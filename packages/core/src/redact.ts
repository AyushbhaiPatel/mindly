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
  /** Command-line lookups left for this call; see `programAt`. */
  budget: { scans: number };
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
 * Last words of a name that only ever name display text or a kind, never the secret itself
 * (`passwordPlaceholder`, `token_type`, `passwordError`). Kept short on purpose: words such as
 * `text`, `input`, `message` or `note` also name fields that hold the secret.
 */
const DISPLAY_WORDS = new Set(
  'placeholder label hint help tooltip caption heading title error description prompt type'.split(
    ' ',
  ),
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

/** An ordinary word: letters only, capitals only at the start (or throughout), no longer than 14. */
const PLAIN_WORD = /^[("]?(?:[A-Z]?[a-z]{1,13}(?:['-][a-z]{1,10})?|[A-Z]{1,6})[)"]?[.,:;!?]{0,3}$/;

/** True for two or more ordinary words: a sentence or a label, not a token or a passphrase. */
function isPlainWords(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 40 && words.every((w) => PLAIN_WORD.test(w));
}

/**
 * A quoted value is display text, not a secret, only when both hold: the name says so
 * (`passwordPlaceholder`, `token_type`) and the value reads as plain words (`"Enter your
 * password"`). Anything with a digit, a long or mixed-case word or a single word is still
 * redacted, whatever the name ends in.
 */
function isDisplayText(prefix: string, value: string): boolean {
  return isDisplayName(prefix) && isPlainWords(value);
}

/**
 * The same test for the unquoted-value rule, which only matched the first word of a quoted
 * string: the rest of the string, up to its closing quote, is read from the text.
 */
function startsDisplayText(prefix: string, value: string, at: MatchContext): boolean {
  const quote = prefix.slice(-1);
  if ((quote !== '"' && quote !== "'") || !isDisplayName(prefix)) return false;
  const rest = at.text.slice(at.end, at.end + 400);
  const close = rest.search(quote === '"' ? /["\n]/ : /['\n]/);
  return close !== -1 && rest[close] === quote && isPlainWords(value + rest.slice(0, close));
}

/**
 * Programs whose `-u` / `--user` takes a user (or `user:group`, or a git remote and refspec), not
 * credentials. Rewriting those arguments would leave a stored command that cannot be run again.
 */
const USER_FLAG_PROGRAMS = new Set(
  (
    'docker podman nerdctl kubectl oc crictl buildah chown install rsync tar id systemd-run git ' +
    'docker-compose'
  ).split(' '),
);

/** Programs that run another command as a user: `sudo -u postgres psql`. */
const RUN_AS_PROGRAMS = new Set(['sudo', 'su', 'runuser', 'doas']);

/** Programs where `-uname:password` (no space) is credentials. */
const HTTP_PROGRAMS = new Set(['curl', 'wget', 'curlie', 'aria2c', 'ab', 'lftp']);

/** How far back a command line is read to find its program. */
const COMMAND_SCAN_CHARS = 2000;

/** How many leading words of a command line are looked at to find its program. */
const COMMAND_WORDS = 16;

/**
 * The words of the command line that ends at `end`, quotes removed. A command line starts after
 * an unquoted `;`, `|`, `&`, `(` or newline; quotes and a backslash before a newline do not end
 * it, so a URL with `&` in it or a continued line stays part of the same command.
 */
function commandWords(text: string, end: number): string[] {
  // Word boundaries are collected as offsets and only turned into strings at the end, so a text
  // with many matches does not build a string per character.
  let bounds: number[] = [];
  let wordStart = -1;
  let quote = 0;
  const close = (i: number): void => {
    if (wordStart !== -1) bounds.push(wordStart, i);
    wordStart = -1;
  };
  for (let i = Math.max(0, end - COMMAND_SCAN_CHARS); i < end; i++) {
    const ch = text.charCodeAt(i);
    if (quote !== 0) {
      if (ch === quote) quote = 0;
    } else if (ch === 92 /* \ */) {
      const next = text.charCodeAt(i + 1);
      if (next === 10 || (next === 13 && text.charCodeAt(i + 2) === 10)) {
        close(i);
        i += next === 10 ? 1 : 2;
      } else {
        if (wordStart === -1) wordStart = i;
        i++;
      }
    } else if (ch === 34 /* " */ || ch === 39 /* ' */) {
      quote = ch;
      if (wordStart === -1) wordStart = i;
    } else if (ch === 59 || ch === 124 || ch === 38 || ch === 40 || ch === 10) {
      // ; | & ( and newline start a new command line.
      bounds = [];
      wordStart = -1;
    } else if (ch === 32 || ch === 9 || ch === 13) {
      close(i);
    } else if (wordStart === -1) {
      wordStart = i;
    }
  }
  close(end);
  // The program is among the first words; the rest of a long line is not needed.
  const words: string[] = [];
  for (let k = 0; k < bounds.length && k < 2 * COMMAND_WORDS; k += 2) {
    words.push(text.slice(bounds[k], bounds[k + 1]).replace(/["'\\]/g, ''));
  }
  return words;
}

/** `/usr/bin/Docker.exe` -> `docker`; an argument that is not a bare program name -> ''. */
function programName(word: string): string {
  const m = /^(?:[./~][^\s:]{0,200}\/)?([A-Za-z][A-Za-z0-9._-]{0,40}?)(?:\.exe)?$/i.exec(word);
  return (m?.[1] ?? '').toLowerCase();
}

/**
 * The program a `-u` flag at the end of `words` belongs to: the run-as program itself when only
 * its own options stand between it and the flag (`sudo -n -u`), else the command it runs.
 */
function programOfFlag(words: readonly string[]): string {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++;
      continue;
    }
    const name = programName(word);
    if (!RUN_AS_PROGRAMS.has(name) && name !== 'env' && name !== 'time' && name !== 'nohup') {
      return name;
    }
    // Skip the run-as program's own options, and the value of those that take one.
    let j = i + 1;
    while (j < words.length && (words[j] ?? '').startsWith('-')) {
      j += /^(?:-[ugUhpCDRT]|--user|--group|--host|--prompt)$/.test(words[j] ?? '') ? 2 : 1;
    }
    if (j >= words.length) return name;
    i = j;
  }
  return '';
}

/**
 * True when `-u name:value` is clearly a user and group (or a remote and refspec) and not
 * credentials. Credentials are the default: an unknown program gets its value redacted.
 */
function isUserGroupArgument(name: string, value: string, at: MatchContext): boolean {
  if (/^\d+$/.test(name) && /^\d+$/.test(value)) return true;
  if (name === value && /^[a-z_][a-z0-9_-]{0,31}$/.test(name)) return true;
  const program = programAt(at);
  return USER_FLAG_PROGRAMS.has(program) || RUN_AS_PROGRAMS.has(program);
}

/**
 * The program of the command line a match sits on. Each lookup reads back up to
 * `COMMAND_SCAN_CHARS`, so one call only gets so many: past that the program is unknown (''),
 * which callers treat as "may be credentials". Hostile input cannot buy more work than that.
 */
function programAt(at: MatchContext): string {
  if (at.budget.scans <= 0) return '';
  at.budget.scans--;
  return programOfFlag(commandWords(at.text, at.start));
}

/** Command-line lookups one `redact()` call may do. */
const MAX_COMMAND_SCANS = 2000;

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
    // `-u user:password` / `--user user:password` / `--user=user:password` (curl, wget and other
    // HTTP tools). Credentials unless it is clearly a user:group argument of docker, sudo, chown
    // and the like, which must stay as written.
    re: /((?:^|\s)(?:-u|--user)(?:\s{1,5}|=)["']?)([^\s:"'`]{1,200}):([^\s"'`]{3,200})/g,
    replace: `$1$2:${REDACTED}`,
    skip: (g, at) =>
      (g[3] ?? '').startsWith('$') || isUserGroupArgument(g[2] ?? '', g[3] ?? '', at),
  },
  {
    kind: 'cli_credentials',
    // `curl -uuser:password`, with no space: only where the program is known to be an HTTP client.
    re: /((?:^|\s)-u["']?)([^\s:"'`=-][^\s:"'`]{0,200}):([^\s"'`]{3,200})/g,
    replace: `$1$2:${REDACTED}`,
    skip: (g, at) => (g[3] ?? '').startsWith('$') || !HTTP_PROGRAMS.has(programAt(at)),
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
  const budget = { scans: MAX_COMMAND_SCANS };
  const kinds = new Set<string>();

  const apply = (kind: string, re: RegExp, replace: string, skip?: Rule['skip']): void => {
    re.lastIndex = 0;
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
      if (skip?.(groups, { text, start, end: start + match.length, budget })) return match;
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
