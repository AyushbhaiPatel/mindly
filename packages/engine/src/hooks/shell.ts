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

/** `text` without the run of `ch` it ends with; a loop, as a regex takes quadratic time here. */
const trimEnd = (text: string, ch: string): string => {
  let end = text.length;
  while (end > 0 && text[end - 1] === ch) end--;
  return text.slice(0, end);
};

/**
 * A test for "does this command name `path`, its basename, or a directory above it?", prepared
 * once per command: its words are split up front, so asking about many paths costs set lookups
 * instead of a regular expression per path and directory.
 */
export function pathNamer(command: string): (path: string) => boolean {
  const names = new Set<string>();
  for (const raw of command.split(/[\s'"`;|&()<>=:,]+/)) {
    const word = trimEnd(raw.replace(/^\.\//, ''), '/');
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

/** `NAME=value`, or `NAME+=value`, which adds to the value: both set the variable. */
const isAssignment = (w: Word): boolean =>
  w.mask.startsWith('u') && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text);

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
  /** Shell code it runs: in a shell of its own, or in this one (`same`: `eval`, `trap`). */
  | { kind: 'inline'; code: string; same?: boolean }
  | { kind: 'script'; code: string }
  | {
      kind: 'git';
      dir: Word | null;
      asks: GitAsk[];
      /** Files and folders it names as such (an output file, a clone's folder), placed already. */
      items?: Item[];
      trusted: boolean;
      nocase: boolean;
      /** The working tree git is told to use (`--work-tree`); null for the one it finds. */
      workTree: Word | null;
      /** Shell code it runs (`git rebase --exec`). */
      exec?: string[];
    }
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
      return readGit(words, stdin);
    case 'trap':
      // The first argument is what runs when the signal comes.
      return args[0] && args.length > 1
        ? { kind: 'inline', code: args[0].text, same: true }
        : READS;
    case 'alias': {
      const code = args
        .filter((w) => w.text.includes('='))
        .map((w) => w.text.slice(w.text.indexOf('=') + 1));
      return code.length > 0 ? { kind: 'inline', code: code.join('\n'), same: true } : READS;
    }
    case 'eval':
      return {
        kind: 'inline',
        same: true,
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
const GIT_VALUED = [
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--attr-source',
  '--super-prefix',
  '--list-cmds',
];

/**
 * Options before the subcommand that make git read its pathspecs, or find its files, differently
 * from how the question is asked: its answer is not taken.
 */
const GIT_ELSEWHERE =
  /^--(git-dir|work-tree|namespace|glob-pathspecs|noglob-pathspecs|literal-pathspecs|icase-pathspecs)(=|$)/;

/** git's tree with nothing in it: where `git switch --orphan` goes. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Settings that `-c` may give a single command without changing what it does to files: how it
 * prints, who commits. Any other may run a program or move what git works on.
 */
const GIT_HARMLESS_CONFIG =
  /^(color\.[\w.-]+|advice\.[\w.-]+|user\.(name|email)|log\.[\w.-]+|i18n\.[\w.-]+|column\.[\w.-]+|format\.pretty|core\.quotepath|diff\.(noprefix|mnemonicprefix)|init\.defaultbranch|status\.(short|branch|showstash)|(commit|tag)\.gpgsign)$/i;

/** A pager setting is harmless only as a pager that just shows text. */
const GIT_PAGER_SETTING = /^(core\.pager|pager\.[\w.-]+)$/i;
const HARMLESS_PAGER = /^(cat|less|more|true|false)?$/;

/**
 * Variables that may be set for git, or exported before it, without changing what it does to
 * files: how it prints, and who commits when. Any other may point git at other settings or files
 * (`HOME`, `XDG_CONFIG_HOME`, `GIT_DIR`, `GIT_CONFIG_*`) or run a program (`EDITOR`, `PATH`,
 * `SSH_ASKPASS`, `GIT_EXTERNAL_DIFF`).
 */
function harmlessVariable(name: string, value: string, adds: boolean): boolean {
  if (/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(name)) return true;
  if (/^(GIT_TERMINAL_PROMPT|LANG|LANGUAGE|LC_[A-Z]+|TZ|NO_COLOR|TERM)$/.test(name)) return true;
  // What `+=` adds to is not known here, so the value it ends with is not either.
  if (adds) return false;
  if (name === 'GIT_PAGER' || name === 'PAGER') return /^(cat|less)?$/.test(value);
  if (/^(GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL)$/.test(name))
    return /^(true|:|cat)?$/.test(value);
  return false;
}

/** A variable word: `X=…`, `X+=…`, or a bare name (`export X`). */
const variableWord = (w: Word): { name: string; value: string | null; adds: boolean } | null => {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(\+?)=(.*))?$/s.exec(w.text);
  return m ? { name: m[1] as string, value: m[3] ?? null, adds: m[2] === '+' } : null;
};

/**
 * A variable set in a way that may change what git does: `X=…`, `X+=…`, or a bare name that
 * `export` gives a value set before. Harmless ones are left out.
 */
const unsafeVariable = (w: Word): boolean => {
  const v = variableWord(w);
  return v !== null && !harmlessVariable(v.name, v.value ?? '', v.adds);
};

/**
 * A variable that may already be in the environment, so that setting it without `export` still
 * reaches git: one named the way environment variables are (`HOME`, `PATH`, `GIT_DIR`). A
 * lower-case name (`msg=fix`) is the shell's own unless it is exported.
 */
const environmentName = (w: Word): boolean =>
  /^[A-Z_][A-Z0-9_]*$/.test(variableWord(w)?.name ?? '');

/** Shell words that set variables for the commands after them (`export GIT_DIR=x`). */
const EXPORTS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

/**
 * Whether a command that sets variables (`export`, `declare`, an assignment alone) may change
 * what a later git command runs with. `allExport`: `set -a` is on, so every variable set is
 * exported. Variables set without being exported reach git only when already in the environment.
 */
function setsGitVariable(
  program: string,
  cmd: SimpleCommand,
  words: readonly Word[],
  allExport: boolean,
): boolean {
  if (words.length === 0) {
    // Assignments alone: `X=1; git …`.
    return cmd.words.some(
      (w) => isAssignment(w) && unsafeVariable(w) && (allExport || environmentName(w)),
    );
  }
  if (!EXPORTS.has(program)) return false;
  const flags = words.slice(1).filter(isFlag);
  const names = words.slice(1).filter((w) => !isFlag(w) && !w.text.startsWith('+'));
  // `-f` names functions; `export -n` takes the export away (as `declare +x` does).
  const letters = flags.filter((f) => !f.text.startsWith('--')).map((f) => f.text.slice(1));
  if (letters.some((l) => l.includes('f'))) return false;
  if (program === 'export' && letters.some((l) => l.includes('n'))) return false;
  const exported = program === 'export' || allExport || letters.some((l) => l.includes('x'));
  return names.some(
    (w) =>
      unsafeVariable(w) && (exported || (environmentName(w) && variableWord(w)?.value !== null)),
  );
}

/** `set -a` / `set -o allexport` turns exporting every variable on, `set +a` off; null: neither. */
function allExportSet(words: readonly Word[]): boolean | null {
  let on: boolean | null = null;
  for (let i = 1; i < words.length; i++) {
    const t = (words[i] as Word).text;
    if (/^[-+]o$/.test(t) && words[i + 1]?.text === 'allexport') on = t === '-o';
    else if (/^-[a-zA-Z]*a/.test(t)) on = true;
    else if (/^\+[a-zA-Z]*a/.test(t)) on = false;
  }
  return on;
}

const TRACKED_FILES: FileKinds = { tracked: true, untracked: false, ignored: false };
/** Any file that is there, whatever git makes of it. */
const ANY_FILE: FileKinds = { tracked: true, untracked: true, ignored: true };

/** git's own options before the subcommand, and the subcommand with what follows it. */
function gitCommand(words: readonly Word[]): {
  dir: Word | null;
  rest: Word[];
  trusted: boolean;
  nocase: boolean;
  /** The working tree git is told to use instead of the one it finds (`--work-tree`). */
  workTree: Word | null;
  /** A setting given here may run a program or move what git works on. */
  unsafe: boolean;
  /** Shell code a setting given here runs (`-c alias.x='!…'`). */
  exec: string[];
} {
  const rest = words.slice(1);
  let dir: Word | null = null;
  let trusted = true;
  let nocase = false;
  let workTree: Word | null = null;
  let unsafe = false;
  const exec: string[] = [];
  while (rest[0] && isFlag(rest[0])) {
    const flag = rest.shift() as Word;
    if (GIT_ELSEWHERE.test(flag.text)) trusted = false;
    if (/^--(git-dir|config-env)(=|$)|^--exec-path=/.test(flag.text)) unsafe = true;
    if (flag.text.startsWith('--work-tree=')) workTree = sliceWord(flag, '--work-tree='.length);
    else if (flag.text === '--work-tree') workTree = rest[0] ?? null;
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
      const set = /^core\.worktree=/i.exec(value?.text ?? '');
      if (set && value) workTree = sliceWord(value, set[0].length);
      if (flag.text === '-c' && value && !set) {
        const at = value.text.indexOf('=');
        const key = at === -1 ? value.text : value.text.slice(0, at);
        const val = at === -1 ? '' : value.text.slice(at + 1);
        const harmless =
          GIT_HARMLESS_CONFIG.test(key) ||
          (GIT_PAGER_SETTING.test(key) && HARMLESS_PAGER.test(val));
        if (!harmless) unsafe = true;
        // An alias that starts with `!` is shell code.
        if (/^alias\./i.test(key) && val.startsWith('!')) exec.push(val.slice(1));
      }
    }
  }
  return { dir, rest, trusted, nocase, workTree, unsafe, exec };
}

/**
 * What a git subcommand's options are, for reading its words: the short letters that take a
 * value (`short`), or take one only when it is attached (`attached`, as in `-M50%`), and the long
 * names that take a value (`long`) or not (`flags`), so an abbreviation of either is read as git
 * reads it. `strict`: an option not known here makes the command a change of the whole tree.
 *
 * For a subcommand that only looks or only moves refs, `safe` lists the options that keep it so;
 * any other option it is given (one that runs a program or writes a file, one not known here, an
 * abbreviation that cannot be told) makes it a change of the whole tree. `'any'` says none of its
 * options writes a working file or runs a program given in the text. `output` names the options
 * whose value is a file it writes.
 */
interface GitOptions {
  short?: string;
  attached?: string;
  long?: readonly string[];
  flags?: readonly string[];
  strict?: boolean;
  safe?: 'any' | { letters: string; long: readonly string[] };
  output?: readonly string[];
}

const optionNames = (text: string): string[] => text.split(/\s+/).filter((x) => x !== '');

/** Display and selection options of the commands that show history and differences. */
const DIFF_LOG_SAFE = {
  letters: 'pusztrcMCBDRawbnUWlLSGmiIEFPvefqOX0123456789',
  long: optionNames(`--stat --numstat --shortstat --dirstat --dirstat-by-file --summary --patch
    --no-patch --patch-with-raw --patch-with-stat --name-only --name-status --raw --oneline
    --graph --decorate --no-decorate --color --no-color --color-words --color-moved
    --color-moved-ws --abbrev-commit --no-abbrev-commit --abbrev --no-abbrev --full-index
    --binary --patience --histogram --minimal --anchored --indent-heuristic
    --no-indent-heuristic --word-diff --word-diff-regex --ignore-space-change
    --ignore-all-space --ignore-space-at-eol --ignore-blank-lines --ignore-cr-at-eol
    --ignore-matching-lines --ignore-submodules --first-parent --merges --no-merges --reverse
    --all --branches --tags --remotes --glob --exclude --follow --full-diff --relative
    --no-relative --text --no-ext-diff --no-textconv --renames --no-renames --find-renames
    --find-copies --find-copies-harder --irreversible-delete --check --exit-code --quiet
    --cached --staged --merge-base --submodule --stat-width --stat-name-width --stat-count
    --stat-graph-width --unified --function-context --src-prefix --dst-prefix --no-prefix
    --default-prefix --line-prefix --date --pretty --format --encoding --notes --no-notes
    --show-signature --log-size --left-right --left-only --right-only --cherry --cherry-mark
    --cherry-pick --boundary --topo-order --date-order --author-date-order --max-count --skip
    --since --after --until --before --author --committer --grep --all-match --invert-grep
    --regexp-ignore-case --basic-regexp --extended-regexp --fixed-strings --perl-regexp
    --max-parents --min-parents --no-min-parents --no-max-parents --simplify-by-decoration
    --simplify-merges --ancestry-path --full-history --dense --sparse --show-pulls --parents
    --children --walk-reflogs --mailmap --no-mailmap --use-mailmap --source
    --clear-decorations --decorate-refs --decorate-refs-exclude --expand-tabs
    --no-expand-tabs --show-linear-break --count --diff-filter --diff-algorithm
    --break-rewrites --inter-hunk-context --pickaxe-all --pickaxe-regex --remerge-diff
    --diff-merges --no-diff-merges --combined-all-paths --cc --root --always --no-commit-id
    --numbered --email --sort --committer-date-is-author-date --no-color-moved --name
    --porcelain --line-porcelain --incremental --show-stats --show-email --show-name
    --show-number --score-debug --ignore-rev --ignore-revs-file --contents --objects
    --objects-edge --no-walk --do-walk --in-commit-order --bisect --timestamp --header
    --no-pager --summary --format --group --no-merges --progress --not --compact-summary`),
};

/** Options of `git status`. */
const STATUS_SAFE = {
  letters: 'sbuvz',
  long: optionNames(`--short --branch --show-stash --porcelain --long --verbose --untracked-files
    --ignore-submodules --ignored --column --no-column --ahead-behind --no-ahead-behind
    --renames --no-renames --find-renames --null`),
};

/** Options of `git grep`: not `-O` / `--open-files-in-pager`, which runs a program on the files. */
const GREP_SAFE = {
  letters: 'aiIwvhHEGFPnlLcoqzefABCWp0123456789',
  long: optionNames(`--cached --no-index --untracked --no-exclude-standard --exclude-standard
    --recurse-submodules --text --textconv --no-textconv --ignore-case --word-regexp
    --invert-match --full-name --extended-regexp --basic-regexp --perl-regexp
    --fixed-strings --line-number --column --files-with-matches --name-only
    --files-without-match --null --only-matching --count --color --no-color --break
    --heading --show-function --context --after-context --before-context --function-context
    --max-depth --threads --and --or --not --all-match --quiet --max-count`),
};

/** Options of `git fetch`: not `--upload-pack`, which runs a program, nor `--update-head-ok`. */
const FETCH_SAFE = {
  letters: 'qvfpPtnjamko46',
  long: optionNames(`--quiet --verbose --all --append --atomic --depth --deepen --shallow-since
    --shallow-exclude --unshallow --update-shallow --negotiation-tip --negotiate-only
    --dry-run --porcelain --write-fetch-head --no-write-fetch-head --force --keep
    --multiple --auto-maintenance --no-auto-maintenance --auto-gc --no-auto-gc --write-commit-graph
    --prefetch --prune --prune-tags --no-tags --refetch --refmap --tags --recurse-submodules
    --no-recurse-submodules --jobs --set-upstream --progress --server-option --show-forced-updates
    --no-show-forced-updates --ipv4 --ipv6 --filter`),
};

/** Options of `git push`: not `--receive-pack` / `--exec`, which run a program. */
const PUSH_SAFE = {
  letters: 'qvnfduo46',
  long: optionNames(`--quiet --verbose --all --branches --mirror --tags --follow-tags --dry-run
    --porcelain --delete --force --force-with-lease --no-force-with-lease --force-if-includes
    --atomic --no-atomic --set-upstream --no-verify --verify --recurse-submodules --thin
    --no-thin --prune --signed --no-signed --push-option --progress --ipv4 --ipv6`),
};

/** The commands that show history and differences, all read alike. */
const LOOKS_AT_HISTORY: GitOptions = {
  short: 'SGLO',
  attached: 'MCBlUnX',
  long: ['--output'],
  safe: DIFF_LOG_SAFE,
  output: ['--output'],
};

const GIT_OPTIONS: Readonly<Record<string, GitOptions>> = {
  restore: {
    strict: true,
    short: 's',
    long: ['--source', '--conflict', '--pathspec-from-file'],
    flags: optionNames(`--worktree --staged --quiet --progress --no-progress --ours --theirs --merge
      --patch --overlay --no-overlay --ignore-unmerged --ignore-skip-worktree-bits
      --recurse-submodules --no-recurse-submodules --pathspec-file-nul`),
  },
  checkout: {
    strict: true,
    short: 'bB',
    long: ['--orphan', '--conflict', '--pathspec-from-file'],
    flags: optionNames(`--force --quiet --progress --no-progress --ours --theirs --track --no-track
      --detach --merge --patch --overlay --no-overlay --ignore-skip-worktree-bits
      --ignore-other-worktrees --recurse-submodules --no-recurse-submodules --guess --no-guess
      --overwrite-ignore --no-overwrite-ignore --pathspec-file-nul`),
  },
  switch: {
    strict: true,
    short: 'cC',
    long: ['--create', '--force-create', '--orphan', '--conflict'],
    flags: optionNames(`--detach --guess --no-guess --force --discard-changes --merge --quiet
      --progress --no-progress --track --no-track --ignore-other-worktrees
      --recurse-submodules --no-recurse-submodules`),
  },
  reset: {
    strict: true,
    long: ['--pathspec-from-file'],
    flags: optionNames(`--hard --soft --mixed --merge --keep --quiet --no-quiet --refresh
      --no-refresh --recurse-submodules --no-recurse-submodules --intent-to-add --patch
      --pathspec-file-nul`),
  },
  rm: {
    strict: true,
    long: ['--pathspec-from-file'],
    flags: optionNames(`--cached --dry-run --force --ignore-unmatch --quiet --sparse --recursive
      --pathspec-file-nul`),
  },
  mv: { strict: true, flags: optionNames('--dry-run --force --verbose --sparse') },
  clean: {
    strict: true,
    short: 'e',
    long: ['--exclude'],
    flags: optionNames('--dry-run --force --interactive --quiet'),
  },
  stash: {
    short: 'm',
    long: ['--message', '--pathspec-from-file'],
    flags:
      optionNames(`--include-untracked --no-include-untracked --all --keep-index --no-keep-index
      --patch --staged --quiet --index --pathspec-file-nul`),
  },
  config: {
    short: 'f',
    long: ['--file', '--blob', '--type', '--default', '--comment', '--value', '--url'],
    flags: optionNames(`--get --get-all --get-regexp --get-urlmatch --list --global --system --local
      --worktree --show-origin --show-scope --name-only --null --includes --no-includes
      --unset --unset-all --add --replace-all --rename-section --remove-section --edit`),
  },
  archive: {
    short: 'o',
    long: ['--output', '--format', '--prefix', '--remote', '--exec', '--add-file', '--mtime'],
    safe: {
      letters: 'lv0123456789',
      long: optionNames(
        '--format --prefix --list --verbose --worktree-attributes --add-file --mtime --remote --output',
      ),
    },
    output: ['o', '--output'],
  },
  'merge-file': { short: 'L', long: ['--marker-size', '--diff-algorithm'] },
  'checkout-index': {
    strict: true,
    long: ['--prefix', '--stage'],
    flags: optionNames(
      '--all --force --quiet --no-create --index --stdin --temp --ignore-skip-worktree-bits',
    ),
  },
  'read-tree': {
    strict: true,
    long: ['--prefix', '--exclude-per-directory', '--index-output'],
    flags: optionNames(`--reset --trivial --aggressive --empty --dry-run --verbose --quiet
      --no-sparse-checkout --recurse-submodules --no-recurse-submodules`),
    output: ['--index-output'],
  },
  init: {
    strict: true,
    short: 'b',
    long: optionNames(`--initial-branch --template --separate-git-dir --object-format
      --ref-format`),
    flags: optionNames('--quiet --bare --shared'),
  },
  'format-patch': {
    short: 'ov',
    long: optionNames(`--output-directory --output --subject-prefix --in-reply-to --to --cc --suffix
      --start-number --reroll-count --add-header --signature --signature-file
      --cover-from-description --base --interdiff --range-diff --creation-factor`),
    flags: optionNames(`--stdout --numbered-files --cover-letter --numbered --no-numbered --from
      --notes --thread --attach --inline`),
  },
  clone: {
    strict: true,
    short: 'obucj',
    long: optionNames(`--origin --branch --upload-pack --reference --reference-if-able
      --separate-git-dir --depth --shallow-since --shallow-exclude --config --template --jobs
      --filter --server-option --bundle-uri --ref-format --revision`),
    flags: optionNames(`--quiet --verbose --progress --no-progress --no-checkout --checkout
      --bare --mirror --local --no-local --no-hardlinks --shared --recurse-submodules
      --no-recurse-submodules --shallow-submodules --no-shallow-submodules --remote-submodules
      --no-remote-submodules --single-branch --no-single-branch --tags --no-tags --sparse
      --also-filter-submodules --dissociate --reject-shallow --no-reject-shallow --recursive
      --no-recursive --ipv4 --ipv6 --hardlinks --no-verbose --no-quiet --no-bare --no-mirror
      --no-shared --no-dissociate --no-sparse --no-also-filter-submodules --no-depth
      --no-filter --no-template --no-reference --no-config --no-upload-pack`),
  },
  worktree: { short: 'bB', long: ['--reason', '--orphan'] },
  // `submodule add`'s options; another verb is a change of the whole tree, or only looks.
  submodule: {
    short: 'b',
    long: optionNames('--branch --name --reference --depth --jobs'),
    flags: optionNames('--quiet --force --recursive --cached --files --dissociate'),
  },
  bisect: {},
  'sparse-checkout': {},
  difftool: { short: 'xtX', long: optionNames('--extcmd --tool --rotate-to --skip-to') },
  rebase: { short: 'sXx', long: ['--onto', '--exec', '--strategy', '--strategy-option'] },
  merge: {
    short: 'msXF',
    long: ['--message', '--strategy', '--strategy-option', '--file', '--into-name'],
  },
  'cherry-pick': { short: 'mX', long: ['--mainline', '--strategy', '--strategy-option'] },
  revert: { short: 'mX', long: ['--mainline', '--strategy', '--strategy-option'] },
  pull: { short: 'sX', long: ['--strategy', '--strategy-option', '--depth', '--upload-pack'] },
  apply: {
    short: 'pC',
    long: ['--exclude', '--include', '--directory', '--whitespace'],
    flags: optionNames(
      '--stat --numstat --summary --check --index --cached --apply --reverse --3way',
    ),
  },
  am: { short: 'pC', long: ['--directory', '--exclude', '--include', '--whitespace'] },
  // Commands that only look.
  diff: LOOKS_AT_HISTORY,
  log: LOOKS_AT_HISTORY,
  show: LOOKS_AT_HISTORY,
  whatchanged: LOOKS_AT_HISTORY,
  'diff-tree': LOOKS_AT_HISTORY,
  'diff-index': LOOKS_AT_HISTORY,
  'diff-files': LOOKS_AT_HISTORY,
  'range-diff': LOOKS_AT_HISTORY,
  'rev-list': LOOKS_AT_HISTORY,
  shortlog: LOOKS_AT_HISTORY,
  cherry: LOOKS_AT_HISTORY,
  blame: LOOKS_AT_HISTORY,
  annotate: LOOKS_AT_HISTORY,
  status: { attached: 'u', safe: STATUS_SAFE },
  grep: {
    short: 'efABCm',
    attached: 'O',
    flags: ['--open-files-in-pager'],
    safe: GREP_SAFE,
  },
  fetch: {
    short: 'jo',
    long: ['--upload-pack', '--depth', '--refmap', '--server-option'],
    safe: FETCH_SAFE,
  },
  'ls-remote': {
    long: ['--upload-pack', '--sort', '--server-option'],
    safe: {
      letters: 'qhtb',
      long: optionNames(
        '--heads --tags --branches --refs --quiet --exit-code --get-url --symref --sort --server-option',
      ),
    },
  },
  push: {
    short: 'o',
    // Each takes the next word as its value: `--recurse-submodules no .` pushes to `.`.
    long: ['--receive-pack', '--exec', '--push-option', '--repo', '--recurse-submodules'],
    safe: PUSH_SAFE,
  },
  // Commands none of whose options writes a working file or runs a program given in the text.
  'ls-files': { safe: 'any' },
  'ls-tree': { safe: 'any' },
  'cat-file': { safe: 'any' },
  'rev-parse': { safe: 'any' },
  describe: { safe: 'any' },
  'name-rev': { safe: 'any' },
  'show-ref': { safe: 'any' },
  'show-branch': { safe: 'any' },
  'for-each-ref': { safe: 'any' },
  'merge-base': { safe: 'any' },
  'check-ignore': { safe: 'any' },
  'check-attr': { safe: 'any' },
  'check-ref-format': { safe: 'any' },
  'count-objects': { safe: 'any' },
  var: { safe: 'any' },
  version: { safe: 'any' },
  help: { safe: 'any' },
  'verify-commit': { safe: 'any' },
  'verify-tag': { safe: 'any' },
  fsck: { safe: 'any' },
  // Commands that move refs or the index and none of whose options writes a working file.
  add: { safe: 'any' },
  stage: { safe: 'any' },
  commit: { short: 'mFcCt', safe: 'any' },
  branch: { safe: 'any' },
  tag: { short: 'mF', safe: 'any' },
  remote: { safe: 'any' },
  reflog: { safe: 'any' },
  notes: { safe: 'any' },
  'update-ref': { safe: 'any' },
  'symbolic-ref': { safe: 'any' },
  'update-index': { safe: 'any' },
  gc: { safe: 'any' },
  prune: { safe: 'any' },
  repack: { safe: 'any' },
  'pack-refs': { safe: 'any' },
  replace: { safe: 'any' },
  maintenance: { safe: 'any' },
};

/** Options that write a file or run a program, whatever the subcommand. */
const GIT_RUNS_OR_WRITES =
  /^--(output|exec|upload-pack|receive-pack|open-files-in-pager|output-directory)$/;

/** A git subcommand's arguments, read with its option table. */
interface GitParsed {
  /** Plain arguments, those after `--` included. */
  args: Word[];
  /** The arguments after `--`; null when there is none. */
  afterDashes: Word[] | null;
  /** Short flags seen outside option values, by letter. */
  short: Set<string>;
  /** Long flags seen, by name (without `=value`), abbreviations made whole where they can be. */
  long: Set<string>;
  /** The values of the options that take one, by letter or long name. */
  values: Map<string, Word[]>;
}

function parseGit(words: readonly Word[], options: GitOptions): GitParsed {
  const shortValued = options.short ?? '';
  const attached = options.attached ?? '';
  const longValued = options.long ?? [];
  // The options that keep a command looking count too: git takes an abbreviation of them alike.
  const safe = typeof options.safe === 'object' ? options.safe.long : [];
  const known = [...new Set([...longValued, ...(options.flags ?? []), ...safe])];
  const out: GitParsed = {
    args: [],
    afterDashes: null,
    short: new Set(),
    long: new Set(),
    values: new Map(),
  };
  const set = (key: string, value: Word | null): void => {
    if (value === null) return;
    out.values.set(key, [...(out.values.get(key) ?? []), value]);
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.text === '--') {
      out.afterDashes = words.slice(i + 1);
      out.args.push(...out.afterDashes);
      break;
    }
    if (!isFlag(w)) {
      out.args.push(w);
      continue;
    }
    if (w.text.startsWith('--')) {
      const eq = w.text.indexOf('=');
      const given = eq === -1 ? w.text : w.text.slice(0, eq);
      // An abbreviation stands for the one option it starts, when it is that one's alone, as
      // git reads it (`--har` is `--hard`).
      const matches = known.filter((n) => n.startsWith(given));
      const name = known.includes(given)
        ? given
        : given.length >= 3 && matches.length === 1
          ? (matches[0] as string)
          : given;
      out.long.add(name);
      if (eq !== -1) set(name, sliceWord(w, eq + 1));
      else if (longValued.includes(name)) set(name, words[++i] ?? null);
      continue;
    }
    // A cluster of letters: a letter that takes a value takes the rest of the cluster, or the
    // next word; what follows it is never read as letters. One whose value is optional takes
    // only the rest of the cluster.
    for (let k = 1; k < w.text.length; k++) {
      const letter = w.text[k] as string;
      out.short.add(letter);
      const more = k + 1 < w.text.length;
      if (attached.includes(letter) && more) {
        set(letter, sliceWord(w, k + 1));
        break;
      }
      if (!shortValued.includes(letter)) continue;
      set(letter, more ? sliceWord(w, k + 1) : (words[++i] ?? null));
      break;
    }
  }
  return out;
}

/** Whether a parsed git command has one of the short letters or long names. */
const gitHas = (p: GitParsed, letters: string, names: readonly string[] = []): boolean =>
  [...letters].some((l) => p.short.has(l)) || names.some((n) => p.long.has(n));

/** The values of an option, by letter or long name. */
const gitValues = (p: GitParsed, ...keys: readonly string[]): Word[] =>
  keys.flatMap((k) => p.values.get(k) ?? []);

/**
 * Whether every option a command was given is one that keeps it looking or moving refs only.
 * The options that name a file it writes are read apart, as that file.
 */
function gitOptionsSafe(p: GitParsed, table: GitOptions): boolean {
  const safe = table.safe ?? { letters: '', long: [] };
  const output = table.output ?? [];
  for (const name of p.long) {
    if (output.includes(name)) continue;
    if (GIT_RUNS_OR_WRITES.test(name)) return false;
    if (safe !== 'any' && !safe.long.includes(name)) return false;
  }
  return (
    safe === 'any' || [...p.short].every((l) => safe.letters.includes(l) || output.includes(l))
  );
}

/** A push destination that is a repository on this machine, whose working tree it may update. */
const localRepository = (w: Word | undefined): boolean =>
  w !== undefined &&
  (/^(file:|[.~/])/.test(w.text) || (w.text.includes('/') && !w.text.includes(':')));

/** Where a clone comes from is on this machine: a path, not a URL nor `host:path`. */
const localSource = (w: Word | undefined): boolean =>
  w !== undefined &&
  (/^file:/.test(w.text) || (!w.text.includes('://') && !/^[^/]*:/.test(w.text)));

/** The folder a clone of `from` goes to when none is given: its last part, less `.git`/`.bundle`. */
const cloneName = (from: Word | undefined): Word[] => {
  if (from === undefined) return [];
  let text = trimEnd(from.text, '/');
  if (text.endsWith('/.git')) text = text.slice(0, -'/.git'.length);
  for (const ext of ['.git', '.bundle']) {
    if (text.endsWith(ext)) {
      text = text.slice(0, -ext.length);
      break;
    }
  }
  const name = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf(':')) + 1);
  return name ? [word(name)] : [];
};

/** A config file git reads its settings from, or one that cannot be told. */
const gitReadsConfig = (w: Word): boolean =>
  w.dynamic ||
  /(^|\/)\.git(\/|$)|(^|\/)\.git(config|modules)$|(^|\/)git\/config$|^\/etc\/gitconfig$/.test(
    w.text,
  ) ||
  w.text.startsWith('~');

/** A word in single quotes, for the shell to read back as it is. */
const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

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

/**
 * git: which subcommands rewrite or remove working files. A subcommand only looks, or only moves
 * refs or the index, when it is known to and every option it is given keeps it so; anything else
 * (an alias, a subcommand or option not known here, a setting given with `-c` or a `GIT_*`
 * variable, which `settings` says) may change the whole working tree. The files it writes its
 * output to and the folders it fills are written, by name.
 */
function readGit(words: readonly Word[], stdin: string | null, settings = false): Verdict {
  const { dir, rest, trusted, nocase, workTree, unsafe, exec: aliases } = gitCommand(words);
  const sub = rest[0]?.text;
  if (sub === undefined) return READS;
  const command = [word('git'), ...rest.slice(1)];
  const table = GIT_OPTIONS[sub] ?? {};
  // Each subcommand's options are read with its own table: a value is never a flag or a path.
  const p = parseGit(command, table);
  const under = (list: readonly Word[]): Word[] =>
    dir ? list.map((w) => joinWords(dir, w)) : [...list];
  /** What may change any file of the tree, and cannot be asked: a warning when one is covered. */
  const anything: GitAsk = {
    against: [],
    pathspecs: [],
    unasked: true,
    possible: true,
    touches: ANY_FILE,
  };
  /** The verdict, and any file of the tree on top when a setting given to it may do anything. */
  const done = (v: Verdict, any = unsafe || settings): Verdict => {
    if (!any) return v;
    if (v.kind === 'git') return running({ ...v, asks: [...v.asks, anything] }, aliases);
    const items = v.kind === 'writes' ? v.items : [];
    if (v.kind !== 'reads' && v.kind !== 'writes') return v;
    return running(
      { kind: 'git', dir, asks: [anything], items, trusted, nocase, workTree },
      aliases,
    );
  };
  /** Shell code it runs besides, read like any other (`rebase --exec`, `bisect run`). */
  function running(v: Verdict, code: readonly string[]): Verdict {
    return v.kind === 'git' && code.length > 0 ? { ...v, exec: [...(v.exec ?? []), ...code] } : v;
  }
  /** Files it writes, named as files and not as pathspecs, and folders it fills. */
  const outputs = (files: readonly Word[], lands: readonly Word[] = [], any = false): Verdict =>
    done(
      files.length + lands.length === 0
        ? READS
        : writes(
            ...files.map((w) => ({ word: under([w])[0] as Word })),
            ...under(lands).map((w) => ({ word: w, how: 'land' as const })),
          ),
      any || unsafe || settings,
    );
  if (table.safe !== undefined) {
    // Only looking, or only moving refs or the index, as long as each option keeps it so. A push
    // into a repository on this machine may update that one's working tree.
    const changes = !gitOptionsSafe(p, table) || (sub === 'push' && localRepository(p.args[0]));
    return outputs(gitValues(p, ...(table.output ?? [])), [], changes);
  }
  // A subcommand whose options are not known here: any word may be an option's value.
  const unknownTable = GIT_OPTIONS[sub] === undefined;
  // An option not known here, to a command whose options are, may change what it does.
  const known = [...(table.long ?? []), ...(table.flags ?? [])];
  if (table.strict && [...p.long].some((n) => !known.includes(n))) return done(READS, true);
  const verb = rest[1] && !isFlag(rest[1]) ? rest[1].text : null;
  let dashes = rest.findIndex((w) => w.text === '--');
  let afterDashes = dashes === -1 ? [] : rest.slice(dashes + 1);
  /**
   * A command that brings files back from the index or a revision. What it changes is what
   * differs: git is asked (`git diff` against `against`, with the pathspecs exactly as given).
   */
  const ask = (...asks: (GitAsk | null)[]): Verdict => {
    const kept = asks.filter((a): a is GitAsk => a !== null);
    return done(
      kept.length === 0 ? READS : { kind: 'git', dir, asks: kept, trusted, nocase, workTree },
    );
  };
  /** What may change the whole tree and cannot be asked: a warning when a covered file is there. */
  const whole = (): Verdict =>
    ask({ against: [], pathspecs: [], unasked: true, possible: true, touches: TRACKED_FILES });
  // Paths read from a file or from standard input: those an `echo` before the pipe gives are
  // read, any others are not known here.
  const fromInput =
    p.long.has('--pathspec-from-file') || (sub === 'checkout-index' && p.long.has('--stdin'));
  if (fromInput) {
    const from = gitValues(p, '--pathspec-from-file')[0]?.text ?? '-';
    if (from !== '-' || stdin === null) {
      return sub === 'reset'
        ? done(READS)
        : { kind: 'unread', why: 'git reads the paths it changes from a file or its input' };
    }
    const listed = stdin
      .split(/[\n\0]/)
      .filter((x) => x.trim() !== '')
      .map((x) => word(x, true));
    // They are paths, as if given after `--`.
    p.args.push(...listed);
    afterDashes = [...afterDashes, ...listed];
    if (dashes === -1) dashes = rest.length;
  }
  /** The folder part of a prefix files are written under (`vendor/` of `vendor/x-`). */
  const prefixDir = (w: Word): Word => {
    const cut = w.text.lastIndexOf('/');
    return cut === -1 ? word('.') : sliceWord(w, 0, cut + 1);
  };
  if (unknownTable) return whole();
  switch (sub) {
    case 'format-patch': {
      // Patch files named after their commits, in the folder given or where it runs: what they
      // are called is told by a sample name with the suffix they get.
      if (gitHas(p, '', ['--stdout'])) return done(READS);
      const single = gitValues(p, '--output');
      if (single.length > 0) return outputs(single);
      const into = gitValues(p, 'o', '--output-directory')[0];
      const suffix = gitValues(p, '--suffix')[0]?.text ?? '.patch';
      const name = word(p.long.has('--numbered-files') ? '1' : `0001-patch${suffix}`);
      return outputs([into ? joinWords(into, name) : name]);
    }
    case 'config': {
      // It writes the file it is given; a setting it writes may change what later commands do.
      const reads =
        gitHas(p, 'l', ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list']) ||
        p.long.has('--blob') ||
        verb === 'get' ||
        verb === 'list' ||
        (verb === null &&
          p.args.length === 1 &&
          !gitHas(p, 'e', [
            '--edit',
            '--unset',
            '--unset-all',
            '--remove-section',
            '--rename-section',
          ]));
      if (reads) return done(READS);
      // A file of its own is only that file, unless it is one git reads its settings from (the
      // repository's, the user's, the system's, `.gitmodules`).
      const file = gitValues(p, 'f', '--file');
      const own = file.length > 0 && !file.some(gitReadsConfig);
      const key = (verb === 'set' ? p.args[1] : p.args[0])?.text ?? '';
      const harmless = !gitHas(p, 'e', ['--edit']) && (own || GIT_HARMLESS_CONFIG.test(key));
      return outputs(file, [], !harmless);
    }
    case 'merge-file':
      // The first file takes the result, unless it goes to the standard output.
      return gitHas(p, 'p', ['--stdout']) || p.args[0] === undefined
        ? done(READS)
        : outputs([p.args[0]]);
    case 'checkout-index': {
      // With a prefix, the files are written under it, named as they are in the index.
      const prefix = gitValues(p, '--prefix')[0];
      if (prefix) return outputs([], [prefixDir(prefix)]);
      if (gitHas(p, 'a', ['--all'])) return whole();
      return outputs(p.args);
    }
    case 'read-tree': {
      // An index written elsewhere is a file. Without -u nothing else of the tree changes.
      const out = gitValues(p, '--index-output');
      if (!gitHas(p, 'u')) return outputs(out);
      const prefix = gitValues(p, '--prefix')[0];
      return prefix ? outputs(out, [prefixDir(prefix)]) : outputs(out, [], true);
    }
    case 'init':
      // A new repository, in the folder given or where it runs, with its own files apart when
      // told (`--separate-git-dir`). The hooks of a template run on later commands.
      return outputs(
        [],
        [...p.args.slice(0, 1), ...gitValues(p, '--separate-git-dir')],
        p.long.has('--template'),
      );
    case 'clone': {
      // The new repository's folder: given, or named after what is cloned, and its own files when
      // put apart. It runs code from what it clones only when told to (a program to fetch with,
      // hooks from a template or a setting). One cloned from here brings the files this one has,
      // covered ones included.
      const [from, to] = p.args;
      const into = [...(to ? [to] : cloneName(from)), ...gitValues(p, '--separate-git-dir')];
      const runs = gitHas(p, 'uc', ['--upload-pack', '--template', '--config']);
      return outputs([], into, runs || localSource(from));
    }
    case 'submodule': {
      // `submodule add` clones into the folder given, or one named after what it clones;
      // `foreach` runs shell code in each. Other verbs check out what the submodules record.
      const q = parseGit([word('git'), ...rest.slice(1)], table);
      const [action, ...args] = q.args;
      if (action === undefined || ['status', 'summary'].includes(action.text)) return done(READS);
      if (action.text === 'foreach') return running(whole(), [args.map((w) => w.text).join(' ')]);
      if (action.text !== 'add') return whole();
      const [from, to] = args;
      return outputs([], to ? [to] : cloneName(from), localSource(from));
    }
    case 'difftool':
      // A program given to run on each pair of files is shell code.
      return running(
        whole(),
        gitValues(p, 'x', '--extcmd').map((w) => w.text),
      );
    case 'worktree': {
      const q = parseGit([word('git'), ...rest.slice(2)], table);
      if (['list', 'lock', 'unlock', 'prune', 'repair'].includes(verb ?? '')) return done(READS);
      // A new working tree is checked out in the folder given, with the files this one has; one
      // removed or moved goes with what is in it.
      if (verb === 'add') return outputs([], q.args[0] ? [q.args[0]] : [], true);
      if (verb === 'remove' || verb === 'move') return done(writes(...trees(under(q.args))));
      return whole();
    }
    case 'bisect': {
      if (['log', 'visualize', 'view', 'help', 'terms'].includes(verb ?? '')) return done(READS);
      if (verb !== 'run') return whole();
      // The command it runs at each step: one word is shell code, several are a program and its
      // arguments, which no shell reads again.
      const run = rest.slice(2);
      const code =
        run.length === 1 ? (run[0] as Word).text : run.map((w) => quoted(w.text)).join(' ');
      return running(whole(), run.length > 0 ? [code] : []);
    }
    case 'sparse-checkout':
      return verb === 'list' ? done(READS) : whole();
    case 'restore': {
      const staged = gitHas(p, 'S', ['--staged']);
      const worktree = gitHas(p, 'W', ['--worktree']);
      // `--staged` alone only moves the index; the file on disk stays.
      if (staged && !worktree) return done(READS);
      const args = p.args;
      const source = gitValues(p, 's', '--source')[0] ?? null;
      // In patch mode without a path, any file may change.
      if (args.length === 0 && !gitHas(p, 'p', ['--patch'])) return done(READS);
      // From the index by default; with `--staged` both come from HEAD, or from the source.
      const against = source ? [source.text] : staged ? ['HEAD'] : [];
      return ask({ against, pathspecs: args, touches: TRACKED_FILES });
    }
    case 'rm': {
      if (gitHas(p, 'n', ['--cached', '--dry-run'])) return done(READS);
      // It removes the tracked files its pathspecs match, as git reads them.
      const paths = p.args;
      return ask(
        paths.length > 0
          ? { against: [], pathspecs: paths, tracked: true, touches: TRACKED_FILES }
          : null,
      );
    }
    case 'mv': {
      const given = argsWithout(command, []);
      const dest = given[given.length - 1];
      if (dest === undefined) return done(READS);
      const sources = given.slice(0, -1);
      const [to] = under([dest]) as [Word];
      const entries = under(sources).map((s) => ({ name: posix.basename(s.text), from: s }));
      return done(writes(...trees(under(sources)), { word: to, tree: true, entries }));
    }
    case 'clean': {
      if (hasOption(command, 'n', ['--dry-run'])) return done(READS);
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
      return done(writes(...(items.length > 0 ? items : trees(under([word('.')]), { how }))));
    }
    case 'checkout': {
      const force = gitHas(p, 'f', ['--force']);
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
      if (gitHas(p, 'p', ['--ours', '--theirs', '--patch']))
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
      const force = gitHas(p, 'f', ['--force', '--discard-changes']);
      const { args, values } = gitArgs(command, 'cC', ['--create', '--force-create', '--orphan']);
      // An orphan branch starts from nothing: every tracked file goes.
      if (values.has('--orphan')) return ask(switchTo(EMPTY_TREE, force, false));
      const creates = ['c', 'C', '--create', '--force-create'].some((k) => values.has(k));
      const first = args[0]?.text ?? (creates ? 'HEAD' : null);
      if (first === null) return done(READS);
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
        return done(READS);
      const tail = [word('git'), ...rest.slice(verb === 'push' || verb === 'save' ? 2 : 1)];
      const paths =
        dashes !== -1
          ? afterDashes
          : verb === 'save'
            ? []
            : parseGit(tail, GIT_OPTIONS['stash'] as GitOptions).args;
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
      if (!gitHas(p, '', ['--hard', '--merge', '--keep'])) return done(READS);
      const revision = p.args[0]?.text ?? 'HEAD';
      // `--keep` and `--merge` keep local changes (or stop): what changes is what differs
      // between HEAD and where the branch goes.
      if (!gitHas(p, '', ['--hard'])) return ask(switchTo(revision, false, false));
      return ask({ against: [revision], pathspecs: [], touches: TRACKED_FILES });
    }
    case 'merge':
    case 'cherry-pick':
    case 'revert':
    case 'rebase':
    case 'pull':
    case 'am':
    case 'apply': {
      // Only `apply` has read forms: looking at the patch, or applying it to the index alone.
      if (
        sub === 'apply' &&
        !p.long.has('--apply') &&
        (gitHas(p, '', ['--check', '--stat', '--numstat', '--summary']) ||
          (p.long.has('--cached') && !p.long.has('--index')))
      )
        return done(READS);
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
        const rebase = ask(
          autostash,
          branch !== undefined ? switchTo(branch, false, false) : null,
          replay([base, onto ?? upstream]),
          replay([`${upstream}...${base}`]),
        );
        // The commands it runs after each commit are read like any other shell code.
        const exec = gitArgs(command, 'x', ['--exec']).all.flatMap((w) => (w ? [w.text] : []));
        return running(rebase, exec);
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
      // submodule, an alias, anything not known here: the whole tree may change.
      return whole();
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
    gitEnv: false,
    allExport: false,
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
  /** A variable that may change what git does was exported earlier on the line. */
  gitEnv: boolean;
  /** `set -a` is on: every variable set is exported. */
  allExport: boolean;
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
  const outer: {
    dir: string | null;
    previous: string | null;
    stack: (string | null)[];
    gitEnv: boolean;
    allExport: boolean;
  }[] = [];
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
      outer.push({
        dir,
        previous,
        stack: [...stack],
        gitEnv: r.gitEnv,
        allExport: r.allExport,
      });
      before = null;
      continue;
    }
    if (cmd.subshell === 'close') {
      // An unmatched `)` (a `case` pattern) closes nothing.
      const back = outer.pop();
      // What a subshell sets or exports stays in it.
      if (back) ({ dir, previous, stack, gitEnv: r.gitEnv, allExport: r.allExport } = back);
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
    // Each runs in a shell of its own: what it sets or exports stays there.
    const apart = (code: string, from: string | null, gitEnv: boolean): void => {
      const was = { gitEnv: r.gitEnv, allExport: r.allExport };
      r.gitEnv ||= gitEnv;
      collectTargets(code, from, depth + 1, r);
      ({ gitEnv: r.gitEnv, allExport: r.allExport } = was);
    };
    for (const inner of cmd.nested) apart(inner, at, false);
    // The shell expands a here-document whose delimiter is not quoted: substitutions in it run.
    if (cmd.stdin !== null && cmd.stdinExpands) {
      for (const inner of substitutions(cmd.stdin)) apart(inner, at, false);
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
    // A variable set for git, or exported (or set, under `set -a`) earlier on the line, may make
    // it do anything to the tree. What a pipeline's part or a background command sets stays in
    // its own shell.
    const kept = { gitEnv: r.gitEnv, allExport: r.allExport };
    const program = words[0] && !words[0].dynamic ? programName(words[0]) : '';
    const assigned = cmd.words
      .slice(0, words[0] ? cmd.words.indexOf(words[0]) : cmd.words.length)
      .some((w) => isAssignment(w) && unsafeVariable(w));
    if (setsGitVariable(program, cmd, words, r.allExport)) r.gitEnv = true;
    if (program === 'set') r.allExport = allExportSet(words) ?? r.allExport;
    // A file read into this shell (`source x`, `. <(…)`) may set anything; it is not read here.
    if (program === 'source' || program === '.') r.gitEnv = true;
    const gitSettings = program === 'git' && (assigned || r.gitEnv);
    const verdict = gitSettings ? readGit(words, stdin, true) : classify(words, stdin);
    /**
     * Code this command runs: in a shell of its own (a shell's, git's own), where the settings
     * given to it hold, or in this one (`eval`, `trap`), where what it sets stays for the rest.
     */
    const nested = (code: string, from: string | null, same = false): void => {
      if (!same) return apart(code, from, assigned);
      r.gitEnv ||= assigned;
      collectTargets(code, from, depth + 1, r);
    };
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
        // Files and folders it names as such: an output file, a folder a clone is put in.
        for (const item of verdict.items ?? []) add(item, here);
        // git runs where the command runs, or where `-C` sends it.
        const at = verdict.dir ? enter(verdict.dir, here) : here;
        if (at === null) {
          r.limit ??= 'a git command runs in a folder the text does not tell';
          break;
        }
        // A working tree named apart (`--work-tree`): paths are read in it. One outside the tree
        // the line starts in is not checked here, and said.
        let base = at;
        if (verdict.workTree !== null) {
          const tree = enter(verdict.workTree, at);
          if (tree === null || !insideTop(tree)) {
            r.limit ??= 'a git command works on another working tree';
            break;
          }
          base = tree;
        }
        // What git says now is what the command would do now: not once an earlier command of
        // the line may have changed it, nor with settings that change where git finds its files
        // or how it reads its paths. After such a command, the paths it names are written; what it
        // does to the whole tree (a switch, a merge, a pop) is a possible write.
        const settled =
          verdict.trusted &&
          !r.moved &&
          !gitSettings &&
          !cmd.words.some((w) =>
            /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE|[A-Z_]*PATHSPECS)=/.test(
              w.text,
            ),
          );
        // The whole working tree, for a command given no path: from its top when it is the tree
        // the command line starts in.
        const top = r.top !== null && insideTop(at);
        for (const code of verdict.exec ?? []) nested(code, at);
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
              base,
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
                base,
              );
            }
          }
        }
        break;
      }
      case 'inline':
        nested(verdict.code, here, verdict.same);
        break;
      case 'script': {
        const found = readCode(verdict.code);
        for (const p of found.paths) {
          // A bare name is a path only when a file of that name exists.
          const item: Item = { word: word(p.text, true), certain: p.certain, tree: p.tree };
          if (looksLikePath(p.text)) add(item, here);
          else if (p.certain && /^[\w@+.-]+$/.test(p.text)) add({ ...item, ifExists: true }, here);
        }
        for (const line of found.commands) nested(line, here);
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
    if (cmd.apart) ({ gitEnv: r.gitEnv, allExport: r.allExport } = kept);
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
      // An option or a setting may still make it write (`git diff --output=x`).
      const settings = cmd.words.some((w) => isAssignment(w) && unsafeVariable(w));
      if (readGit(words, null, settings).kind !== 'reads') return false;
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
