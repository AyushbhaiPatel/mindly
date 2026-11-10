/**
 * Credentials given to an HTTP client on a command line: curl's `-u user:password`, httpie's and
 * xh's `-a`, ab's `-A`, lftp's `-u user,password`, bearer tokens and `Authorization` headers.
 *
 * One rule, read in one pass per line, that quoting cannot get wrong because it does not read
 * quoting to find commands:
 *
 * - Lines. Physical lines are joined only across a continuation (`\`, or `^` or a backtick after
 *   a space, at the end of the line) and into indented option lines directly under a line that
 *   names a client. Never across an open quote.
 * - Tokens. On each line, a credential option (`-u`, `--user`, `-a`, `--bearer` and the like)
 *   counts when a client is named earlier on the same line, anywhere, quoted or not
 *   (`sh -c "curl ..."`, JSON, a sentence), so nesting and runners do not matter.
 * - Values. The value is the run after the option (or after its `=`): to the matching quote
 *   when it starts with one, else to the next space or quote. In `name:secret` the secret is
 *   redacted; a bare user name or a `$VARIABLE` is left alone.
 *
 * The cost is one pass over each line and constant work per option, so there are no limits that
 * could skip a credential. The trade-off is documented in docs/security.md: on a line that names
 * a client, another program's `-u x:y` after it has its value redacted too.
 */

/** A program name as a word: not inside a longer name, a variable or a file name. */
const NAME_BEFORE = '(?<![\\p{L}\\p{N}_$\\{.-])';
const NAME_AFTER = '(?:\\.exe)?(?![\\p{L}\\p{N}_])';

/** A variable named after a program: `$CURL`, `${CURL_BIN}`, `$MY_XH`. */
const variable = (names: string): string =>
  `\\$\\{?(?:[A-Za-z0-9]{1,16}_)?(?:${names})(?:_(?!proxy\\b)[A-Za-z0-9]{1,16})?\\}?(?![A-Za-z0-9_])`;

/**
 * HTTP clients: by program name (with or without a directory or `.exe`), or a variable that holds
 * one. Not `$HTTP_PORT`, `$HTTP_PROXY` or `$HTTPBIN`, nor `http://` in a URL or `http.server`.
 */
const CLIENT = new RegExp(
  [
    `${NAME_BEFORE}(?:curl(?:[-_][A-Za-z0-9_-]{1,40}|\\d{1,4})?|wget2?|curlie|aria2c|hurl|httpstat|httpie|ab|lftp)${NAME_AFTER}`,
    `|${NAME_BEFORE}(?:https?|xhs?)(?:\\.exe)?(?![\\p{L}\\p{N}_:/.=-])`,
    `|${variable('curl|wget|curlie|aria2c|lftp|hurl|httpstat|httpie|xh')}`,
    '|\\$\\{?(?:[A-Za-z0-9]{1,16}_)?https?_(?:client|cmd|command|tool|bin)\\}?(?![A-Za-z0-9_])',
    // An assignment that holds curl's options: `CURL_OPTS="--user ..."`.
    '|(?<![\\p{L}\\p{N}_])(?:curl|wget)(?:_[A-Za-z0-9]{1,12})?=',
  ].join(''),
  'iu',
);

/** Clients with credential options of their own: ab, lftp, and httpie or xh. */
const AB = new RegExp(`${NAME_BEFORE}ab${NAME_AFTER}`, 'iu');
const LFTP = new RegExp(`${NAME_BEFORE}lftp${NAME_AFTER}|${variable('lftp')}`, 'iu');
const HTTPIE = new RegExp(
  `${NAME_BEFORE}(?:https?|xhs?|httpie)(?:\\.exe)?(?![\\p{L}\\p{N}_:/.=-])|${variable('httpie|xh')}`,
  'iu',
);

/** curl's short options that take no value, so they can come before `u` in one cluster. */
const CURL_NO_VALUE = '0123456aBfGgIijJkLlMNnOpqRsSvVZ#';

/** httpie's and xh's short options that take no value, so they can come before `a`. */
const HTTPIE_NO_VALUE = 'bcdfhjqvxFIS';

/** curl options whose whole value is a secret. */
const SECRET_OPTIONS = new Set([
  '--bearer',
  '--oauth2-bearer',
  '--pass',
  '--proxy-pass',
  '--tlspassword',
  '--proxy-tlspassword',
]);

/** An `Authorization` header, as a curl `-H` value or an httpie item. */
const AUTH_HEADER = /(?:proxy-)?authorization[ \t]*:[ \t]*/giy;

/** The scheme before the credentials in an `Authorization` header, kept as written. */
const AUTH_SCHEME =
  /(?:bearer|basic|token|digest|negotiate|ntlm|aws4-hmac-sha256)(?:[ \t]+|(?=["'\\\s]|$))/iy;

/** A line that begins with whitespace and an option: part of a command wrapped over lines. */
const INDENTED_OPTION = /[ \t]+--?[A-Za-z0-9#]/y;

/** Characters that may surround a value: quotes, and the backslashes that escape them. */
function isQuoting(c: string): boolean {
  return c === '"' || c === "'" || c === '\\';
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n';
}

/** True when the line break at `i` continues the line: `\`, or ` ^` or a backtick after a space. */
function isContinued(text: string, i: number): boolean {
  const last = text[i - 1] === '\r' ? i - 2 : i - 1;
  const ch = text[last];
  if (ch === '\\') return true;
  return (ch === '^' || ch === '`') && (text[last - 1] === ' ' || text[last - 1] === '\t');
}

/** Where the first client of each kind is named in a line (-1 for none). */
interface Clients {
  any: number;
  ab: number;
  lftp: number;
  httpie: number;
}

function findClients(text: string, from: number, to: number): Clients {
  // Read on the line only, so a line without a client does not read the rest of the text; and
  // one search per kind, so a line full of client names is still read once per kind.
  const line = text.slice(from, to);
  const first = (re: RegExp): number => {
    const m = re.exec(line);
    return m === null ? -1 : from + m.index;
  };
  const any = first(CLIENT);
  if (any === -1) return { any, ab: -1, lftp: -1, httpie: -1 };
  return { any, ab: first(AB), lftp: first(LFTP), httpie: first(HTTPIE) };
}

/** A credential option at the start of a run, and where its value starts. */
interface Option {
  /**
   * The kind of value: `user` for `name:secret`, `secret` for a whole token, `cert` for curl's
   * `file:password`.
   */
  kind: 'user' | 'secret' | 'cert';
  /** httpie's `-a` / `--auth`, whose value is a token when the line asks for bearer auth. */
  auth: boolean;
  /** Where the value starts: right after a glued option or its `=`, or -1 for the next run. */
  glued: number;
  /** A short-option cluster (`-su`), whose `user@host:/path` is rsync's, not credentials. */
  cluster: boolean;
}

/**
 * Reads a run (`start`..`end`) as a credential option, if it is one, given which clients the line
 * names before it. Quotes, backslashes and `(` in front of it are skipped (`"--user` inside a
 * quoted string, `$(curl` ...).
 */
function readOption(text: string, start: number, end: number, before: Clients): Option | null {
  let i = start;
  // `CURL_OPTS="--user ...`: the option inside an assignment's quoted value.
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(text.slice(start, Math.min(end, start + 64)));
  if (assignment !== null) i += assignment[0].length;
  while (i < end && (isQuoting(text[i] ?? '') || text[i] === '(' || text[i] === '`')) i++;
  if (text[i] !== '-') return null;
  const run = text.slice(i, end);
  const long = /^--[a-z0-9-]+/.exec(run)?.[0];
  if (long !== undefined) {
    const attached = run[long.length] === '=' ? i + long.length + 1 : -1;
    if (attached === -1 && long.length !== run.length) return null;
    if (long === '--user' || long === '--proxy-user') {
      return { kind: 'user', auth: false, glued: attached, cluster: false };
    }
    if (long === '--auth' && before.httpie !== -1) {
      return { kind: 'user', auth: true, glued: attached, cluster: false };
    }
    if (SECRET_OPTIONS.has(long)) {
      return { kind: 'secret', auth: false, glued: attached, cluster: false };
    }
    if (long === '--cert' || long === '--proxy-cert') {
      return { kind: 'cert', auth: false, glued: attached, cluster: false };
    }
    return null;
  }
  // A short option, alone, at the end of a cluster, or with its value glued on: `-u`, `-su`,
  // `-uuser:pass`. The letters before it must be options that take no value.
  const letters: { flag: string; noValue: string }[] = [{ flag: 'uU', noValue: CURL_NO_VALUE }];
  if (before.httpie !== -1) letters.push({ flag: 'a', noValue: HTTPIE_NO_VALUE });
  if (before.ab !== -1) letters.push({ flag: 'AP', noValue: '' });
  for (const { flag, noValue } of letters) {
    for (let k = 1; k < run.length; k++) {
      const c = run[k] ?? '';
      if (flag.includes(c)) {
        const rest = i + k + 1;
        return { kind: 'user', auth: c === 'a', glued: rest < end ? rest : -1, cluster: k > 1 };
      }
      if (!noValue.includes(c)) break;
    }
  }
  return null;
}

/**
 * The value that starts at `at`, on the line ending at `lineEnd`: its first and last characters
 * without the quoting around it. A value that starts with a quote runs to the matching quote on
 * the same line; any other runs to the next space or quote. `(`, `)`, `;` and `|` stay in it.
 */
function readValue(text: string, at: number, lineEnd: number): { from: number; to: number } {
  let from = at;
  let quote = '';
  while (from < lineEnd && isQuoting(text[from] ?? '')) {
    if (text[from] !== '\\') quote = text[from] ?? '';
    from++;
  }
  let to = from;
  if (quote !== '') {
    while (to < lineEnd && text[to] !== quote) to++;
    // No closing quote on the line: the value is the run, as if it were not quoted.
    if (to >= lineEnd) {
      to = from;
      while (to < lineEnd && !isSpace(text[to] ?? '') && !isQuoting(text[to] ?? '')) to++;
    }
  } else {
    while (to < lineEnd && !isSpace(text[to] ?? '')) {
      const c = text[to] ?? '';
      if (c === '"' || c === "'") {
        // A quote right after the separator quotes the secret: `admin:"secret"`. Any other
        // closes quoting around the command (`{"command":"curl -u a:b"}`) and ends the value.
        const prev = text[to - 1];
        const close = prev === ':' || prev === ',' ? closingQuote(text, to, lineEnd) : -1;
        if (close === -1) break;
        to = close + 1;
        break;
      }
      // A backslash that escapes a quote belongs to the quoting around the value.
      if (c === '\\' && (text[to + 1] === '"' || text[to + 1] === "'")) break;
      // A backtick closes Markdown code or a substitution around the command.
      if (c === '`') break;
      to++;
    }
  }
  while (to > from && isQuoting(text[to - 1] ?? '')) to--;
  return { from, to };
}

/** Where the quote at `at` closes on the same line, or -1. */
function closingQuote(text: string, at: number, lineEnd: number): number {
  const q = text[at];
  for (let k = at + 1; k < lineEnd; k++) if (text[k] === q) return k;
  return -1;
}

/** Collects the parts of a text to redact. */
class Finder {
  readonly edits: { from: number; to: number }[] = [];

  constructor(
    private readonly text: string,
    private readonly marker: string,
  ) {}

  private push(from: number, to: number): void {
    // Quotes and backslashes at the ends belong to the quoting around a secret.
    while (from < to && isQuoting(this.text[from] ?? '')) from++;
    while (to > from && isQuoting(this.text[to - 1] ?? '')) to--;
    if (to <= from) return;
    const value = this.text.slice(from, to);
    if (value.startsWith('$')) return;
    // A value that is nothing but an earlier redaction is left as it is.
    const rest = value.includes(this.marker) ? value.split(this.marker).join('') : value;
    if (!/[A-Za-z0-9]/.test(rest)) return;
    this.edits.push({ from, to });
  }

  /** `name:secret` (or `name,secret` for lftp): the secret, or the name when it is empty. */
  private user(from: number, to: number, sep: string, cluster: boolean, token: boolean): void {
    const value = this.text.slice(from, to);
    const at = value.indexOf(sep);
    if (at === -1) {
      if (token) this.push(from, to);
      return;
    }
    const name = value.slice(0, at);
    const secret = value.slice(at + 1);
    if (secret.startsWith('//')) return;
    // `rsync -avu user@host:/path` after a client on the same line is a path, not credentials.
    if (cluster && name.includes('@') && secret.startsWith('/')) return;
    if (secret === '') {
      if (name !== '' && !name.startsWith('$')) this.push(from, from + at);
      return;
    }
    this.push(from + at + 1, to);
  }

  /** `--cert file:password`. A Windows drive letter or a `pkcs11:` / `file:` URI is no password. */
  private cert(from: number, to: number): void {
    const value = this.text.slice(from, to);
    const at = value.indexOf(':', /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0);
    if (at <= 0 || /^(?:pkcs11|file)$/i.test(value.slice(0, at))) return;
    this.push(from + at + 1, to);
  }

  /** An `Authorization` header item from `at`: the scheme is kept, the rest of its run redacted. */
  private header(at: number, lineEnd: number): void {
    let from = at;
    let quote = '';
    while (from < lineEnd && isQuoting(this.text[from] ?? '')) {
      if (this.text[from] !== '\\') quote = this.text[from] ?? '';
      from++;
    }
    AUTH_SCHEME.lastIndex = from;
    const scheme = AUTH_SCHEME.exec(this.text);
    if (scheme !== null) from += scheme[0].length;
    let to = from;
    while (to < lineEnd && !isQuoting(this.text[to] ?? '')) {
      if (quote === '' && isSpace(this.text[to] ?? '')) break;
      if (this.text[to] === '`') break;
      to++;
    }
    this.push(from, to);
  }

  /** Reads one logical line, `start`..`end`. */
  line(start: number, end: number): void {
    const text = this.text;
    const clients = findClients(text, start, end);
    if (clients.any === -1) return;
    // httpie's `-A bearer` (or jwt) makes a value of `-a` without a colon a token.
    const bearer = /(?:^|\s)(?:-A|--auth-type)[\s=]*["']?(?:bearer|jwt)\b/i.test(
      text.slice(start, end),
    );
    let i = clients.any;
    while (i < end) {
      while (i < end && isSpace(text[i] ?? '')) i++;
      const runStart = i;
      while (i < end && !isSpace(text[i] ?? '')) i++;
      const runEnd = i;
      if (runEnd === runStart) break;
      // Authorization headers anywhere in the run: `-H "Authorization: Bearer x"`, httpie items.
      for (let k = runStart; k < runEnd; k++) {
        const c = text[k];
        if (c !== 'a' && c !== 'A' && c !== 'p' && c !== 'P') continue;
        AUTH_HEADER.lastIndex = k;
        const header = AUTH_HEADER.exec(text);
        if (header === null) continue;
        const glued = k >= runStart + 2 && text[k - 2] === '-' && text[k - 1] === 'H';
        if (!glued && k > runStart && /[\p{L}\p{N}_-]/u.test(text[k - 1] ?? '')) continue;
        this.header(k + header[0].length, end);
        break;
      }
      const option = readOption(text, runStart, runEnd, {
        any: clients.any,
        ab: clients.ab !== -1 && clients.ab < runStart ? clients.ab : -1,
        lftp: clients.lftp !== -1 && clients.lftp < runStart ? clients.lftp : -1,
        httpie: clients.httpie !== -1 && clients.httpie < runStart ? clients.httpie : -1,
      });
      if (option === null) continue;
      let valueAt = option.glued;
      if (valueAt === -1) {
        let k = runEnd;
        while (k < end && isSpace(text[k] ?? '')) k++;
        if (k >= end) break;
        valueAt = k;
      }
      const { from, to } = readValue(text, valueAt, end);
      if (option.kind === 'secret') {
        if (text[from] !== '-') this.push(from, to);
      } else if (option.kind === 'cert') {
        this.cert(from, to);
      } else if (text[from] !== '-') {
        const sep = clients.lftp !== -1 && clients.lftp < runStart ? ',' : ':';
        this.user(from, to, sep, option.cluster, bearer && option.auth);
      }
      // Reading goes on after the value, whose run may hold spaces when it was quoted.
      if (option.glued === -1) i = Math.max(i, to);
    }
  }

  /** Reads every logical line of the text. */
  all(): void {
    const text = this.text;
    let start = 0;
    let lineStart = 0;
    let previousNamesClient = false;
    let previousJoined = false;
    for (;;) {
      const newline = text.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? text.length : newline;
      const namesClient = findClients(text, lineStart, lineEnd).any !== -1;
      if (newline === -1) {
        this.line(start, text.length);
        break;
      }
      // The next physical line joins this logical line across a continuation, or as an indented
      // option directly under a line that names a client (or under such an option line).
      INDENTED_OPTION.lastIndex = newline + 1;
      const indented = INDENTED_OPTION.test(text);
      const joins =
        isContinued(text, newline) ||
        (indented && (namesClient || (previousJoined && previousNamesClient)));
      if (joins) {
        previousNamesClient = previousNamesClient || namesClient;
        previousJoined = true;
        lineStart = newline + 1;
        continue;
      }
      this.line(start, lineEnd);
      start = lineStart = newline + 1;
      previousNamesClient = false;
      previousJoined = false;
    }
  }
}

/**
 * Redacts the credentials HTTP clients are given on command lines in `text`, replacing each with
 * `marker`. Returns the new text and how many credentials were replaced.
 */
export function redactCommandCredentials(
  text: string,
  marker: string,
): { text: string; count: number } {
  const finder = new Finder(text, marker);
  finder.all();
  if (finder.edits.length === 0) return { text, count: 0 };
  // Edits come in order of the text; a header and an option in one run may not.
  const edits = finder.edits;
  if (edits.some((e, k) => k > 0 && e.from < (edits[k - 1]?.from ?? 0))) {
    edits.sort((a, b) => a.from - b.from || b.to - a.to);
  }
  const parts: string[] = [];
  let at = 0;
  let open = false;
  for (const edit of edits) {
    if (open && edit.from <= at) {
      if (edit.to > at) at = edit.to;
      continue;
    }
    if (open) parts.push(marker);
    parts.push(text.slice(at, edit.from));
    open = true;
    at = edit.to;
  }
  if (open) parts.push(marker);
  parts.push(text.slice(at));
  return { text: parts.join(''), count: (parts.length - 1) / 2 };
}
