import {
  hasHiddenChars,
  matchCopies,
  matchCopy,
  originalSpan,
  replaceSpans,
  type Span,
} from './hidden.js';

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

function compileExtra(source: string): RegExp | null {
  if (extraCache.has(source)) return extraCache.get(source) ?? null;
  let re: RegExp | null = null;
  try {
    if (source.length <= 500) re = new RegExp(source, 'g');
  } catch {
    re = null;
  }
  extraCache.set(source, re);
  return re;
}

function redactVisible(input: string, options: RedactOptions = {}): RedactionResult {
  let text = input.length > MAX_REDACT_INPUT ? input.slice(0, MAX_REDACT_INPUT) : input;
  let count = 0;
  const kinds = new Set<string>();

  const apply = (kind: string, re: RegExp, replace: string, skip?: Rule['skip']): void => {
    re.lastIndex = 0;
    text = text.replace(re, (...args: unknown[]) => {
      // Do not double-count already-redacted values.
      const match = String(args[0]);
      if (match.endsWith(REDACTED) || match === REDACTED) return match;
      if (skip?.(args.map((a) => (typeof a === 'string' ? a : '')))) return match;
      count++;
      kinds.add(kind);
      return noteEdit(
        args,
        replace.replace(/\$(\d)/g, (_m, g: string) => String(args[Number(g)] ?? '')),
      );
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

/** The replacements one pass of a pattern made, in the offsets of that pass's input. */
interface Pass {
  input: string;
  edits: { at: number; len: number; text: string }[];
}

/** Set while `redact` needs to know where replacements were made. */
let recording: Pass[] | null = null;

/**
 * Notes a replacement (from the callback of a `String.replace`: its arguments, and the text put
 * in). Every change `redactVisible` makes must go through here, or `redact` cannot place it.
 */
function noteEdit(args: readonly unknown[], text: string): string {
  if (recording) {
    const i = args.findIndex((a) => typeof a === 'number');
    const input = args[i + 1];
    if (i > 0 && typeof input === 'string') {
      let pass = recording[recording.length - 1];
      if (!pass || pass.input !== input) {
        pass = { input, edits: [] };
        recording.push(pass);
      }
      pass.edits.push({ at: args[i] as number, len: String(args[0]).length, text });
    }
  }
  return text;
}

/**
 * Where, in `copy`, the replacements of `passes` were made: one span per replaced secret, with
 * the text that took its place. A kept prefix or suffix (a variable name, an `@`) is not part of
 * the span. Null when the passes do not lead from `copy` to `result` (a change was not noted).
 */
function replacedSpans(copy: string, passes: readonly Pass[], result: string): Span[] | null {
  let text = copy;
  // For each unit of `text`: the unit of `copy` it is (>= 0), or -(k + 1) for edit k's text.
  let origin = new Int32Array(copy.length);
  for (let u = 0; u < copy.length; u++) origin[u] = u;
  const edits: (Span & { live: boolean })[] = [];
  for (const pass of passes) {
    if (pass.input !== text) return null;
    const parts: string[] = [];
    let room = text.length;
    for (const e of pass.edits) room += e.text.length;
    const next = new Int32Array(room);
    let n = 0;
    let cursor = 0;
    for (const e of pass.edits) {
      if (e.at < cursor) return null;
      const match = text.slice(e.at, e.at + e.len);
      const most = Math.min(e.len, e.text.length);
      let p = 0;
      while (p < most && match[p] === e.text[p]) p++;
      let q = 0;
      while (q < most - p && match[e.len - 1 - q] === e.text[e.text.length - 1 - q]) q++;
      const from = e.at + p;
      const to = e.at + e.len - q;
      let start = Number.POSITIVE_INFINITY;
      let end = Number.NEGATIVE_INFINITY;
      for (let u = from; u < to; u++) {
        const o = origin[u] ?? 0;
        const inner = o < 0 ? edits[-o - 1] : undefined;
        if (inner) inner.live = false;
        start = Math.min(start, inner ? inner.start : o);
        end = Math.max(end, inner ? inner.end : o + 1);
      }
      if (start === Number.POSITIVE_INFINITY) {
        const o = from < origin.length ? (origin[from] ?? 0) : copy.length;
        start = o < 0 ? (edits[-o - 1]?.start ?? 0) : o;
        end = start;
      }
      const id = edits.length;
      const replacement = e.text.slice(p, e.text.length - q);
      edits.push({ start, end, text: replacement, live: true });
      parts.push(text.slice(cursor, from), replacement);
      next.set(origin.subarray(cursor, from), n);
      n += from - cursor;
      next.fill(-id - 1, n, n + replacement.length);
      n += replacement.length;
      cursor = to;
    }
    parts.push(text.slice(cursor));
    next.set(origin.subarray(cursor, text.length), n);
    n += text.length - cursor;
    text = parts.join('');
    origin = next.subarray(0, n);
  }
  if (text !== result) return null;
  return edits.filter((e) => e.live).map(({ start, end, text: t }) => ({ start, end, text: t }));
}

/** Redacts `text` and says where the replacements were made, or null when that is not known. */
function redactTraced(
  text: string,
  options: RedactOptions,
): { result: RedactionResult; spans: Span[] | null } {
  const passes: Pass[] = [];
  recording = passes;
  let result: RedactionResult;
  try {
    result = redactVisible(text, options);
  } finally {
    recording = null;
  }
  return { result, spans: result.count === 0 ? [] : replacedSpans(text, passes, result.text) };
}

/**
 * Replaces the secrets in `input` and keeps every other character. Characters that render as
 * nothing and control characters can hide a secret (inside it) or hide a word boundary (next to
 * it), so secrets are looked for in several copies: without those characters, with each turned
 * into a space, and mixes of the two (see `CopyMode`). What any finds is replaced in `input`, the
 * hidden characters inside a secret included; everything else is returned as it was.
 */
export function redact(input: string, options: RedactOptions = {}): RedactionResult {
  let text = input.length > MAX_REDACT_INPUT ? input.slice(0, MAX_REDACT_INPUT) : input;
  if (!hasHiddenChars(text)) return redactVisible(text, options);
  let count = 0;
  const kinds = new Set<string>();
  // A secret glued to another one by a hidden character is found once its neighbour is replaced.
  for (let round = 0; round < MAX_HIDDEN_ROUNDS; round++) {
    const spans: Span[] = [];
    for (const copy of matchCopies(text)) {
      const { result, spans: found } = redactTraced(copy.text, options);
      if (found === null) return untraced(text, options);
      for (const k of result.kinds) kinds.add(k);
      for (const f of found) {
        const [start, end] = originalSpan(copy, f.start, f.end, text.length);
        spans.push({ start, end, text: f.text });
      }
    }
    if (spans.length === 0) break;
    const replaced = replaceSpans(text, spans, REDACTED);
    count += replaced.count;
    // Another round finds something only next to a secret glued on by hidden characters.
    const glued = spans.some((sp) => gluedAt(text, sp.start, -1) || gluedAt(text, sp.end, 1));
    text = replaced.text;
    if (!glued) break;
  }
  return { text, count, kinds: [...kinds] };
}

/**
 * Whether hidden characters at `at`, going in `dir`, lead to a word character: a secret replaced
 * there may have hidden another one glued to it.
 */
function gluedAt(text: string, at: number, dir: 1 | -1): boolean {
  let o = dir === 1 ? at : at - 1;
  let hidden = false;
  while (o >= 0 && o < text.length) {
    const cp = text.codePointAt(dir === 1 ? o : o - (isLowSurrogate(text, o) ? 1 : 0)) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (!hasHiddenChars(ch)) return hidden && /[A-Za-z0-9_]/.test(ch);
    hidden = true;
    o += dir * ch.length;
  }
  return false;
}

function isLowSurrogate(text: string, o: number): boolean {
  const c = text.charCodeAt(o);
  return c >= 0xdc00 && c <= 0xdfff && o > 0;
}

/** Rounds of `redact` on text with hidden characters; each runs only when the last found one. */
const MAX_HIDDEN_ROUNDS = 4;

/**
 * Used only when a replacement was made that `noteEdit` did not see, so its place in the original
 * is not known. The copy without hidden characters is redacted; when another copy finds more
 * than that one, none of the text is kept.
 */
function untraced(text: string, options: RedactOptions): RedactionResult {
  const removed = redactVisible(matchCopy(text, 'removed').text, options);
  for (const copy of matchCopies(text)) {
    const other = redactVisible(copy.text, options);
    if (other.count > removed.count)
      return { text: REDACTED, count: other.count, kinds: other.kinds };
  }
  return removed;
}
