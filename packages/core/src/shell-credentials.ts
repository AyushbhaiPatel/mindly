/**
 * Credentials passed to an HTTP client on a command line: curl's `-u user:password` and its
 * other secret options, httpie's and xh's `-a` / `--auth` and `--bearer`, and `Authorization`
 * headers. These are only credentials for those programs: `-u` is a user or a group for docker,
 * sudo or chown, and a stored command has to stay runnable, so the text is read as shell
 * commands first.
 *
 * The text is read once, from left to right. Physical lines are joined into logical lines across
 * escaped newlines and into indented option lines; each logical line is split into commands at
 * unquoted separators, and each command into shell words with their quotes removed. A quoted
 * argument is read again as commands of its own (`sh -c "curl ..."`, `ssh host "curl ..."`), at
 * most two levels deep. Everything is linear in the length of the text.
 */

/** HTTP clients by program name, besides curl, wget and ab. */
const CLIENT_NAMES = 'curlie|aria2c|lftp|hurl|httpstat|httpie';

/**
 * An HTTP client, for which `-u name:value` means credentials. Named as a word after any
 * non-word character, with or without a directory or `.exe` (`!curl`, `C:\me>curl`,
 * `/usr/bin/curl`, `CURL.EXE`), including builds such as `curl_chrome116` or
 * `curl-impersonate`; or a variable that holds one. A variable counts when its name is a client
 * name, alone or with an affix (`$CURL`, `${CURL_BIN}`, `$CURL_IMPERSONATE`, `$MY_WGET`), or
 * names an HTTP client or command (`$HTTP_CLIENT`, `$HTTP_BIN`), never a setting or address that
 * only mentions one (`$HTTP_PORT`, `$HTTP_PROXY`, `$HTTPBIN`); an assignment counts when its name
 * starts with one (`CURL_OPTS="..."`, not `use_curl=1`). A client behind a shell function or
 * alias defined elsewhere is not recognised.
 */
const CURL_CLIENT = new RegExp(
  [
    '(?<![\\p{L}\\p{N}_])(?:',
    // A program name; after `$` or `${` it is a variable, judged by the next alternative.
    `(?<![$\\{])(?:curl(?:[-_][A-Za-z0-9_-]{1,40}|\\d{1,4})?|wget2?|ab|${CLIENT_NAMES})`,
    '(?:\\.exe)?(?![\\p{L}\\p{N}_])',
    `|\\$\\{?(?:[A-Za-z0-9]{1,16}_)?(?:curl|wget|${CLIENT_NAMES})(?:_(?!proxy\\b)[A-Za-z0-9]{1,16})?\\}?(?![A-Za-z0-9_])`,
    '|\\$\\{?(?:[A-Za-z0-9]{1,16}_)?https?_(?:client|cmd|command|tool|bin)\\}?(?![A-Za-z0-9_])',
    '|(?:curl|wget)(?:_[A-Za-z0-9]{1,12})?=',
    ')',
  ].join(''),
  'iu',
);

/**
 * httpie and xh, whose `-a` / `--auth` takes `user:password` the way curl's `-u` does. `http` in
 * a URL (`http://`) or a module name (`http.server`) is not the program.
 */
const HTTPIE_CLIENT =
  /(?<![\p{L}\p{N}_${.-])(?:https?|xhs?)(?:\.exe)?(?![\p{L}\p{N}_:/.-])|\$\{?(?:[A-Za-z0-9]{1,16}_)?(?:httpie|xh)(?:_[A-Za-z0-9]{1,16})?\}?(?![A-Za-z0-9_])/iu;

/** The kinds of client: curl and the like, and httpie and xh. */
const CURL = 0;
const HTTPIE = 1;
type ClientKind = typeof CURL | typeof HTTPIE;
const CLIENTS: readonly RegExp[] = [CURL_CLIENT, HTTPIE_CLIENT];

/** A substring every client name contains; text without one holds no client's credentials. */
const CLIENT_HINT = /curl|wget|ab|aria2c|lftp|hurl|http|xh/i;

/**
 * Commands that run another command, with the short options (letters) and long options of each
 * that take a value as the next word (`sudo -u deploy`, `timeout -s KILL`).
 */
const RUNNERS = new Map<string, { short: string; long: readonly string[] }>([
  [
    'sudo',
    {
      short: 'ugCDhprtU',
      long: ['user', 'group', 'chroot', 'chdir', 'close-from', 'host', 'prompt', 'role', 'type'],
    },
  ],
  ['doas', { short: 'uC', long: [] }],
  ['timeout', { short: 'sk', long: ['signal', 'kill-after'] }],
  ['env', { short: 'uCS', long: ['unset', 'chdir', 'split-string'] }],
  ['nice', { short: 'n', long: ['adjustment'] }],
  ['ionice', { short: 'cnp', long: ['class', 'classdata', 'pid'] }],
  ['stdbuf', { short: 'ioe', long: ['input', 'output', 'error'] }],
  ['time', { short: 'fo', long: ['format', 'output'] }],
  ['exec', { short: 'a', long: [] }],
  ['nohup', { short: '', long: [] }],
  ['command', { short: '', long: [] }],
  ['caffeinate', { short: '', long: [] }],
  ['chronic', { short: '', long: [] }],
]);

/** Programs whose short-flag clusters take a `user@host:/path` target, not credentials. */
const REMOTE_COPY = /^(?:(?:\/|\.{1,2}\/|~\/)[\w./-]{0,200}\/)?(?:rsync|scp|sftp|ssh|rclone)$/i;

/** curl's short options that take no value, so they can come before `u` in one cluster. */
const CURL_NO_VALUE = new Set('0123456aBfGgIijJkLlMNnOpqRsSvVZ#');

/** httpie's and xh's short options that take no value, so they can come before `a`. */
const HTTPIE_NO_VALUE = new Set('bcdfhjqvxFIS');

/** curl options whose whole value is a secret. */
const CURL_SECRET_OPTIONS = new Set([
  '--pass',
  '--proxy-pass',
  '--tlspassword',
  '--proxy-tlspassword',
  '--oauth2-bearer',
]);

/** An `Authorization` header (`Authorization: Bearer x`, httpie's `Authorization:token`). */
const AUTH_HEADER = /^(?:proxy-)?authorization[ \t]*:[ \t]*/i;

/** The scheme before the credentials in an `Authorization` header, kept as written. */
const AUTH_SCHEME = /^(?:bearer|basic|token|digest|negotiate|ntlm|aws4-hmac-sha256)[ \t]+/i;

/** A line that begins with whitespace and an option: part of a command wrapped over lines. */
const WRAPPED_OPTION_LINE = /[ \t]+--?[A-Za-z0-9#]/y;

/** A line that begins with an option, indented or not. */
const OPTION_LINE = /[ \t]*--?[A-Za-z0-9#]/y;

/** Characters of a word with no special meaning outside quotes, read in one piece. */
const PLAIN_RUN = /[^\s;|&'"\\^`]+/y;

/** Characters inside double quotes with no special meaning, read in one piece. */
const QUOTED_RUN = /[^"\\]+/y;

/** How deep quoted arguments are read again as commands (`sh -c "ssh h \"curl ...\""`). */
const MAX_DEPTH = 2;

/** How much of a line is read to tell whether it runs a client. */
const MAX_LINE_CHARS = 4000;

/** A string being read, and the offset in the original text of each of its characters. */
interface Source {
  s: string;
  at: (i: number) => number;
}

/** A shell word: where it starts in its source, where its reading may go up to, and its value. */
interface Word {
  start: number;
  limit: number;
  value: string;
  /** Where the first quoted part of `value` starts, or -1 for a word without quotes. */
  quoted: number;
  /** Where the word ends in its source. */
  end: number;
}

interface Edit {
  from: number;
  to: number;
}

function isBlank(code: number): boolean {
  return code === 32 || code === 9 || code === 13 || code === 10 || Number.isNaN(code);
}

/** True for an `&` that ends a command: `a & b`, `a &`, but not `?a=1&b=2`, `2>&1` or `&>`. */
function isStandaloneAmp(s: string, i: number): boolean {
  const prev = s.charCodeAt(i - 1);
  const next = s.charCodeAt(i + 1);
  return prev !== 62 && next !== 62 && (isBlank(prev) || isBlank(next));
}

/** True when a continuation character at `i` (a cmd `^` or a PowerShell backtick) ends a line. */
function isWindowsContinuation(s: string, i: number): boolean {
  const ch = s[i];
  if (ch !== '^' && ch !== '`') return false;
  if (!isBlank(s.charCodeAt(i - 1))) return false;
  return s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n');
}

/**
 * Reads one shell word starting at `start`, going no further than `limit`. Single quotes keep
 * everything; double quotes let a backslash escape `"`, `\`, `$` and a backtick; outside quotes a
 * backslash escapes a space, a quote, a backslash or a newline only, so a Windows path keeps its
 * backslashes. An unbalanced quote runs to `limit`. When `map` is given, it receives the source
 * offset of every character of the value.
 */
function readWord(s: string, start: number, limit: number, map?: number[]): Word {
  // Most words have no quotes or escapes: one slice, and nothing else to allocate.
  PLAIN_RUN.lastIndex = start;
  if (map === undefined && PLAIN_RUN.test(s)) {
    const end = Math.min(PLAIN_RUN.lastIndex, limit);
    const c = s.charCodeAt(end);
    if (end === limit || c === 32 || c === 9 || c === 13 || c === 10 || c === 59 || c === 124) {
      return { start, limit, value: s.slice(start, end), quoted: -1, end };
    }
  }
  let value = '';
  let quoted = -1;
  let j = start;
  const add = (k: number): void => {
    value += s[k] ?? '';
    map?.push(k);
  };
  // Adds the plain characters from `from` up to `to` in one piece.
  const addRun = (from: number, to: number): void => {
    value += s.slice(from, to);
    if (map !== undefined) for (let k = from; k < to; k++) map.push(k);
  };
  while (j < limit) {
    PLAIN_RUN.lastIndex = j;
    if (PLAIN_RUN.test(s)) {
      const to = Math.min(PLAIN_RUN.lastIndex, limit);
      addRun(j, to);
      j = to;
      continue;
    }
    const c = s[j] ?? '';
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ';' || c === '|') break;
    if (c === '&' && (s[j + 1] === '&' || isStandaloneAmp(s, j))) break;
    if (c === "'") {
      if (quoted === -1) quoted = value.length;
      const close = s.indexOf("'", j + 1);
      const to = close === -1 || close > limit ? limit : close;
      addRun(j + 1, to);
      j = to + 1;
    } else if (c === '"') {
      if (quoted === -1) quoted = value.length;
      j++;
      while (j < limit && s[j] !== '"') {
        QUOTED_RUN.lastIndex = j;
        if (QUOTED_RUN.test(s)) {
          const to = Math.min(QUOTED_RUN.lastIndex, limit);
          addRun(j, to);
          j = to;
        } else if (s[j] === '\\' && j + 1 < limit && '"\\$`\n'.includes(s[j + 1] ?? '')) {
          if (s[j + 1] !== '\n') add(j + 1);
          j += 2;
        } else {
          add(j++);
        }
      }
      j++;
    } else if (c === '\\' && j + 1 < limit) {
      const next = s[j + 1] ?? '';
      if (next === '\n') {
        j += 2;
      } else if (next === '\r' && s[j + 2] === '\n') {
        j += 3;
      } else if (' \t"\'\\;&|'.includes(next)) {
        add(j + 1);
        j += 2;
      } else {
        add(j++);
      }
    } else {
      add(j++);
    }
  }
  return { start, limit, value, quoted, end: Math.min(j, limit) };
}

/** The commands of `s` from `from` to `to`, each a list of words. */
function readCommands(s: string, from: number, to: number): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  const endCommand = (): void => {
    if (words.length > 0) commands.push(words);
    words = [];
  };
  let i = from;
  while (i < to) {
    const c = s[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
    } else if (c === ';' || c === '|') {
      endCommand();
      i++;
    } else if (c === '&' && s[i + 1] === '&') {
      endCommand();
      i += 2;
    } else if (c === '&' && isStandaloneAmp(s, i)) {
      endCommand();
      i++;
    } else if (isWindowsContinuation(s, i)) {
      i++;
    } else {
      const word = readWord(s, i, to);
      words.push(word);
      i = word.end > i ? word.end : i + 1;
    }
  }
  endCommand();
  return commands;
}

/** `/usr/bin/Sudo.exe` -> `sudo`. */
function programBase(word: string): string {
  return word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

/** A word that ends in a runner's name, with or without a path or `.exe`. */
const RUNNER_HINT =
  /(?:^|[/\\])(?:sudo|doas|timeout|env|nice|ionice|stdbuf|time|exec|nohup|command|caffeinate|chronic)(?:\.exe)?$/i;

/** The runner a word runs, if any: `sudo`, `/usr/bin/time`. */
function runnerOf(word: string) {
  return RUNNER_HINT.test(word) ? RUNNERS.get(programBase(word)) : undefined;
}

/** True when `word` is a client of the given kind, by itself or by its path. */
function isClientWord(word: string, kind: ClientKind): boolean {
  if (!CLIENT_HINT.test(word)) return false;
  const re = CLIENTS[kind] ?? CURL_CLIENT;
  for (const candidate of [word, programBase(word)]) {
    const found = re.exec(candidate);
    if (found !== null && found.index === 0) return true;
  }
  return false;
}

/**
 * True when a word names a client of the given kind: as the whole word or its path, or, outside
 * quotes, anywhere after a non-word character (`!curl`, `C:\Users\me>curl`). A client named only
 * inside a quoted argument belongs to the commands in that argument.
 */
function mentionsClient(word: Word, kind: ClientKind): boolean {
  if (isClientWord(word.value, kind)) return true;
  if (word.quoted !== -1 || !CLIENT_HINT.test(word.value)) return false;
  return (CLIENTS[kind] ?? CURL_CLIENT).test(word.value);
}

/** True when an option word of a runner takes the next word as its value, as getopt reads it. */
function runnerOptionTakesValue(runner: { short: string; long: readonly string[] }, word: string) {
  if (word.startsWith('--')) return !word.includes('=') && runner.long.includes(word.slice(2));
  const letters = word.slice(1);
  for (let k = 0; k < letters.length; k++) {
    const letter = letters[k] ?? '';
    if (!/[A-Za-z]/.test(letter)) return false;
    // The first letter that takes a value takes the rest of the word, or else the next word.
    if (runner.short.includes(letter)) return k === letters.length - 1;
  }
  return false;
}

/**
 * The index of the word that is run, after any variable assignments and runners with their
 * options, values and numbers (`sudo -u deploy env A=1 nice -n 5 curl`). Each word is looked at
 * once.
 */
function skipRunners(words: readonly Word[], i: number): number {
  while (i < words.length) {
    const word = words[i]?.value ?? '';
    const runner = runnerOf(word);
    if (runner === undefined) {
      // An assignment is skipped, unless it is the client itself (`CURL_OPTS="..."`).
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || isClientWord(word, CURL)) return i;
      i++;
      continue;
    }
    i++;
    while (i < words.length) {
      const option = words[i]?.value ?? '';
      if (option === '--') {
        i++;
        break;
      }
      if (option.startsWith('-') && option.length > 1) {
        i += runnerOptionTakesValue(runner, option) ? 2 : 1;
      } else if (/^\d{1,6}(?:\.\d{1,3})?[smhd]?$/.test(option)) {
        i++;
      } else {
        break;
      }
    }
  }
  return i;
}

/**
 * True when the physical line from `start` to `end` runs an HTTP client, after an optional shell
 * prompt and any runners (`$ curl`, `sudo -u deploy curl`, `time -f "%e" /usr/bin/curl`): the
 * start of a command that may be wrapped over indented option lines.
 */
function lineRunsClient(text: string, start: number, end: number): boolean {
  const words = readCommands(text, start, Math.min(end, start + MAX_LINE_CHARS))[0] ?? [];
  let i = /^[$>%#]$/.test(words[0]?.value ?? '') ? 1 : 0;
  i = skipRunners(words, i);
  const word = words[i]?.value;
  return word !== undefined && (isClientWord(word, CURL) || isClientWord(word, HTTPIE));
}

/**
 * True when the line break after the physical line `start`..`end` does not end the command: it is
 * escaped (a backslash, or after a space a cmd `^` or a PowerShell backtick), or the next line is
 * an indented option and this line is a command, not a sentence: it runs a client or is an option
 * line itself.
 */
function joinsNextLine(text: string, start: number, end: number): boolean {
  const last = text[end - 1] === '\r' ? end - 2 : end - 1;
  const ch = text[last];
  if (ch === '\\') return true;
  if ((ch === '^' || ch === '`') && (text[last - 1] === ' ' || text[last - 1] === '\t')) {
    return true;
  }
  WRAPPED_OPTION_LINE.lastIndex = end + 1;
  if (!WRAPPED_OPTION_LINE.test(text)) return false;
  OPTION_LINE.lastIndex = start;
  return OPTION_LINE.test(text) || lineRunsClient(text, start, end);
}

/** True when a word is the value of the option before it (`--proto-default sftp`). */
function isOptionValue(words: readonly Word[], i: number): boolean {
  const prev = words[i - 1]?.value ?? '';
  return /^-[^=]*$/.test(prev) && !/^-[A-Za-z]+\d/.test(prev);
}

/** True when a word runs a remote-copy program: unquoted, alone or as a path. */
function isRemoteCopy(word: Word): boolean {
  return word.quoted === -1 && REMOTE_COPY.test(word.value);
}

/**
 * For each word of a command, whether rsync, scp, sftp, ssh or rclone is run between the client
 * and it: after a runner and its options (`ionice -c3 rsync`), or as an ordinary word that is not
 * an option's value (`then rsync`). A quoted argument (`-d '... ssh into db01 ...'`) is one
 * word and never a command.
 */
function remoteCopyBefore(words: readonly Word[], client: number): Uint8Array {
  const seen = new Uint8Array(words.length);
  let has = 0;
  let i = Math.max(0, client + 1);
  while (i < words.length) {
    seen[i] = has;
    const word = words[i];
    if (word !== undefined && word.quoted === -1 && runnerOf(word.value) !== undefined) {
      const target = skipRunners(words, i);
      for (let k = i + 1; k < target && k < words.length; k++) seen[k] = has;
      const run = words[target];
      if (run !== undefined) {
        seen[target] = has;
        if (isRemoteCopy(run)) has = 1;
      }
      i = target + 1;
      continue;
    }
    if (word !== undefined && isRemoteCopy(word) && !isOptionValue(words, i)) has = 1;
    i++;
  }
  return seen;
}

/** Reads every command of the text and collects the ranges of text to redact. */
class Reader {
  readonly edits: Edit[] = [];

  constructor(private readonly marker: string) {}

  /** Records the characters `from`..`to` of a word's value as a secret. */
  private redact(source: Source, word: Word, from: number, to: number): void {
    if (to <= from) return;
    const secret = word.value.slice(from, to);
    // A value that is nothing but an earlier redaction is left as it is.
    if (secret.includes(this.marker)) {
      if (!/[A-Za-z0-9]/.test(secret.split(this.marker).join(''))) return;
    }
    // A word without quotes or escapes is its source as written; any other is read again.
    let first: number | undefined = word.start + from;
    let last: number | undefined = word.start + to - 1;
    if (word.end - word.start !== word.value.length) {
      const map: number[] = [];
      readWord(source.s, word.start, word.limit, map);
      first = map[from];
      last = map[to - 1];
    }
    if (first === undefined || last === undefined) return;
    this.edits.push({ from: source.at(first), to: source.at(last) + 1 });
  }

  /**
   * `user:password` from offset `o` of a word: the password is redacted, or the user when the
   * password is empty (`apikey:`). A shell variable or the `//` of a URL is not a literal secret.
   * A value with no colon is a user name, unless `token` says it is a token.
   */
  private userPassword(source: Source, word: Word, o: number, token: boolean): void {
    const value = word.value.slice(o);
    const colon = value.indexOf(':');
    if (colon === -1) {
      if (token && value !== '' && !value.startsWith('$')) {
        this.redact(source, word, o, word.value.length);
      }
      return;
    }
    const name = value.slice(0, colon);
    const password = value.slice(colon + 1);
    if (password.startsWith('$') || password.startsWith('//')) return;
    if (password === '') {
      if (name !== '' && !name.startsWith('$')) this.redact(source, word, o, o + colon);
      return;
    }
    this.redact(source, word, o + colon + 1, word.value.length);
  }

  /** `--cert file:password`. A Windows drive letter or a `pkcs11:` / `file:` URI is no password. */
  private certificate(source: Source, word: Word, o: number): void {
    const value = word.value.slice(o);
    const colon = value.indexOf(':', /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0);
    if (colon <= 0) return;
    if (/^(?:pkcs11|file)$/i.test(value.slice(0, colon))) return;
    const password = value.slice(colon + 1);
    if (password === '' || password.startsWith('$')) return;
    this.redact(source, word, o + colon + 1, word.value.length);
  }

  /** A whole option value that is a secret (`--pass x`, `--bearer x`). */
  private secretValue(source: Source, word: Word, o: number): void {
    const value = word.value.slice(o);
    if (value === '' || /^[-$]/.test(value)) return;
    this.redact(source, word, o, word.value.length);
  }

  /** An `Authorization` header from offset `o`: the scheme is kept, the credentials redacted. */
  private header(source: Source, word: Word, o: number): void {
    const value = word.value.slice(o);
    const name = AUTH_HEADER.exec(value);
    if (name === null) return;
    let at = o + name[0].length;
    const scheme = AUTH_SCHEME.exec(word.value.slice(at));
    if (scheme !== null) at += scheme[0].length;
    if (word.value.slice(at).startsWith('$')) return;
    this.redact(source, word, at, word.value.length);
  }

  /** A short-option cluster ending in one of `letters` (`-su`): the offset after it, or -1. */
  private static cluster(value: string, letters: string, noValue: ReadonlySet<string>): number {
    if (value.length < 2 || value[0] !== '-' || value[1] === '-') return -1;
    for (let k = 1; k < value.length; k++) {
      const letter = value[k] ?? '';
      if (letters.includes(letter)) return k + 1;
      if (!noValue.has(letter)) return -1;
    }
    return -1;
  }

  /** Reads one command; `inherited` marks clients named before it (in the word it came from). */
  command(source: Source, words: readonly Word[], inherited: readonly boolean[], depth: number) {
    const n = words.length;
    const client = [inherited[CURL] ? -1 : n, inherited[HTTPIE] ? -1 : n];
    for (let i = 0; i < n && (client[CURL] === n || client[HTTPIE] === n); i++) {
      const word = words[i];
      if (word === undefined) continue;
      if (client[CURL] === n && mentionsClient(word, CURL)) client[CURL] = i;
      if (client[HTTPIE] === n && mentionsClient(word, HTTPIE)) client[HTTPIE] = i;
    }
    const curlAt = client[CURL] ?? n;
    const httpieAt = client[HTTPIE] ?? n;
    let remote: Uint8Array | undefined;
    // httpie's `-A bearer` (or jwt) makes a value of `-a` without a colon a token.
    const bearer =
      httpieAt < n &&
      words.some((w, i) => {
        const v = w.value;
        const type = /^(?:-A|--auth-type)=?(.*)$/.exec(v);
        if (type === null) return false;
        const value = type[1] !== '' ? type[1] : (words[i + 1]?.value ?? '');
        return /^(?:bearer|jwt)$/i.test(value ?? '');
      });

    for (let i = 0; i < n; i++) {
      const word = words[i];
      if (word === undefined) continue;
      const v = word.value;
      // A quoted argument may hold commands of its own; an Authorization header holds none.
      if (depth < MAX_DEPTH && word.quoted !== -1 && /\s/.test(v) && !AUTH_HEADER.test(v)) {
        const clientBefore = [curlAt <= i, httpieAt <= i];
        if (CLIENT_HINT.test(v) || ((curlAt <= i || httpieAt <= i) && v.includes('-'))) {
          this.nested(source, word, clientBefore, depth);
        }
      }
      const next = words[i + 1];

      if (curlAt < i && v.startsWith('-')) {
        const glued = Reader.cluster(v, 'uU', CURL_NO_VALUE);
        if (v === '--user' || v === '--proxy-user' || (glued === v.length && glued > 0)) {
          if (next !== undefined) {
            const isCluster = v.length > 2 && !v.startsWith('--');
            if (isCluster && this.remoteTarget(next.value)) {
              remote ??= remoteCopyBefore(words, curlAt);
              if (remote[i] === 1) {
                i++;
                continue;
              }
            }
            this.userPassword(source, next, 0, false);
          }
          i++;
          continue;
        }
        if (glued > 0) {
          if (glued > 2 && this.remoteTarget(v.slice(glued))) {
            remote ??= remoteCopyBefore(words, curlAt);
            if (remote[i] === 1) continue;
          }
          this.userPassword(source, word, glued, false);
          continue;
        }
        const long = /^(--[a-z0-9-]+)(=?)/.exec(v);
        const option = long?.[1] ?? '';
        const attached = long?.[2] === '=';
        const target = attached ? word : next;
        const offset = attached ? option.length + 1 : 0;
        if (option === '--user' || option === '--proxy-user') {
          this.userPassword(source, word, offset, false);
          continue;
        }
        if (option === '--cert' || option === '--proxy-cert') {
          if (target !== undefined) this.certificate(source, target, offset);
          if (!attached) i++;
          continue;
        }
        if (CURL_SECRET_OPTIONS.has(option)) {
          if (target !== undefined) this.secretValue(source, target, offset);
          if (!attached) i++;
          continue;
        }
        if (v === '-H' || option === '--header') {
          if (target !== undefined) this.header(source, target, offset);
          if (!attached) i++;
          continue;
        }
        if (v.startsWith('-H') && v.length > 2 && !v.startsWith('--')) {
          this.header(source, word, 2);
          continue;
        }
      }

      if (httpieAt < i) {
        if (!v.startsWith('-')) {
          if (AUTH_HEADER.test(v)) this.header(source, word, 0);
          continue;
        }
        const glued = Reader.cluster(v, 'a', HTTPIE_NO_VALUE);
        if (v === '--auth' || (glued === v.length && glued > 0)) {
          if (next !== undefined) this.userPassword(source, next, 0, bearer);
          i++;
          continue;
        }
        if (glued > 0) {
          this.userPassword(source, word, glued, bearer);
          continue;
        }
        if (v.startsWith('--auth=')) {
          this.userPassword(source, word, 7, bearer);
          continue;
        }
        if (v === '--bearer') {
          if (next !== undefined) this.secretValue(source, next, 0);
          i++;
          continue;
        }
        if (v.startsWith('--bearer=')) this.secretValue(source, word, 9);
      }
    }
  }

  /** True when a `-u` value may be an rsync-style `user@host:/path` target. */
  private remoteTarget(value: string): boolean {
    const colon = value.indexOf(':');
    return colon !== -1 && (value.slice(0, colon).includes('@') || value[colon + 1] === '/');
  }

  /**
   * Reads a quoted argument as commands of its own, from where its quotes start: in
   * `CURL_OPTS="--user a:b"` the assignment is the client and `--user a:b` its command.
   */
  private nested(source: Source, word: Word, clients: readonly boolean[], depth: number): void {
    const map: number[] = [];
    const value = readWord(source.s, word.start, word.limit, map).value.slice(word.quoted);
    const inner: Source = { s: value, at: (k) => source.at(map[k + word.quoted] ?? 0) };
    for (const words of readCommands(value, 0, value.length)) {
      this.command(inner, words, clients, depth + 1);
    }
  }

  /** Reads every logical line of the text. */
  text(text: string): void {
    const source: Source = { s: text, at: (k) => k };
    let logical = 0;
    let line = 0;
    for (;;) {
      const newline = text.indexOf('\n', line);
      const end = newline === -1 ? text.length : newline;
      if (newline !== -1 && joinsNextLine(text, line, end)) {
        line = newline + 1;
        continue;
      }
      if (CLIENT_HINT.test(text.slice(logical, end))) {
        for (const words of readCommands(text, logical, end)) {
          this.command(source, words, [false, false], 0);
        }
      }
      if (newline === -1) break;
      logical = line = newline + 1;
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
  if (!CLIENT_HINT.test(text)) return { text, count: 0 };
  const reader = new Reader(marker);
  reader.text(text);
  if (reader.edits.length === 0) return { text, count: 0 };
  const edits = reader.edits.sort((a, b) => a.from - b.from || b.to - a.to);
  const parts: string[] = [];
  let at = 0;
  for (const edit of edits) {
    if (edit.from < at) continue;
    parts.push(text.slice(at, edit.from), marker);
    at = edit.to;
  }
  parts.push(text.slice(at));
  return { text: parts.join(''), count: (parts.length - 1) / 2 };
}
