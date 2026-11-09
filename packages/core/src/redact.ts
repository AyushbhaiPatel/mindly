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
  /**
   * Returns true for matches that are clearly not secrets. Receives the capture groups and the
   * few characters that follow the match.
   */
  skip?: (groups: readonly string[], after: string) => boolean;
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
function isNonSecretValue(prefix: string, raw: string, after = ''): boolean {
  const value = raw.replace(/[)\]}>.;,]+$/, '');
  // Type names only count after an unquoted `:` (an annotation), never after `=` or a quote.
  const annotation = /:\s*$/.test(prefix);
  if (annotation && TYPE_WORDS.has(value.toLowerCase())) return true;
  if (annotation && /^[A-Z][A-Za-z0-9]*(?:[<[(|].*)?$/.test(value) && !/\d/.test(value)) {
    // A capitalised word is a type name only where code continues around it: a generic or union
    // (`Optional[str]`, `Foo | null`), or a closing bracket, separator or default value after it
    // (`password: SecretString }`). Alone on its line (`password: Wintermute`) it is a value.
    const typeSyntax = value !== raw || /[<[(|]/.test(value);
    if (typeSyntax || /^[ \t]{0,8}(?:\r?\n[ \t]{0,8})?[;,)}\]|=>]/.test(after)) return true;
  }
  return /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|env\.|config\.|settings\.|this\.|self\.|options\.|opts\.|props\.|req\.|args\.)/.test(
    value,
  );
}

/** Words that mark a name (variable, key or flag) as holding a secret. */
const SECRET_WORDS =
  'secret|token|passwd|password|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?key|credentials?';

/** A secret-bearing name: a secret word with up to 60 name characters on either side. */
const SECRET_NAME = `[A-Za-z0-9_.-]{0,60}(?:${SECRET_WORDS})[A-Za-z0-9_.-]{0,60}`;

/**
 * Last words of a name that say it holds display text or metadata about a secret, not the secret
 * (`passwordPlaceholder`, `token_type`, `passwordError`).
 */
const DISPLAY_WORDS = new Set(
  (
    'placeholder label hint help helper message msg error err title text description desc prompt ' +
    'type name field input pattern policy rule rules regex format length len min max strength ' +
    'tooltip caption heading legend warning info note validation requirement requirements ' +
    'instructions summary question reminder'
  ).split(' '),
);

/** True when the name in an assignment prefix (`passwordLabel: '`) ends in a display word. */
function isDisplayName(prefix: string): boolean {
  const name = /([A-Za-z0-9_.-]{1,200})["']?\s{0,5}[:=]\s{0,5}["']?$/.exec(prefix)?.[1] ?? '';
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter((w) => w !== '');
  return DISPLAY_WORDS.has((words[words.length - 1] ?? '').toLowerCase());
}

/**
 * A quoted value with spaces in it is prose more often than a passphrase. It is redacted when the
 * name really names a secret (`"password": "correct horse battery staple"`), and left alone when
 * the name says it is UI text or metadata (`passwordPlaceholder="Enter your password"`).
 */
function isDisplayText(prefix: string, value: string): boolean {
  return /\s/.test(value) && isDisplayName(prefix);
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
    kind: 'cli_credentials',
    // `curl -u user:password` / `wget --user user:password`. Only for HTTP clients, where the
    // flag means credentials: for docker, sudo or chown-style arguments it is a user:group pair,
    // and a stored command has to stay runnable.
    re: /\b((?:curl|wget)\s[^\n|;&]{0,300}?(?:-u|--user)\s{1,5}["']?[^\s:"'`]{1,200}:)([^\s"'`]{3,200})/g,
    replace: `$1${REDACTED}`,
    skip: (g) => (g[2] ?? '').startsWith('$'),
  },
  {
    kind: 'cli_credentials',
    // `docker login -p value`: `-p` means a password only for this command.
    re: /\b(docker\s{1,5}login\s[^\n|;&]{0,200}?-p\s{1,5}["']?)([^\s"'`]{3,4000})/g,
    replace: `$1${REDACTED}`,
    skip: (g) => (g[2] ?? '').startsWith('$'),
  },
  {
    kind: 'cli_flag',
    // `--token value` / `--db-password value`: a flag whose name ends in a secret word, with the
    // value as the next argument. `--password-stdin`, `--token-file` and the like do not end in
    // one; a value that is another flag or a shell variable is not a literal secret.
    re: new RegExp(
      `((?:^|[\\s"'\`(])--?(?:[A-Za-z0-9]{1,30}[-_]){0,6}(?:${SECRET_WORDS})\\s{1,5}["']?)([^\\s"'\`,;]{6,4000})`,
      'gi',
    ),
    replace: `$1${REDACTED}`,
    skip: (g) => /^[-$]/.test(g[2] ?? ''),
  },
  {
    kind: 'assignment',
    // NAME="value" / "name": "value": a quoted value is taken whole, spaces and punctuation
    // included, up to its closing quote.
    re: new RegExp(`\\b(${SECRET_NAME}["']?\\s{0,5}[:=]\\s{0,5}")([^"\\n]{6,4000})(?=")`, 'gi'),
    replace: `$1${REDACTED}`,
    skip: (g) => isDisplayText(g[1] ?? '', g[2] ?? '') || isNonSecretValue(g[1] ?? '', g[2] ?? ''),
  },
  {
    kind: 'assignment',
    re: new RegExp(`\\b(${SECRET_NAME}["']?\\s{0,5}[:=]\\s{0,5}')([^'\\n]{6,4000})(?=')`, 'gi'),
    replace: `$1${REDACTED}`,
    skip: (g) => isDisplayText(g[1] ?? '', g[2] ?? '') || isNonSecretValue(g[1] ?? '', g[2] ?? ''),
  },
  {
    kind: 'assignment',
    // NAME=value / name: value where NAME looks secret-bearing.
    re: new RegExp(`\\b(${SECRET_NAME}["']?\\s{0,5}[:=]\\s{0,5}["']?)([^\\s"'\`,;]{6,4000})`, 'gi'),
    replace: `$1${REDACTED}`,
    // The first word of a quoted display string is not a secret either.
    skip: (g, after) =>
      (/["']$/.test(g[1] ?? '') && /^[ \t]/.test(after) && isDisplayName(g[1] ?? '')) ||
      isNonSecretValue(g[1] ?? '', g[2] ?? '', after),
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

export function redact(input: string, options: RedactOptions = {}): RedactionResult {
  let text = input.length > MAX_REDACT_INPUT ? input.slice(0, MAX_REDACT_INPUT) : input;
  let count = 0;
  const kinds = new Set<string>();

  const apply = (kind: string, re: RegExp, replace: string, skip?: Rule['skip']): void => {
    re.lastIndex = 0;
    text = text.replace(re, (...args: unknown[]) => {
      const match = String(args[0]);
      const groups = args.map((a) => (typeof a === 'string' ? a : ''));
      // Do not double-count a value that is already redacted. Only the secret part is looked
      // at (the match without its kept prefix), and only when nothing else is left in it: a
      // value that merely ends in an earlier redaction still has a secret in front of it.
      const prefix = replace.startsWith('$1') ? (groups[1] ?? '') : '';
      const secret = match.startsWith(prefix) ? match.slice(prefix.length) : match;
      if (secret.includes(REDACTED) && !/[A-Za-z0-9]/.test(secret.split(REDACTED).join(''))) {
        return match;
      }
      const offset = args.find((a) => typeof a === 'number');
      const end = (typeof offset === 'number' ? offset : 0) + match.length;
      if (skip?.(groups, text.slice(end, end + 12))) return match;
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
  '**/.env-*',
  '**/.env_*',
  '**/.envrc',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_dsa*',
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
