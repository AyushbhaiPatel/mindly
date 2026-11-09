/*
 * Text-only reading of shell commands an agent ran. Nothing here executes anything: commands are
 * compared and searched as strings, to tell whether a command could have written a file Mindly
 * is watching (saves), which files it names as write targets (rules and write guards) and whether
 * two runs were the same command line.
 */
import { posix } from 'node:path';

/** The command line with surrounding and repeated whitespace removed. */
export function normalizeCommandLine(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** Programs that only read files (when no output redirection is used). */
const READ_ONLY_PROGRAMS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'wc',
  'ls',
  'stat',
  'file',
  'diff',
  'bat',
  'nl',
  'jq',
  'echo',
  'printf',
  'test',
  'pwd',
  'sort',
  'uniq',
  'cut',
  'tr',
  'true',
  'false',
  'which',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'du',
  'df',
  'tree',
  'cmp',
  'comm',
  'column',
  'tac',
  'rev',
  'date',
  'sleep',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'xxd',
  'od',
  'hexdump',
  'strings',
  '[',
]);

/** `git` subcommands that only read. */
const READ_ONLY_GIT = new Set(['diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files']);

/** `git` subcommands that change the index, refs or remotes but never the files they name. */
const GIT_KEEPS_FILES = new Set([
  ...READ_ONLY_GIT,
  'add',
  'commit',
  'push',
  'fetch',
  'branch',
  'tag',
  'rev-parse',
  'remote',
  'config',
  'describe',
  'shortlog',
  'reflog',
  'ls-tree',
  'cat-file',
  'merge-base',
  'rev-list',
  'check-ignore',
]);

/** `git` subcommands that rewrite or remove the paths given to them. */
const GIT_WRITES_PATHS = new Set(['checkout', 'restore', 'rm', 'mv', 'clean']);

/**
 * Programs that check or run the files they are pointed at without rewriting them (test runners,
 * type checkers, linters and formatters in check mode). A fixing flag turns them into writers.
 */
const CHECKING_PROGRAMS = new Set([
  'vitest',
  'jest',
  'mocha',
  'ava',
  'playwright',
  'cypress',
  'pytest',
  'tox',
  'tsc',
  'eslint',
  'prettier',
  'biome',
  'stylelint',
  'ruff',
  'mypy',
  'pyright',
  'flake8',
  'pylint',
  'shellcheck',
  'phpunit',
  'rspec',
  'rubocop',
]);

/** Flags that make a checking program rewrite files. */
const FIXING_FLAG =
  /^(--fix(=.*|-.*)?|--write|-w|--apply(-unsafe)?|--auto-?correct(-all)?|-a|-A|--update-?snapshots?|-u)$/;

/** Package-manager scripts that are checks by convention. */
const CHECKING_SCRIPT = /^(test|lint|typecheck|type-check|check|build|tsc)(:[\w:-]+)?$/;

/** Words that launch another program: the program is what follows them. */
const LAUNCHERS = new Set([
  'sudo',
  'env',
  'time',
  'nice',
  'nohup',
  'command',
  'exec',
  'npx',
  'pnpx',
  'bunx',
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
]);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SCRIPT_RUNNERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the command text mentions `path` or its basename as a word. */
export function mentionsPath(command: string, path: string): boolean {
  if (path === '') return false;
  if (command.includes(path)) return true;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === '') return false;
  return new RegExp(`(^|[\\s'"=/<>:(\`])${escapeRe(base)}($|[\\s'"\`;|&)<>:,])`).test(command);
}

/** Whether the command text names `path`, its basename, or a directory above it, as a word. */
export function namesPathOrParent(command: string, path: string): boolean {
  if (mentionsPath(command, path)) return true;
  const segments = path.split('/');
  for (let i = segments.length - 1; i > 0; i--) {
    const dir = segments.slice(0, i).join('/');
    if (
      new RegExp(`(^|[\\s'"=<>:(\`])(\\./)?${escapeRe(dir)}/?($|[\\s'"\`;|&)<>:,])`).test(command)
    )
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// A small reader of shell syntax: words, quotes, redirections and command separators. It does not
// expand anything; a word that depends on a variable or a substitution is marked `dynamic`.
// ---------------------------------------------------------------------------------------------

interface Word {
  text: string;
  /** Holds a variable or substitution whose value is unknown. */
  dynamic: boolean;
  /** Came (partly) from a quoted string, so wildcards in it are literal. */
  quoted: boolean;
}

interface Redirect {
  /** `>`, `>>`, `<`, … */
  op: string;
  target: Word;
}

interface SimpleCommand {
  words: Word[];
  redirects: Redirect[];
}

interface Parsed {
  commands: SimpleCommand[];
  /** Text of `$(…)` and backtick substitutions, read as commands of their own. */
  nested: string[];
}

const MAX_COMMAND_CHARS = 20_000;
const MAX_TARGETS = 60;
const MAX_DEPTH = 3;

function parse(input: string): Parsed {
  const src = input.length > MAX_COMMAND_CHARS ? input.slice(0, MAX_COMMAND_CHARS) : input;
  const commands: SimpleCommand[] = [];
  const nested: string[] = [];
  let current: SimpleCommand = { words: [], redirects: [] };
  let word: Word | null = null;
  let pendingRedirect: string | null = null;
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let heredocNext: { stripTabs: boolean } | null = null;

  const open = (): Word => (word ??= { text: '', dynamic: false, quoted: false });
  const endWord = (): void => {
    if (word === null) return;
    const w = word;
    word = null;
    if (heredocNext !== null) {
      heredocs.push({ delimiter: w.text, stripTabs: heredocNext.stripTabs });
      heredocNext = null;
      return;
    }
    if (pendingRedirect !== null) {
      current.redirects.push({ op: pendingRedirect, target: w });
      pendingRedirect = null;
      return;
    }
    current.words.push(w);
  };
  const endCommand = (): void => {
    endWord();
    pendingRedirect = null;
    if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
    current = { words: [], redirects: [] };
  };
  /** Index just past the `)` that closes a `$(` opened before `from`. */
  const closeParen = (from: number): number => {
    let depth = 1;
    let i = from;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    return i;
  };
  /** Reads `$…` at `i` into the open word; returns the index after it. */
  const dollar = (i: number): number => {
    const w = open();
    const next = src[i + 1];
    if (next === '(') {
      const end = closeParen(i + 2);
      nested.push(src.slice(i + 2, Math.max(i + 2, end - 1)));
      w.dynamic = true;
      return end;
    }
    const braced = /^\$\{(\w+)\}/.exec(src.slice(i, i + 80));
    const plain = /^\$(\w+)/.exec(src.slice(i, i + 80));
    const m = braced ?? plain;
    if (!m) {
      w.text += '$';
      return i + 1;
    }
    // The working directory is the one variable whose value is known: paths resolve against it.
    if (m[1] === 'PWD') w.text += '.';
    else w.dynamic = true;
    return i + m[0].length;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\n') {
      endCommand();
      i++;
      // The bodies of here-documents opened on this line are text, not commands.
      while (heredocs.length > 0) {
        const doc = heredocs.shift() as { delimiter: string; stripTabs: boolean };
        for (;;) {
          if (i >= src.length) break;
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl === -1 ? src.length : nl);
          i = nl === -1 ? src.length : nl + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      open().text += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const w = open();
      w.quoted = true;
      w.text += src.slice(i + 1, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      const w = open();
      w.quoted = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i] as string;
        if (d === '\\' && i + 1 < src.length) {
          w.text += src[i + 1];
          i += 2;
        } else if (d === '$') {
          i = dollar(i);
        } else if (d === '`') {
          const end = src.indexOf('`', i + 1);
          nested.push(src.slice(i + 1, end === -1 ? src.length : end));
          w.dynamic = true;
          i = end === -1 ? src.length : end + 1;
        } else {
          w.text += d;
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === '$') {
      i = dollar(i);
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      nested.push(src.slice(i + 1, end === -1 ? src.length : end));
      open().dynamic = true;
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '#' && word === null) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '>' || c === '<') {
      // Digits right before the operator are a file descriptor, not a word.
      const before = word as Word | null;
      if (before !== null && !before.quoted && /^\d+$/.test(before.text)) word = null;
      else endWord();
      let op = c;
      i++;
      while (
        i < src.length &&
        (src[i] === c || src[i] === '|' || src[i] === '-') &&
        op.length < 3
      ) {
        if (src[i] === '-' && op !== '<<') break;
        op += src[i];
        i++;
      }
      if (src[i] === '&') {
        // `>&2`, `<&3`, `>&-` move streams; `>&file` writes a file.
        if (/^[\d-]/.test(src[i + 1] ?? '')) {
          i += 2;
          while (i < src.length && /\d/.test(src[i] as string)) i++;
          continue;
        }
        i++;
      }
      if (op.startsWith('<<') && op !== '<<<') heredocNext = { stripTabs: op === '<<-' };
      else pendingRedirect = op;
      continue;
    }
    if (c === '&' && src[i + 1] === '>') {
      // `&>file`: both streams into a file.
      endWord();
      i++;
      continue;
    }
    if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')') {
      endCommand();
      i++;
      while (i < src.length && (src[i] === '|' || src[i] === '&' || src[i] === ';')) i++;
      continue;
    }
    if ((c === '{' || c === '}') && word === null && /^[\s;]?$/.test(src[i + 1] ?? '')) {
      // A `{ …; }` group; braces inside a word are brace expansion and stay in it.
      endCommand();
      i++;
      continue;
    }
    open().text += c;
    i++;
  }
  endCommand();
  return { commands, nested };
}

/** The words of a command with leading assignments and launcher words removed. */
function programWords(words: readonly Word[]): Word[] {
  let rest = [...words];
  for (;;) {
    const first = rest[0];
    if (first === undefined) return rest;
    if (!first.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text)) {
      rest = rest.slice(1);
      continue;
    }
    const name = programName(first);
    if (LAUNCHERS.has(name)) {
      rest = rest.slice(1);
      // Options of the launcher itself (`sudo -u x`, `env -i`) are skipped with it.
      while (rest[0] && rest[0].text.startsWith('-')) rest = rest.slice(1);
      continue;
    }
    return rest;
  }
}

function withoutAssignments(words: readonly Word[]): Word[] {
  let at = 0;
  while (at < words.length) {
    const w = words[at] as Word;
    if (w.quoted || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) break;
    at++;
  }
  return words.slice(at);
}

function programName(word: Word): string {
  return word.text.slice(word.text.lastIndexOf('/') + 1);
}

const isFlag = (w: Word): boolean => w.text.startsWith('-') && w.text !== '-';
const plainArgs = (words: readonly Word[]): Word[] => words.slice(1).filter((w) => !isFlag(w));
const hasFlag = (words: readonly Word[], re: RegExp): boolean =>
  words.slice(1).some((w) => isFlag(w) && re.test(w.text));

/** What a simple command is, for the question "does it write the files it names?". */
type Verdict =
  | { kind: 'reads' }
  | { kind: 'writes'; files: Word[]; trees: Word[]; into?: { dir: Word; names: string[] } }
  | { kind: 'unknown'; args: Word[] }
  | { kind: 'cd'; dir: Word | null }
  | { kind: 'inline'; code: string }
  | { kind: 'script'; code: string };

function classify(words: readonly Word[], depth = 0): Verdict {
  const first = words[0];
  if (first === undefined) return { kind: 'reads' };
  const unknown: Verdict = { kind: 'unknown', args: words.slice(1) };
  if (first.dynamic) return unknown;
  const program = programName(first);
  const args = plainArgs(words);

  if (program === 'cd' || program === 'pushd') return { kind: 'cd', dir: args[0] ?? null };
  if (READ_ONLY_PROGRAMS.has(program)) return { kind: 'reads' };

  if (CHECKING_PROGRAMS.has(program)) {
    if (words.slice(1).some((w) => FIXING_FLAG.test(w.text))) {
      // Fixers rewrite what they are given: files, directories, or patterns they expand themselves.
      return { kind: 'writes', files: [], trees: args.map((w) => ({ ...w, quoted: false })) };
    }
    // `ruff format` and `biome format --write` rewrite; without a check flag assume they do.
    if (args[0]?.text === 'format' && !hasFlag(words, /^--(check|diff)$/)) return unknown;
    return { kind: 'reads' };
  }

  switch (program) {
    case 'sed': {
      if (!hasFlag(words, /^(-[a-zA-Z]*i.*|--in-place(=.*)?)$/)) return { kind: 'reads' };
      // Without -e/-f the first plain argument is the script, not a file.
      const scripted = hasFlag(words, /^(-[a-zA-Z]*[ef]|--expression(=.*)?|--file(=.*)?)$/);
      // BSD sed takes the backup suffix as a separate, often empty, argument.
      const given = args[0]?.text === '' ? args.slice(1) : args;
      return { kind: 'writes', files: scripted ? given : given.slice(1), trees: [] };
    }
    case 'awk':
    case 'gawk':
      return hasFlag(words, /^-i$/) ? unknown : { kind: 'reads' };
    case 'find':
      return words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/.test(w.text))
        ? unknown
        : { kind: 'reads' };
    case 'rm':
    case 'unlink':
    case 'shred':
      return { kind: 'writes', files: [], trees: args };
    case 'rmdir':
    case 'touch':
    case 'truncate':
    case 'mkdir':
    case 'tee':
      return { kind: 'writes', files: args, trees: [] };
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      // The first plain argument is the mode or owner.
      const targets = args.slice(1);
      return hasFlag(words, /^(-[a-zA-Z]*R[a-zA-Z]*|--recursive)$/)
        ? { kind: 'writes', files: [], trees: targets }
        : { kind: 'writes', files: targets, trees: [] };
    }
    case 'mv':
    case 'cp':
    case 'ln':
    case 'install':
    case 'rsync': {
      const into = targetDirectory(words);
      const sources = into ? args : args.slice(0, -1);
      const dest = into ?? args[args.length - 1];
      if (dest === undefined) return { kind: 'reads' };
      // The destination itself, or (when it is a directory) the entry each source becomes in it.
      const names = sources.filter((s) => !s.dynamic).map((s) => posix.basename(s.text));
      return {
        kind: 'writes',
        files: [],
        trees: program === 'mv' ? sources : [],
        into: { dir: dest, names },
      };
    }
    case 'dd': {
      const out = words.find((w) => w.text.startsWith('of='));
      return out
        ? { kind: 'writes', files: [{ ...out, text: out.text.slice(3) }], trees: [] }
        : { kind: 'reads' };
    }
    case 'perl':
      if (hasFlag(words, /^-[a-zA-Z]*i/)) {
        const scripted = hasFlag(words, /^-[a-zA-Z]*e$/);
        return { kind: 'writes', files: scripted ? args.slice(1) : args, trees: [] };
      }
      break;
    case 'git': {
      const rest = words.slice(1);
      let dir: Word | null = null;
      while (rest[0] && isFlag(rest[0])) {
        const flag = rest.shift() as Word;
        if (flag.text === '-C') dir = rest.shift() ?? null;
        else if (flag.text === '-c') rest.shift();
      }
      const sub = rest[0]?.text;
      if (sub === undefined || GIT_KEEPS_FILES.has(sub)) return { kind: 'reads' };
      if (!GIT_WRITES_PATHS.has(sub)) return unknown;
      const dashes = rest.findIndex((w) => w.text === '--');
      // Before `--` a plain argument may be a branch; only path-looking ones count.
      const named =
        dashes !== -1
          ? rest.slice(dashes + 1)
          : rest.slice(1).filter((w) => !isFlag(w) && /[./]/.test(w.text));
      const trees = dir ? named.map((w) => joinWords(dir, w.text, w)) : named;
      return { kind: 'writes', files: [], trees };
    }
    case 'eval':
      return {
        kind: 'inline',
        code: words
          .slice(1)
          .map((w) => w.text)
          .join(' '),
      };
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const rest = words.slice(1).filter((w) => !isFlag(w));
      const head = rest[0];
      if (head === undefined) return { kind: 'reads' };
      if (head.text === 'run' || head.text === 'run-script') {
        return CHECKING_SCRIPT.test(rest[1]?.text ?? '') ? { kind: 'reads' } : unknown;
      }
      if (CHECKING_SCRIPT.test(head.text)) return { kind: 'reads' };
      // `pnpm exec vitest`, `yarn dlx prettier`, `pnpm vitest`: what runs is a later word.
      const explicit = head.text === 'exec' || head.text === 'dlx' || head.text === 'x';
      const runs = explicit ? rest[1] : head;
      if (runs === undefined || depth >= MAX_DEPTH) return unknown;
      const name = programName(runs);
      // Without `exec`, an unknown word is a script of the package: it can run anything.
      if (!explicit && !CHECKING_PROGRAMS.has(name) && !READ_ONLY_PROGRAMS.has(name))
        return unknown;
      return classify(words.slice(words.indexOf(runs)), depth + 1);
    }
    default:
      break;
  }

  if (SHELLS.has(program)) {
    const at = words.findIndex((w) => /^-[a-zA-Z]*c$/.test(w.text));
    const code = at === -1 ? undefined : words[at + 1];
    if (code) return { kind: 'inline', code: code.text };
    return { kind: 'unknown', args: withoutScript(words) };
  }
  if (SCRIPT_RUNNERS.has(program)) {
    if (program === 'node' && hasFlag(words, /^--test$/)) return { kind: 'reads' };
    if ((program === 'python' || program === 'python3') && words[1]?.text === '-m') {
      const module = words[2]?.text ?? '';
      if (CHECKING_PROGRAMS.has(module) && depth < MAX_DEPTH)
        return classify(words.slice(2), depth + 1);
      return unknown;
    }
    const at = words.findIndex((w) => /^-[a-zA-Z]*[ce]$|^--eval$|^-p$/.test(w.text));
    const code = at === -1 ? undefined : words[at + 1];
    if (code) return { kind: 'script', code: code.text };
    return { kind: 'unknown', args: withoutScript(words) };
  }
  return unknown;
}

/** The arguments of an interpreter without the script it runs (which it reads, not writes). */
function withoutScript(words: readonly Word[]): Word[] {
  const at = words.findIndex((w, i) => i > 0 && !isFlag(w));
  return words.slice(1).filter((_, i) => i + 1 !== at);
}

/** The `-t dir` / `--target-directory=dir` of cp, mv, ln and install. */
function targetDirectory(words: readonly Word[]): Word | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.text.startsWith('--target-directory=')) {
      return { ...w, text: w.text.slice('--target-directory='.length) };
    }
    if (w.text === '-t' || w.text === '--target-directory') return words[i + 1] ?? null;
  }
  return null;
}

function joinWords(dir: Word, name: string, from: Word): Word {
  return {
    text: posix.join(dir.text, name),
    dynamic: dir.dynamic || from.dynamic,
    quoted: dir.quoted && from.quoted,
  };
}

/** A file a shell command names as something it writes. */
export interface ShellTarget {
  /**
   * The path as the command gives it, relative to the directory the command starts in (after any
   * `cd` before it) or absolute. May hold `*`, `?` or `{a,b}` when `glob` is set.
   */
  path: string;
  /** The path is a wildcard pattern the shell expands. */
  glob: boolean;
  /** When the path is a directory, everything under it is written too (`rm -r`, `git checkout`). */
  tree: boolean;
  /**
   * When the path is a directory, the entries the command writes inside it (`cp a.ts dir` writes
   * `dir/a.ts`); when it is not, the path itself is written.
   */
  entries: string[];
  /**
   * The text shows the write (a redirection, `rm`, `sed -i`, …). False when the path is only an
   * argument of a program Mindly does not know, which may as well just read it.
   */
  certain: boolean;
}

/** Inline code that changes files: a write mode, or a call that writes, moves or removes. */
const INLINE_WRITE =
  /['"][wax]\+?b?['"]|write|append|unlink|remove|rename|truncate|rmSync|rmtree|mkdir|copy|move|touch/i;

const looksLikePath = (text: string): boolean =>
  /[./]/.test(text) && !text.includes('://') && !/^[\d.]+$/.test(text);

/**
 * The files a shell command names as write targets, read from its text: redirections, the
 * arguments of programs that write what they are given (`rm`, `mv`, `cp`, `sed -i`, `tee`, …),
 * path-looking arguments of programs Mindly does not know, and paths quoted inside inline scripts.
 * Programs known to only read or check (`cat`, `grep`, `sed -n`, test runners, linters without a
 * fixing flag) contribute nothing but their redirections. `cd` is followed. A target is `certain`
 * when the text shows the write, and not when the path is merely given to an unknown program.
 *
 * This is a reading of text, not a sandbox: a program can write files it never names. What it
 * guarantees is the common cases in both directions, so a read is not blocked and a plain write
 * is not missed.
 */
export function shellWriteTargets(command: string): ShellTarget[] {
  const out = new Map<string, ShellTarget>();
  collectTargets(command, '', 0, out);
  return [...out.values()];
}

function collectTargets(
  command: string,
  startDir: string,
  depth: number,
  out: Map<string, ShellTarget>,
): void {
  if (depth > MAX_DEPTH) return;
  const parsed = parse(command);
  // The directory later commands run in, relative to where the command started; null when a
  // `cd` went somewhere that cannot be read from the text.
  let dir: string | null = startDir;

  const add = (word: Word, tree: boolean, certain = true, entries: string[] = []): void => {
    if (out.size >= MAX_TARGETS || word.dynamic || word.text === '' || word.text === '-') return;
    const text = word.text;
    if (text.startsWith('~') || /^\/(dev|proc)\//.test(text)) return;
    let path: string;
    if (posix.isAbsolute(text)) path = posix.normalize(text);
    else if (dir === null) return;
    else path = posix.normalize(posix.join(dir, text));
    const glob = !word.quoted && /[*?{]/.test(text);
    const key = `${path}\0${glob ? 'g' : ''}`;
    const known = out.get(key);
    if (known) {
      known.tree ||= tree;
      known.certain ||= certain;
      known.entries.push(...entries.filter((e) => !known.entries.includes(e)));
    } else out.set(key, { path, glob, tree, certain, entries: [...entries] });
  };

  for (const cmd of parsed.commands) {
    for (const r of cmd.redirects) if (r.op.startsWith('>')) add(r.target, false);
    const words = programWords(cmd.words);
    const verdict = classify(words);
    switch (verdict.kind) {
      case 'reads':
        break;
      case 'cd': {
        const to = verdict.dir;
        if (to === null || to.dynamic || to.text === '-' || to.text.startsWith('~')) dir = null;
        else if (posix.isAbsolute(to.text)) dir = posix.normalize(to.text);
        else if (dir !== null) dir = posix.normalize(posix.join(dir, to.text));
        break;
      }
      case 'writes':
        for (const w of verdict.files) add(w, false);
        for (const w of verdict.trees) add(w, true);
        if (verdict.into) add(verdict.into.dir, false, true, verdict.into.names);
        break;
      case 'inline':
        if (dir !== null) collectTargets(verdict.code, dir, depth + 1, out);
        break;
      case 'script': {
        // Paths quoted inside inline code (`python -c "open('a/b.ts','w')"`); the write is
        // evident when the code also opens for writing or calls something that changes files.
        const writes = INLINE_WRITE.test(verdict.code);
        for (const m of verdict.code.matchAll(/['"`]([^'"`\s]{1,512})['"`]/g)) {
          const text = m[1] as string;
          if (looksLikePath(text)) add({ text, dynamic: false, quoted: true }, false, writes);
        }
        break;
      }
      case 'unknown':
        // A program Mindly does not know may write what it is given, or only read it.
        for (const w of verdict.args) {
          if (!isFlag(w)) {
            if (looksLikePath(w.text)) add(w, false, false);
            continue;
          }
          const eq = w.text.indexOf('=');
          if (eq !== -1 && looksLikePath(w.text.slice(eq + 1)))
            add({ ...w, text: w.text.slice(eq + 1) }, false, false);
        }
        break;
    }
  }
  for (const inner of parsed.nested) {
    if (dir !== null) collectTargets(inner, dir, depth + 1, out);
  }
}

/** Whether every part of the command is a known read-only program without output redirection. */
export function isReadOnlyCommand(command: string): boolean {
  const parsed = parse(command);
  // Command substitution can run anything.
  if (parsed.nested.length > 0) return false;
  for (const cmd of parsed.commands) {
    // Discarding a stream writes no file; any other output redirection does.
    if (cmd.redirects.some((r) => r.op.startsWith('>') && r.target.text !== '/dev/null')) {
      return false;
    }
    const words = withoutAssignments(cmd.words);
    const first = words[0];
    if (first === undefined) continue;
    if (first.dynamic) return false;
    const program = programName(first);
    if (program === 'git') {
      const sub = words.slice(1).find((t) => !t.text.startsWith('-'));
      if (sub === undefined || !READ_ONLY_GIT.has(sub.text)) return false;
      continue;
    }
    if (program === 'cd') continue;
    if (program === 'sed') {
      if (classify(words).kind !== 'reads') return false;
      continue;
    }
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
  }
  return true;
}

/**
 * Whether a shell command may have written `path`: it mentions the path (or its basename) and is
 * not made only of read-only programs. Deliberately cautious: when in doubt it says yes, so a save
 * that depends on the file not being written is dropped rather than counted.
 */
export function shellMayWrite(command: string, path: string): boolean {
  return mentionsPath(command, path) && !isReadOnlyCommand(command);
}

/**
 * Whether a shell command may have written any file: it is not made only of read-only programs.
 * Cautious like `shellMayWrite`: when in doubt it says yes, so a checkpoint rescan follows.
 */
export function shellMayWriteFiles(command: string): boolean {
  return !isReadOnlyCommand(command);
}
