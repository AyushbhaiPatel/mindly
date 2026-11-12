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

import { redactCommandCredentials } from './shell-credentials.js';

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

/** Provider tokens, private keys and URL credentials: matched by their own shape. */
const TOKEN_RULES: Rule[] = [
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
    // A password an earlier rule already replaced (`https://bot:ghp_...@`) is left as it is.
    skip: (g) => (g[0] ?? '').slice((g[1] ?? '').length, -1) === REDACTED,
  },
];

/**
 * Secrets found by the name next to them: `docker login -p`, `--token value`, `NAME=value`. These
 * run after the command reader, which handles HTTP clients' credentials.
 */
const NAMED_RULES: Rule[] = [
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

/**
 * `source` (a pattern of `TOKEN_RULES`) for a `mark` copy whose mark is `mark`: every character it
 * matches may be followed by the mark, which no character it matches can be, so a secret split by
 * marks is read as one and a word boundary holds next to a mark. The mark is taken whenever it is
 * there, so a secret's last part runs on past a mark as far as its characters go, as it would
 * without the hidden character (a word glued after it goes with it). The patterns are plain enough
 * (characters, classes, groups, quantifiers and `\b`) for this to be read off their source.
 */
function allowMarks(source: string, mark: string): string {
  const m = `\\u${mark.charCodeAt(0).toString(16).padStart(4, '0')}`;
  let out = '';
  const atom = (x: string): void => {
    out += `(?:(?!${m})${x}${m}?)`;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? '';
    if (c === '\\') {
      const escape = source.slice(i, i + 2);
      if (escape === '\\b' || escape === '\\B') out += escape;
      else atom(escape);
      i += 2;
    } else if (c === '[') {
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++;
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      atom(source.slice(i, j + 1));
      i = j + 1;
    } else if (c === '(') {
      const open = /^\((?:\?(?::|<?[=!]|<[A-Za-z]\w*>))?/.exec(source.slice(i, i + 40))?.[0] ?? '(';
      out += open;
      i += open.length;
    } else if (c === '{') {
      const close = source.indexOf('}', i);
      out += source.slice(i, close + 1);
      i = close + 1;
    } else if (')|?*+^$'.includes(c)) {
      out += c;
      i++;
    } else {
      atom(c);
      i++;
    }
  }
  return out;
}

/**
 * Rules whose secret is a token bounded by word boundaries (`\bghp_...\b`): those a hidden
 * character next to it or inside it can hide. The others (assignments, URLs, headers, key blocks,
 * user patterns) are read in the other copies.
 */
const TOKEN_KINDS = new Set([
  'anthropic_key',
  'openai_key',
  'aws_access_key',
  'github_token',
  'github_pat',
  'gitlab_token',
  'slack_token',
  'stripe_key',
  'google_api_key',
  'npm_token',
  'pypi_token',
  'jwt',
]);

/** A rule, with `find` listing its matches where a plain search is not linear. */
interface MarkedRule extends Rule {
  find?: (text: string) => { at: number; match: string }[];
}

/** A rule whose matches `findJwts` lists, for copies made with `mark` ('' for none). */
function withJwtFinder(rule: Rule, mark: string): MarkedRule {
  if (rule.kind !== 'jwt') return rule;
  const sticky = new RegExp(rule.re.source, 'y');
  return { ...rule, find: (text: string) => findJwts(text, mark, sticky) };
}

/** `TOKEN_RULES` for text without marks: JWTs are found in one pass (see `findJwts`). */
const PLAIN_TOKEN_RULES: readonly MarkedRule[] = TOKEN_RULES.map((rule) => withJwtFinder(rule, ''));

const markedRules = new Map<string, MarkedRule[]>();

/** The rules of `TOKEN_RULES` for bounded tokens, for a `mark` copy whose mark is `mark` (see `allowMarks`). */
function rulesForMarks(mark: string): MarkedRule[] {
  let rules = markedRules.get(mark);
  if (rules === undefined) {
    rules = TOKEN_RULES.filter((rule) => TOKEN_KINDS.has(rule.kind)).map((rule) =>
      withJwtFinder(
        { ...rule, re: new RegExp(allowMarks(rule.re.source, mark), rule.re.flags) },
        mark,
      ),
    );
    markedRules.set(mark, rules);
  }
  return rules;
}

/** `[A-Za-z0-9_-]`: what the parts of a JWT are made of. */
function isJwtUnit(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45
  );
}

function isWordUnit(c: number): boolean {
  return isJwtUnit(c) && c !== 45;
}

/** Most units in a JWT's first part, its `eyJ` included (see the `jwt` rule). */
const JWT_HEAD_MAX = 2003;

/**
 * The matches of the `jwt` rule (`sticky`, made for `mark`, or '' for text without marks), in one
 * pass and the same as a search with that rule finds. A JWT's first part ends at the first
 * character that is neither a JWT unit nor a mark, which must be a `.`: every start inside one run
 * of such characters reaches the same `.` and reads the same rest, so a run that does not end in a
 * `.` is passed over, and in one that does only the first start (`eyJ` after a word boundary)
 * whose first part is not too long is tried. A plain search tried every `eyJ` after a boundary
 * (`a-eyJa-eyJ...`, or after each mark) and read up to 2,000 characters from each.
 */
function findJwts(text: string, mark: string, sticky: RegExp): { at: number; match: string }[] {
  const m = mark === '' ? -1 : mark.charCodeAt(0);
  const isRunUnit = (c: number): boolean => c === m || isJwtUnit(c);
  const head = (k: number): boolean => {
    let o = k;
    for (const ch of 'eyJ') {
      if (text[o] !== ch) return false;
      o++;
      if (text.charCodeAt(o) === m && ch !== 'J') o++;
    }
    return true;
  };
  const out: { at: number; match: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (!isRunUnit(text.charCodeAt(i))) {
      i++;
      continue;
    }
    let end = i;
    let units = 0;
    while (end < text.length && isRunUnit(text.charCodeAt(end))) {
      if (text.charCodeAt(end) !== m) units++;
      end++;
    }
    let next = end;
    if (text[end] === '.') {
      for (let k = i; k < end; k++) {
        const c = text.charCodeAt(k);
        const boundary = isWordUnit(c) && (k === 0 || !isWordUnit(text.charCodeAt(k - 1)));
        if (boundary && units <= JWT_HEAD_MAX && head(k)) {
          sticky.lastIndex = k;
          const found = sticky.exec(text);
          if (found !== null) {
            out.push({ at: k, match: found[0] });
            next = k + found[0].length;
          }
          break;
        }
        if (c !== m) units--;
      }
    }
    i = next;
  }
  return out;
}

/** `text` with the marks at its start and end that `match` has and `text` lost put back. */
function keepMarks(match: string, text: string, mark: string): string {
  let lead = 0;
  while (match[lead] === mark) lead++;
  let trail = 0;
  while (trail < match.length - lead && match[match.length - 1 - trail] === mark) trail++;
  let out = text;
  if (lead > 0 && !out.startsWith(mark.repeat(lead))) out = mark.repeat(lead) + out;
  if (trail > 0 && !out.endsWith(mark.repeat(trail))) out += mark.repeat(trail);
  return out;
}

/** The replacements one pass of a pattern made, in the offsets of that pass's input. */
interface Pass {
  input: string;
  edits: { at: number; len: number; text: string }[];
}

/**
 * Set while `redact` needs to know where replacements were made: each `apply` that changes the
 * text adds one pass, made from that call's own input.
 */
let recording: Pass[] | null = null;

/**
 * Redacts `input` with every rule. With a `mark`, it reads `input` as a `mark` copy made with that
 * character, with the token rules only: marks are passed over inside a secret and kept around it.
 */
function redactVisible(input: string, options: RedactOptions = {}, mark = ''): RedactionResult {
  let text = input.length > MAX_REDACT_INPUT ? input.slice(0, MAX_REDACT_INPUT) : input;
  let count = 0;
  const kinds = new Set<string>();

  const apply = (kind: string, rule: Omit<MarkedRule, 'kind'>): void => {
    const { re, replace, skip, find } = rule;
    re.lastIndex = 0;
    const input = text;
    const pass: Pass | null = recording ? { input, edits: [] } : null;
    const onMatch = (...args: unknown[]): string => {
      const match = String(args[0]);
      // An empty match covers no text: there is nothing to hide there, and a marker would only
      // point at the secret next to it.
      if (match.length === 0) return match;
      // The match and its groups come before the offset; the whole input comes after it.
      const at = args.findIndex((a) => typeof a === 'number');
      const raw = args.slice(0, at).map((a) => (typeof a === 'string' ? a : ''));
      // Do not double-count a value that is already redacted. Only the secret part is looked
      // at (the match without its kept prefix), and only when nothing else is left in it: a
      // value that merely ends in an earlier redaction still has a secret in front of it.
      const kept = replace
        .slice(0, Math.max(0, replace.indexOf(REDACTED)))
        .replace(/\$(\d)/g, (_m, g: string) => raw[Number(g)] ?? '');
      const secret = match.startsWith(kept) ? match.slice(kept.length) : match;
      if (secret.includes(REDACTED) && !/[A-Za-z0-9]/.test(secret.split(REDACTED).join(''))) {
        return match;
      }
      const groups = mark ? raw.map((a) => a.split(mark).join('')) : raw;
      const start = args[at] as number;
      if (skip?.(groups, { text: input, start, end: start + match.length })) return match;
      let out = replace.replace(/\$(\d)/g, (_m, g: string) => String(args[Number(g)] ?? ''));
      if (mark) out = keepMarks(match, out, mark);
      // A replacement that changes nothing is no redaction.
      if (out === match) return match;
      count++;
      kinds.add(kind);
      pass?.edits.push({ at: start, len: match.length, text: out });
      return out;
    };
    if (find) {
      const parts: string[] = [];
      let cursor = 0;
      for (const { at, match } of find(input)) {
        parts.push(input.slice(cursor, at), onMatch(match, at, input));
        cursor = at + match.length;
      }
      parts.push(input.slice(cursor));
      text = parts.join('');
    } else {
      text = input.replace(re, onMatch);
    }
    if (pass && pass.edits.length > 0) recording?.push(pass);
  };

  for (const rule of mark ? rulesForMarks(mark) : PLAIN_TOKEN_RULES) apply(rule.kind, rule);
  if (mark) return { text, count, kinds: [...kinds] };
  const commands = redactCommandCredentials(text, REDACTED);
  if (commands.count > 0) {
    recording?.push({
      input: text,
      edits: commands.edits.map((e) => ({ at: e.at, len: e.len, text: REDACTED })),
    });
    text = commands.text;
    count += commands.count;
    kinds.add('cli_credentials');
  }
  for (const rule of NAMED_RULES) apply(rule.kind, rule);
  for (const source of options.extraPatterns ?? []) {
    const re = compileExtra(source);
    if (re) apply('custom', { re, replace: REDACTED });
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

/**
 * Where, in `copy`, the replacements of `passes` were made: one span per replaced secret, with
 * the text that took its place. A kept prefix or suffix (a variable name, an `@`) is not part of
 * the span. Null when the passes do not lead from `copy` to `result`, which every change going
 * through `apply` rules out.
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
  mark: string,
): { result: RedactionResult; spans: Span[] | null } {
  const passes: Pass[] = [];
  recording = passes;
  let result: RedactionResult;
  try {
    result = redactVisible(text, options, mark);
  } finally {
    recording = null;
  }
  return { result, spans: result.count === 0 ? [] : replacedSpans(text, passes, result.text) };
}

/**
 * Replaces the secrets in `input` and keeps every other character. Characters that render as
 * nothing and control characters can hide a secret (inside it) or hide a word boundary (next to
 * it), so secrets are looked for in several copies: without those characters, with each turned
 * into a space, mixes of the two, and one where the patterns read past them (see `CopyMode`). What
 * any finds is replaced in `input`, the hidden characters inside a secret included; everything
 * else is returned as it was.
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
      const { result, spans: found } = redactTraced(copy.text, options, copy.mark);
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
 * Used only if a copy's replacements could not be placed in the original, which `apply` recording
 * every change it makes rules out. The copy without hidden characters is returned redacted: it
 * loses the hidden characters but keeps the text readable, rather than replacing all of it.
 */
function untraced(text: string, options: RedactOptions): RedactionResult {
  return redactVisible(matchCopy(text, 'removed').text, options);
}
