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
  /**
   * The line's commands, as triples: where one starts, where it ends, and where the first HTTP
   * client is named in it (-1 for none).
   */
  commands: number[];
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
 * most 24 characters, with a capital inside it only once and only in a word of up to 12 letters
 * (a name such as `GitHub`); or a number of up to four digits, a range or a minimum (`8–64`,
 * `8+`). Brackets, quotes and sentence punctuation around it do not count. A token that mixes
 * letters and digits is never plain.
 */
function isPlainWord(word: string): boolean {
  const core = word.replace(/^[("'“‘«]+/, '').replace(/[)"'”’».,:;!?…]+$/, '');
  if (core === '') return word.length <= 3;
  // A number, a range or a minimum: `8`, `8-64`, `8–64`, `8+`.
  if (/^\d{1,4}(?:[-–—]\d{1,4})?\+?$/.test(core)) return true;
  if (core.length > 24 || !/^\p{L}+(?:['’-]\p{L}+)*$/u.test(core)) return false;
  // One capital inside a short word is a name (`GitHub`, `iPhone`); more is an identifier.
  const inner = core.match(/\p{Ll}\p{Lu}/gu)?.length ?? 0;
  return inner === 0 || (inner === 1 && core.length <= 12);
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

/** HTTP clients by program name. */
const CLIENT_NAMES = 'curlie|aria2c|lftp|hurl|httpstat|httpie';

/**
 * An HTTP client, for which `-u name:value` means credentials. Named as a word after any
 * non-word character, with or without a directory or `.exe` (`!curl`, `C:\me>curl`,
 * `/usr/bin/curl`, `CURL.EXE`), including builds such as `curl_chrome116` or
 * `curl-impersonate`; or a variable that holds one. A variable counts when its name is a client
 * name, alone or with a short affix (`$CURL`, `${CURL_BIN}`, `$MY_WGET`), never a setting that
 * only mentions one (`$HTTP_PORT`, `$HTTP_PROXY`); an assignment counts when its name starts
 * with one (`CURL_OPTS="..."`, not `use_curl=1`). A client behind a shell function or alias
 * defined elsewhere is not recognised.
 */
const HTTP_CLIENT_SOURCE = [
  '(?<![\\p{L}\\p{N}_])(?:',
  // A program name; after `$` or `${` it is a variable, judged by the next alternative.
  `(?<![$\\{])(?:curl(?:[-_][A-Za-z0-9_-]{1,40}|\\d{1,4})?|wget2?|ab|${CLIENT_NAMES})`,
  '(?:\\.exe)?(?![\\p{L}\\p{N}_])',
  `|\\$\\{?(?:[A-Za-z0-9]{1,8}_)?(?:curl|wget|${CLIENT_NAMES})(?:_(?!proxy\\b)[A-Za-z0-9]{1,8})?\\}?(?![A-Za-z0-9_])`,
  '|(?:curl|wget)(?:_[A-Za-z0-9]{1,12})?=',
  ')',
].join('');

const HTTP_CLIENT = new RegExp(HTTP_CLIENT_SOURCE, 'iu');

/**
 * A line whose first word is an HTTP client, after an optional shell prompt (`$ curl ...`): the
 * start of a command that may be wrapped over indented option lines.
 */
const CLIENT_LINE = new RegExp(`[ \\t]*(?:[$>%#][ \\t]+)?${HTTP_CLIENT_SOURCE}`, 'iuy');

/** curl's short options that take no value, so they can come before `u` in one cluster. */
const CURL_FLAG_CLUSTER = '[0-6aBfGgIijJkLlMNnOpqRsSvVZ#]{0,10}';

/** A user flag: `-u`, `-U`, a curl cluster ending in one (`-su`), `--user`, `--proxy-user`. */
const USER_FLAG = `-${CURL_FLAG_CLUSTER}[uU]|--(?:proxy-)?user`;

/**
 * A line that begins with whitespace and an option (`  -u admin:pw`, `  --header ...`): part of
 * a command wrapped over several lines without continuation characters. A list item
 * (`  - item`) has a space after its dash and is not an option.
 */
const WRAPPED_FLAG_LINE = /[ \t]+--?[A-Za-z0-9#]/y;

/** A line that begins with an option, indented or not: a wrapped command goes on through it. */
const OPTION_LINE = /[ \t]*--?[A-Za-z0-9#]/y;

/**
 * True when the newline at `i` does not end the command: it is escaped (a backslash, or after a
 * space a cmd `^` or a PowerShell backtick), or the next line is an indented option and the line
 * before it is a command, not a sentence: it starts with an HTTP client or is an option line
 * itself.
 */
function joinsNextLine(text: string, i: number): boolean {
  const before = text[i - 1] === '\r' ? i - 2 : i - 1;
  const ch = text[before];
  if (ch === '\\') return true;
  if ((ch === '^' || ch === '`') && (text[before - 1] === ' ' || text[before - 1] === '\t')) {
    return true;
  }
  WRAPPED_FLAG_LINE.lastIndex = i + 1;
  if (!WRAPPED_FLAG_LINE.test(text)) return false;
  const above = text.lastIndexOf('\n', i - 1) + 1;
  OPTION_LINE.lastIndex = above;
  if (OPTION_LINE.test(text)) return true;
  CLIENT_LINE.lastIndex = above;
  return CLIENT_LINE.test(text);
}

function isBlank(code: number): boolean {
  return code === 32 || code === 9 || code === 13 || code === 10 || Number.isNaN(code);
}

/**
 * Splits a line into commands at unquoted `|`, `||`, `&&`, `;` and a standalone `&` (an `&`
 * inside a word, as in `?a=1&b=2`, is part of a URL). Quotes are followed across the joined
 * line, so a quoted value that goes on over an escaped newline stays one argument; an unbalanced
 * quote runs to the end of the line, which keeps more in one command.
 */
function splitCommands(text: string, start: number, end: number): number[] {
  const out: number[] = [];
  let from = start;
  let quote = 0;
  const push = (to: number): void => {
    HTTP_CLIENT.lastIndex = 0;
    const found = HTTP_CLIENT.exec(text.slice(from, to));
    out.push(from, to, found === null ? -1 : from + found.index);
  };
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
      else if (c === 92 && quote === 34) i++;
    } else if (c === 92) {
      i++;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 124 || c === 59) {
      push(i);
      from = i + 1;
    } else if (c === 38) {
      const prev = text.charCodeAt(i - 1);
      const next = text.charCodeAt(i + 1);
      if (next === 38) {
        push(i);
        from = i + 2;
        i++;
      } else if (prev !== 62 && next !== 62 && (isBlank(prev) || isBlank(next))) {
        push(i);
        from = i + 1;
      }
    }
  }
  push(end);
  return out;
}

/**
 * Where an HTTP client is named earlier in the command `pos` is in, or -1. A line is a physical
 * line, joined with the next across an escaped newline or a wrapped option line. Within it, the
 * client must come after the last command separator before `pos`: `curl ... && docker run -u
 * app:staff` leaves docker's user alone, while a client inside `sh -c "..."`, after `#` or in a
 * sentence still counts. Any other program's `-u` (a user, a group, a URL) is never touched.
 */
function httpClientBefore(at: MatchContext, pos: number): number {
  const { text, line } = at;
  if (pos < line.start || pos >= line.end) {
    let start = text.lastIndexOf('\n', pos - 1);
    while (start > 0 && joinsNextLine(text, start)) start = text.lastIndexOf('\n', start - 1);
    let end = text.indexOf('\n', pos);
    while (end !== -1 && joinsNextLine(text, end)) end = text.indexOf('\n', end + 1);
    line.start = start + 1;
    line.end = end === -1 ? text.length : end;
    line.commands = splitCommands(text, line.start, line.end);
  }
  const cmds = line.commands;
  let lo = 0;
  let hi = cmds.length / 3 - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((cmds[mid * 3] ?? 0) <= pos) lo = mid;
    else hi = mid - 1;
  }
  const client = cmds[lo * 3 + 2] ?? -1;
  return client !== -1 && client < pos ? client : -1;
}

/** Where the flag that starts `flagGroup` is. */
function flagStart(flagGroup: string, at: MatchContext): number {
  return at.start + Math.max(0, flagGroup.search(/\S/));
}

/** True when the flag that starts `flagGroup` sits in a command that names an HTTP client. */
function clientBeforeFlag(flagGroup: string, at: MatchContext): boolean {
  return httpClientBefore(at, flagStart(flagGroup, at)) !== -1;
}

/** Programs whose short-flag clusters take a `user@host:/path` target, not credentials. */
const REMOTE_COPY = /(?<![\p{L}\p{N}_-])(?:rsync|scp|sftp|ssh|rclone)(?![\p{L}\p{N}_-])/iu;

/**
 * Skip for the `-u name:value` rules: not in an HTTP client's command, or not a literal secret.
 * A valid curl cluster ending in u is credentials (`curl -su me@example.com:token`), unless an
 * rsync, scp or ssh named after the client owns it: `-avu user@host:/data` is a remote path.
 */
function isNotHttpCredentials(groups: readonly string[], at: MatchContext): boolean {
  const flag = groups[1] ?? '';
  const name = groups[2] ?? '';
  const value = groups[3] ?? '';
  if (value.startsWith('$') || value.startsWith('//')) return true;
  if (value === '' && name.startsWith('$')) return true;
  const pos = flagStart(flag, at);
  const client = httpClientBefore(at, pos);
  if (client === -1) return true;
  const cluster = /^[\s"']?-[^-\s"'=]{2,}/.test(flag);
  if (cluster && (name.includes('@') || value.startsWith('/'))) {
    return REMOTE_COPY.test(at.text.slice(client, pos));
  }
  return false;
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
    // `curl -u "user:a pass phrase"`: a quoted value is taken whole.
    re: new RegExp(
      `((?:^|\\s)(?:${USER_FLAG})(?:\\s{1,5}|=)")([^"\\n:]{0,200}):([^"\\n]{1,400})(?=")`,
      'g',
    ),
    replace: `$1$2:${REDACTED}`,
    skip: isNotHttpCredentials,
  },
  {
    kind: 'cli_credentials',
    re: new RegExp(
      `((?:^|\\s)(?:${USER_FLAG})(?:\\s{1,5}|=)')([^'\\n:]{0,200}):([^'\\n]{1,400})(?=')`,
      'g',
    ),
    replace: `$1$2:${REDACTED}`,
    skip: isNotHttpCredentials,
  },
  {
    kind: 'cli_credentials',
    // `curl -u user:password`, `--user user:password`, `--user=user:password`, `-U` and
    // `--proxy-user`, and a curl cluster ending in u (`-su`). Only in a command that names an
    // HTTP client first. `-u :token` has no user and is redacted all the same.
    re: new RegExp(
      `((?:^|[\\s"'])(?:${USER_FLAG})(?:\\s{1,5}|=)["']?)([^\\s:"'\`]{0,200}):([^\\s"'\`]{1,200})`,
      'g',
    ),
    replace: `$1$2:${REDACTED}`,
    skip: isNotHttpCredentials,
  },
  {
    kind: 'cli_credentials',
    // `curl -u apikey:`: a key given as the user name, with an empty password.
    re: new RegExp(
      `((?:^|[\\s"'])(?:${USER_FLAG})(?:\\s{1,5}|=)["']?)([^\\s:"'\`]{1,200})():(?=$|[\\s"'\`])`,
      'g',
    ),
    replace: `$1${REDACTED}:`,
    skip: isNotHttpCredentials,
  },
  {
    kind: 'cli_credentials',
    // `curl -uuser:password`, with no space after the flag.
    re: /((?:^|\s)-[uU]["']?)([^\s:"'`=-][^\s:"'`]{0,200}):([^\s"'`]{1,200})/g,
    replace: `$1$2:${REDACTED}`,
    skip: isNotHttpCredentials,
  },
  {
    kind: 'cli_credentials',
    // `curl --cert client.pem:password`. A Windows drive letter is part of the file name.
    re: /((?:^|\s)--(?:proxy-)?cert(?:\s{1,5}|=)["']?((?:[A-Za-z]:[\\/])?[^\s:"'`]{1,300}):)([^\s"'`]{1,200})/g,
    replace: `$1${REDACTED}`,
    skip: (g, at) =>
      (g[3] ?? '').startsWith('$') ||
      // `C:\certs\client.pem` with no password: the colon is the drive letter's.
      (/^[A-Za-z]$/.test(g[2] ?? '') && /^[\\/]/.test(g[3] ?? '')) ||
      // `pkcs11:object=key;type=cert` or `file:...` is a URI, not `file:password`.
      /^(?:pkcs11|file)$/i.test(g[2] ?? '') ||
      !clientBeforeFlag(g[1] ?? '', at),
  },
  {
    kind: 'cli_credentials',
    // curl options whose value is a secret: `--tlspassword`, `--oauth2-bearer`, `--pass`.
    re: /((?:^|\s)--(?:proxy-)?(?:tlspassword|oauth2-bearer|pass)(?:\s{1,5}|=)["']?)([^\s"'`]{1,4000})/g,
    replace: `$1${REDACTED}`,
    skip: (g, at) => /^[-$]/.test(g[2] ?? '') || !clientBeforeFlag(g[1] ?? '', at),
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
    const line: LineMemo = { start: 0, end: 0, commands: [] };
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
