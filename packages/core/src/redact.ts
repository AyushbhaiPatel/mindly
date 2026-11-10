/**
 * Secret redaction. Every piece of user or agent text passes through `redact()` before it is
 * stored, logged, sent to a model provider or put in a notification.
 *
 * Patterns are written to be linear-time (no nested unbounded quantifiers) and input is capped,
 * so hostile content cannot stall a hook with catastrophic regex backtracking.
 */

export const REDACTED = '[REDACTED]';

/** Hard cap on how much text one call processes. Longer input is truncated first. */
export const MAX_REDACT_INPUT = 1_000_000;

interface Rule {
  kind: string;
  re: RegExp;
  /** Replacement; `$1` style groups keep non-secret context such as the variable name. */
  replace: string;
  /** Returns true for matches that are clearly not secrets (receives the capture groups). */
  skip?: (groups: readonly string[]) => boolean;
}

/** Type names that follow `password:` in code (TypeScript, Python, Go, …), never secrets. */
const TYPE_WORDS = new Set([
  'string',
  'number',
  'boolean',
  'bool',
  'any',
  'unknown',
  'never',
  'void',
  'null',
  'undefined',
  'none',
  'true',
  'false',
  'str',
  'int',
  'bytes',
  'optional',
  'secretstr',
  'char',
  'object',
]);

/**
 * True when an assignment's value is a type annotation or a reference to where the secret lives
 * (`process.env.X`, `config.password`), not a literal secret. Redacting those only garbles code.
 */
function isNonSecretValue(prefix: string, raw: string): boolean {
  const value = raw.replace(/[)\]}>.;,]+$/, '');
  // Type names only count after an unquoted `:` (an annotation), never after `=` or a quote.
  const annotation = /:\s*$/.test(prefix);
  if (annotation && TYPE_WORDS.has(value.toLowerCase())) return true;
  if (annotation && /^[A-Z][A-Za-z0-9]*(?:[<[(|].*)?$/.test(value) && !/\d/.test(value)) {
    return true;
  }
  return /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|env\.|config\.|settings\.|this\.|self\.|options\.|opts\.|props\.|req\.|args\.)/.test(
    value,
  );
}

const RULES: Rule[] = [
  {
    kind: 'private_key',
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,200}/g, replace: REDACTED },
  {
    kind: 'openai_key',
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,200}/g,
    replace: REDACTED,
  },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, replace: REDACTED },
  { kind: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{50,255}\b/g, replace: REDACTED },
  { kind: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{20,64}\b/g, replace: REDACTED },
  { kind: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,200}/g, replace: REDACTED },
  {
    kind: 'slack_webhook',
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,200}/g,
    replace: REDACTED,
  },
  {
    kind: 'stripe_key',
    re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,200}\b/g,
    replace: REDACTED,
  },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  { kind: 'npm_token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
  { kind: 'pypi_token', re: /\bpypi-[A-Za-z0-9_-]{50,300}/g, replace: REDACTED },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}/g,
    replace: REDACTED,
  },
  {
    kind: 'auth_header',
    re: /\b(authorization\s{0,5}[:=]\s{0,5}(?:bearer|basic|token)\s{1,5})[A-Za-z0-9._~+/=-]{8,4000}/gi,
    replace: `$1${REDACTED}`,
  },
  {
    kind: 'url_credentials',
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,200}:)[^\s@/]{1,200}@/gi,
    replace: `$1${REDACTED}@`,
  },
  {
    kind: 'assignment',
    // NAME=value / "name": "value" where NAME looks secret-bearing.
    re: /\b([A-Za-z0-9_.-]{0,60}(?:secret|token|passwd|password|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?key|credentials?)[A-Za-z0-9_.-]{0,60}["']?\s{0,5}[:=]\s{0,5}["']?)([^\s"'`,;]{6,4000})/gi,
    replace: `$1${REDACTED}`,
    skip: (g) => isNonSecretValue(g[1] ?? '', g[2] ?? ''),
  },
];

export interface RedactionResult {
  text: string;
  /** Number of replacements made. */
  count: number;
  /** Distinct rule kinds that matched, for audit events (never the secret itself). */
  kinds: string[];
}

export interface RedactOptions {
  /** Extra user-configured patterns (regex source strings). Invalid patterns are ignored. */
  extraPatterns?: readonly string[];
}

const extraCache = new Map<string, RegExp | null>();

/** Text a pattern is tried on: empty, short, words, digits, punctuation, lines. */
const ZERO_WIDTH_PROBES = [
  '',
  'a',
  'ab c',
  'secret token 123',
  'Deploy to prod: key=ACME-1234, user@example.com\n\tpath/to/file.ts (line 42); ÄÖ ✓ 0x1F',
];

/**
 * True when the global regex `re` can match without matching any text (``, `a*`, `\b`,
 * `(?=.)`) on one of a few short samples. Such a pattern would put a marker between characters.
 */
export function matchesZeroWidth(re: RegExp): boolean {
  for (const probe of ZERO_WIDTH_PROBES) {
    re.lastIndex = 0;
    for (let m = re.exec(probe), n = 0; m !== null && n < 200; m = re.exec(probe), n++) {
      if (m[0].length === 0) {
        re.lastIndex = 0;
        return true;
      }
    }
  }
  re.lastIndex = 0;
  return false;
}

const LOOKAROUND_OPEN = /^\(\?<?[=!]/;

/**
 * True when some part of the regex `source` consumes a character: a literal, `.`, a class or
 * an escape other than `\b`/`\B`, outside every lookaround. A pattern made only of
 * lookarounds, anchors and word boundaries (`(?=password)`, `^`, `\B(?=q)`) never matches any
 * text, so it cannot redact anything; at best it marks a position next to the secret.
 */
export function consumesText(source: string): boolean {
  let lookaround = 0;
  // Depth of open groups, and which of them are lookarounds.
  const stack: boolean[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === '\\') {
      const next = source[i + 1];
      i++;
      if (next === undefined) return lookaround === 0;
      if (next === 'b' || next === 'B') continue;
      // Skip the rest of a multi-character escape: \k<name>, \p{...}, \u{...}, \x41, \u0041.
      if (
        (next === 'k' && source[i + 1] === '<') ||
        ((next === 'p' || next === 'P' || next === 'u') && source[i + 1] === '{')
      ) {
        const close = source.indexOf(next === 'k' ? '>' : '}', i);
        if (close > 0) i = close;
      }
      if (lookaround === 0) return true;
      continue;
    }
    if (ch === '[') {
      // A class consumes a character (even `[^]`); skip to its end.
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      i = j;
      if (lookaround === 0) return true;
      continue;
    }
    if (ch === '(') {
      const isLook = LOOKAROUND_OPEN.test(source.slice(i, i + 4));
      stack.push(isLook);
      if (isLook) lookaround++;
      // Skip the group's own syntax: (?:, (?=, (?!, (?<=, (?<!, (?<name>.
      if (source[i + 1] === '?') {
        if (source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!') {
          const close = source.indexOf('>', i);
          i = close > 0 ? close : i + 2;
        } else {
          i += source[i + 2] === '<' ? 3 : 2;
        }
      }
      continue;
    }
    if (ch === ')') {
      if (stack.pop() === true) lookaround--;
      continue;
    }
    if ('^$|*+?'.includes(ch)) continue;
    if (ch === '{') {
      // A quantifier such as {2,5}; a lone `{` is a literal.
      const m = /^\{\d+(,\d*)?\}/.exec(source.slice(i));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (lookaround === 0) return true;
  }
  return false;
}

function compileExtra(source: string): RegExp | null {
  if (extraCache.has(source)) return extraCache.get(source) ?? null;
  let re: RegExp | null = null;
  try {
    if (source.length <= 500) re = new RegExp(source, 'g');
  } catch {
    re = null;
  }
  // The settings refuse these; a caller passing patterns of its own must not get them either.
  if (re !== null && (!consumesText(source) || matchesZeroWidth(re))) re = null;
  extraCache.set(source, re);
  return re;
}

export function redact(input: string, options: RedactOptions = {}): RedactionResult {
  let text = input.length > MAX_REDACT_INPUT ? input.slice(0, MAX_REDACT_INPUT) : input;
  let count = 0;
  const kinds = new Set<string>();

  const apply = (kind: string, re: RegExp, replace: string, skip?: Rule['skip']): void => {
    re.lastIndex = 0;
    text = text.replace(re, (...args: unknown[]) => {
      const match = String(args[0]);
      // An empty match covers no text: there is nothing to hide there, and a marker would only
      // point at the secret next to it.
      if (match.length === 0) return match;
      // Do not double-count already-redacted values.
      if (match.endsWith(REDACTED) || match === REDACTED) return match;
      if (skip?.(args.map((a) => (typeof a === 'string' ? a : '')))) return match;
      count++;
      kinds.add(kind);
      return replace.replace(/\$(\d)/g, (_m, g: string) => String(args[Number(g)] ?? ''));
    });
  };

  for (const rule of RULES) apply(rule.kind, rule.re, rule.replace, rule.skip);
  for (const source of options.extraPatterns ?? []) {
    const re = compileExtra(source);
    if (re) apply('custom', re, REDACTED);
  }
  return { text, count, kinds: [...kinds] };
}

/** Convenience wrapper returning only the redacted text. */
export function redactText(input: string, options?: RedactOptions): string {
  return redact(input, options).text;
}

/** Recursively redacts every string value inside a JSON-like structure. */
export function redactDeep<T>(value: T, options?: RedactOptions, depth = 0): T {
  if (depth > 20) return value;
  if (typeof value === 'string') return redactText(value, options) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, options, depth + 1)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, options, depth + 1);
    }
    return out as T;
  }
  return value;
}

/**
 * Paths whose content Mindly never reads or captures. Patterns are project-relative globs.
 */
export const DEFAULT_DENY_PATHS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/secrets/**',
  '**/*.kdbx',
  '**/credentials.json',
  '**/service-account*.json',
];
