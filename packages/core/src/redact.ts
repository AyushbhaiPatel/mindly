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
   * Returns true for matches that are clearly not secrets. Receives the capture groups and
   * where the match sits in the text.
   */
  skip?: (groups: readonly string[], at: MatchContext) => boolean;
}

/** Where a match sits: the whole text, and the offsets the match starts and ends at. */
interface MatchContext {
  text: string;
  start: number;
  end: number;
  /** The line last looked at by `httpClientBefore`, kept so each line is read once. */
  line: LineMemo;
}

interface LineMemo {
  start: number;
  end: number;
  /** Where the first HTTP client is named on the line, or -1. */
  client: number;
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
 * Last words of a name that only ever name display text, never the secret itself
 * (`passwordPlaceholder`, `passwordError`). Kept short on purpose: words such as `text`, `input`,
 * `message`, `prompt` or `type` also name fields and variables that hold the secret.
 */
const DISPLAY_WORDS = new Set(
  'placeholder label hint help tooltip caption heading error'.split(' '),
);

/** The last word of the name in an assignment prefix: `passwordLabel: '` -> `label`. */
function lastNameWord(prefix: string): string {
  const name = /([A-Za-z0-9_.-]{1,200})["']?\s{0,5}[:=]\s{0,5}["']?$/.exec(prefix)?.[1] ?? '';
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter((w) => w !== '');
  return (words[words.length - 1] ?? '').toLowerCase();
}

/**
 * An ordinary word of a sentence: letters of any script with an inner hyphen or apostrophe, at
 * most 24 characters and no capital after a lower-case letter; or a number of up to four digits.
 * Brackets, quotes and sentence punctuation around it do not count. A token that mixes letters
 * and digits is never plain.
 */
function isPlainWord(word: string): boolean {
  const core = word.replace(/^[("'“‘«]+/, '').replace(/[)"'”’».,:;!?…]+$/, '');
  if (core === '') return word.length <= 3;
  if (/^\d{1,4}$/.test(core)) return true;
  return core.length <= 24 && /^\p{L}+(?:['’-]\p{L}+)*$/u.test(core) && !/\p{Ll}\p{Lu}/u.test(core);
}

/** True for two or more ordinary words: a sentence or a label, not a token. */
function isPlainWords(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 40 && words.every(isPlainWord);
}

/**
 * A quoted value is display text, not a secret, only when both hold: the name says so
 * (`passwordPlaceholder`, `tokenError`) and the value reads as plain words (`"Enter your
 * password"`). A single word, a token mixing letters and digits or a long or mixed-case word is
 * still redacted, whatever the name ends in. A `..._type` name is display text only for an
 * authorization scheme followed by plain words (`token_type: "Bearer access"`).
 */
function isDisplayText(prefix: string, value: string): boolean {
  const last = lastNameWord(prefix);
  if (last === 'type')
    return /^\s*(?:Bearer|Basic|Digest|MAC)\s/i.test(value) && isPlainWords(value);
  return DISPLAY_WORDS.has(last) && isPlainWords(value);
}

/**
 * The same test for the unquoted-value rule, which only matched the first word of a quoted
 * string: the rest of the string, up to its closing quote, is read from the text.
 */
function startsDisplayText(prefix: string, value: string, at: MatchContext): boolean {
  const quote = prefix.slice(-1);
  if (quote !== '"' && quote !== "'") return false;
  const last = lastNameWord(prefix);
  if (last !== 'type' && !DISPLAY_WORDS.has(last)) return false;
  const rest = at.text.slice(at.end, at.end + 400);
  const close = rest.search(quote === '"' ? /["\n]/ : /['\n]/);
  return (
    close !== -1 && rest[close] === quote && isDisplayText(prefix, value + rest.slice(0, close))
  );
}

/**
 * An HTTP client named as a word, with or without a directory or `.exe`: `curl`, `/usr/bin/curl`,
 * `C:\tools\CURL.EXE`. For these, `-u name:value` means credentials.
 */
const HTTP_CLIENT =
  /(?:^|[\s"'`(=;|&/\\])(?:curl|wget|curlie|aria2c|ab|lftp)(?:\.exe)?(?=$|[\s"'`);|&])/i;

/** True when the newline at `i` is escaped with a backslash, so the line goes on after it. */
function isContinuation(text: string, i: number): boolean {
  const before = text[i - 1] === '\r' ? i - 2 : i - 1;
  return text[before] === '\\';
}

/**
 * True when an HTTP client is named earlier on the line `pos` is on. A line is a physical line,
 * joined with the next across a backslash before the newline. Nothing else is parsed: the client
 * may sit inside `sh -c "..."`, after `&&` or in a sentence, and any other program's `-u` (a
 * user, a group, a URL, a unit) is never touched.
 */
function httpClientBefore(at: MatchContext, pos: number): boolean {
  const { text, line } = at;
  if (pos < line.start || pos >= line.end) {
    let start = text.lastIndexOf('\n', pos - 1);
    while (start > 0 && isContinuation(text, start)) start = text.lastIndexOf('\n', start - 1);
    let end = text.indexOf('\n', pos);
    while (end !== -1 && isContinuation(text, end)) end = text.indexOf('\n', end + 1);
    line.start = start + 1;
    line.end = end === -1 ? text.length : end;
    HTTP_CLIENT.lastIndex = 0;
    const found = HTTP_CLIENT.exec(text.slice(line.start, line.end));
    line.client = found === null ? -1 : line.start + found.index;
  }
  return line.client !== -1 && line.client < pos;
}

/** Skip for the `-u name:value` rules: not on an HTTP client's line, or not a literal secret. */
function isNotHttpCredentials(groups: readonly string[], at: MatchContext): boolean {
  const value = groups[3] ?? '';
  if (value.startsWith('$') || value.startsWith('//')) return true;
  // The match may begin with the whitespace before the flag, which can be the line break.
  const flag = at.start + (/^\s/.test(groups[1] ?? '') ? 1 : 0);
  return !httpClientBefore(at, flag);
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
    // `curl -u user:password`, `--user user:password`, `--user=user:password`, `--proxy-user` and
    // combined short flags ending in u (`-su`). Only on a line that names an HTTP client first.
    re: /((?:^|\s)(?:-[A-Za-z]{0,8}u|--(?:proxy-)?user)(?:\s{1,5}|=)["']?)([^\s:"'`]{1,200}):([^\s"'`]{1,200})/g,
    replace: `$1$2:${REDACTED}`,
    skip: isNotHttpCredentials,
  },
  {
    kind: 'cli_credentials',
    // `curl -uuser:password`, with no space after the flag.
    re: /((?:^|\s)-u["']?)([^\s:"'`=-][^\s:"'`]{0,200}):([^\s"'`]{1,200})/g,
    replace: `$1$2:${REDACTED}`,
    skip: isNotHttpCredentials,
  },
  {
    kind: 'cli_credentials',
    // `docker login -p value`: `-p` means a password only for this command.
    re: /\b((?:docker|podman|nerdctl)(?:\.exe)?\s{1,5}login\s(?:[^\n|;&]{0,300}?\s)?-p\s{1,5}["']?)([^\s"'`]{3,4000})/gi,
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
    skip: (g, at) =>
      startsDisplayText(g[1] ?? '', g[2] ?? '', at) ||
      isNonSecretValue(g[1] ?? '', g[2] ?? '', at.text.slice(at.end, at.end + 12)),
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
    const line: LineMemo = { start: 0, end: 0, client: -1 };
    text = text.replace(re, (...args: unknown[]) => {
      const match = String(args[0]);
      const groups = args.map((a) => (typeof a === 'string' ? a : ''));
      // Do not double-count a value that is already redacted. Only the secret part is looked
      // at (the match without its kept prefix), and only when nothing else is left in it: a
      // value that merely ends in an earlier redaction still has a secret in front of it.
      const kept = replace
        .slice(0, Math.max(0, replace.indexOf(REDACTED)))
        .replace(/\$(\d)/g, (_m, g: string) => groups[Number(g)] ?? '');
      const secret = match.startsWith(kept) ? match.slice(kept.length) : match;
      if (secret.includes(REDACTED) && !/[A-Za-z0-9]/.test(secret.split(REDACTED).join(''))) {
        return match;
      }
      const offset = args.find((a) => typeof a === 'number');
      const start = typeof offset === 'number' ? offset : 0;
      if (skip?.(groups, { text, start, end: start + match.length, line })) return match;
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
