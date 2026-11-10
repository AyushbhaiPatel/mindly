/*
 * Text-only reading of shell commands an agent ran. Nothing here executes anything or touches the
 * file system: commands are compared and searched as strings, to tell whether a command could
 * have written a file Mindly is watching (saves), which files it names as write targets (rules
 * and write guards) and whether two runs were the same command line.
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
  '[[',
  ':',
]);

/**
 * Shell words that start a compound command or change only the shell itself. None writes the
 * files it names (`for f in src/*.ts`, `export OUT=dist/a.js`).
 */
const SHELL_WORDS = new Set([
  'for',
  'select',
  'case',
  'esac',
  'in',
  'done',
  'fi',
  'function',
  'local',
  'export',
  'declare',
  'typeset',
  'readonly',
  'set',
  'unset',
  'shift',
  'return',
  'exit',
  'break',
  'continue',
  'wait',
  'read',
  'unalias',
  'type',
  'hash',
  'umask',
  'ulimit',
  'dirs',
  'jobs',
  'kill',
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

/**
 * Programs that check or run the files they are pointed at and never rewrite them: test runners
 * and type checkers. Their short flags mean other things (`jest -w 4`, `tsc -w`, `vitest -u`).
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
  'mypy',
  'pyright',
  'flake8',
  'pylint',
  'shellcheck',
  'phpunit',
  'rspec',
]);

const JS_FILES = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro'];
const STYLE_FILES = ['css', 'scss', 'sass', 'less'];
const C_FILES = ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'proto'];

/**
 * Linters and formatters: they only read, unless one of their own fixing flags is given, and then
 * they only rewrite the kinds of file they understand.
 */
const FIXERS: Readonly<
  Record<string, { fixes: (words: readonly Word[]) => boolean; files: string[] }>
> = {
  eslint: { fixes: (w) => hasFlag(w, /^--fix$/), files: JS_FILES },
  prettier: {
    fixes: (w) => hasFlag(w, /^(--write|-w)$/),
    files: [
      ...JS_FILES,
      ...STYLE_FILES,
      'json',
      'json5',
      'jsonc',
      'md',
      'mdx',
      'html',
      'yaml',
      'yml',
      'graphql',
      'gql',
      'hbs',
    ],
  },
  biome: {
    fixes: (w) => hasFlag(w, /^(--write|--apply|--apply-unsafe|--fix)$/),
    files: [...JS_FILES, ...STYLE_FILES, 'json', 'jsonc', 'graphql'],
  },
  stylelint: { fixes: (w) => hasFlag(w, /^--fix$/), files: [...STYLE_FILES, 'vue', 'svelte'] },
  ruff: {
    fixes: (w) =>
      hasFlag(w, /^(--fix|--fix-only|--unsafe-fixes)$/) ||
      (plainArgs(w)[0]?.text === 'format' && !hasFlag(w, /^--(check|diff)$/)),
    files: ['py', 'pyi', 'ipynb'],
  },
  black: { fixes: (w) => !hasFlag(w, /^(--check|--diff|-c|--code)$/), files: ['py', 'pyi'] },
  isort: { fixes: (w) => !hasFlag(w, /^(--check|--check-only|-c|--diff)$/), files: ['py', 'pyi'] },
  autopep8: { fixes: (w) => hasFlag(w, /^(-i|--in-place)$/), files: ['py'] },
  rubocop: {
    fixes: (w) => hasFlag(w, /^(-a|-A|-x|--auto-?correct(-all)?|--autocorrect-all|--fix-layout)$/),
    files: ['rb', 'rake', 'gemspec'],
  },
  gofmt: { fixes: (w) => hasFlag(w, /^-[a-z]*w[a-z]*$/), files: ['go'] },
  goimports: { fixes: (w) => hasFlag(w, /^-[a-z]*w[a-z]*$/), files: ['go'] },
  rustfmt: { fixes: (w) => !hasFlag(w, /^--check$/), files: ['rs'] },
  shfmt: { fixes: (w) => hasFlag(w, /^(-[a-z]*w[a-z]*|--write)$/), files: ['sh', 'bash'] },
  'clang-format': { fixes: (w) => hasFlag(w, /^-i$/), files: C_FILES },
};

/** Words that are a subcommand of a fixer, not a file. */
const FIXER_SUBCOMMANDS = new Set(['format', 'check', 'lint', 'ci']);

/** Package-manager scripts that are checks by convention. */
const CHECKING_SCRIPT = /^(test|lint|typecheck|type-check|check|build|tsc)(:[\w:-]+)?$/;

/**
 * Programs that run another program. `values` are their options that take a value in the next
 * word; `skip` is how many plain words come before the program (`timeout 5 rm …`); `chdir` are
 * the options that make the program run in another directory.
 */
const LAUNCHERS: Readonly<
  Record<string, { values?: string[]; skip?: number; chdir?: string[]; assigns?: boolean }>
> = {
  sudo: {
    values: [
      '-u',
      '-g',
      '-h',
      '-p',
      '-C',
      '-D',
      '-R',
      '-T',
      '-U',
      '-r',
      '-t',
      '--user',
      '--group',
      '--host',
      '--prompt',
      '--chdir',
    ],
    chdir: ['-D', '--chdir'],
    assigns: true,
  },
  doas: { values: ['-u', '-C'] },
  env: {
    values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
    chdir: ['-C', '--chdir'],
    assigns: true,
  },
  nice: { values: ['-n', '--adjustment'] },
  ionice: { values: ['-c', '-n', '-p', '--class', '--classdata', '--pid'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], skip: 1 },
  stdbuf: { values: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  time: { values: ['-f', '-o', '--format', '--output'] },
  xargs: {
    values: [
      '-I',
      '-n',
      '-P',
      '-L',
      '-d',
      '-E',
      '-s',
      '-a',
      '--max-args',
      '--max-procs',
      '--replace',
      '--delimiter',
      '--arg-file',
    ],
  },
  watch: { values: ['-n', '--interval'] },
  npx: { values: ['-p', '--package'] },
  pnpx: { values: ['-p', '--package'] },
  bunx: {},
  nohup: {},
  command: {},
  builtin: {},
  exec: { values: ['-a'] },
  chronic: {},
  setsid: {},
  busybox: {},
  toybox: {},
  shx: {},
  then: {},
  do: {},
  else: {},
  elif: {},
  if: {},
  while: {},
  until: {},
  '!': {},
};

/**
 * Programs that build, deploy or talk to another machine. What they are given is a folder to
 * work in, a target or a command for somewhere else, not a file they write in its place.
 */
const RUNS_ELSEWHERE = new Set([
  'make',
  'gmake',
  'cmake',
  'ninja',
  'bazel',
  'docker',
  'docker-compose',
  'podman',
  'kubectl',
  'helm',
  'turbo',
  'nx',
  'lerna',
  'ssh',
  'mosh',
  'gh',
  'glab',
]);

/** Package manager commands that write into the project they run in. */
const INSTALLS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
  'ci',
  'prune',
  'dedupe',
  'link',
  'unlink',
]);

/** make targets that remove or install files. */
const MAKE_WRITES = /^(clean|distclean|mrproper|realclean|install|uninstall)$/;

/** Options of the package managers whose value is the next word. */
const PACKAGE_MANAGER_VALUES = [
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--cwd',
  '--prefix',
  '--workspace',
  '-w',
];

/** Programs `classify` knows as writers, by the names a package manager may run them under. */
const KNOWN_WRITERS = new Set(['rimraf', 'del', 'del-cli', 'trash', 'trash-put', 'rm', 'cp', 'mv']);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SCRIPT_RUNNERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun']);

/** Programs that remove or rewrite what `find -exec` hands them. */
const DESTRUCTIVE = new Set([
  'rm',
  'mv',
  'shred',
  'unlink',
  'truncate',
  'sed',
  'perl',
  'dd',
  'tee',
]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the command text mentions `path` or its basename as a word. */
export function mentionsPath(command: string, path: string): boolean {
  if (path === '') return false;
  if (command.includes(path)) return true;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === '') return false;
  return new RegExp(`(^|[\\s'"=/<>:(\`])${escapeRe(base)}($|[\\s'"\`;|&)<>:,])`).test(command);
}

/**
 * A test for "does this command name `path`, its basename, or a directory above it?", prepared
 * once per command: its words are split up front, so asking about many paths costs set lookups
 * instead of a regular expression per path and directory.
 */
export function pathNamer(command: string): (path: string) => boolean {
  const names = new Set<string>();
  for (const raw of command.split(/[\s'"`;|&()<>=:,]+/)) {
    const word = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (word === '' || word.length > 1024) continue;
    // An absolute or longer spelling of a path names it too: every trailing part counts.
    const parts = word.split('/');
    for (let i = 0; i < parts.length && i < 64; i++) names.add(parts.slice(i).join('/'));
  }
  return (path) => {
    if (path === '') return false;
    if (names.has(path) || names.has(path.slice(path.lastIndexOf('/') + 1))) return true;
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      if (names.has(path.slice(0, at))) return true;
    }
    return false;
  };
}

/** Whether the command text names `path`, its basename, or a directory above it, as a word. */
export function namesPathOrParent(command: string, path: string): boolean {
  return pathNamer(command)(path);
}

// ---------------------------------------------------------------------------------------------
// A small reader of shell syntax: words, quotes, redirections, here-documents and command
// separators. It expands nothing it cannot know: the working directory, the home directory and
// the repository root are kept as marks that are placed later; a word that depends on any other
// variable or substitution is `dynamic`.
// ---------------------------------------------------------------------------------------------

/** Stand-ins for values the text refers to: `$PWD` / `$(pwd)`, `$HOME`, the repository root. */
const HERE = String.fromCharCode(0xe000);
const HOME = String.fromCharCode(0xe001);
const TOP = String.fromCharCode(0xe002);
/** `$OLDPWD`: the directory before the last `cd`. */
const BACK = String.fromCharCode(0xe003);
const MARKS = new RegExp(`[${HERE}-${BACK}]`);

interface Word {
  text: string;
  /** For each character of `text`: `u` when it was written outside quotes, `q` inside. */
  mask: string;
  /** Holds a variable or substitution whose value is unknown. */
  dynamic: boolean;
  /**
   * A brace expansion too large to read, written as a wildcard that matches every word it stands
   * for: only part of what it names was read.
   */
  cut?: boolean | undefined;
}

interface Redirect {
  /** `>`, `>>`, `<`, … */
  op: string;
  target: Word;
}

interface SimpleCommand {
  words: Word[];
  redirects: Redirect[];
  /** Text of `$(…)` and backtick substitutions written in this command. */
  nested: string[];
  /** What the command reads from a here-document or here-string. */
  stdin: string | null;
  /** The command before it feeds it through a pipe. */
  piped: boolean;
  /** Joined to the command before it by `||`: it runs only when that one failed. */
  otherwise: boolean;
  /**
   * Runs in a shell of its own (part of a pipeline, or sent to the background with `&`): a `cd`
   * in it changes nothing for the commands after it.
   */
  apart: boolean;
  /** The here-document is expanded by the shell (its delimiter was not quoted). */
  stdinExpands: boolean;
  /** Not a command: where a `( … )` subshell starts or ends. */
  subshell?: 'open' | 'close';
}

/** Commands longer than this are read up to here; the rest is reported as not read. */
const MAX_COMMAND_CHARS = 200_000;
const MAX_TARGETS = 500;
const MAX_DEPTH = 4;
/** Words without a dot or slash kept per command as "a path, if such a file exists". */
const MAX_BARE_WORDS = 12;
/** Simple commands read from one command line, nested ones included. */
const MAX_COMMANDS = 20_000;
/** Longest path, and longest working directory, that is followed. */
const MAX_PATH_CHARS = 4096;
/** git commands of one command line that are asked about. */
const MAX_QUESTIONS = 8;
/** Sources of one copy that are kept by name. */
const MAX_ENTRIES = 64;
/** Words one brace expansion (`{a,b}`, `{1..9}`) may turn into. */
const MAX_BRACE_WORDS = 256;
/** Alternatives still checked of a brace expansion that is too large. */
const MAX_BRACE_KEPT = 1024;

const word = (text: string, quoted = false): Word => ({
  text,
  mask: (quoted ? 'q' : 'u').repeat(text.length),
  dynamic: false,
});

/**
 * A word whose brace expansion is too large to read, as a wildcard: each group of braces written
 * outside quotes becomes `*`, which matches every word the group stands for (and more).
 */
function braceGlob(w: Word): Word {
  let text = '';
  let mask = '';
  for (let i = 0; i < w.text.length; i++) {
    if (w.text[i] === '{' && w.mask[i] === 'u') {
      let level = 0;
      let end = -1;
      for (let j = i; j < w.text.length; j++) {
        if (w.mask[j] !== 'u') continue;
        if (w.text[j] === '{') level++;
        else if (w.text[j] === '}' && --level === 0) {
          end = j;
          break;
        }
      }
      if (end !== -1) {
        text += '*';
        mask += 'u';
        i = end;
        continue;
      }
    }
    text += w.text[i];
    mask += w.mask[i];
  }
  return { text, mask, dynamic: w.dynamic, cut: true };
}

/**
 * The words a brace expansion stands for: `a{b,c}d` is `abd acd`, `f{1..3}` is `f1 f2 f3`. Only
 * braces written outside quotes expand. A word that would become too many stays a wildcard that
 * matches all of them (see {@link braceGlob}).
 */
function expandBraces(w: Word, depth = 0): Word[] {
  if (!w.text.includes('{')) return [w];
  if (depth > 8) return [braceGlob(w)];
  for (let i = 0; i < w.text.length; i++) {
    if (w.text[i] !== '{' || w.mask[i] !== 'u') continue;
    let level = 0;
    let end = -1;
    const commas: number[] = [];
    for (let j = i; j < w.text.length; j++) {
      if (w.mask[j] !== 'u') continue;
      const ch = w.text[j];
      if (ch === '{') level++;
      else if (ch === '}' && --level === 0) {
        end = j;
        break;
      } else if (ch === ',' && level === 1) commas.push(j);
    }
    if (end === -1) return [w];
    let alternatives: Word[];
    if (commas.length > 0) {
      const cuts = [i, ...commas, end];
      alternatives = cuts.slice(0, -1).map((at, k) => sliceWord(w, at + 1, cuts[k + 1]));
    } else {
      const seq = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/.exec(w.text.slice(i + 1, end));
      if (!seq) continue;
      const [from, to] = [seq[1] as string, seq[2] as string];
      const numeric = /\d$/.test(from) && /\d$/.test(to);
      if (!numeric && (/\d$/.test(from) || /\d$/.test(to))) continue;
      const lo = numeric ? Number(from) : from.charCodeAt(0);
      const hi = numeric ? Number(to) : to.charCodeAt(0);
      if (Math.abs(hi - lo) >= MAX_BRACE_WORDS) return [braceGlob(w)];
      alternatives = [];
      for (let v = lo; ; v += hi >= lo ? 1 : -1) {
        alternatives.push(word(numeric ? String(v) : String.fromCharCode(v)));
        if (v === hi) break;
      }
    }
    const joined = alternatives.map((alt): Word => ({
      text: w.text.slice(0, i) + alt.text + w.text.slice(end + 1),
      mask: w.mask.slice(0, i) + alt.mask + w.mask.slice(end + 1),
      dynamic: w.dynamic,
    }));
    const out: Word[] = [];
    for (const one of joined) {
      out.push(...expandBraces(one, depth + 1));
      if (out.length > MAX_BRACE_WORDS) {
        // Too many words: each alternative without braces of its own is still checked by name,
        // and the word as a whole by what it can match.
        const plain = joined.filter((x) => !x.text.includes('{')).slice(0, MAX_BRACE_KEPT);
        return [...plain, braceGlob(w)];
      }
    }
    return out;
  }
  return [w];
}

function parse(
  input: string,
  timeUp: () => boolean = () => false,
): { commands: SimpleCommand[]; cut: false | 'length' | 'time' } {
  let cut: false | 'length' | 'time' = input.length > MAX_COMMAND_CHARS ? 'length' : false;
  const src = cut ? input.slice(0, MAX_COMMAND_CHARS) : input;
  let steps = 0;
  const commands: SimpleCommand[] = [];
  const blank = (piped = false, otherwise = false): SimpleCommand => ({
    words: [],
    redirects: [],
    nested: [],
    stdin: null,
    piped,
    otherwise,
    apart: piped,
    stdinExpands: false,
  });
  // Open `{ … }` groups; `true` for the body of a function, which runs only when it is called.
  const groups: boolean[] = [];
  let functionNext = false;
  let current = blank();
  let open: Word | null = null;
  let pendingRedirect: string | null = null;
  const heredocs: {
    delimiter: string;
    stripTabs: boolean;
    expands: boolean;
    into: SimpleCommand;
  }[] = [];
  let heredocNext: { stripTabs: boolean } | null = null;

  const cur = (): Word => (open ??= { text: '', mask: '', dynamic: false });
  const put = (text: string, quoted: boolean): void => {
    const w = cur();
    w.text += text;
    w.mask += (quoted ? 'q' : 'u').repeat(text.length);
  };
  const endWord = (): void => {
    const w = open as Word | null;
    if (w === null) return;
    open = null;
    if (heredocNext !== null) {
      heredocs.push({
        delimiter: w.text,
        stripTabs: heredocNext.stripTabs,
        expands: !w.mask.includes('q'),
        into: current,
      });
      heredocNext = null;
      return;
    }
    if (pendingRedirect !== null) {
      if (pendingRedirect === '<<<') current.stdin = w.text;
      else current.redirects.push({ op: pendingRedirect, target: w });
      pendingRedirect = null;
      return;
    }
    current.words.push(...expandBraces(w));
  };
  const endCommand = (piped = false, otherwise = false): void => {
    endWord();
    pendingRedirect = null;
    const c = current;
    if (c.words.length > 0 || c.redirects.length > 0 || c.nested.length > 0 || c.stdin !== null)
      commands.push(c);
    current = blank(piped, otherwise);
  };
  /** Index just past the `)` that closes a `$(` opened before `from`; quotes are honoured. */
  const closeParen = (from: number): number => {
    let depth = 1;
    let i = from;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        i = end === -1 ? src.length : end;
      } else if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    return i;
  };
  /** A substitution: the few whose value is known become a mark, the rest are read later. */
  const substitution = (code: string, quoted: boolean): void => {
    const what = code.trim().replace(/\s+/g, ' ');
    if (what === 'pwd') put(HERE, quoted);
    else if (what === 'git rev-parse --show-toplevel') put(TOP, quoted);
    else {
      current.nested.push(code);
      cur().dynamic = true;
    }
  };
  /** Reads `$…` at `i` into the open word; returns the index after it. */
  const dollar = (i: number, quoted: boolean): number => {
    const next = src[i + 1];
    if (next === '(' && src[i + 2] === '(') {
      // `$(( … ))`: arithmetic, a number nobody can read from the text.
      const end = src.indexOf('))', i + 3);
      cur().dynamic = true;
      return end === -1 ? src.length : end + 2;
    }
    if (next === '(') {
      const end = closeParen(i + 2);
      substitution(src.slice(i + 2, Math.max(i + 2, end - 1)), quoted);
      return end;
    }
    if (next === "'" && !quoted) {
      // `$'…'`: a quoted string in which a backslash escapes the next character.
      let j = i + 2;
      cur();
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        put(src[j] as string, true);
        j++;
      }
      return j + 1;
    }
    const m = /^\$(?:\{(\w+)\}|(\w+))/.exec(src.slice(i, i + 80));
    if (!m && next === '{') {
      // `${f%.ts}`, `${x:-y}`: a value that cannot be read from the text.
      const end = src.indexOf('}', i + 2);
      cur().dynamic = true;
      return end === -1 ? src.length : end + 1;
    }
    if (!m) {
      put('$', quoted);
      return i + 1;
    }
    const name = m[1] ?? m[2];
    if (name === 'PWD') put(HERE, quoted);
    else if (name === 'HOME') put(HOME, quoted);
    else if (name === 'OLDPWD') put(BACK, quoted);
    else cur().dynamic = true;
    return i + m[0].length;
  };
  const backtick = (i: number, quoted: boolean): number => {
    const end = src.indexOf('`', i + 1);
    substitution(src.slice(i + 1, end === -1 ? src.length : end), quoted);
    return end === -1 ? src.length : end + 1;
  };

  let i = 0;
  while (i < src.length) {
    if (++steps % 4096 === 0 && timeUp()) {
      // What is left is not read; the caller says so.
      cut = 'time';
      break;
    }
    const c = src[i] as string;
    if (c === '\n') {
      endCommand();
      i++;
      // The bodies of here-documents opened on this line belong to the commands that read them.
      while (heredocs.length > 0) {
        const doc = heredocs.shift() as (typeof heredocs)[number];
        const start = i;
        let end = src.length;
        for (;;) {
          if (i >= src.length) break;
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl === -1 ? src.length : nl);
          const lineStart = i;
          i = nl === -1 ? src.length : nl + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
            end = lineStart;
            break;
          }
        }
        doc.into.stdin = src.slice(start, end);
        doc.into.stdinExpands = doc.expands;
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
      put(src[i + 1] ?? '', true);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      cur();
      put(src.slice(i + 1, end === -1 ? src.length : end), true);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      cur();
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i] as string;
        if (d === '\\' && i + 1 < src.length) {
          put(src[i + 1] as string, true);
          i += 2;
        } else if (d === '$') {
          i = dollar(i, true);
        } else if (d === '`') {
          i = backtick(i, true);
        } else {
          put(d, true);
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === '$') {
      i = dollar(i, false);
      continue;
    }
    if (c === '`') {
      i = backtick(i, false);
      continue;
    }
    if (c === '#' && open === null) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if ((c === '>' || c === '<') && current.words[0]?.text === '[[') {
      // Inside `[[ … ]]` these compare strings.
      put(c, false);
      i++;
      continue;
    }
    if (c === '>' || c === '<') {
      // Digits right before the operator are a file descriptor, not a word.
      const before = open as Word | null;
      if (before !== null && /^u+$/.test(before.mask) && /^\d+$/.test(before.text)) open = null;
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
      if (op === '<<' || op === '<<-') heredocNext = { stripTabs: op === '<<-' };
      else pendingRedirect = op;
      continue;
    }
    if (c === '&' && src[i + 1] === '>') {
      // `&>file`: both streams into a file.
      endWord();
      i++;
      continue;
    }
    if (c === '(' && /^\(\s*\)/.test(src.slice(i, i + 16)) && open !== null) {
      // `name() …`: a function definition. Its body is read, but as a shell of its own.
      open = null;
      functionNext = true;
      i = src.indexOf(')', i) + 1;
      continue;
    }
    if (c === '(' && src[i + 1] === '(' && open === null) {
      // `(( … ))`: arithmetic. Its `>` and `<` compare numbers.
      const end = src.indexOf('))', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '(' || c === ')') {
      // A subshell: what it does to the working directory ends with it.
      if (c === '(') functionNext = false;
      endCommand();
      commands.push({ ...blank(), subshell: c === '(' ? 'open' : 'close' });
      i++;
      continue;
    }
    if (c === '|' || c === '&' || c === ';') {
      const pipe = c === '|' && src[i + 1] !== '|';
      endWord();
      if (pipe || (c === '&' && src[i + 1] !== '&')) current.apart = true;
      endCommand(pipe, c === '|' && src[i + 1] === '|');
      i++;
      while (i < src.length && (src[i] === '|' || src[i] === '&' || src[i] === ';')) i++;
      continue;
    }
    if ((c === '{' || c === '}') && open === null && /^[\s;]?$/.test(src[i + 1] ?? '')) {
      // A `{ …; }` group; braces inside a word are brace expansion and stay in it.
      const named = current.words[0]?.text === 'function';
      if (named) current.words = [];
      endCommand();
      if (c === '{') {
        const body = functionNext || named;
        functionNext = false;
        groups.push(body);
        if (body) commands.push({ ...blank(), subshell: 'open' });
      } else if (groups.pop() === true) {
        commands.push({ ...blank(), subshell: 'close' });
      }
      i++;
      continue;
    }
    put(c, false);
    i++;
  }
  endCommand();
  // A here-document whose line never ended still feeds its command nothing.
  return { commands, cut };
}

const isAssignment = (w: Word): boolean =>
  w.mask.startsWith('u') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);

function withoutAssignments(words: readonly Word[]): Word[] {
  let at = 0;
  while (at < words.length && isAssignment(words[at] as Word)) at++;
  return words.slice(at);
}

/**
 * The words of the program a command really runs: leading assignments and launchers (`sudo -u x`,
 * `timeout 5`, `env -C dir`) are taken off. `chdir` is the directory a launcher moves it to.
 */
function programWords(words: readonly Word[]): { words: Word[]; chdir: Word | null } {
  let rest = withoutAssignments(words);
  let chdir: Word | null = null;
  for (let guard = 0; guard < 16; guard++) {
    const first = rest[0];
    if (first === undefined || first.dynamic) break;
    const name = programName(first);
    const launcher = Object.hasOwn(LAUNCHERS, name) ? LAUNCHERS[name] : undefined;
    if (launcher === undefined) break;
    // `command -v x` asks about a program, it does not run one.
    if (name === 'command' && /^-[vV]$/.test(rest[1]?.text ?? '')) return { words: [], chdir };
    let at = 1;
    while (at < rest.length) {
      const w = rest[at] as Word;
      if (w.text === '--') {
        at++;
        break;
      }
      if (!w.text.startsWith('-') || w.text === '-') break;
      const eq = w.text.indexOf('=');
      const flag = eq === -1 ? w.text : w.text.slice(0, eq);
      const takesValue = eq === -1 && (launcher.values ?? []).includes(flag);
      if ((launcher.chdir ?? []).includes(flag)) {
        chdir = eq === -1 ? (rest[at + 1] ?? null) : sliceWord(w, eq + 1);
      }
      at += takesValue ? 2 : 1;
    }
    if (launcher.assigns) while (at < rest.length && isAssignment(rest[at] as Word)) at++;
    at += launcher.skip ?? 0;
    rest = withoutAssignments(rest.slice(at));
  }
  return { words: rest, chdir };
}

function programName(w: Word): string {
  return w.text.slice(w.text.lastIndexOf('/') + 1);
}

function sliceWord(w: Word, from: number, to?: number): Word {
  return { text: w.text.slice(from, to), mask: w.mask.slice(from, to), dynamic: w.dynamic };
}

/** `dir/name`, keeping what is known about each part. */
function joinWords(dir: Word, name: Word): Word {
  const sep = dir.text.endsWith('/') ? '' : '/';
  return {
    text: `${dir.text}${sep}${name.text}`,
    mask: `${dir.mask}${'u'.repeat(sep.length)}${name.mask}`,
    dynamic: dir.dynamic || name.dynamic,
  };
}

const isFlag = (w: Word): boolean => w.text.startsWith('-') && w.text !== '-';
const plainArgs = (words: readonly Word[]): Word[] => words.slice(1).filter((w) => !isFlag(w));
const hasFlag = (words: readonly Word[], re: RegExp): boolean =>
  words.slice(1).some((w) => isFlag(w) && re.test(w.text));

/** A short-option cluster (`-rf`) that holds one of `letters`, or one of the long `names`. */
function hasOption(words: readonly Word[], letters: string, names: readonly string[]): boolean {
  return words.slice(1).some((w) => {
    if (!isFlag(w)) return false;
    if (w.text.startsWith('--')) return names.includes(w.text.split('=')[0] as string);
    return [...w.text.slice(1)].some((ch) => letters.includes(ch));
  });
}

/** Plain arguments, without the values of the options listed in `valued`. */
function argsWithout(words: readonly Word[], valued: readonly string[]): Word[] {
  const out: Word[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.text === '--') {
      out.push(...words.slice(i + 1));
      break;
    }
    if (isFlag(w)) {
      if (valued.includes(w.text)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

/** The value of an option given as `-x value`, `--name value` or `--name=value`. */
function optionValue(words: readonly Word[], names: readonly string[]): Word | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as Word;
    if (names.includes(w.text)) return words[i + 1] ?? null;
    const eq = w.text.indexOf('=');
    if (eq !== -1 && names.includes(w.text.slice(0, eq))) return sliceWord(w, eq + 1);
  }
  return null;
}

/** One thing a command writes, as its text gives it. */
interface Item {
  word: Word;
  /** When the path is a directory, everything under it is written too. */
  tree?: boolean;
  /** False when the program may as well leave the path alone. Default true. */
  certain?: boolean;
  /** Only files with these extensions are rewritten. */
  only?: string[];
  ifExists?: boolean;
  how?: ShellTarget['how'];
  /** What lands inside the path when it is a directory, and where each comes from. */
  entries?: { name: string; from: Word | null }[];
  /** The path is a pattern the program expands itself, whatever the quoting. */
  pattern?: boolean;
  /** Stands for a git question when git cannot answer it. */
  fallback?: number | undefined;
  dotfiles?: boolean;
  nocase?: boolean;
  touches?: FileKinds;
}

/** What a simple command is, for the question "does it write the files it names?". */
type Verdict =
  | { kind: 'reads' }
  | { kind: 'writes'; items: Item[] }
  | { kind: 'unknown'; args: Word[]; bare: boolean }
  | { kind: 'cd'; how: 'cd' | 'pushd' | 'popd'; dir: Word | null }
  | { kind: 'inline'; code: string }
  | { kind: 'script'; code: string }
  | { kind: 'git'; dir: Word | null; asks: GitAsk[]; trusted: boolean; nocase: boolean }
  /** The command writes files the text cannot tell: said as a limit of the reading. */
  | { kind: 'unread'; why: string };

const READS: Verdict = { kind: 'reads' };
const writes = (...items: Item[]): Verdict => ({ kind: 'writes', items });
const files = (words: readonly Word[], extra: Omit<Item, 'word'> = {}): Item[] =>
  words.map((word) => ({ word, ...extra }));
const trees = (words: readonly Word[], extra: Omit<Item, 'word'> = {}): Item[] =>
  words.map((word) => ({ word, tree: true, ...extra }));

const looksLikePath = (text: string): boolean =>
  /[./]/.test(text) &&
  !/\s/.test(text) &&
  !text.includes('://') &&
  !/^[\d.]+$/.test(text) &&
  !/^[^/]+:/.test(text);

/** A `host:path` argument of scp or rsync: not a local file. */
const isRemote = (w: Word): boolean => /^[^/]+:/.test(w.text);

function classify(words: readonly Word[], stdin: string | null, depth = 0): Verdict {
  const first = words[0];
  if (first === undefined) return READS;
  const unknown: Verdict = { kind: 'unknown', args: words.slice(1), bare: true };
  if (first.dynamic) return unknown;
  const program = programName(first);
  const args = plainArgs(words);

  if (program === 'cd') return { kind: 'cd', how: 'cd', dir: args[0] ?? null };
  if (program === 'pushd') return { kind: 'cd', how: 'pushd', dir: args[0] ?? null };
  if (program === 'popd') return { kind: 'cd', how: 'popd', dir: null };
  if (READ_ONLY_PROGRAMS.has(program) || SHELL_WORDS.has(program)) return READS;
  if (program === 'make' || program === 'gmake') {
    // `make -C dir clean` removes and installs files inside that directory.
    const dir = optionValue(words, ['-C', '--directory']);
    const targets = argsWithout(words, ['-C', '--directory', '-f', '--file', '-j', '-l']);
    if (dir && targets.some((w) => MAKE_WRITES.test(w.text)))
      return writes({ word: dir, tree: true, certain: false });
    return READS;
  }
  if (CHECKING_PROGRAMS.has(program) || RUNS_ELSEWHERE.has(program)) return READS;

  const fixer = Object.hasOwn(FIXERS, program) ? FIXERS[program] : undefined;
  if (fixer !== undefined) {
    if (!fixer.fixes(words)) return READS;
    const given = args.filter((w, i) => !(i === 0 && FIXER_SUBCOMMANDS.has(w.text)));
    const items: Item[] = [];
    for (const w of given) {
      const ext = /[^/.]\.([A-Za-z0-9]+)$/.exec(w.text)?.[1];
      // A named file is rewritten when the tool knows its kind; anything else it is given is a
      // directory or a pattern the tool expands itself.
      if (ext === undefined || /[*?{]/.test(w.text)) {
        items.push({ word: w, tree: true, only: fixer.files, pattern: true, dotfiles: true });
      } else if (fixer.files.includes(ext.toLowerCase())) items.push({ word: w });
      else items.push({ word: w, certain: false });
    }
    return writes(...items);
  }

  switch (program) {
    case 'sed':
    case 'gsed': {
      if (!hasFlag(words, /^(-[a-zA-Z]*i.*|--in-place(=.*)?)$/)) return READS;
      // Without -e/-f the first plain argument is the script, not a file.
      const scripted = hasFlag(words, /^(-[a-zA-Z]*[ef]|--expression(=.*)?|--file(=.*)?)$/);
      // BSD sed takes the backup suffix as a separate, often empty, argument.
      const given = args[0]?.text === '' ? args.slice(1) : args;
      return writes(...files(scripted ? given : given.slice(1)));
    }
    case 'sort': {
      const out =
        optionValue(words, ['-o', '--output']) ??
        words.slice(1).find((w) => /^-o./.test(w.text) && !w.text.startsWith('--'));
      if (!out) return READS;
      return writes({ word: out.text.startsWith('-o') ? sliceWord(out, 2) : out });
    }
    case 'awk':
    case 'gawk':
      return hasFlag(words, /^-i$/) ? unknown : READS;
    case 'find':
      return readFind(words);
    case 'rm': {
      const recursive = hasOption(words, 'rR', ['--recursive']);
      return writes(...(recursive ? trees(args) : files(args)));
    }
    case 'rimraf':
    case 'trash':
    case 'trash-put':
    case 'del':
    case 'del-cli':
      return writes(...trees(args));
    case 'unlink':
    case 'shred':
    case 'rmdir':
    case 'touch':
    case 'mkdir':
    case 'tee':
    case 'gzip':
    case 'gunzip':
    case 'bzip2':
    case 'bunzip2':
    case 'xz':
      // Compressors replace the file they are given, unless they write to standard output.
      if (/zip|^xz$|^bz/.test(program) && hasOption(words, 'ctl', ['--stdout', '--test', '--list']))
        return READS;
      return writes(...files(args));
    case 'truncate':
      return writes(...files(argsWithout(words, ['-s', '--size', '-r', '--reference'])));
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      // A change of mode or owner leaves the content alone: worth a warning, not a block. The
      // first plain argument is the mode or owner.
      const targets = args.slice(1);
      return writes(
        ...(hasOption(words, 'R', ['--recursive'])
          ? trees(targets, { certain: false })
          : files(targets, { certain: false })),
      );
    }
    case 'mv':
    case 'cp':
    case 'ln':
    case 'install':
    case 'rsync':
    case 'scp':
      return readCopy(program, words);
    case 'dd': {
      const out = words.find((w) => w.text.startsWith('of='));
      return out ? writes({ word: sliceWord(out, 3) }) : READS;
    }
    case 'tar':
    case 'bsdtar':
    case 'gtar':
      return readTar(words);
    case 'unzip': {
      // Listing, testing or printing writes nothing (`-dcerts` is a directory, not options).
      if (
        hasOption(
          words.filter((w) => !w.text.startsWith('-d')),
          'ltpZ',
          [],
        )
      )
        return READS;
      // `-d dir` or `-ddir`; without it the archive unpacks where the command runs.
      const attached = words.slice(1).find((w) => /^-d./.test(w.text));
      const into = optionValue(words, ['-d']) ?? (attached ? sliceWord(attached, 2) : word('.'));
      return writes({ word: into, how: 'land' });
    }
    case 'zip':
      return args[0] ? writes({ word: args[0] }) : READS;
    case 'curl': {
      // `-o file`, also at the end of a cluster of short options (`-sSLo file`).
      const out = words.filter((w, i) => /^(-[a-zA-Z]*o|--output)$/.test(words[i - 1]?.text ?? ''));
      const joined = words
        .filter((w) => w.text.startsWith('--output='))
        .map((w) => sliceWord(w, '--output='.length));
      return writes(...files([...out, ...joined]));
    }
    case 'wget': {
      const cluster = words.findIndex((w) => /^-[a-zA-Z]*O$/.test(w.text));
      const out =
        optionValue(words, ['-O', '--output-document']) ??
        (cluster === -1 ? null : (words[cluster + 1] ?? null));
      const dir = optionValue(words, ['-P', '--directory-prefix']);
      return writes(
        ...(out && out.text !== '-' ? files([out]) : []),
        ...(dir ? [{ word: dir, how: 'land' as const }] : []),
      );
    }
    case 'openssl':
    case 'ssh-keygen': {
      const out = words.filter((w, i) => /^(-out|-keyout|-f)$/.test(words[i - 1]?.text ?? ''));
      return writes(...files(out.filter((_, i) => program === 'openssl' || i === 0)));
    }
    case 'perl':
      // `-pi`, `-i.bak`, `-0pi -e`: an in-place edit. `-Mstrict` or `-ne` are not.
      if (hasFlag(words, /^-[lnpaswtTuU0-9]*i(?:[lnpae]*|[.~_].*)$/)) {
        const scripted = hasFlag(words, /^-[lnpaswtTuUi0-9]*e$/);
        return writes(...files(scripted ? args.slice(1) : args));
      }
      break;
    case 'git':
      return readGit(words);
    case 'trap':
      // The first argument is what runs when the signal comes.
      return args[0] && args.length > 1 ? { kind: 'inline', code: args[0].text } : READS;
    case 'alias': {
      const code = args
        .filter((w) => w.text.includes('='))
        .map((w) => w.text.slice(w.text.indexOf('=') + 1));
      return code.length > 0 ? { kind: 'inline', code: code.join('\n') } : READS;
    }
    case 'eval':
      return {
        kind: 'inline',
        code: words
          .slice(1)
          .map((w) => w.text)
          .join(' '),
      };
    case 'source':
    case '.':
      return { kind: 'unknown', args: withoutScript(words), bare: false };
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      // `bun -e code` is an interpreter run, not a package script.
      if (program === 'bun' && hasFlag(words, /^(-e|--eval|-p|--print)$/)) break;
      // A package manager runs scripts and tools: what it writes is theirs to say, not what it
      // is given. A folder it is pointed at (`--filter ./packages/api`, `-C dir`) is not written.
      const none: Verdict = { kind: 'unknown', args: [], bare: false };
      const rest = argsWithout(words, PACKAGE_MANAGER_VALUES);
      const head = rest[0];
      if (head === undefined) return READS;
      // Installing or removing packages in another folder writes inside it.
      const dir = optionValue(words, ['-C', '--dir', '--cwd', '--prefix']);
      if (dir && INSTALLS.has(head.text)) return writes({ word: dir, tree: true, certain: false });
      if (head.text === 'run' || head.text === 'run-script') {
        return CHECKING_SCRIPT.test(rest[1]?.text ?? '') ? READS : none;
      }
      if (CHECKING_SCRIPT.test(head.text)) return READS;
      // `pnpm exec vitest`, `yarn dlx prettier`, `pnpm vitest`: what runs is a later word.
      const explicit = head.text === 'exec' || head.text === 'dlx' || head.text === 'x';
      const runs = explicit ? rest[1] : head;
      if (runs === undefined || depth >= MAX_DEPTH) return none;
      const name = programName(runs);
      // Without `exec`, a word that is no known program is a script or a subcommand of the
      // package manager (`pnpm install`).
      const known =
        CHECKING_PROGRAMS.has(name) ||
        READ_ONLY_PROGRAMS.has(name) ||
        KNOWN_WRITERS.has(name) ||
        Object.hasOwn(FIXERS, name);
      if (!explicit && !known) return none;
      return classify(words.slice(words.indexOf(runs)), stdin, depth + 1);
    }
    default:
      break;
  }

  if (SHELLS.has(program)) {
    const at = words.findIndex((w) => /^-[a-zA-Z]*c$/.test(w.text));
    const code = at === -1 ? undefined : words[at + 1];
    if (code) return { kind: 'inline', code: code.text };
    // No script file: the commands come from a here-document, here-string or pipe.
    if (stdin !== null && args.filter((w) => w.text !== '-' && w.text !== '-s').length === 0)
      return { kind: 'inline', code: stdin };
    return { kind: 'unknown', args: withoutScript(words), bare: false };
  }
  if (SCRIPT_RUNNERS.has(program)) {
    if (program === 'node' && hasFlag(words, /^--test$/)) return READS;
    if ((program === 'python' || program === 'python3') && words[1]?.text === '-m') {
      const module = words[2]?.text ?? '';
      const known = CHECKING_PROGRAMS.has(module) || Object.hasOwn(FIXERS, module);
      if (known && depth < MAX_DEPTH) return classify(words.slice(2), stdin, depth + 1);
      return { kind: 'unknown', args: [], bare: false };
    }
    const at = words.findIndex(
      (w, i) =>
        /^-[a-zA-Z]*[ce]$|^--eval$|^--print$|^-p$/.test(w.text) ||
        (program === 'php' && w.text === '-r') ||
        (program === 'deno' && i === 1 && w.text === 'eval'),
    );
    const code = at === -1 ? undefined : words[at + 1];
    if (code) return { kind: 'script', code: code.text };
    if (stdin !== null && args.filter((w) => w.text !== '-').length === 0)
      return { kind: 'script', code: stdin };
    return { kind: 'unknown', args: withoutScript(words), bare: false };
  }
  return unknown;
}

/** The arguments of an interpreter without the script it runs (which it reads, not writes). */
function withoutScript(words: readonly Word[]): Word[] {
  const at = words.findIndex((w, i) => i > 0 && !isFlag(w));
  return words.slice(1).filter((_, i) => i + 1 !== at);
}

/**
 * `find`: what an action deletes or rewrites is what its tests let through. One or more `-name`
 * tests narrow it to those names under the start directories; `-type d -empty -delete` only
 * removes empty directories; any other shape counts as the start directories with all they hold.
 */
function readFind(words: readonly Word[]): Verdict {
  const starts: Word[] = [];
  let at = 1;
  while (at < words.length && /^-[HLP]$|^-O\d$|^-D$/.test((words[at] as Word).text)) at++;
  for (; at < words.length; at++) {
    const w = words[at] as Word;
    if (/^[-(!]/.test(w.text)) break;
    starts.push(w);
  }
  const where = starts.length > 0 ? starts : [word('.')];
  const out: Word[] = [];
  const names: { pattern: Word; nocase: boolean }[] = [];
  let certain = false;
  let possible = false;
  let deletes = false;
  let other = false;
  let complex = false;
  let narrows = false;
  let alternatives = false;
  for (let i = at; i < words.length; i++) {
    const w = words[i] as Word;
    const next = words[i + 1];
    if (w.text === '-delete') {
      certain = true;
      deletes = true;
    } else if (/^-(exec|execdir|ok|okdir)$/.test(w.text)) {
      if (next && !next.dynamic && DESTRUCTIVE.has(programName(next))) certain = true;
      else if (next && !READ_ONLY_PROGRAMS.has(programName(next))) possible = true;
      other = true;
    } else if (/^-(fprint0?|fprintf|fls)$/.test(w.text) && next) {
      out.push(next);
    } else if (/^-i?name$/.test(w.text) && next) {
      if (next.dynamic) complex = true;
      else names.push({ pattern: next, nocase: w.text === '-iname' });
      i++;
    } else if (/^(-not|!)$/.test(w.text)) {
      // A negation can let through what no name test names.
      complex = true;
    } else if (/^(-i?path|-i?wholename|-i?regex)$/.test(w.text)) {
      // Together with the name tests these only narrow what is found; as an alternative to them
      // (`-o`), they can let through anything.
      narrows = true;
      i++;
    } else if (w.text === '-o' || w.text === '-or') {
      alternatives = true;
    }
  }
  if (narrows && alternatives) complex = true;
  if (!certain && !possible) return out.length > 0 ? writes(...files(out)) : READS;
  // Only empty directories can go: no file is touched.
  const onlyEmptyDirs =
    deletes &&
    !other &&
    words.some((w) => w.text === '-empty') &&
    words.some((w, i) => w.text === '-type' && words[i + 1]?.text === 'd');
  if (onlyEmptyDirs) return out.length > 0 ? writes(...files(out)) : READS;
  const sure = certain ? {} : { certain: false };
  if (names.length === 0 || complex) return writes(...files(out), ...trees(where, sure));
  const items: Item[] = [];
  for (const start of where) {
    for (const { pattern, nocase } of names) {
      // The name is matched at any depth below the start, dotfiles included.
      items.push({
        word: joinWords(start, joinWords(word('**'), pattern)),
        tree: true,
        pattern: true,
        dotfiles: true,
        nocase,
        ...sure,
      });
    }
  }
  return writes(...files(out), ...items);
}

/** Options of the copying programs whose value is the next word. */
const COPY_VALUES: Readonly<Record<string, string[]>> = {
  cp: ['-t', '--target-directory', '-S', '--suffix'],
  mv: ['-t', '--target-directory', '-S', '--suffix'],
  ln: ['-t', '--target-directory', '-S', '--suffix'],
  install: ['-t', '--target-directory', '-m', '--mode', '-o', '--owner', '-g', '--group', '-S'],
  scp: ['-i', '-P', '-o', '-F', '-c', '-l', '-S', '-J'],
  rsync: [
    '-e',
    '--rsh',
    '-f',
    '--filter',
    '--exclude',
    '--include',
    '--exclude-from',
    '--include-from',
    '--files-from',
    '--log-file',
    '--backup-dir',
    '--link-dest',
    '--compare-dest',
    '--copy-dest',
    '--partial-dir',
    '--temp-dir',
    '-T',
    '--chown',
    '--chmod',
    '--bwlimit',
    '--port',
    '--max-size',
    '--min-size',
    '--timeout',
  ],
};

/**
 * cp, mv, ln, install, rsync, scp: what lands in the destination. A copy into a directory creates
 * or overwrites entries named after the sources; it does not destroy the directory. Each source
 * is kept with its name, so whoever places the paths can see what it brings.
 */
function readCopy(program: string, words: readonly Word[]): Verdict {
  const given = argsWithout(words, COPY_VALUES[program] ?? []);
  const target = optionValue(words, ['-t', '--target-directory']);
  if (program === 'install' && hasOption(words, 'd', ['--directory'])) {
    return writes(...files(given));
  }
  const sources = target ? given : given.slice(0, -1);
  const dest = target ?? given[given.length - 1];
  if (dest === undefined) return READS;
  const local = sources.filter((s) => !isRemote(s));
  // What is moved away is gone from where it was.
  const gone =
    program === 'mv' || (program === 'rsync' && hasFlag(words, /^--remove-source-files$/))
      ? trees(local)
      : [];
  // A copy to another machine writes nothing here.
  if ((program === 'scp' || program === 'rsync') && isRemote(dest)) return writes(...gone);
  const recursive =
    program === 'mv' ||
    (program === 'cp' && hasOption(words, 'rRa', ['--recursive', '--archive'])) ||
    (program === 'scp' && hasOption(words, 'r', [])) ||
    program === 'rsync';
  // `dir/.` and rsync's `dir/` pour their content into the destination.
  const pours = (s: Word): boolean =>
    posix.basename(s.text) === '.' || (program === 'rsync' && s.text.endsWith('/'));
  const entries = sources.map((s) => ({
    name: s.dynamic ? '*' : pours(s) ? '.' : posix.basename(s.text),
    from: s.dynamic || isRemote(s) ? null : s,
  }));
  const item: Item = { word: dest, tree: recursive, entries };
  // `--delete` removes from the destination what the source does not hold: the tree goes.
  if (hasFlag(words, /^--del(ete.*)?$/)) return writes(...gone, ...trees([dest]));
  return writes(...gone, item);
}

/**
 * tar: extraction lands files in the directory it unpacks into; creation writes the archive. The
 * old form (`tar xzfC a.tgz dir`) takes the values of `f` and `C` from the next words, in order.
 */
function readTar(words: readonly Word[]): Verdict {
  let letters = '';
  let archive: Word | null = optionValue(words, ['--file']);
  let into: Word | null = optionValue(words, ['--directory']);
  const takes = (cluster: string, from: number): number => {
    let at = from;
    for (const ch of cluster) {
      if (ch === 'f') archive = words[at++] ?? archive;
      else if (ch === 'C') into = words[at++] ?? into;
      else if (ch === 'b') at++;
    }
    return at;
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as Word;
    if (i === 1 && /^[a-zA-Z]+$/.test(w.text)) {
      letters += w.text;
      i = takes(w.text, i + 1) - 1;
    } else if (/^-[a-zA-Z]+$/.test(w.text)) {
      letters += w.text.slice(1);
      i = takes(w.text.slice(1), i + 1) - 1;
    }
  }
  const has = (letter: string, long: RegExp): boolean =>
    letters.includes(letter) || hasFlag(words, long);
  if (has('x', /^--(extract|get)$/)) return writes({ word: into ?? word('.'), how: 'land' });
  if (has('c', /^--create$/) || has('r', /^--append$/) || has('u', /^--update$/)) {
    const file = archive as Word | null;
    return file && file.text !== '-' ? writes({ word: file }) : READS;
  }
  return READS;
}

/** What a git command asks of git; see {@link GitQuestion}. */
interface GitAsk {
  against: string[];
  pathspecs: Word[];
  untracked?: boolean;
  ignored?: boolean;
  ifExists?: boolean;
  tracked?: boolean;
  mayFail?: boolean;
  guess?: boolean;
  listTree?: boolean;
  /** git is not asked: only the stand-in counts (`git pull`, whose answer cannot be known). */
  unasked?: boolean;
  /** The stand-in is a possible write, said as a warning when a covered file is there. */
  possible?: boolean;
  unlessAncestor?: [string, string];
  /** The files that exist and that it can touch, should git not answer. */
  touches: FileKinds;
}

/** git's options before the subcommand that take a value as the next word. */
const GIT_VALUED = ['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'];

/**
 * Options before the subcommand that make git read its pathspecs, or find its files, differently
 * from how the question is asked: its answer is not taken.
 */
const GIT_ELSEWHERE =
  /^--(git-dir|work-tree|namespace|glob-pathspecs|noglob-pathspecs|literal-pathspecs|icase-pathspecs)(=|$)/;

/** git's tree with nothing in it: where `git switch --orphan` goes. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const TRACKED_FILES: FileKinds = { tracked: true, untracked: false, ignored: false };

/** git's own options before the subcommand, and the subcommand with what follows it. */
function gitCommand(words: readonly Word[]): {
  dir: Word | null;
  rest: Word[];
  trusted: boolean;
  nocase: boolean;
} {
  const rest = words.slice(1);
  let dir: Word | null = null;
  let trusted = true;
  let nocase = false;
  while (rest[0] && isFlag(rest[0])) {
    const flag = rest.shift() as Word;
    if (GIT_ELSEWHERE.test(flag.text)) trusted = false;
    if (/^--icase-pathspecs$/.test(flag.text)) nocase = true;
    if (flag.text === '-C') {
      // Each `-C` is taken from where the one before it led.
      const to = rest.shift() ?? null;
      dir = to === null || dir === null || to.text.startsWith('/') ? to : joinWords(dir, to);
    } else if (GIT_VALUED.includes(flag.text)) {
      const value = rest.shift();
      // A setting that moves the working tree or changes how paths are matched.
      if (
        flag.text === '-c' &&
        /^core\.(worktree|ignorecase|sparsecheckout)/i.test(value?.text ?? '')
      )
        trusted = false;
    }
  }
  return { dir, rest, trusted, nocase };
}

/** git subcommands that leave refs, the index and the working tree as they are. */
const GIT_LOOKS = new Set([
  ...READ_ONLY_GIT,
  'rev-parse',
  'describe',
  'shortlog',
  'ls-tree',
  'ls-remote',
  'cat-file',
  'merge-base',
  'rev-list',
  'check-ignore',
  'check-attr',
  'check-ref-format',
  'show-ref',
  'show-branch',
  'for-each-ref',
  'name-rev',
  'whatchanged',
  'diff-files',
  'diff-index',
  'diff-tree',
  'range-diff',
  'cherry',
  'count-objects',
  'annotate',
  'reflog',
  'help',
  'version',
  'var',
  'verify-commit',
  'verify-tag',
  'format-patch',
]);

/**
 * Whether a git command can change what git would answer for a later command of the same line:
 * anything but looking (`status`, `log`, `diff`, `stash list`, listing branches, reading config).
 */
function gitChanges(words: readonly Word[]): boolean {
  const { rest } = gitCommand(words);
  const sub = rest[0]?.text;
  if (sub === undefined || GIT_LOOKS.has(sub)) return false;
  const command = [word('git'), ...rest.slice(1)];
  const args = plainArgs(command);
  switch (sub) {
    case 'remote':
      return ['update', 'prune', 'set-head', 'rename', 'remove', 'rm'].includes(
        args[0]?.text ?? '',
      );
    case 'stash':
      return !['list', 'show', 'create'].includes(rest[1]?.text ?? 'push');
    case 'branch':
    case 'tag':
      return (
        !hasFlag(command, /^(-l|--list|-a|--all|-r|--remotes|-v|-vv)$/) &&
        (args.length > 0 || hasFlag(command, /^-[a-zA-Z]*[fmMcCdD]/))
      );
    case 'worktree':
      return args[0]?.text !== 'list';
    case 'submodule':
      return !['status', 'summary'].includes(args[0]?.text ?? 'status');
    case 'config':
      return !(
        hasFlag(command, /^(--get|--get-all|--get-regexp|-l|--list)$/) ||
        (args.length <= 1 && !hasFlag(command, /^--(unset|add|replace-all|rename-section)/))
      );
    default:
      return true;
  }
}

/**
 * Plain arguments of a git subcommand, without the values of its options: `short` holds the
 * letters whose value is the rest of the cluster or the next word (`-b x`, `-bx`, `-fb x`),
 * `long` the long options that take the next word. The values are kept by option.
 */
function gitArgs(
  words: readonly Word[],
  short: string,
  long: readonly string[],
): { args: Word[]; values: Map<string, Word | null>; all: (Word | null)[] } {
  const args: Word[] = [];
  const values = new Map<string, Word | null>();
  const all: (Word | null)[] = [];
  const set = (key: string, value: Word | null): void => {
    values.set(key, value);
    all.push(value);
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.text === '--') {
      args.push(...words.slice(i + 1));
      break;
    }
    if (!isFlag(w)) {
      args.push(w);
      continue;
    }
    if (w.text.startsWith('--')) {
      const eq = w.text.indexOf('=');
      const name = eq === -1 ? w.text : w.text.slice(0, eq);
      if (!long.includes(name)) continue;
      set(name, eq !== -1 ? sliceWord(w, eq + 1) : (words[++i] ?? null));
      continue;
    }
    for (let k = 1; k < w.text.length; k++) {
      const letter = w.text[k] as string;
      if (!short.includes(letter)) continue;
      set(letter, k + 1 < w.text.length ? sliceWord(w, k + 1) : (words[++i] ?? null));
      break;
    }
  }
  return { args, values, all };
}

/**
 * A word git takes for a pathspec whatever else exists: a wildcard, magic (`:(glob)…`, `:/x`),
 * or a path that can only be one (`.`, `./x`, `x/`).
 */
const surelyPathspec = (w: Word): boolean =>
  /[*?[]/.test(w.text) || w.text.startsWith(':') || /^\.\.?(\/|$)|\/$/.test(w.text);

/**
 * A branch switch to `target`: every file that differs between HEAD and it is written. Forced,
 * every local change is thrown away on top: what differs between the working tree and it.
 */
function switchTo(target: string, force: boolean, guess: boolean): GitAsk | null {
  if (target === 'HEAD' && !force) return null;
  return {
    against: force ? [target] : ['HEAD', target],
    pathspecs: [],
    mayFail: true,
    guess,
    touches: TRACKED_FILES,
  };
}

/** A pathspec's magic (`:(top,icase)x`, `:/x`, `:!x`) and what follows it. */
function pathspecMagic(text: string): {
  rest: string;
  top: boolean;
  exclude: boolean;
  icase: boolean;
  literal: boolean;
  glob: boolean;
} {
  const none = { top: false, exclude: false, icase: false, literal: false, glob: false };
  if (!text.startsWith(':')) return { rest: text, ...none };
  const long = /^:\(([^)]*)\)/.exec(text);
  if (long) {
    const names = (long[1] as string).split(',').map((s) => s.trim().replace(/:.*$/, ''));
    return {
      rest: text.slice(long[0].length),
      top: names.includes('top'),
      exclude: names.includes('exclude'),
      icase: names.includes('icase'),
      literal: names.includes('literal'),
      glob: names.includes('glob'),
    };
  }
  const short = /^:([!^/]*):?/.exec(text) as RegExpExecArray;
  const marks = short[1] as string;
  return {
    ...none,
    rest: text.slice(short[0].length),
    top: marks.includes('/'),
    exclude: marks.includes('!') || marks.includes('^'),
  };
}

/**
 * A pathspec with git's own wildcards as patterns that match at least what it does. git's `*`
 * also crosses `/` (`*.pem` matches `certs/server.pem`), which a pattern's `*` does not: each
 * wildcard may therefore also stand for folders in between.
 */
function gitWildcards(text: string): string[] {
  const first = text.search(/[*?[]/);
  if (first === -1) return [text];
  const last = Math.max(text.lastIndexOf('*'), text.lastIndexOf('?'), text.lastIndexOf(']'));
  const head = text.slice(0, first);
  const tail = text.slice(last + 1);
  // What comes before the first wildcard is literal, folders included.
  const cut = head.lastIndexOf('/');
  const dir = cut === -1 ? '' : head.slice(0, cut + 1);
  const start = head.slice(cut + 1);
  if (tail.includes('/')) {
    // The name at the end is literal, whatever lies between.
    return [`${dir}${start}*/**/${tail.slice(tail.lastIndexOf('/') + 1)}`];
  }
  return [`${dir}${start}*${tail}`, `${dir}${start}*/**/*${tail}`];
}

/** git: which subcommands rewrite or remove the working files they are given. */
function readGit(words: readonly Word[]): Verdict {
  const { dir, rest, trusted, nocase } = gitCommand(words);
  const sub = rest[0]?.text;
  if (sub === undefined || GIT_KEEPS_FILES.has(sub)) return READS;
  const command = [word('git'), ...rest.slice(1)];
  const under = (list: readonly Word[]): Word[] =>
    dir ? list.map((w) => joinWords(dir, w)) : [...list];
  const dashes = rest.findIndex((w) => w.text === '--');
  const afterDashes = dashes === -1 ? [] : rest.slice(dashes + 1);
  /**
   * A command that brings files back from the index or a revision. What it changes is what
   * differs: git is asked (`git diff` against `against`, with the pathspecs exactly as given).
   */
  const ask = (...asks: (GitAsk | null)[]): Verdict => {
    const kept = asks.filter((a): a is GitAsk => a !== null);
    return kept.length === 0 ? READS : { kind: 'git', dir, asks: kept, trusted, nocase };
  };
  // Paths read from a file (or standard input) are not known here.
  if (hasFlag(command, /^--pathspec-from-file(=|$)/))
    return { kind: 'unread', why: 'git reads the paths it changes from a file' };
  switch (sub) {
    case 'restore': {
      const staged = hasOption(command, 'S', ['--staged']);
      const worktree = hasOption(command, 'W', ['--worktree']);
      // `--staged` alone only moves the index; the file on disk stays.
      if (staged && !worktree) return READS;
      const { args, values } = gitArgs(command, 's', ['--source']);
      const source = values.get('s') ?? values.get('--source') ?? null;
      if (args.length === 0) return READS;
      // From the index by default; with `--staged` both come from HEAD, or from the source.
      const against = source ? [source.text] : staged ? ['HEAD'] : [];
      return ask({ against, pathspecs: args, touches: TRACKED_FILES });
    }
    case 'rm': {
      if (hasFlag(command, /^--cached$/)) return READS;
      // It removes the tracked files its pathspecs match, as git reads them.
      const paths = argsWithout(command, []);
      return ask(
        paths.length > 0
          ? { against: [], pathspecs: paths, tracked: true, touches: TRACKED_FILES }
          : null,
      );
    }
    case 'mv': {
      const given = argsWithout(command, []);
      const dest = given[given.length - 1];
      if (dest === undefined) return READS;
      const sources = given.slice(0, -1);
      const [to] = under([dest]) as [Word];
      const entries = under(sources).map((s) => ({ name: posix.basename(s.text), from: s }));
      return writes(...trees(under(sources)), { word: to, tree: true, entries });
    }
    case 'clean': {
      if (hasOption(command, 'n', ['--dry-run'])) return READS;
      // Without a path it cleans where it runs; ignored files only with -x / -X, or when an
      // exclude pattern takes a file back out of what is ignored (`-e '!.env'`).
      const { args, all } = gitArgs(command, 'e', ['--exclude']);
      const unignores = all.some((v) => v?.text.startsWith('!') ?? false);
      const how = hasOption(command, 'xX', []) || unignores ? 'clean-ignored' : 'clean';
      // Its paths are pathspecs: git's wildcards cross folders, `:/` is the top of the tree,
      // and pathspecs that only leave files out stand for everything else.
      const items: Item[] = [];
      for (const w of args) {
        const magic = pathspecMagic(w.text);
        if (magic.exclude) continue;
        const bare = magic.rest === '' ? '.' : magic.rest;
        const patterns = magic.literal || magic.glob ? [bare] : gitWildcards(bare);
        for (const p of patterns) {
          const text = magic.top ? `${TOP}/${p}` : p;
          const placed = magic.top ? word(text) : (under([word(text)])[0] as Word);
          items.push({
            word: { ...placed, mask: (magic.literal ? 'q' : 'u').repeat(placed.text.length) },
            tree: true,
            how,
            dotfiles: true,
            nocase: magic.icase,
          });
        }
      }
      return writes(...(items.length > 0 ? items : trees(under([word('.')]), { how })));
    }
    case 'checkout': {
      const force = hasOption(command, 'f', ['--force']);
      const { args, values } = gitArgs(command, 'bB', ['--orphan']);
      if (dashes !== -1) {
        // A revision before `--` brings the files from there; without one, from the index.
        const before = gitArgs([word('git'), ...rest.slice(1, dashes)], 'bB', ['--orphan']).args;
        const revision = before[0];
        return ask({
          against: revision ? [revision.text] : [],
          pathspecs: afterDashes,
          touches: TRACKED_FILES,
        });
      }
      // These only make sense with paths, from the index.
      if (hasFlag(command, /^(--ours|--theirs|-p|--patch)$/))
        return ask({ against: [], pathspecs: args, touches: TRACKED_FILES });
      // A new branch is made at a start point (HEAD by default), and switched to.
      if (values.has('b') || values.has('B') || values.has('--orphan'))
        return ask(switchTo(args[0]?.text ?? 'HEAD', force, false));
      const first = args[0];
      if (first === undefined) return ask(force ? switchTo('HEAD', true, false) : null);
      const target = first.text === '-' ? '@{-1}' : first.text;
      if (args.length >= 2) {
        // A revision followed by paths; or, when there is no revision of that name, paths only.
        return ask(
          { against: [], pathspecs: args, ifExists: true, touches: TRACKED_FILES },
          { against: [target], pathspecs: args.slice(1), mayFail: true, touches: TRACKED_FILES },
        );
      }
      // One word: a wildcard or magic is a pathspec. Any other word is a path when such a file
      // exists, and a branch to switch to when there is one of that name (or a remote one).
      if (surelyPathspec(first))
        return ask({ against: [], pathspecs: [first], touches: TRACKED_FILES });
      return ask(
        { against: [], pathspecs: [first], ifExists: true, touches: TRACKED_FILES },
        switchTo(target, force, true),
      );
    }
    case 'switch': {
      const force = hasOption(command, 'f', ['--force', '--discard-changes']);
      const { args, values } = gitArgs(command, 'cC', ['--create', '--force-create', '--orphan']);
      // An orphan branch starts from nothing: every tracked file goes.
      if (values.has('--orphan')) return ask(switchTo(EMPTY_TREE, force, false));
      const creates = ['c', 'C', '--create', '--force-create'].some((k) => values.has(k));
      const first = args[0]?.text ?? (creates ? 'HEAD' : null);
      if (first === null) return READS;
      return ask(switchTo(first === '-' ? '@{-1}' : first, force, !creates));
    }
    case 'stash': {
      // `git stash [push] [--] [paths]` puts changes away: the files go back to HEAD.
      const verb = rest[1]?.text;
      if (verb === 'pop' || verb === 'apply' || verb === 'branch') {
        // It brings back what was put away: what changed between the stash's base and it, and
        // the untracked files it holds (its third parent). `branch` first switches to its base.
        const given = argsWithout([word('git'), ...rest.slice(2)], []);
        const named = given[verb === 'branch' ? 1 : 0]?.text ?? 'stash@{0}';
        const s = /^\d+$/.test(named) ? `stash@{${named}}` : named;
        const any: FileKinds = { tracked: true, untracked: true, ignored: false };
        return ask(
          verb === 'branch' ? switchTo(`${s}^1`, false, false) : null,
          { against: [`${s}^1`, s], pathspecs: [], mayFail: true, touches: any },
          {
            against: [`${s}^3`],
            pathspecs: [],
            mayFail: true,
            listTree: true,
            touches: any,
          },
        );
      }
      if (
        verb !== undefined &&
        verb !== 'push' &&
        verb !== 'save' &&
        verb !== '--' &&
        !isFlag(rest[1] as Word)
      )
        return READS;
      const tail = [word('git'), ...rest.slice(verb === 'push' || verb === 'save' ? 2 : 1)];
      const paths =
        dashes !== -1 ? afterDashes : verb === 'save' ? [] : argsWithout(tail, ['-m', '--message']);
      const all = hasOption(tail, 'a', ['--all']);
      const untracked = all || hasOption(tail, 'u', ['--include-untracked']);
      return ask({
        against: ['HEAD'],
        pathspecs: paths,
        untracked,
        ignored: all,
        touches: { tracked: true, untracked, ignored: all },
      });
    }
    case 'reset': {
      // With paths, or without --hard, it only moves the index.
      if (!hasFlag(command, /^--(hard|merge|keep)$/)) return READS;
      const revision = argsWithout(command, [])[0]?.text ?? 'HEAD';
      // `--keep` and `--merge` keep local changes (or stop): what changes is what differs
      // between HEAD and where the branch goes.
      if (!hasFlag(command, /^--hard$/)) return ask(switchTo(revision, false, false));
      return ask({ against: [revision], pathspecs: [], touches: TRACKED_FILES });
    }
    case 'merge':
    case 'cherry-pick':
    case 'revert':
    case 'rebase':
    case 'pull':
    case 'am':
    case 'apply': {
      if (hasFlag(command, /^--(check|stat|numstat|summary|cached)$/)) return READS;
      // Files the command line does not name. What a merge brings in is what changed on the
      // other side since the two met; a commit picked or reverted, what it changed; a rebase,
      // what differs between HEAD and where it goes. Whatever else (a pull, a patch, carrying
      // on after a stop) is a possible write of the tracked files.
      const unknown: GitAsk = {
        against: [],
        pathspecs: [],
        unasked: true,
        possible: true,
        touches: TRACKED_FILES,
      };
      if (
        hasFlag(command, /^--(abort|continue|skip|quit)$/) ||
        sub === 'pull' ||
        sub === 'am' ||
        sub === 'apply'
      )
        return ask(unknown);
      const valued = sub === 'merge' ? 'msX' : sub === 'rebase' ? 'sXx' : 'mX';
      const { args, values } = gitArgs(command, valued, [
        '--message',
        '--strategy',
        '--strategy-option',
        '--onto',
        '--exec',
        '--mainline',
        '--gpg-sign',
      ]);
      const revs = args.map((w) => (w.text === '-' ? '@{-1}' : w.text)).filter((x) => x !== '');
      const changes = (against: string[]): GitAsk => ({
        against,
        pathspecs: [],
        mayFail: true,
        touches: TRACKED_FILES,
      });
      // Local changes put away and brought back around it (`--autostash`) are rewritten too.
      const autostash = hasFlag(command, /^--autostash$/)
        ? { against: ['HEAD'], pathspecs: [], touches: TRACKED_FILES }
        : null;
      if (sub === 'merge') {
        // What the other side changed since the two met. Without one named, the upstream.
        const to = revs.length > 0 ? revs : ['@{upstream}'];
        return ask(autostash, ...to.map((x) => changes([`HEAD...${x}`])));
      }
      if (sub === 'rebase') {
        if (revs.length === 0 && hasFlag(command, /^--root$/)) return ask(unknown);
        // `git rebase [--onto X] U [B]`: B is checked out first; then the tree goes to X and B's
        // commits since U are replayed on it. Every file that differs between B and X is written,
        // and every file those commits touch. A branch already on U (and no --onto) stays.
        const onto = optionValue(command, ['--onto'])?.text;
        const upstream = revs[0] ?? '@{upstream}';
        const branch = revs[1];
        const base = branch ?? 'HEAD';
        const stays =
          onto === undefined &&
          !hasFlag(command, /^(-i|--interactive|-f|--force-rebase|--no-ff|-x|--exec)$/);
        const replay = (against: string[]): GitAsk => ({
          ...changes(against),
          ...(stays ? { unlessAncestor: [upstream, base] as [string, string] } : {}),
        });
        return ask(
          autostash,
          branch !== undefined ? switchTo(branch, false, false) : null,
          replay([base, onto ?? upstream]),
          replay([`${upstream}...${base}`]),
        );
      }
      if (revs.length === 0) return ask(unknown);
      // A commit picked or reverted: what it changed against its parent (the one `-m` names). A
      // range `A..B` (either end HEAD when left out): what B's side changed since it left A; a
      // symmetric `A...B`, both sides.
      const parent = values.get('m')?.text ?? values.get('--mainline')?.text ?? '1';
      return ask(
        autostash,
        ...revs.flatMap((x) => {
          const range = /^(.*?)(\.\.\.?)(.*)$/.exec(x);
          if (range === null) return [changes([`${x}^${parent}`, x])];
          const a = range[1] || 'HEAD';
          const b = range[3] || 'HEAD';
          return range[2] === '...'
            ? [changes([`${a}...${b}`]), changes([`${b}...${a}`])]
            : [changes([`${a}...${b}`])];
        }),
      );
    }
    default:
      // They change files the command line does not name.
      return {
        kind: 'unknown',
        args: under(rest.slice(1).filter((w) => !isFlag(w) && looksLikePath(w.text))),
        bare: false,
      };
  }
}

/**
 * A git command whose writes git itself can tell: the files that differ between the working
 * tree and `against` (the index when empty), limited by the pathspecs exactly as given.
 */
export interface GitQuestion {
  /** Where git runs: the directory the command runs in, placed like a target's path. */
  cwd: string;
  /**
   * What the working tree is compared with: nothing (the index) or one revision. Two revisions
   * (HEAD and where a branch switch goes) are compared with each other.
   */
  against: string[];
  /** Pathspecs as the command gives them; empty means the whole tree. */
  pathspecs: string[];
  /** Untracked files the pathspecs match are removed too (`git stash -u`). */
  untracked: boolean;
  /** Ignored files the pathspecs match are removed too (`git stash -a`). */
  ignored: boolean;
  /** Asked only when the first pathspec names a file or directory that exists. */
  ifExists: boolean;
  /** The tracked files the pathspecs match are what is written (`git rm`), not what differs. */
  tracked: boolean;
  /**
   * The revisions are words that may name no revision (`git checkout x`, where `x` may be a
   * path): when there is none, git would write nothing for this reading. With `guess`, a remote
   * branch of that name stands for a missing one, as `git checkout x` makes `x` from `origin/x`.
   */
  mayFail: boolean;
  guess: boolean;
  /** Every file of the one revision is written (the untracked files a stash holds). */
  listTree: boolean;
  /**
   * Nothing is written when the first revision is already in the second's history (a rebase onto
   * an upstream the branch is on stops there).
   */
  unlessAncestor?: [string, string];
  /**
   * Targets of {@link ShellReading.targets} whose `fallback` is this question's index stand for
   * it when git cannot answer.
   */
}

/** A file a shell command names as something it writes. */
export interface ShellTarget {
  /**
   * The path as the command gives it, relative to the directory the command starts in (after any
   * `cd` before it) or absolute. May hold `*`, `?` or `{a,b}` when `glob` is set. A path that
   * starts with `~` is under a home directory that could not be placed here (`~name/x`, or any
   * `~` path when no home was given).
   */
  path: string;
  /** The path is a wildcard pattern. */
  glob: boolean;
  /**
   * The wildcards also match names that start with a dot. A shell's `*` and `?` do not; a
   * pattern a program expands itself (`find -name`, a formatter's glob) does.
   */
  dotfiles: boolean;
  /** The pattern is compared without regard to letter case (`find -iname`). */
  nocase: boolean;
  /** When the path is a directory, everything under it is written too (`rm -r`, `git checkout`). */
  tree: boolean;
  /**
   * How the path is written. `write`: created, rewritten or removed. `land`: files of unknown
   * names are put somewhere inside it (an archive unpacked there). `clean`: the files there that
   * git does not track and does not ignore are removed (`git clean`); `clean-ignored` removes the
   * ignored ones too (`-x`). Either way only files that exist are touched.
   */
  how: 'write' | 'land' | 'clean' | 'clean-ignored';
  /**
   * Set on targets that stand in for a git question (see {@link GitQuestion}) and only count
   * when git could not answer it: its index in {@link ShellReading.questions}.
   */
  fallback: number | null;
  /**
   * For a copy: when the path is a directory, the names that land inside it (`cp a.ts dir`
   * writes `dir/a.ts`; `.` stands for the content of the source itself, `*` for names that are
   * not known); when it is not a directory, the path itself is written. With `tree`, a source
   * that is a directory lands with everything under it.
   */
  entries: string[];
  /** For each of `entries`, the source it comes from, placed like `path`; null when unknown. */
  sources: (string | null)[];
  /**
   * The text shows the write (a redirection, `rm`, `sed -i`, …). False when the path is only an
   * argument of a program Mindly does not know, which may as well just read it.
   */
  certain: boolean;
  /** Only files with these extensions are written (a formatter given a directory); null: all. */
  only: string[] | null;
  /**
   * The word is a path only when a file or directory of that name exists, which the caller
   * checks: a bare word given to an unknown program, or the one word after `git checkout`.
   */
  ifExists: boolean;
  /**
   * Only files that exist there and are of these kinds are touched, nothing the command creates:
   * what a git command that puts back tracked files (`git reset --hard`, `git checkout -- .`)
   * stands for when git cannot say. Null for any file.
   */
  touches: FileKinds | null;
}

/** Kinds of file as git sees them. */
export interface FileKinds {
  tracked: boolean;
  untracked: boolean;
  ignored: boolean;
}

/** What reading a command found. */
export interface ShellReading {
  targets: ShellTarget[];
  /** git commands whose writes git can tell (`git checkout -- x`, `git restore`, `reset --hard`). */
  questions: GitQuestion[];
  /**
   * Set when a limit cut the reading short (a very long command, too many targets, nesting too
   * deep, a path too long, no time left): what was not read may write files, so the targets are
   * not the whole answer.
   */
  limit: string | null;
}

/** What reading a command may know about where it runs. Nothing is looked up here. */
export interface ShellReadOptions {
  /**
   * The user's home directory: `~`, `~/x` and `$HOME` are read as paths under it. Without it they
   * stay as written (`~/x`). `~name/x` (another user's home) always stays as written, for the
   * caller to place.
   */
  home?: string;
  /** Root of the working tree, for `$(git rev-parse --show-toplevel)`. */
  top?: string;
  /**
   * Asked now and then while reading: true when there is no time left. The reading stops there
   * and says so in `limit`.
   */
  timeUp?: () => boolean;
}

// ---------------------------------------------------------------------------------------------
// Inline code (`python -c`, `node -e`, a here-document fed to an interpreter). A quoted path is a
// write target when it is an argument of a call that writes; a path that is only read is nothing;
// any other quoted path is a possible write.
// ---------------------------------------------------------------------------------------------

/** Calls whose first argument is a path they create, rewrite or remove. */
const CODE_WRITES_FIRST = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'writeTextFile',
  'writeTextFileSync',
  'outputFile',
  'outputFileSync',
  'createWriteStream',
  'truncate',
  'truncateSync',
  'mkdir',
  'mkdirSync',
  'mkdirs',
  'makedirs',
  'touch',
  'file_put_contents',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'rmtree',
  'rm_rf',
  'rm_r',
  'rm_f',
  'remove',
  'removeSync',
  'removedirs',
  'emptyDir',
  'emptyDirSync',
  'delete',
]);
/** Of those, the ones that take a directory with all it holds. */
const CODE_REMOVES_TREE =
  /^(rm|rmSync|rmtree|rm_rf|rm_r|remove|removeSync|removedirs|emptyDir|emptyDirSync)$/;
/** Calls that move their first argument onto their second. */
const CODE_MOVES = /^(rename|renameSync|move|moveSync|mv)$/;
/** Calls that write their second argument and only read their first. */
const CODE_WRITES_SECOND =
  /^(copy|copy2|copyfile|copyFile|copyFileSync|copySync|copytree|cp|cpSync|cp_r|symlink|symlinkSync|link|linkSync)$/;
/** Calls that only read the path they are given, or print the text they are given. */
const CODE_READS =
  /^(readFile|readFileSync|read_text|read_bytes|readlines|readTextFile|readTextFileSync|exists|existsSync|stat|statSync|lstat|isfile|isdir|access|accessSync|createReadStream|require|load|loads|loadtxt|file_get_contents|file|readdir|readdirSync|listdir|glob|write|print|println|puts|log|error|warn|info|debug|echo|printf|join|format)$/;
/** Calls that hand a command line to a shell or run a program. */
const CODE_RUNS =
  /^(system|popen|Popen|exec|execSync|execFile|execFileSync|spawn|spawnSync|run|call|check_call|check_output|getoutput|shell_exec|passthru)$/;
/** Methods of a path object that change the file it stands for. */
const PATH_METHOD_WRITES = /^(write_text|write_bytes|unlink|touch|rmdir|mkdir|rename|replace)$/;

interface CodeFinding {
  /** Paths the code writes, and paths it merely names. */
  paths: { text: string; certain: boolean; tree: boolean }[];
  /** Command lines the code runs. */
  commands: string[];
}

/**
 * Paths built from string literals made one literal: `path.join('a', 'b')`,
 * `os.path.join('a', 'b')`, `require('path').join(…)` and `Path('a') / 'b'` become `'a/b'`.
 */
function joinLiterals(code: string): string {
  const lit = `(?:'[^'\\n]{0,256}'|"[^"\\n]{0,256}")`;
  const joined = code.replace(
    new RegExp(
      `(?:\\bos\\.path|\\bpath|\\bposixpath|require\\(\\s*['"](?:node:)?path['"]\\s*\\))\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*((?:${lit}\\s*,\\s*){0,16}${lit})\\s*\\)`,
      'g',
    ),
    (_all, args: string) => {
      const parts = [...args.matchAll(/(['"])([^'"\\\n]*)\1/g)].map((m) => m[2] as string);
      return `'${parts.join('/')}'`;
    },
  );
  // `Path('a') / 'b' / 'c'`: the parts become one path.
  return joined.replace(
    /\b(Path|PurePath|PosixPath)\(\s*(['"])([^'"\\\n]{0,256})\2\s*\)((?:\s*\/\s*(['"])[^'"\\\n]{0,256}\5){1,8})/g,
    (_all, ctor: string, _q: string, head: string, tail: string) => {
      const parts = [...tail.matchAll(/(['"])([^'"\\\n]*)\1/g)].map((m) => m[2] as string);
      return `${ctor}('${[head, ...parts].join('/')}')`;
    },
  );
}

/** `os.open` flags that write. */
const OPEN_WRITE_FLAGS = /\bO_(WRONLY|RDWR|TRUNC|CREAT|APPEND)\b/;

function readCode(source: string): CodeFinding {
  const code = joinLiterals(source.slice(0, MAX_COMMAND_CHARS));
  const out: CodeFinding = { paths: [], commands: [] };
  // Every quoted string, with where it sits.
  const strings: { start: number; end: number; text: string }[] = [];
  for (const m of code.matchAll(/(['"`])((?:(?!\1)[^\\\n]){0,512})\1/g)) {
    strings.push({ start: m.index, end: m.index + m[0].length, text: m[2] as string });
    if (strings.length >= 2000) break;
  }
  /** The call a string is an argument of, and which argument. */
  const roles: ({ chain: string; name: string; at: 1 | 2 } | null)[] = [];
  for (let k = 0; k < strings.length; k++) {
    const s = strings[k] as (typeof strings)[number];
    const before = code.slice(Math.max(0, s.start - 120), s.start);
    // `name(…)`, `name([…])`, or a call without parentheses (`unlink "a"` in Perl and Ruby).
    // A keyword (`file=`) or a string prefix (`f'…'`, `r'…'`) may stand between.
    const call =
      /([A-Za-z_][\w.:]*)\s*\(\s*(\[\s*)?(?:\w+\s*=\s*)?[rbfuRBFU]{0,2}$/.exec(before) ??
      /([A-Za-z_][\w.:]*)[ \t]+$/.exec(before);
    const prev = k > 0 ? (strings[k - 1] as (typeof strings)[number]) : null;
    const prevRole = k > 0 ? (roles[k - 1] ?? null) : null;
    if (call) {
      const chain = call[1] as string;
      roles.push({ chain, name: chain.slice(chain.search(/[^.:]*$/)), at: 1 });
    } else if (prev && prevRole && /^\s*,\s*$/.test(code.slice(prev.end, s.start))) {
      roles.push({ ...prevRole, at: 2 });
    } else roles.push(null);
  }
  const add = (text: string, certain: boolean, tree = false): void => {
    // Perl and shell spell the mode in front of the name (`">a.ts"`).
    const name = text.replace(/^\+?[<>|]+/, '');
    if (name === '' || /\s/.test(name)) return;
    out.paths.push({ text: name, certain, tree });
  };
  for (let k = 0; k < strings.length; k++) {
    const s = strings[k] as (typeof strings)[number];
    const role = roles[k] ?? null;
    const after = code.slice(s.end, s.end + 60);
    // `Path('a').write_text(…)`: the method decides.
    const method = /^\s*\)+\s*\.\s*(\w+)/.exec(after)?.[1];
    if (role && /(^|[.:])(Path|PurePath|PosixPath|Pathname)$/.test(role.chain) && role.at === 1) {
      if (method && PATH_METHOD_WRITES.test(method)) add(s.text, true);
      else if (method === undefined || method === 'open') {
        if (looksLikePath(s.text)) add(s.text, false);
      }
      continue;
    }
    if (role === null) {
      // Not an argument of any call: a mode in front of the name is a write, the rest is named.
      if (/^\+?>/.test(s.text)) add(s.text, true);
      else if (looksLikePath(s.text)) add(s.text, false);
      continue;
    }
    const { name, chain, at } = role;
    if (CODE_RUNS.test(name)) {
      // A command line, or the words of one in a list (`run(['rm', 'a.ts'])`).
      if (at === 1) {
        const words = [s.text];
        for (let j = k + 1; j < strings.length && roles[j]?.at === 2; j++) {
          if (roles[j]?.chain !== chain) break;
          words.push((strings[j] as (typeof strings)[number]).text);
        }
        const list = /\[\s*$/.test(code.slice(Math.max(0, s.start - 8), s.start));
        out.commands.push(list ? words.join(' ') : s.text);
      }
      continue;
    }
    if (name === 'open' || name === 'fopen') {
      if (at !== 1) continue;
      // `os.open(p, os.O_WRONLY | …)`: the flags say.
      if (/(^|\.)os\.open$/.test(chain)) {
        if (OPEN_WRITE_FLAGS.test(after)) add(s.text, true);
        continue;
      }
      // The mode is the second argument or `mode=`; without one the file is only read. A mode
      // that is not a literal read mode (a variable, an expression) may write.
      const given = /^\s*,\s*(?:mode\s*=\s*)?(?:(['"])([^'"]*)\1|([A-Za-z_][\w.]*))/.exec(after);
      const keyword = /^\s*,(?:[^,)]*,)*?\s*mode\s*=\s*(?:(['"])([^'"]*)\1|([A-Za-z_][\w.]*))/.exec(
        after,
      );
      const m = keyword ?? given;
      const literal = m?.[2];
      const variable = m?.[3];
      if (/^\+?>/.test(s.text)) add(s.text, true);
      else if (literal !== undefined && /[wax+]/.test(literal)) add(s.text, true);
      else if (
        variable !== undefined &&
        !/^(encoding|newline|buffering|errors|closefd)$/.test(variable)
      )
        add(s.text, true);
      continue;
    }
    if (at === 1 && (name === 'write' || name === 'write_file') && /^(File|IO|fs)\./.test(chain)) {
      add(s.text, true);
      continue;
    }
    if (CODE_MOVES.test(name) || /(^|\.)os\.replace$/.test(chain)) {
      add(s.text, true, true);
      continue;
    }
    if (CODE_WRITES_SECOND.test(name)) {
      if (at === 2) add(s.text, true, true);
      continue;
    }
    if (CODE_WRITES_FIRST.has(name)) {
      if (at === 1) add(s.text, true, CODE_REMOVES_TREE.test(name));
      continue;
    }
    if (CODE_READS.test(name)) continue;
    if (/^\+?>/.test(s.text)) add(s.text, true);
    else if (looksLikePath(s.text)) add(s.text, false);
  }
  return out;
}

/**
 * The files a shell command names as write targets, read from its text: redirections, the
 * arguments of programs that write what they are given (`rm`, `mv`, `cp`, `sed -i`, `tee`, …),
 * arguments of programs Mindly does not know, and paths written by inline scripts. Programs
 * known to only read or check (`cat`, `grep`, `sed -n`, test runners, linters without a fixing
 * flag) contribute nothing but their redirections. `cd`, `pushd` and `popd` are followed. A
 * target is `certain` when the text shows the write, and not when the path is merely given to an
 * unknown program.
 *
 * This is a reading of text, not a sandbox: a program can write files it never names, and a path
 * held in a variable or passed through a pipe is not seen. What it aims for is the common cases
 * in both directions, so a read is not blocked and a plain write is not missed.
 */
export function readShellWrites(command: string, options: ShellReadOptions = {}): ShellReading {
  const reading: Reading = {
    out: new Map(),
    limit: null,
    home: options.home ?? null,
    top: options.top ?? null,
    timeUp: options.timeUp ?? (() => false),
    commands: 0,
    questions: [],
    moved: false,
  };
  collectTargets(command, '', 0, reading);
  return {
    targets: [...reading.out.values()],
    questions: reading.questions,
    limit: reading.limit,
  };
}

/** The targets of {@link readShellWrites}. */
export function shellWriteTargets(command: string, options: ShellReadOptions = {}): ShellTarget[] {
  return readShellWrites(command, options).targets;
}

interface Reading {
  out: Map<string, ShellTarget>;
  limit: string | null;
  home: string | null;
  top: string | null;
  timeUp: () => boolean;
  /** Simple commands read so far, over every nested reading. */
  commands: number;
  questions: GitQuestion[];
  /**
   * A command read so far may have changed what git would answer for a later one: a git command
   * that is not only looking, a program or script that may run git, a `cd` out of the tree.
   */
  moved: boolean;
}

/**
 * The text of a word as a path pattern: unquoted `*` and `?` stay wildcards, an unquoted `[…]`
 * class becomes `?` (one character), and braces the expansion left alone stay alternatives.
 * `classes` says the word also has a reading with the class kept as written, which is what the
 * shell uses when nothing matches.
 */
function wordPattern(w: Word): { pattern: string; glob: boolean; classes: boolean } {
  let pattern = '';
  let glob = false;
  let classes = false;
  for (let i = 0; i < w.text.length; i++) {
    const ch = w.text[i] as string;
    const bare = w.mask[i] === 'u';
    if (bare && ch === '[') {
      const end = w.text.indexOf(']', i + 2);
      if (
        end !== -1 &&
        end - i <= 64 &&
        w.mask[end] === 'u' &&
        !w.text.slice(i, end).includes('/')
      ) {
        pattern += '?';
        glob = true;
        classes = true;
        i = end;
        continue;
      }
    }
    if (bare && (ch === '*' || ch === '?')) glob = true;
    if (bare && ch === '{' && /^\{[^{}]{0,256},[^{}]{0,256}\}/.test(w.text.slice(i, i + 520)))
      glob = true;
    pattern += ch;
  }
  return { pattern, glob, classes };
}

function collectTargets(command: string, startDir: string | null, depth: number, r: Reading): void {
  if (depth > MAX_DEPTH) {
    r.limit ??= 'commands nested too deep';
    return;
  }
  const parsed = parse(command, r.timeUp);
  if (parsed.cut === 'length') {
    r.limit ??= `only the first ${MAX_COMMAND_CHARS} characters were read`;
  } else if (parsed.cut === 'time') r.limit ??= 'no time was left to read all of it';
  // The directory later commands run in, relative to where the command started; null when a
  // `cd` went somewhere that cannot be read from the text.
  let dir: string | null = startDir;
  // Where `cd -` goes back to, and what `pushd` put away.
  let previous: string | null = startDir;
  let stack: (string | null)[] = [];
  // What to return to when each open `( … )` ends.
  const outer: { dir: string | null; previous: string | null; stack: (string | null)[] }[] = [];
  let bare = 0;

  /**
   * A word as a path, seen from `from`: relative to where the whole command started, or absolute,
   * or under a home directory (`~…`). Marks and `~` are placed. Null when it cannot be known.
   */
  const place = (text: string, tilde: boolean, from: string | null): string | null => {
    if (text.length > MAX_PATH_CHARS) {
      r.limit ??= `a path longer than ${MAX_PATH_CHARS} characters was not read`;
      return null;
    }
    let fixed: string | null = null;
    if (text.startsWith(HERE) || text.startsWith(BACK)) {
      const at = text.startsWith(HERE) ? from : previous;
      if (at === null) return null;
      fixed = posix.join(at, `./${text.slice(1)}`);
    } else if (text.startsWith(HOME)) {
      fixed = r.home !== null ? posix.join(r.home, `./${text.slice(1)}`) : `~${text.slice(1)}`;
    } else if (text.startsWith(TOP)) {
      if (r.top === null) return null;
      fixed = posix.join(r.top, `./${text.slice(1)}`);
    } else if (tilde) {
      // Written outside quotes, `~` is a home directory; inside, it is a file name.
      const other = /^~([+-])(\/.*)?$/.exec(text);
      if (other) {
        // `~+` is the working directory, `~-` the one before it.
        const at = other[1] === '+' ? from : previous;
        if (at === null) return null;
        fixed = posix.join(at, `./${other[2] ?? ''}`);
      } else if (r.home !== null && text === '~') fixed = r.home;
      else if (r.home !== null && text.startsWith('~/')) fixed = posix.join(r.home, text.slice(2));
      else fixed = text;
    } else if (posix.isAbsolute(text)) {
      fixed = text;
    }
    const out = fixed ?? (from === null ? null : posix.join(from, text));
    if (out === null || MARKS.test(out)) return null;
    if (out.length > MAX_PATH_CHARS) {
      r.limit ??= `a path longer than ${MAX_PATH_CHARS} characters was not read`;
      return null;
    }
    // A path under a home directory that could not be placed keeps its `~`.
    const path = posix.normalize(out);
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
  };
  /** Whether a word starts with a `~` the shell expands (written outside quotes). */
  const tilde = (w: Word): boolean => w.text.startsWith('~') && w.mask.startsWith('u');

  const add = (item: Item, from: string | null = dir): void => {
    const w = item.pattern ? { ...item.word, mask: 'u'.repeat(item.word.text.length) } : item.word;
    if (w.dynamic || w.text === '' || w.text === '-') return;
    if (w.cut) r.limit ??= `a brace expansion of more than ${MAX_BRACE_WORDS} words`;
    const { pattern, glob, classes } = wordPattern(w);
    // A `[…]` class the shell cannot match stays in the name as written: both readings count.
    const forms = classes
      ? [
          { text: pattern, glob },
          { text: w.text, glob: false },
        ]
      : [{ text: pattern, glob }];
    const certain = item.certain ?? true;
    const only = item.only ?? null;
    const how = item.how ?? 'write';
    const entries = (item.entries ?? []).map((e) => ({
      name: e.name,
      source: e.from === null || e.from.dynamic ? null : place(e.from.text, tilde(e.from), from),
    }));
    for (const form of forms) {
      const path = place(form.text, tilde(w), from);
      if (path === null || /^\/(dev|proc)\//.test(path)) continue;
      const fallback = item.fallback ?? null;
      const touches = item.touches ?? null;
      const kinds = touches
        ? `${touches.tracked ? 't' : ''}${touches.untracked ? 'u' : ''}${touches.ignored ? 'i' : ''}`
        : '';
      const key = `${path}\0${form.glob ? 'g' : ''}${item.ifExists ? 'e' : ''}${item.nocase ? 'c' : ''}${how}\0${fallback}\0${kinds}`;
      const known = r.out.get(key);
      if (known) {
        known.tree ||= item.tree ?? false;
        // The kinds of file written are those of the surest mention; equally sure ones add up.
        if (certain && !known.certain) known.only = only;
        else if (certain === known.certain) {
          known.only =
            known.only === null || only === null ? null : [...new Set([...known.only, ...only])];
        }
        known.certain ||= certain;
        known.dotfiles ||= item.dotfiles ?? false;
        for (const e of entries) {
          if (known.entries.length >= MAX_ENTRIES) break;
          known.entries.push(e.name);
          known.sources.push(e.source);
        }
        continue;
      }
      if (r.out.size >= MAX_TARGETS) {
        r.limit ??= `more than ${MAX_TARGETS} write targets`;
        return;
      }
      r.out.set(key, {
        path,
        glob: form.glob,
        dotfiles: item.dotfiles ?? false,
        nocase: item.nocase ?? false,
        tree: item.tree ?? false,
        how,
        entries: entries.slice(0, MAX_ENTRIES).map((e) => e.name),
        sources: entries.slice(0, MAX_ENTRIES).map((e) => e.source),
        certain,
        only,
        ifExists: item.ifExists ?? false,
        fallback,
        touches,
      });
    }
  };
  /** Where a `cd` to `to` leads from `from`; null when unknown. */
  const enter = (to: Word, from: string | null): string | null =>
    to.dynamic ? null : place(to.text, tilde(to), from);
  /** Whether a directory is inside the working tree the command line starts in, as far as known. */
  const insideTop = (at: string | null): boolean =>
    at !== null &&
    (/^(\/|~|\.\.(\/|$))/.test(at)
      ? r.top !== null && (at === r.top || at.startsWith(`${r.top}/`))
      : true);

  let before: SimpleCommand | null = null;
  // Where the shell was before the last `cd`, for the command after `cd … ||`: that one runs
  // only when the `cd` failed.
  let beforeCd: string | null = null;
  let wasCd = false;
  for (const cmd of parsed.commands) {
    if (cmd.subshell === 'open') {
      outer.push({ dir, previous, stack: [...stack] });
      before = null;
      continue;
    }
    if (cmd.subshell === 'close') {
      // An unmatched `)` (a `case` pattern) closes nothing.
      const back = outer.pop();
      if (back) ({ dir, previous, stack } = back);
      before = null;
      continue;
    }
    // A command line can hold more commands than there is time or reason to read.
    r.commands++;
    if (r.commands > MAX_COMMANDS) {
      r.limit ??= `more than ${MAX_COMMANDS} commands`;
      return;
    }
    if (r.commands % 64 === 0 && r.timeUp()) {
      r.limit ??= 'no time was left to read all of it';
      return;
    }
    // Substitutions run where they are written, before the command that holds them.
    const at = cmd.otherwise && wasCd ? beforeCd : dir;
    wasCd = false;
    for (const inner of cmd.nested) collectTargets(inner, at, depth + 1, r);
    // The shell expands a here-document whose delimiter is not quoted: substitutions in it run.
    if (cmd.stdin !== null && cmd.stdinExpands) {
      for (const inner of substitutions(cmd.stdin)) collectTargets(inner, at, depth + 1, r);
    }
    const { words, chdir } = programWords(cmd.words);
    const here = chdir ? enter(chdir, at) : at;
    for (const red of cmd.redirects) if (red.op.startsWith('>')) add({ word: red.target }, here);
    // What the program reads on standard input, when the text shows it: its own here-document,
    // or what an `echo` / `printf` / `cat <<EOF` before the pipe prints.
    let stdin = cmd.stdin;
    if (stdin === null && cmd.piped && before !== null) {
      const feeder = programWords(before.words).words;
      const name = feeder[0] && !feeder[0].dynamic ? programName(feeder[0]) : '';
      if (name === 'echo' || name === 'printf') {
        const flags = feeder.slice(1).filter((w) => name === 'echo' && /^-[neE]+$/.test(w.text));
        const text = feeder
          .slice(1 + flags.length)
          .map((w) => w.text)
          .join(' ');
        // printf, and echo -e, turn `\n` into the line ends that separate commands.
        const escapes = name === 'printf' || flags.some((w) => w.text.includes('e'));
        stdin = escapes
          ? text.replace(/\\([ntr\\])/g, (_, c: string) =>
              c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : '\\',
            )
          : text;
      } else if (name === 'cat' && feeder.length === 1) stdin = before.stdin;
    }
    before = cmd;
    const verdict = classify(words, stdin);
    switch (verdict.kind) {
      case 'reads':
        break;
      case 'cd': {
        if (chdir || cmd.apart) break;
        beforeCd = dir;
        wasCd = true;
        if (verdict.how === 'popd') {
          if (stack.length > 0) {
            previous = dir;
            dir = stack.pop() as string | null;
          }
          break;
        }
        const to = verdict.dir;
        let next: string | null;
        if (to === null) {
          // A bare `cd` goes home; a bare `pushd` swaps with the directory it put away.
          if (verdict.how === 'pushd') {
            if (stack.length === 0) break;
            next = stack.pop() as string | null;
          } else next = r.home;
        } else if (to.text === '-' && !to.dynamic) next = previous;
        else next = enter(to, dir);
        if (verdict.how === 'pushd' && stack.length < 256) stack.push(dir);
        previous = dir;
        dir = next;
        // Into another repository, maybe: git commands there may move what later ones ask about.
        if (!insideTop(next)) r.moved = true;
        break;
      }
      case 'writes':
        for (const item of verdict.items) add(item, here);
        break;
      case 'unread':
        r.limit ??= verdict.why;
        break;
      case 'git': {
        // git runs where the command runs, or where `-C` sends it.
        const at = verdict.dir ? enter(verdict.dir, here) : here;
        if (at === null) {
          r.limit ??= 'a git command runs in a folder the text does not tell';
          break;
        }
        // What git says now is what the command would do now: not once an earlier command of
        // the line may have changed it, nor with settings that change where git finds its files
        // or how it reads its paths. After such a command, the paths it names are written; what it
        // does to the whole tree (a switch, a merge, a pop) is a possible write.
        const settled =
          verdict.trusted && !r.moved && !cmd.words.some((w) => /^GIT_[A-Z_]+=/.test(w.text));
        // The whole working tree, for a command given no path: from its top when it is the tree
        // the command line starts in.
        const top = r.top !== null && insideTop(at);
        for (const q of verdict.asks) {
          if (q.pathspecs.some((w) => w.dynamic)) continue;
          let index: number | undefined;
          if (settled && !q.unasked && r.questions.length < MAX_QUESTIONS) {
            index = r.questions.length;
            r.questions.push({
              cwd: at,
              against: q.against,
              pathspecs: q.pathspecs.map((w) => w.text),
              untracked: q.untracked ?? false,
              ignored: q.ignored ?? false,
              ifExists: q.ifExists ?? false,
              tracked: q.tracked ?? false,
              mayFail: q.mayFail ?? false,
              guess: q.guess ?? false,
              listTree: q.listTree ?? false,
              ...(q.unlessAncestor !== undefined ? { unlessAncestor: q.unlessAncestor } : {}),
            });
          }
          // Should git not answer, or not be asked: the paths it was given, and for the whole
          // tree the files of the kinds it touches that exist there. Pathspecs that only leave
          // files out stand for everything else.
          const certain = !q.possible;
          if (q.pathspecs.every((w) => pathspecMagic(w.text).exclude)) {
            add(
              {
                word: word(top ? TOP : '.'),
                tree: true,
                certain: certain && !r.moved,
                fallback: index,
                touches: q.touches,
              },
              at,
            );
            continue;
          }
          for (const w of q.pathspecs) {
            const magic = pathspecMagic(w.text);
            // A pathspec that leaves files out writes nothing itself.
            if (magic.exclude) continue;
            const bare = magic.rest === '' ? '.' : magic.rest;
            const fromTop = magic.top && top;
            const patterns = magic.literal || magic.glob ? [bare] : gitWildcards(bare);
            for (const p of patterns) {
              const text = fromTop ? `${TOP}/${p}` : p;
              add(
                {
                  word: {
                    text,
                    mask: (magic.literal ? 'q' : 'u').repeat(text.length),
                    dynamic: false,
                    cut: w.cut,
                  },
                  tree: true,
                  // The whole tree after a change is a possible write, like a command given no path.
                  certain: certain && !(r.moved && bare === '.'),
                  fallback: index,
                  ifExists: q.ifExists ?? false,
                  // git's wildcards also match names that start with a dot.
                  dotfiles: true,
                  nocase: verdict.nocase || magic.icase,
                  // The whole tree, and anything `git rm` is given (it only removes tracked
                  // files): the files of the kinds it touches that are there.
                  ...(bare === '.' || q.tracked ? { touches: q.touches } : {}),
                },
                at,
              );
            }
          }
        }
        break;
      }
      case 'inline':
        collectTargets(verdict.code, here, depth + 1, r);
        break;
      case 'script': {
        const found = readCode(verdict.code);
        for (const p of found.paths) {
          // A bare name is a path only when a file of that name exists.
          const item: Item = { word: word(p.text, true), certain: p.certain, tree: p.tree };
          if (looksLikePath(p.text)) add(item, here);
          else if (p.certain && /^[\w@+.-]+$/.test(p.text)) add({ ...item, ifExists: true }, here);
        }
        for (const line of found.commands) collectTargets(line, here, depth + 1, r);
        break;
      }
      case 'unknown':
        // A program Mindly does not know may write what it is given, or only read it. A
        // directory it is given may be walked, so it counts with everything under it. Text with
        // spaces in it is a message or a command for somewhere else, not a path.
        for (const w of verdict.args) {
          if (w.dynamic) continue;
          if (isFlag(w)) {
            const eq = w.text.indexOf('=');
            if (eq !== -1 && looksLikePath(w.text.slice(eq + 1)))
              add({ word: sliceWord(w, eq + 1), tree: true, certain: false }, here);
          } else if (looksLikePath(w.text)) {
            add({ word: w, tree: true, certain: false }, here);
          } else if (verdict.bare && bare < MAX_BARE_WORDS && /^[\w@+-]+$/.test(w.text)) {
            bare++;
            add({ word: w, tree: true, certain: false, ifExists: true }, here);
          }
        }
        break;
    }
    // What git says about a later command no longer holds once this one ran: a git command that
    // is not only looking, or a program or script that may run git.
    if (words[0] !== undefined && !words[0].dynamic && programName(words[0]) === 'git') {
      if (gitChanges(words)) r.moved = true;
    } else if (
      verdict.kind === 'unknown' ||
      verdict.kind === 'script' ||
      verdict.kind === 'unread' ||
      (words[0] !== undefined && (words[0].dynamic || RUNS_ELSEWHERE.has(programName(words[0]))))
    ) {
      r.moved = true;
    } else if (
      [
        ...(verdict.kind === 'writes' ? verdict.items.map((x) => x.word) : []),
        ...cmd.redirects.filter((red) => red.op.startsWith('>')).map((red) => red.target),
      ].some((w) => /(^|\/)\.git(\/|$)/.test(w.text))
    ) {
      // A write inside `.git` itself.
      r.moved = true;
    }
  }
}

/** The commands of `$(…)` and backtick substitutions in a text the shell expands. */
function substitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < 20; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      out.push(text.slice(i + 2, j - 1));
      i = j - 1;
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) break;
      out.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

/** Whether every part of the command is a known read-only program without output redirection. */
export function isReadOnlyCommand(command: string): boolean {
  const parsed = parse(command);
  if (parsed.cut) return false;
  for (const cmd of parsed.commands) {
    // Command substitution can run anything.
    if (cmd.nested.length > 0) return false;
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
    if (program === 'sed' || program === 'sort') {
      if (classify(words, null).kind !== 'reads') return false;
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
