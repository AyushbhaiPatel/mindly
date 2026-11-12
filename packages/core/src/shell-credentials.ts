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
const AUTH_HEADER = /(?:proxy-)?authorization["']?[ \t]*:[ \t]*/giy;

/** The scheme before the credentials in an `Authorization` header, kept as written. */
const AUTH_SCHEME =
  /(bearer|basic|token|apikey|api-key|digest|negotiate|ntlm|aws4-[a-z0-9-]+|hoba|mutual|vapid)(?:[ \t]+|\\[ \t]|(?=[ \t]*["']?[\\^`]\r?\n))/iy;

/**
 * Schemes whose credentials are `name=value` parameters: Digest, and AWS Signature Version 4 in
 * any of its forms (`AWS4-HMAC-SHA256`, SigV4a's `AWS4-ECDSA-P256-SHA256`).
 */
const PARAM_SCHEME = /^(?:digest|aws4-[a-z0-9-]+)$/i;

/**
 * A `Digest` or `AWS4-...` `Authorization` header (or JSON key), whose credentials are
 * `name=value` parameters. The scheme may be on the next physical line of the logical line, after
 * a continuation (`-H "Authorization: \` and then `Digest ...`).
 */
const PARAM_HEADER =
  /authorization["']?[ \t]*[:=][ \t\r\n"'\\^`]*(?:digest|aws4-[a-z0-9-]+)(?![A-Za-z0-9-])/i;

/**
 * The name of a parameter whose value is a secret or proves one, and its `=`: read anywhere on a
 * line that holds a `PARAM_HEADER` (the rest, `username` or `uri`, are kept).
 */
const SECRET_PARAM =
  /(?<![A-Za-z0-9_-])(?:response|cnonce|nonce|opaque|signature|password)[ \t]*=/gi;

/**
 * A Digest or AWS Signature parameter at the start of a header value (`username=`, `Credential=`):
 * the value is parameters, read by `params`. Any other value is one token, as for `Basic`.
 */
const PARAM_NAMES =
  'username|realm|nonce|uri|response|algorithm|cnonce|opaque|qop|nc|userhash|credential|signedheaders|signature|password';
const PARAM_START = new RegExp(`^(?:${PARAM_NAMES})[ \\t]*=`, 'i');

/** One of those parameters where a value would start, after spaces: then that value is empty. */
const PARAM_NAME = new RegExp(`(?:${PARAM_NAMES})[ \\t]*=`, 'iy');

/** A credential after a scheme is one token of at least this many characters, no spaces. */
const MIN_SCHEME_TOKEN = 8;

/** Without a scheme, a credential is one token of at least this many characters. */
const MIN_BARE_TOKEN = 16;

/**
 * An option written as its own quoted argument and the quoted argument after it, as in argv
 * arrays and JSON: `["curl", "-u", "admin:pw", url]`, `{"args":["--user","admin:pw"]}`.
 */
const QUOTED_OPTION = /(["'])(--?[A-Za-z][A-Za-z0-9-]{0,30})\1[\s,]*(["'])((?:(?!\3)[^\n])*)\3/g;

/** File names that `-E` (curl's short `--cert`) takes: `client.pem:password`. */
const CERT_FILE = /\.(?:pem|crt|cer|der|p12|pfx|key)$/i;

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

/** Every client named in a line, in order, and whether it is lftp. Read only when needed. */
function clientsInLine(text: string, from: number, to: number): { at: number; lftp: boolean }[] {
  const out: { at: number; lftp: boolean }[] = [];
  const re = new RegExp(CLIENT.source, 'giu');
  const line = text.slice(from, to);
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    out.push({ at: from + m.index, lftp: /lftp/i.test(m[0]) });
  }
  return out;
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
  /** curl's `-E`, which only counts for a certificate file (`client.pem:password`). */
  short?: boolean;
}

/** An option written as its own argument (`"-u"`, `'--user'`), by name. */
function optionByName(name: string, before: Clients): Option | null {
  const plain = { auth: false, glued: -1, cluster: false };
  if (name === '-u' || name === '-U' || name === '--user' || name === '--proxy-user') {
    return { kind: 'user', ...plain };
  }
  if ((name === '-a' || name === '--auth') && before.httpie !== -1) {
    return { kind: 'user', ...plain, auth: true };
  }
  if ((name === '-A' || name === '-P') && before.ab !== -1) return { kind: 'user', ...plain };
  if (name === '--cert' || name === '--proxy-cert') return { kind: 'cert', ...plain };
  if (name === '-E') return { kind: 'cert', ...plain, short: true };
  if (SECRET_OPTIONS.has(name)) return { kind: 'secret', ...plain };
  return null;
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
  if (text[i] !== '-') {
    // `{"args":"-u admin:pw"}`: an option that opens a quoted string inside the run.
    const inner = /["'([`]-/.exec(text.slice(i, end));
    if (inner === null) return null;
    i += inner.index + 1;
  }
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
  const letters: { flag: string; noValue: string; kind: Option['kind'] }[] = [
    { flag: 'uU', noValue: CURL_NO_VALUE, kind: 'user' },
    { flag: 'E', noValue: CURL_NO_VALUE, kind: 'cert' },
  ];
  if (before.httpie !== -1) letters.push({ flag: 'a', noValue: HTTPIE_NO_VALUE, kind: 'user' });
  if (before.ab !== -1) letters.push({ flag: 'AP', noValue: '', kind: 'user' });
  for (const { flag, noValue, kind } of letters) {
    for (let k = 1; k < run.length; k++) {
      const c = run[k] ?? '';
      if (flag.includes(c)) {
        const rest = i + k + 1;
        const glued = rest < end ? rest : -1;
        return { kind, auth: c === 'a', glued, cluster: k > 1, short: c === 'E' };
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
      // A backtick before a space, punctuation or the end closes Markdown code around the
      // command; one inside a word is PowerShell's escape (`P@ss`$w0rd`) and part of the value.
      if (c === '`' && !/[A-Za-z0-9$`#@{]/.test(text[to + 1] ?? '')) break;
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

  /**
   * `name:secret` (lftp also takes `name,secret`): the secret, or the name when it is empty.
   * `seps` holds the separators the option's client takes.
   */
  private user(from: number, to: number, seps: string, cluster: boolean, token: boolean): void {
    const value = this.text.slice(from, to);
    let at = -1;
    for (let k = 0; k < value.length && at === -1; k++) if (seps.includes(value[k] ?? '')) at = k;
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
  private cert(from: number, to: number, short = false): void {
    const value = this.text.slice(from, to);
    const at = value.indexOf(':', /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0);
    if (at <= 0 || /^(?:pkcs11|file)$/i.test(value.slice(0, at))) return;
    // `-E` is also grep's and sed's: only a certificate file before the colon makes it curl's.
    if (short && !CERT_FILE.test(value.slice(0, at))) return;
    this.push(from + at + 1, to);
  }

  /**
   * An `Authorization` header from `at`, just after its colon, when its value looks like a
   * credential: a scheme and a token of at least 8 characters, or a single token of at least 16.
   * The scheme is kept. A word in a sentence (`the Authorization: header`), or a quote that
   * closes before any value (`headers['Authorization: ']`), is not a credential. `open` is the
   * quote the header name is inside (`"Authorization: ...`), or '' when it is in none.
   *
   * Returns where the value read ends, so the search for the next header in the run goes on
   * from there.
   */
  private header(at: number, lineEnd: number, open: string): number {
    const text = this.text;
    const quote = { open };
    let from = this.gap(at, lineEnd, quote);
    // A quote right at the colon closes the string the header name was in: no value follows.
    if (from > at && (text[from] === ']' || text[from] === ',' || text[from] === ')')) return from;
    AUTH_SCHEME.lastIndex = from;
    const scheme = AUTH_SCHEME.exec(text);
    if (scheme !== null) from = this.gap(from + scheme[0].length, lineEnd, quote);
    let to = from;
    while (to < lineEnd) {
      const c = text[to] ?? '';
      if (isSpace(c) || c === '"' || c === "'" || c === '\\' || c === '`') break;
      to++;
    }
    if (to - from < (scheme !== null ? MIN_SCHEME_TOKEN : MIN_BARE_TOKEN)) return to;
    // Digest and AWS Signature parameters (`username="u"`) are read by `params`, on the line; a
    // single token after those schemes (`Digest dXNlcm5h...==`) is redacted as one.
    const params = PARAM_SCHEME.test(scheme?.[1] ?? '');
    if (!(params && PARAM_START.test(text.slice(from, to)))) this.push(from, to);
    return to;
  }

  /**
   * From `at`, inside a header value: past the quotes around it, read as a shell reads them
   * (`quote.open` is the quote open at `at`, and is kept up to date), and past a line
   * continuation (`\`, `^` or a backtick at the end of a physical line) that stays inside the
   * value: one inside an open quote (`-H "Authorization: \` and then `Bearer ...`), or one glued
   * to the value (`"Bearer "\` and then `"<token>"`). After a closing quote, a space ends the
   * value (`-H "Authorization:" \` removes the header; the next line is another argument). A
   * backslash-escaped space outside quotes is part of the value (`Authorization:\ Bearer\ ...`).
   */
  private gap(at: number, lineEnd: number, quote: { open: string }): number {
    const text = this.text;
    const toggle = (q: string): void => {
      if (quote.open === '') quote.open = q;
      else if (quote.open === q) quote.open = '';
    };
    let k = at;
    while (k < lineEnd) {
      const c = text[k] ?? '';
      const d = text[k + 1] ?? '';
      const newline = d === '\r' ? k + 2 : k + 1;
      if ((c === '\\' || c === '^' || c === '`') && text[newline] === '\n') {
        const glued = k > at || (k > 0 && !isSpace(text[k - 1] ?? ''));
        if (quote.open === '' && !glued) break;
        k = newline + 1;
        if (quote.open !== '') while (k < lineEnd && (text[k] === ' ' || text[k] === '\t')) k++;
      } else if (c === '\\' && (d === '"' || d === "'")) {
        toggle(d);
        k += 2;
      } else if (c === '"' || c === "'") {
        toggle(c);
        k++;
      } else if (c === '\\' && (d === ' ' || d === '\t') && quote.open === '') {
        k += 2;
      } else if ((c === ' ' || c === '\t') && quote.open !== '') {
        k++;
      } else {
        break;
      }
    }
    return k;
  }

  /**
   * On a line (`start`..`end`) that holds a Digest or AWS Signature header, the value of every
   * parameter named in `SECRET_PARAM`, wherever it is on the line: the same name elsewhere on the
   * line is redacted too, which garbles that value and nothing else. A value in quotes (`"..."`,
   * `\"...\"`) runs to the next same quote on the line, or to the end of the line when it never
   * closes; any other runs to a space, comma, quote or backslash. Spaces may stand on either side
   * of the `=` (`response = abc`), but a parameter after them is no value: in
   * `nonce= response="..."` the value of `nonce` is empty, and `response` is read as its own.
   *
   * Names are looked for again just inside a quoted value (`username="John, response="..."`),
   * which costs nothing more: a quoted value ends at the next same quote, so the values of one
   * kind of quote do not overlap, and the line is read once per kind.
   */
  private params(start: number, end: number): void {
    const text = this.text;
    const line = text.slice(start, end);
    SECRET_PARAM.lastIndex = 0;
    for (let m = SECRET_PARAM.exec(line); m !== null; m = SECRET_PARAM.exec(line)) {
      const value = start + m.index + m[0].length;
      let open = value;
      while (open < end && (text[open] === ' ' || text[open] === '\t')) open++;
      const spaced = open > value;
      while (open < end && text[open] === '\\') open++;
      const q = text[open];
      if (q === '"' || q === "'") {
        let close = open + 1;
        while (close < end && text[close] !== q) close++;
        let to = close;
        while (to > open + 1 && text[to - 1] === '\\') to--;
        this.push(open + 1, to);
        SECRET_PARAM.lastIndex = open + 1 - start;
        continue;
      }
      PARAM_NAME.lastIndex = open;
      if (spaced && PARAM_NAME.test(text)) continue;
      let to = open;
      while (to < end) {
        const c = text[to] ?? '';
        if (isSpace(c) || c === ',' || isQuoting(c)) break;
        to++;
      }
      this.push(open, to);
      SECRET_PARAM.lastIndex = Math.max(SECRET_PARAM.lastIndex, to - start);
    }
  }

  /** Reads the value of an option at `runStart` whose value is `from`..`to`. */
  private option(option: Option, from: number, to: number, seps: string, bearer: boolean): void {
    if (option.kind === 'secret') {
      if (this.text[from] !== '-') this.push(from, to);
    } else if (option.kind === 'cert') {
      this.cert(from, to, option.short === true);
    } else if (this.text[from] !== '-') {
      this.user(from, to, seps, option.cluster, bearer && option.auth);
    }
  }

  /** Reads one logical line, `start`..`end`. */
  line(start: number, end: number): void {
    const text = this.text;
    const clients = findClients(text, start, end);
    if (clients.any === -1) return;
    const lineText = text.slice(start, end);
    // httpie's `-A bearer` (or jwt) makes a value of `-a` without a colon a token.
    const bearer = /(?:^|\s)(?:-A|--auth-type)[\s=]*["']?(?:bearer|jwt)\b/i.test(lineText);
    // A line that is a JSON object may name its client after the options: `{"args":..,"tool":"curl"}`.
    const json = /^\s*\{/.test(lineText) && /\}\s*$/.test(lineText);
    if (PARAM_HEADER.test(lineText)) this.params(start, end);
    const before = (at: number, client: number): number =>
      client !== -1 && (json || client < at) ? client : -1;
    // lftp takes `name,password` as well as `name:password`, as the client nearest before the
    // option decides; every other client takes only `name:password`.
    const named = clients.lftp === -1 ? [] : clientsInLine(text, start, end);
    let nearest = -1;
    const separators = (at: number): string => {
      if (named.length === 0) return ':';
      while (nearest + 1 < named.length && (named[nearest + 1]?.at ?? end) < at) nearest++;
      const client = named[nearest] ?? (json ? named[0] : undefined);
      return client?.lftp === true ? ',:' : ':';
    };
    const gate = (at: number): Clients => ({
      any: clients.any,
      ab: before(at, clients.ab),
      lftp: before(at, clients.lftp),
      httpie: before(at, clients.httpie),
    });

    let i = json ? start : clients.any;
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
        // Every header in the run is read, each from where the one before it ends: one with no
        // credential (`"Authorization":"$TOKEN"`) does not hide a real one after it.
        const keyClosed = /["']\s*:/.test(header[0]);
        const before = text[k - 1] ?? '';
        const open = !keyClosed && (before === '"' || before === "'") ? before : '';
        const resume = this.header(k + header[0].length, end, open);
        k = Math.max(k + header[0].length, resume) - 1;
      }
      const option = readOption(text, runStart, runEnd, gate(runStart));
      if (option === null) continue;
      let valueAt = option.glued;
      if (valueAt === -1) {
        let k = runEnd;
        while (k < end && isSpace(text[k] ?? '')) k++;
        if (k >= end) break;
        valueAt = k;
      }
      const { from, to } = readValue(text, valueAt, end);
      this.option(option, from, to, separators(runStart), bearer);
      // Reading goes on after the value, whose run may hold spaces when it was quoted.
      if (option.glued === -1) i = Math.max(i, to);
    }

    // Options written as their own quoted argument, as in argv arrays and JSON.
    const from = json ? start : clients.any;
    QUOTED_OPTION.lastIndex = 0;
    const tail = text.slice(from, end);
    nearest = -1;
    for (let m = QUOTED_OPTION.exec(tail); m !== null; m = QUOTED_OPTION.exec(tail)) {
      const at = from + m.index;
      const option = optionByName(m[2] ?? '', gate(at));
      if (option === null) continue;
      const valueEnd = at + m[0].length - 1;
      const valueStart = valueEnd - (m[4] ?? '').length;
      this.option(option, valueStart, valueEnd, separators(at), bearer);
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
 * `marker`. Returns the new text, how many credentials were replaced, and where in `text` each
 * replacement was made (in order, not overlapping).
 */
export function redactCommandCredentials(
  text: string,
  marker: string,
): { text: string; count: number; edits: { at: number; len: number }[] } {
  const finder = new Finder(text, marker);
  finder.all();
  if (finder.edits.length === 0) return { text, count: 0, edits: [] };
  // Edits come in order of the text; a header and an option in one run may not.
  const edits = finder.edits;
  if (edits.some((e, k) => k > 0 && e.from < (edits[k - 1]?.from ?? 0))) {
    edits.sort((a, b) => a.from - b.from || b.to - a.to);
  }
  const parts: string[] = [];
  const made: { at: number; len: number }[] = [];
  let at = 0;
  let from = 0;
  let open = false;
  for (const edit of edits) {
    if (open && edit.from <= at) {
      if (edit.to > at) at = edit.to;
      continue;
    }
    if (open) {
      parts.push(marker);
      made.push({ at: from, len: at - from });
    }
    parts.push(text.slice(at, edit.from));
    open = true;
    from = edit.from;
    at = edit.to;
  }
  if (open) {
    parts.push(marker);
    made.push({ at: from, len: at - from });
  }
  parts.push(text.slice(at));
  return { text: parts.join(''), count: made.length, edits: made };
}
