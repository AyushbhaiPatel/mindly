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
  coproc: {},
  parallel: { values: ['-j', '--jobs', '-S', '--sshlogin', '-a', '--arg-file'] },
  flock: { values: ['-w', '--timeout', '-E', '--conflict-exit-code'], skip: 1 },
  unbuffer: {},
  chroot: { values: ['--userspec', '--groups'], skip: 1 },
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

const SHELLS = new Set([
  'sh',
  'bash',
  'rbash',
  'dash',
  'zsh',
  'ksh',
  'ksh93',
  'mksh',
  'pdksh',
  'oksh',
  'yash',
  'ash',
  'posh',
  'fish',
  'csh',
  'tcsh',
]);

/**
 * How a shell is told what to run: `-c` anywhere in a cluster of its options (`-ce`, `-xc`)
 * makes the first word after its options the code; `-s` makes it read the code from its input,
 * the words after its options being arguments; otherwise the first word is a script file (or
 * `/dev/stdin`, `-`, a process substitution), and without one the code comes from its input.
 * `--` or `-` ends the options, and `-o` / `-O` (also `+o`, `+O`, `--rcfile`, `--init-file`)
 * take the next word. `dynamic`: an option is not plain text.
 */
function shellInvocation(words: readonly Word[]): {
  c: boolean;
  s: boolean;
  /** The code (`-c`), or the script, or null. */
  operand: Word | null;
  dynamic: boolean;
} {
  let c = false;
  let s = false;
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.procSub !== undefined) break;
    if (w.dynamic) return { c, s, operand: null, dynamic: true };
    const t = w.text;
    if (t === '--' || t === '-') {
      i++;
      break;
    }
    if (!/^[-+]./.test(t)) break;
    if (t.startsWith('--')) {
      if (t === '--rcfile' || t === '--init-file') i++;
      continue;
    }
    if (t.startsWith('-') && t.includes('c')) c = true;
    if (t.startsWith('-') && t.includes('s')) s = true;
    // Each `o` / `O` in the cluster takes a word of its own.
    i += (t.match(/[oO]/g) ?? []).length;
  }
  const operand = words[i] ?? null;
  return { c, s, operand, dynamic: c && (operand?.dynamic ?? false) };
}

/** Paths that stand for a program's own input. */
const STDIN_PATHS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

/**
 * Code a shell or `source` reads from its input: the code of its own here-string or here-document
 * when that is plain text. What a pipe feeds it, and a process substitution, are not read as code.
 */
function codeFrom(from: Word | null, stdin: string | null, ctx: GitContext): string | null {
  if (from !== null && (from.dynamic || !STDIN_PATHS.has(from.text))) return null;
  return stdin !== null && !(ctx.stdinDynamic ?? false) && !(ctx.stdinPiped ?? false)
    ? stdin
    : null;
}

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
  /** Where in `text` the first value not known here stands (set with `dynamic` while parsing). */
  dynamicAt?: number | undefined;
  /**
   * A brace expansion too large to read, written as a wildcard that matches every word it stands
   * for: only part of what it names was read.
   */
  cut?: boolean | undefined;
  /** A process substitution (`<(…)`, `>(…)`): the code whose output or input it stands for. */
  procSub?: string | undefined;
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
  /** What it reads on standard input holds a value not known here (`<<< "$c"`). */
  stdinDynamic: boolean;
  /** Text of `(( … ))` and `$(( … ))` arithmetic written in this command. */
  arithmetic: string[];
  /**
   * It holds an expansion other than `$name`, `${name}`, a special parameter or a substitution
   * (`${x:=…}`, `${a[…]}`, `$[…]`), or assigns an array: it may set a variable git reads.
   */
  taint: boolean;
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
    stdinDynamic: false,
    arithmetic: [],
    taint: false,
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
  /** The open word holds a value not known here, from where it has got to. */
  const unknownValue = (): void => {
    const w = cur();
    w.dynamic = true;
    w.dynamicAt ??= w.text.length;
  };
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
      if (pendingRedirect === '<<<') {
        current.stdin = w.text;
        current.stdinDynamic = w.dynamic;
      } else current.redirects.push({ op: pendingRedirect, target: w });
      pendingRedirect = null;
      return;
    }
    current.words.push(...expandBraces(w));
  };
  const endCommand = (piped = false, otherwise = false): void => {
    endWord();
    pendingRedirect = null;
    const c = current;
    if (
      c.words.length > 0 ||
      c.redirects.length > 0 ||
      c.nested.length > 0 ||
      c.stdin !== null ||
      c.arithmetic.length > 0
    )
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
      unknownValue();
    }
  };
  /** Reads `$…` at `i` into the open word; returns the index after it. */
  const dollar = (i: number, quoted: boolean): number => {
    const next = src[i + 1];
    if (next === '(' && src[i + 2] === '(') {
      // `$(( … ))`: arithmetic, a number nobody can read from the text.
      const end = src.indexOf('))', i + 3);
      current.arithmetic.push(src.slice(i + 3, end === -1 ? src.length : end));
      unknownValue();
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
      // `${f%.ts}`, `${x:-y}`: a value that cannot be read from the text. Any but a special
      // parameter (`${@}`) may set a variable too (`${x:=y}`, `${a[i=1]}`, `${x:HOME=5}`).
      const end = src.indexOf('}', i + 2);
      if (!/^\$\{[@*#?$!-]\}/.test(src.slice(i, i + 4))) current.taint = true;
      unknownValue();
      return end === -1 ? src.length : end + 1;
    }
    if (next === '[') {
      // `$[ … ]`: arithmetic, the old way.
      current.taint = true;
      unknownValue();
      const end = src.indexOf(']', i + 2);
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
    else unknownValue();
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
        // Expanded, it holds values not known here.
        doc.into.stdinDynamic = doc.expands && /[$`]/.test(doc.into.stdin);
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
    if ((c === '>' || c === '<') && src[i + 1] === '(' && open === null) {
      // `<(…)` / `>(…)`: a process substitution, a word naming a file that is the output of (or
      // the input to) the code in it. The code runs; the word's value is not known here.
      const end = closeParen(i + 2);
      const code = src.slice(i + 2, Math.max(i + 2, end - 1));
      current.nested.push(code);
      open = { text: '', mask: '', dynamic: true, dynamicAt: 0, procSub: code };
      i = end;
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
    const opened = open as Word | null;
    if (
      c === '(' &&
      opened !== null &&
      /^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?\+?=$/s.test(opened.text)
    ) {
      // `x=( … )`: an array, whose elements may be assigned by subscript (`[HOME=5]=1`).
      current.taint = true;
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
      current.arithmetic.push(src.slice(i + 2, end === -1 ? src.length : end));
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
    // `flock lock -c code`: the code is a shell's.
    if (name === 'flock') {
      const c = rest.findIndex((w, i) => i > 0 && /^(-c|--command)(=|$)/.test(w.text));
      const flag = rest[c];
      if (flag !== undefined) {
        const eq = flag.text.indexOf('=');
        const code = eq === -1 ? rest[c + 1] : sliceWord(flag, eq + 1);
        return { words: [word('sh'), word('-c'), code ?? word('', true)], chdir };
      }
    }
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
  /** Shell code it runs; `unread`: some of it is not known here, said as not read. */
  | { kind: 'inline'; code: string; unread?: string }
  | { kind: 'script'; code: string }
  | {
      kind: 'git';
      dir: Word | null;
      /** Paths it names as written. */
      paths: GitPath[];
      /** It may write any file of these kinds in the working tree, without naming them. */
      whole: FileKinds | null;
      nocase: boolean;
      /** The working tree git is told to use (`--work-tree`); null for the one it finds. */
      workTree: Word | null;
      how?: 'clean' | 'clean-ignored';
      /** Shell code it runs (`git rebase --exec`). */
      exec?: string[];
    }
  /** The command writes files the text cannot tell: said as a limit of the reading. */
  | { kind: 'unread'; why: string; taints?: boolean };

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

/**
 * How a git command a command runs is read: `settings`, a variable that may change what git
 * does is set for it; `timeUp`, the reading is out of time.
 */
interface GitContext {
  settings: boolean;
  timeUp: () => boolean;
  /** What the command reads on its input holds values not known here. */
  stdinDynamic?: boolean;
  /** What the command reads on its input comes through a pipe. */
  stdinPiped?: boolean;
}

const PLAIN_GIT: GitContext = { settings: false, timeUp: () => false };

function classify(
  words: readonly Word[],
  stdin: string | null,
  depth = 0,
  git: GitContext = PLAIN_GIT,
): Verdict {
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
      return readGit(words, stdin, git.settings, git.timeUp);
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
        // A value in it is code the text does not show.
        ...(words.some((w) => w.dynamic)
          ? { unread: 'eval runs code the text does not show' }
          : {}),
      };
    case 'mapfile':
    case 'readarray': {
      // `-C code` runs in this shell every so many lines.
      const callback = optionValue(words, ['-C']);
      return callback ? { kind: 'inline', code: callback.text } : READS;
    }
    case 'source':
    case '.': {
      // Code read from its input or a process substitution: read when the text shows it. A file
      // it names is not read (it runs in this shell, which taints the line).
      const from = args[0] ?? null;
      if (from === null || from.procSub !== undefined || STDIN_PATHS.has(from.text)) {
        const code = codeFrom(from, stdin, git);
        if (code !== null) return { kind: 'inline', code };
        return { kind: 'unread', why: 'source reads code the text does not show', taints: true };
      }
      return { kind: 'unknown', args: withoutScript(words), bare: false };
    }
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
      return classify(words.slice(words.indexOf(runs)), stdin, depth + 1, git);
    }
    default:
      break;
  }

  if (SHELLS.has(program)) {
    const shell = shellInvocation(words);
    // Code the text does not show may do anything, to this line's variables too.
    const unshown: Verdict = {
      kind: 'unread',
      why: 'a shell runs code the text does not show',
      taints: true,
    };
    if (shell.c || shell.dynamic) {
      return shell.operand !== null && !shell.dynamic
        ? { kind: 'inline', code: shell.operand.text }
        : unshown;
    }
    // The code from its input (`-s`, no script, `/dev/stdin`) or a process substitution.
    const from = shell.s ? null : shell.operand;
    if (from === null || from.procSub !== undefined || STDIN_PATHS.has(from.text)) {
      const code = codeFrom(from, stdin, git);
      return code !== null ? { kind: 'inline', code } : unshown;
    }
    // A script file: what it does is its own, as for a program run by its path.
    return { kind: 'unknown', args: withoutScript(words), bare: false };
  }
  if (SCRIPT_RUNNERS.has(program)) {
    if (program === 'node' && hasFlag(words, /^--test$/)) return READS;
    if ((program === 'python' || program === 'python3') && words[1]?.text === '-m') {
      const module = words[2]?.text ?? '';
      const known = CHECKING_PROGRAMS.has(module) || Object.hasOwn(FIXERS, module);
      if (known && depth < MAX_DEPTH) return classify(words.slice(2), stdin, depth + 1, git);
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

/** A path a git command names as written, as the command gives it. */
interface GitPath {
  word: Word;
  /** The word is a path only when such a file or directory exists (else a branch name). */
  ifExists?: boolean;
  /** Only tracked files under it are touched (`git rm`). */
  tracked?: boolean;
  /** A file name, not a pathspec: no wildcard or magic in it is git's (an output file). */
  literal?: boolean;
  /** A directory files of unknown names are put in (a clone, a new working tree). */
  land?: boolean;
  /** For a file name: everything under it goes too, when it is a directory. */
  tree?: boolean;
}

/** git's own options that only print something and run no subcommand. */
const GIT_ONLY_SHOWS = /^(--version|-v|--help|-h|--exec-path|--html-path|--man-path|--info-path)$/;

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
  // A value with a substitution in it is not known here.
  return v !== null && !harmlessVariable(v.name, v.value ?? '', v.adds || w.dynamic);
};

/**
 * Whether setting `name` may change what git does: a name the way environment variables are
 * written (`HOME`, `PATH`, `GIT_DIR`), which may already be exported, and not a harmless one. A
 * lower-case name (`msg=fix`) is the shell's own. `value` is null when it is not known here.
 */
const gitReads = (name: string | null, value: string | null): boolean =>
  name === null ||
  ((/^[A-Z_][A-Z0-9_]*$/.test(name) || /^git_/i.test(name)) &&
    !harmlessVariable(name, value ?? '', value === null));

/**
 * The variable a word names for a builtin that sets one (`export X=1`, `read X`, `declare
 * "$n=1"`): its name, null when a value not known here stands in it, and its value, null when
 * the text does not hold it (none given, `+=`, or a substitution in it).
 */
function namedVariable(w: Word): { name: string | null; value: string | null } {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(\+?=)?/.exec(w.text);
  const name = m?.[1];
  if (name === undefined || (w.dynamic && (w.dynamicAt ?? 0) <= name.length)) {
    return { name: null, value: null };
  }
  const given = m?.[2] === '=' && !w.dynamic;
  return { name, value: given ? w.text.slice((m as RegExpExecArray)[0].length) : null };
}

/**
 * The builtins and keywords of the shells a line may run in: bash 5.2's (`enable -a`, `compgen
 * -k`), and those zsh, ksh and POSIX sh have besides. A program run as a process of its own cannot
 * change this shell; these can: its variables and their attributes, its options, functions and
 * aliases, what a name runs. Each is marked:
 * - `safe`: changes nothing git runs with while its words are plain text (some only without the
 *   options that set a variable or run a command, see {@link builtinTaints});
 * - `prefix`: a keyword in front of the command it runs (`if`, `then`, `!`, `time`);
 * - `taints`: may change what later commands, git among them, run with.
 * Any builtin or keyword not marked safe, anywhere on the line, makes every git command on it a
 * possible change of the whole tree.
 */
export const SHELL_BUILTINS: Readonly<Record<string, 'safe' | 'prefix' | 'taints'>> = {
  // Safe while their words are plain text.
  cd: 'safe',
  pushd: 'safe',
  popd: 'safe',
  dirs: 'safe',
  echo: 'safe',
  printf: 'safe',
  print: 'safe',
  true: 'safe',
  false: 'safe',
  ':': 'safe',
  test: 'safe',
  '[': 'safe',
  pwd: 'safe',
  wait: 'safe',
  exit: 'safe',
  return: 'safe',
  break: 'safe',
  continue: 'safe',
  type: 'safe',
  help: 'safe',
  jobs: 'safe',
  times: 'safe',
  umask: 'safe',
  which: 'safe',
  whence: 'safe',
  where: 'safe',
  for: 'safe',
  fi: 'safe',
  done: 'safe',
  case: 'safe',
  esac: 'safe',
  in: 'safe',
  '{': 'safe',
  '}': 'safe',
  function: 'safe',
  // Keywords in front of the command they run.
  if: 'prefix',
  then: 'prefix',
  elif: 'prefix',
  else: 'prefix',
  while: 'prefix',
  until: 'prefix',
  do: 'prefix',
  '!': 'prefix',
  time: 'prefix',
  // bash's other builtins and keywords.
  '.': 'taints',
  '[[': 'taints',
  ']]': 'taints',
  alias: 'taints',
  bg: 'taints',
  bind: 'taints',
  builtin: 'taints',
  caller: 'taints',
  command: 'taints',
  compgen: 'taints',
  complete: 'taints',
  compopt: 'taints',
  coproc: 'taints',
  declare: 'taints',
  disown: 'taints',
  enable: 'taints',
  eval: 'taints',
  exec: 'taints',
  export: 'taints',
  fc: 'taints',
  fg: 'taints',
  getopts: 'taints',
  hash: 'taints',
  history: 'taints',
  kill: 'taints',
  let: 'taints',
  local: 'taints',
  logout: 'taints',
  mapfile: 'taints',
  read: 'taints',
  readarray: 'taints',
  readonly: 'taints',
  select: 'taints',
  set: 'taints',
  shift: 'taints',
  shopt: 'taints',
  source: 'taints',
  suspend: 'taints',
  trap: 'taints',
  typeset: 'taints',
  ulimit: 'taints',
  unalias: 'taints',
  unset: 'taints',
  // zsh's and ksh's besides.
  autoload: 'taints',
  bindkey: 'taints',
  bye: 'taints',
  chdir: 'taints',
  compound: 'taints',
  disable: 'taints',
  emulate: 'taints',
  end: 'taints',
  float: 'taints',
  foreach: 'taints',
  functions: 'taints',
  getln: 'taints',
  integer: 'taints',
  limit: 'taints',
  nameref: 'taints',
  nocorrect: 'taints',
  noglob: 'taints',
  private: 'taints',
  pushln: 'taints',
  r: 'taints',
  rehash: 'taints',
  repeat: 'taints',
  sched: 'taints',
  setopt: 'taints',
  unfunction: 'taints',
  unhash: 'taints',
  unlimit: 'taints',
  unsetopt: 'taints',
  vared: 'taints',
  zcompile: 'taints',
  zformat: 'taints',
  zle: 'taints',
  zmodload: 'taints',
  zparseopts: 'taints',
  zregexparse: 'taints',
  zstyle: 'taints',
};

/** Whether a builtin marked safe is given an option that sets a variable or runs a command. */
function builtinTaints(name: string, args: readonly Word[]): boolean {
  // A word that does not start as plain text may be any option (`o=-v; printf "$o" …`), where
  // the builtin still reads options; and a subscript with a substitution in it may be evaluated.
  const optionsEnd = args.findIndex((w) => !w.dynamic && !/^[-+]/.test(w.text));
  const options = optionsEnd === -1 ? args : args.slice(0, optionsEnd);
  if (OPTIONED.has(name) && options.some((w) => w.dynamic && !w.dynamicAt)) return true;
  if (args.some(subscripted)) return true;
  switch (name) {
    case 'test':
    case '[':
      // `-v name` and `-R name` evaluate the name, a subscript in it too. A word not plain text
      // may be one of them when a name follows it (`test "$o" 'a[i=1]'`, `test "$o" "$n"`).
      return args.some(
        (w, i) =>
          /^-[vR]$/.test(w.text) ||
          (w.dynamic &&
            !w.dynamicAt &&
            args[i + 1] !== undefined &&
            (args[i + 1]?.dynamic || (args[i + 1] as Word).text.includes('['))),
      );
    case 'printf':
    case 'print':
      // `printf -v name`: the output goes into a variable.
      return args.some((w) => /^-[^-]*v/.test(w.text));
    case 'wait':
      // `wait -p name` sets a variable.
      return args.some((w) => /^-[^-]*p/.test(w.text));
    case 'jobs':
      // `jobs -x command` runs one.
      return args.some((w) => /^-[^-]*x/.test(w.text));
    case 'umask':
      // Only the one that prints the mask.
      return args.some((w) => !/^-[Sp]+$/.test(w.text));
    case 'for':
      // A lower-case loop variable over plain words: anything else may be one git reads.
      return !/^[a-z_][a-z0-9_]*$/.test(args[0]?.text ?? '') || (args[0]?.dynamic ?? true);
    default:
      return false;
  }
}

/** Programs that may put a symbolic link where a later `cd` goes. */
const LINK_MOVERS = new Set([
  'mv',
  'rsync',
  'tar',
  'bsdtar',
  'gtar',
  'unzip',
  'cpio',
  '7z',
  'install',
]);

/** Whether a command may make, copy or move a symbolic link. */
function makesLinks(words: readonly Word[]): boolean {
  const first = words[0];
  if (first === undefined || first.dynamic) return false;
  const name = programName(first);
  const flags = words.slice(1).filter((w) => w.text.startsWith('-'));
  if (name === 'ln') {
    // `-s`, or `--symbolic` as long as it is told (`--sy`).
    return flags.some((w) => /^-[^-]*s/.test(w.text) || /^--sy/.test(w.text));
  }
  if (name === 'cp') {
    // A link is copied as a link with -P, -d, -a, -R, -r, or made with -s.
    return flags.some(
      (w) => /^-[^-]*[sPdaRr]/.test(w.text) || /^--(sy|no-d|ar|rec|R)/.test(w.text),
    );
  }
  if (LINK_MOVERS.has(name)) return true;
  // git checks out what a revision holds, links too.
  return (
    name === 'git' &&
    ![
      'status',
      'log',
      'diff',
      'show',
      'grep',
      'blame',
      'ls-files',
      'rev-parse',
      'branch',
      'fetch',
      'config',
      'add',
      'commit',
      'push',
      'remote',
      'tag',
    ].includes(gitCommand(words).rest[0]?.text ?? '')
  );
}

/** Safe builtins whose options may set a variable or run a command, given as any word. */
const OPTIONED = new Set(['printf', 'print', 'wait', 'jobs', 'umask']);

/** A word with a subscript holding a substitution (`'a[$(…)]'`), which may be evaluated. */
const subscripted = (w: Word): boolean => {
  const at = w.text.indexOf('[');
  return at !== -1 && /\$\(|`/.test(w.text.slice(at));
};

/**
 * Programs that run the program after them, with the environment and words they are given: their
 * words decide what that program runs with. `xargs` and `parallel` give it words read from their
 * input.
 */
const PASSES_ENVIRONMENT = new Set([
  'env',
  'sudo',
  'doas',
  'nice',
  'ionice',
  'nohup',
  'timeout',
  'stdbuf',
  'setsid',
  'chroot',
  'xargs',
  'parallel',
  'flock',
  'unbuffer',
  'watch',
  'chronic',
  'busybox',
  'toybox',
]);

/** A text the shell expands that holds an expansion other than `$name`, `${name}` or `$(…)`. */
const COMPLEX_EXPANSION = /\$\(\(|\$\[|\$\{(?!\w+\}|[@*#?$!-]\})/;

/**
 * What a simple command means for the line: `taints`, it may change what git commands on the
 * line run with, wherever they stand; `gitAt`, `xargs` or `parallel` run git with words read
 * from their input, from this word on.
 *
 * Only plain words keep a line clean: text, `$name`, `${name}`, special parameters, and
 * substitutions (whose code is read as a line of its own). A builtin or keyword not known to be
 * harmless, any other expansion (`${x:=…}`, `${a[…]}`, `$((…))`), arithmetic, an assignment to
 * an element or to an upper-case variable, a program whose name is not plain text, or a word that
 * is not plain text given to a program that runs another (`env "$v" git`) taints it.
 */
function commandTaints(cmd: SimpleCommand): { taints: boolean; gitAt: number | null } {
  const words = cmd.words;
  const tainted = { taints: true, gitAt: null };
  /**
   * Tainted from word `i` on, which hides what runs or with what (`env "$v" git …`): a git
   * that follows is read as git, given settings.
   */
  const taintedAt = (i: number): { taints: true; gitAt: number | null } => {
    const git = words.findIndex((x, k) => k > i && !x.dynamic && programName(x) === 'git');
    return { taints: true, gitAt: git === -1 ? null : git };
  };
  if (cmd.taint || cmd.arithmetic.length > 0) return tainted;
  // A here-document the shell expands runs what is in it.
  if (cmd.stdin !== null && cmd.stdinExpands && COMPLEX_EXPANSION.test(cmd.stdin)) return tainted;
  let at = 0;
  let launched = false;
  let fromInput = false;
  while (at < words.length) {
    // Assignments: to an element (`a[i]=…`), or to a variable git may read.
    const w = words[at] as Word;
    if (w.mask.startsWith('u') && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(w.text)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*\[/.test(w.text)) return tainted;
      const v = namedVariable(w);
      if (gitReads(v.name, v.value)) return tainted;
      if (launched && w.dynamic) return taintedAt(at);
      at++;
      continue;
    }
    // The program: one whose name is not plain text may be anything.
    if (w.dynamic) return taintedAt(at);
    if (/^[A-Za-z_][A-Za-z0-9_]*\[/.test(w.text) && w.text.includes('=')) return tainted;
    const builtin = w.text.includes('/') ? undefined : SHELL_BUILTINS[w.text];
    if (builtin !== undefined && Object.hasOwn(SHELL_BUILTINS, w.text)) {
      if (builtin === 'prefix') {
        at++;
        continue;
      }
      if (builtin === 'taints' || builtinTaints(w.text, words.slice(at + 1))) return tainted;
      return { taints: false, gitAt: null };
    }
    const name = programName(w);
    const launcher = Object.hasOwn(LAUNCHERS, name) ? LAUNCHERS[name] : undefined;
    if (launcher === undefined || !PASSES_ENVIRONMENT.has(name)) {
      if (!fromInput) return { taints: false, gitAt: null };
      // `xargs git …`, `xargs -I{} env {} git …`: git is given words from the input.
      const git = words.findIndex((x, i) => i >= at && !x.dynamic && programName(x) === 'git');
      return git === -1 ? { taints: false, gitAt: null } : { taints: true, gitAt: git };
    }
    launched = true;
    if (name === 'xargs' || name === 'parallel') fromInput = true;
    // Its options, as `programWords` reads them; none may hide what runs or with what.
    at++;
    while (at < words.length) {
      const o = words[at] as Word;
      if (o.dynamic) return taintedAt(at);
      if (o.text === '--') {
        at++;
        break;
      }
      if (!o.text.startsWith('-') || o.text === '-') break;
      // `env -S 'X=1 git …'` splits a string of its own into the words it runs.
      if (name === 'env' && /^(-[^-]*S|--split-string)/.test(o.text)) return tainted;
      const eq = o.text.indexOf('=');
      const flag = eq === -1 ? o.text : o.text.slice(0, eq);
      const takesValue = eq === -1 && (launcher.values ?? []).includes(flag);
      if (takesValue && (words[at + 1]?.dynamic ?? false)) return taintedAt(at + 1);
      at += takesValue ? 2 : 1;
    }
    for (let k = 0; k < (launcher.skip ?? 0) && at < words.length; k++, at++) {
      if ((words[at] as Word).dynamic) return taintedAt(at);
    }
  }
  return { taints: false, gitAt: null };
}

/** The words `env -S` / `--split-string` is given to split, with what follows, as a line. */
function envSplitString(words: readonly Word[]): string | null {
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Word;
    if (programName(w) !== 'env' || w.dynamic) continue;
    for (let j = i + 1; j < words.length; j++) {
      const o = (words[j] as Word).text;
      if (o === '--' || !o.startsWith('-')) break;
      const m = /^(?:-[^-]*S|--split-string=?)(.*)$/s.exec(o);
      if (!m) continue;
      const own = m[1] !== '' ? m[1] : (words[j + 1]?.text ?? '');
      const after = words.slice(m[1] !== '' ? j + 1 : j + 2).map((x) => quoted(x.text));
      return [own, ...after].join(' ');
    }
  }
  return null;
}

const TRACKED_FILES: FileKinds = { tracked: true, untracked: false, ignored: false };
/** Any file that is there, whatever git makes of it. */
const ANY_FILE: FileKinds = { tracked: true, untracked: true, ignored: true };

/**
 * git's own options before the subcommand, and the subcommand with what follows it. `cut`: no
 * time was left to read all of its options.
 */
function gitCommand(
  words: readonly Word[],
  timeUp: () => boolean = () => false,
): {
  dir: Word | null;
  rest: Word[];
  nocase: boolean;
  /** The working tree git is told to use instead of the one it finds (`--work-tree`). */
  workTree: Word | null;
  /** A setting given here may run a program or move what git works on. */
  unsafe: boolean;
  /** Shell code a setting given here runs (`-c alias.x='!…'`). */
  exec: string[];
  cut: boolean;
} {
  let at = 1;
  const next = (): Word | null => (at < words.length ? (words[at++] as Word) : null);
  let dir: Word | null = null;
  let nocase = false;
  let workTree: Word | null = null;
  let unsafe = false;
  let cut = false;
  const exec: string[] = [];
  while (words[at] && isFlag(words[at] as Word)) {
    if (at % 1024 === 0 && timeUp()) {
      cut = true;
      break;
    }
    const flag = next() as Word;
    const eq = flag.text.indexOf('=');
    const name = eq === -1 ? flag.text : flag.text.slice(0, eq);
    if (name === '--icase-pathspecs') nocase = true;
    if (flag.text === '-C') {
      // Each `-C` is taken from where the one before it led.
      const to = next();
      // One too long to place already is not followed further.
      if (dir !== null && dir.text.length > MAX_PATH_CHARS) continue;
      dir = to === null || dir === null || to.text.startsWith('/') ? to : joinWords(dir, to);
      continue;
    }
    // `--name=value` holds its value; `--name value` and `-c value` take the next word.
    const value = eq !== -1 ? sliceWord(flag, eq + 1) : GIT_VALUED.includes(name) ? next() : null;
    if (name === '--work-tree' && value !== null) workTree = value;
    if (name === '--git-dir' || name === '--config-env' || (name === '--exec-path' && eq !== -1))
      unsafe = true;
    if (name === '-c' && value !== null) {
      const set = /^core\.worktree=/i.exec(value.text);
      if (set) workTree = sliceWord(value, set[0].length);
      const at = value.text.indexOf('=');
      const key = at === -1 ? value.text : value.text.slice(0, at);
      const val = at === -1 ? '' : value.text.slice(at + 1);
      const harmless =
        GIT_HARMLESS_CONFIG.test(key) || (GIT_PAGER_SETTING.test(key) && HARMLESS_PAGER.test(val));
      if (!harmless && !set) unsafe = true;
      // An alias that starts with `!` is shell code.
      if (/^alias\./i.test(key) && val.startsWith('!')) exec.push(val.slice(1));
    }
  }
  return { dir, rest: words.slice(at), nocase, workTree, unsafe, exec, cut };
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
  /** No time was left to read all of its words. */
  cut: boolean;
}

function parseGit(
  words: readonly Word[],
  options: GitOptions,
  timeUp: () => boolean = () => false,
): GitParsed {
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
    cut: false,
  };
  const set = (key: string, value: Word | null): void => {
    if (value === null) return;
    const list = out.values.get(key);
    if (list) list.push(value);
    else out.values.set(key, [value]);
  };
  for (let i = 1; i < words.length; i++) {
    if (i % 1024 === 0 && timeUp()) {
      out.cut = true;
      break;
    }
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

/**
 * A word git takes for a pathspec whatever else exists: a wildcard, magic (`:(glob)…`, `:/x`),
 * or a path that can only be one (`.`, `./x`, `x/`).
 */
const surelyPathspec = (w: Word): boolean =>
  /[*?[]/.test(w.text) || w.text.startsWith(':') || /^\.\.?(\/|$)|\/$/.test(w.text);

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
 * git: which subcommands rewrite or remove working files, read from the text alone. A subcommand
 * only looks, or only moves refs or the index, when it is known to and every option it is given
 * keeps it so; anything else (an alias, a subcommand or option not known here, a setting given
 * with `-c` or a `GIT_*` variable, which `settings` says) may change the whole working tree. The
 * paths a command names, the files it writes its output to and the directories it fills are
 * written. A change of the whole tree without named paths (a branch switch, `reset --hard`, a
 * stash, a merge) may write any file there: it is said as such, for a warning.
 */
function readGit(
  words: readonly Word[],
  stdin: string | null,
  settings = false,
  timeUp: () => boolean = () => false,
): Verdict {
  const { dir, rest, nocase, workTree, unsafe, exec: aliases, cut } = gitCommand(words, timeUp);
  const late: Verdict = { kind: 'unread', why: 'no time was left to read all of it' };
  if (cut) return late;
  const sub = rest[0]?.text;
  if (sub === undefined) {
    // No subcommand in the text: `git --version` only prints; anything else (`xargs git`, where
    // the subcommand comes from the input) may be any.
    const shows = words.length > 1 && words.slice(1).every((w) => GIT_ONLY_SHOWS.test(w.text));
    if (shows && !settings && !unsafe) return READS;
    return { kind: 'git', dir, paths: [], whole: ANY_FILE, nocase, workTree };
  }
  const table = GIT_OPTIONS[sub] ?? {};
  const p = parseGit([word('git'), ...rest.slice(1)], table, timeUp);
  if (p.cut) return late;
  const under = (list: readonly Word[]): Word[] =>
    dir ? list.map((w) => joinWords(dir, w)) : [...list];
  // A setting given for this command may make it do anything to the tree.
  const settingsChange = unsafe || settings;
  const named = (paths: readonly (Word | GitPath)[], whole: FileKinds | null = null): Verdict => {
    const list = paths.map((x): GitPath => ('word' in x ? x : { word: x }));
    const all = whole ?? (settingsChange ? ANY_FILE : null);
    return list.length === 0 && all === null
      ? READS
      : {
          kind: 'git',
          dir,
          paths: list,
          whole: all,
          nocase,
          workTree,
          ...(aliases.length > 0 ? { exec: aliases } : {}),
        };
  };
  /** Shell code it runs besides, read like any other (`rebase --exec`, `bisect run`). */
  const running = (v: Verdict, code: readonly string[]): Verdict =>
    v.kind === 'git' && code.length > 0 ? { ...v, exec: [...(v.exec ?? []), ...code] } : v;
  // What it may do to the whole tree is checked against any file that is there: what git counts
  // as tracked or ignored is its business, and an earlier command may change it.
  const whole = (): Verdict => named([], ANY_FILE);
  /** Files it writes, named as files and not as pathspecs. */
  const files = (list: readonly Word[]): GitPath[] => list.map((w) => ({ word: w, literal: true }));
  /** A directory it fills with files of unknown names. */
  const lands = (w: Word): GitPath => ({ word: w, literal: true, land: true });
  /** The directory part of a prefix files are written under (`vendor/` of `vendor/x-`). */
  const prefixDir = (w: Word): Word => {
    const cut = w.text.lastIndexOf('/');
    return cut === -1 ? word('.') : sliceWord(w, 0, cut + 1);
  };

  if (table.safe !== undefined) {
    // Only looking, or only moving refs or the index, as long as each option keeps it so. A push
    // into a repository on this machine may update that one's working tree.
    const outputs = files(gitValues(p, ...(table.output ?? [])));
    const changes = !gitOptionsSafe(p, table) || (sub === 'push' && localRepository(p.args[0]));
    return named(outputs, changes ? ANY_FILE : null);
  }
  // A subcommand whose options are not known here: any word may be an option's value.
  if (GIT_OPTIONS[sub] === undefined) return whole();
  // An option not known here, to a command whose options are, may change what it does.
  const known = [...(table.long ?? []), ...(table.flags ?? [])];
  if (table.strict && [...p.long].some((n) => !known.includes(n))) return whole();
  // Paths read from a file or from standard input: those an `echo` before the pipe gives are
  // read, any others are not known here.
  const fromInput =
    p.long.has('--pathspec-from-file') || (sub === 'checkout-index' && p.long.has('--stdin'));
  if (fromInput) {
    const from = gitValues(p, '--pathspec-from-file')[0]?.text ?? '-';
    if (from !== '-' || stdin === null) {
      return sub === 'reset'
        ? named([])
        : { kind: 'unread', why: 'git reads the paths it changes from a file or its input' };
    }
    const listed = stdin
      .split(/[\n\0]/)
      .filter((x) => x.trim() !== '')
      .map((x) => word(x, true));
    p.args.push(...listed);
    if (sub === 'checkout') p.afterDashes = [...(p.afterDashes ?? []), ...listed];
  }
  const patch = gitHas(p, 'p', ['--patch']);
  const verb = rest[1] && !isFlag(rest[1]) ? rest[1].text : null;
  switch (sub) {
    case 'format-patch': {
      // Patch files named after their commits, in the folder given or where it runs: what they
      // are called is told by a sample name with the suffix they get.
      if (gitHas(p, '', ['--stdout'])) return named([]);
      const single = gitValues(p, '--output');
      if (single.length > 0) return named(files(single));
      const into = gitValues(p, 'o', '--output-directory')[0];
      const suffix = gitValues(p, '--suffix')[0]?.text ?? '.patch';
      const name = word(p.long.has('--numbered-files') ? '1' : `0001-patch${suffix}`);
      return named(files([into ? joinWords(into, name) : name]));
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
      if (reads) return named([]);
      // A file of its own is only that file, unless it is one git reads its settings from (the
      // repository's, the user's, the system's, `.gitmodules`).
      const file = gitValues(p, 'f', '--file');
      const own = file.length > 0 && !file.some(gitReadsConfig);
      const key = (verb === 'set' ? p.args[1] : p.args[0])?.text ?? '';
      const harmless = !gitHas(p, 'e', ['--edit']) && (own || GIT_HARMLESS_CONFIG.test(key));
      return named(files(file), harmless ? null : ANY_FILE);
    }
    case 'merge-file':
      // The first file takes the result, unless it goes to the standard output.
      return gitHas(p, 'p', ['--stdout']) || p.args[0] === undefined
        ? named([])
        : named(files([p.args[0]]));
    case 'checkout-index': {
      // With a prefix, the files are written under it, named as they are in the index.
      const prefix = gitValues(p, '--prefix')[0];
      if (prefix) return named([lands(prefixDir(prefix))]);
      if (gitHas(p, 'a', ['--all'])) return whole();
      return named(files(p.args));
    }
    case 'read-tree': {
      // An index written elsewhere is a file. Without -u nothing else of the tree changes.
      const out = files(gitValues(p, '--index-output'));
      if (!gitHas(p, 'u')) return named(out);
      const prefix = gitValues(p, '--prefix')[0];
      return prefix ? named([...out, lands(prefixDir(prefix))]) : named(out, ANY_FILE);
    }
    case 'init': {
      // A new repository, in the folder given or where it runs, with its own files apart when
      // told (`--separate-git-dir`). The hooks of a template run on later commands.
      const into = [...p.args.slice(0, 1), ...gitValues(p, '--separate-git-dir')];
      return named(into.map(lands), p.long.has('--template') ? ANY_FILE : null);
    }
    case 'clone': {
      // The new repository's folder: given, or named after what is cloned, and its own files when
      // put apart. It runs code from what it clones only when told to (a program to fetch with,
      // hooks from a template or a setting). One cloned from here brings the files this one has,
      // covered ones included.
      const [from, to] = p.args;
      const into = [...(to ? [to] : cloneName(from)), ...gitValues(p, '--separate-git-dir')];
      const runs = gitHas(p, 'uc', ['--upload-pack', '--template', '--config']);
      return named(into.map(lands), runs || localSource(from) ? ANY_FILE : null);
    }
    case 'submodule': {
      // `submodule add` clones into the folder given, or one named after what it clones;
      // `foreach` runs shell code in each. Other verbs check out what the submodules record.
      const q = parseGit([word('git'), ...rest.slice(1)], table, timeUp);
      if (q.cut) return late;
      const [action, ...args] = q.args;
      if (action === undefined || ['status', 'summary'].includes(action.text)) return named([]);
      if (action.text === 'foreach') return running(whole(), [args.map((w) => w.text).join(' ')]);
      if (action.text !== 'add') return whole();
      const [from, to] = args;
      const into = to ? [to] : cloneName(from);
      return named(into.map(lands), localSource(from) ? ANY_FILE : null);
    }
    case 'difftool':
      // A program given to run on each pair of files is shell code.
      return running(
        whole(),
        gitValues(p, 'x', '--extcmd').map((w) => w.text),
      );
    case 'worktree': {
      const q = parseGit([word('git'), ...rest.slice(2)], table, timeUp);
      if (q.cut) return late;
      if (['list', 'lock', 'unlock', 'prune', 'repair'].includes(verb ?? '')) return named([]);
      // A new working tree is checked out in the folder given, with the files this one has; one
      // removed or moved goes with what is in it.
      if (verb === 'add') return named(q.args[0] ? [lands(q.args[0])] : [], ANY_FILE);
      if (verb === 'remove' || verb === 'move')
        return named(q.args.map((w) => ({ word: w, literal: true, tree: true })));
      return whole();
    }
    case 'bisect': {
      if (['log', 'visualize', 'view', 'help', 'terms'].includes(verb ?? '')) return named([]);
      if (verb !== 'run') return whole();
      // The command it runs at each step: one word is shell code, several are a program and its
      // arguments, which no shell reads again.
      const run = rest.slice(2);
      const code =
        run.length === 1 ? (run[0] as Word).text : run.map((w) => quoted(w.text)).join(' ');
      return running(whole(), run.length > 0 ? [code] : []);
    }
    case 'sparse-checkout':
      return verb === 'list' ? named([]) : whole();
    case 'restore': {
      // `--staged` alone only moves the index; the file on disk stays.
      if (gitHas(p, 'S', ['--staged']) && !gitHas(p, 'W', ['--worktree'])) return named([]);
      if (p.args.length === 0) return patch ? whole() : named([]);
      return named(p.args);
    }
    case 'rm':
      if (gitHas(p, 'n', ['--cached', '--dry-run'])) return named([]);
      // It removes the tracked files its pathspecs match.
      return named(p.args.map((w) => ({ word: w, tracked: true })));
    case 'mv': {
      if (gitHas(p, 'n', ['--dry-run'])) return named([]);
      const dest = p.args[p.args.length - 1];
      if (dest === undefined) return named([]);
      const sources = p.args.slice(0, -1);
      const [to] = under([dest]) as [Word];
      const entries = under(sources).map((s) => ({ name: posix.basename(s.text), from: s }));
      return settingsChange
        ? named([...sources, dest])
        : writes(...trees(under(sources)), { word: to, tree: true, entries });
    }
    case 'clean': {
      if (gitHas(p, 'n', ['--dry-run'])) return named([]);
      // Untracked files; ignored ones too with -x / -X, or when an exclude pattern takes a file
      // back out of what is ignored (`-e '!.env'`). Without a path, all of them where it runs.
      const unignores = gitValues(p, 'e', '--exclude').some((v) => v.text.startsWith('!'));
      const ignored = gitHas(p, 'xX') || unignores;
      const kinds = { tracked: false, untracked: true, ignored };
      return {
        kind: 'git',
        dir,
        paths: p.args.map((w) => ({ word: w })),
        whole: p.args.length === 0 ? kinds : settingsChange ? ANY_FILE : null,
        nocase,
        workTree,
        how: ignored ? 'clean-ignored' : 'clean',
      };
    }
    case 'checkout': {
      const force = gitHas(p, 'f', ['--force']);
      const args = p.args;
      // Paths after `--` (from the index, or from a revision before it).
      if (p.afterDashes !== null)
        return p.afterDashes.length > 0 ? named(p.afterDashes) : patch ? whole() : named([]);
      // These only make sense with paths; in patch mode without one, any file may change.
      if (gitHas(p, '', ['--ours', '--theirs'])) return named(args);
      if (patch && args.length <= 1) return args.length === 0 ? whole() : named(args, ANY_FILE);
      // A new branch made here, without a start point, changes no file.
      if (gitHas(p, 'bB', ['--orphan'])) return args.length > 0 || force ? whole() : named([]);
      const first = args[0];
      if (first === undefined) return force ? whole() : named([]);
      // A revision followed by paths, or paths only: the first word is a path when one exists.
      if (args.length >= 2) return named([{ word: first, ifExists: true }, ...args.slice(1)]);
      // One word: a pathspec, or a path when one exists, or a branch to switch to.
      if (surelyPathspec(first)) return named([first]);
      return named([{ word: first, ifExists: true }], ANY_FILE);
    }
    case 'switch': {
      const force = gitHas(p, 'f', ['--force', '--discard-changes']);
      const creates = gitHas(p, 'cC', ['--create', '--force-create']);
      // A new branch made here, without a start point, changes no file.
      if (creates && p.args.length === 0 && !force) return named([]);
      if (!creates && p.args.length === 0 && !p.long.has('--orphan')) return named([]);
      return whole();
    }
    case 'stash': {
      const stashVerb = verb ?? 'push';
      if (['list', 'show', 'create', 'drop', 'clear', 'store'].includes(stashVerb))
        return named([]);
      if (!['push', 'save'].includes(stashVerb) && verb !== null) return whole();
      // `git stash [push] [--] [paths]` puts changes away: the files go back to HEAD. A message
      // (`-m wip`, `-um wip`) is a value, never a path.
      const q = parseGit([word('git'), ...rest.slice(verb === null ? 1 : 2)], table, timeUp);
      if (q.cut) return late;
      const paths = stashVerb === 'save' ? [] : q.args;
      if (gitHas(q, 'p', ['--patch']) && paths.length === 0) return whole();
      return paths.length > 0 ? named(paths) : whole();
    }
    case 'reset':
      // With paths, or without --hard, it only moves the index.
      return gitHas(p, '', ['--hard', '--merge', '--keep']) ? whole() : named([]);
    case 'apply':
      // Only looking at the patch, or applying it to the index alone.
      if (
        !p.long.has('--apply') &&
        (gitHas(p, '', ['--check', '--stat', '--numstat', '--summary']) ||
          (p.long.has('--cached') && !p.long.has('--index')))
      )
        return named([]);
      return whole();
    case 'rebase': {
      // The commands it runs after each commit are read like any other shell code.
      return running(
        whole(),
        gitValues(p, 'x', '--exec').map((w) => w.text),
      );
    }
    default:
      // merge, pull, cherry-pick, revert, am, submodule, send-pack, an alias, anything not known
      // here: the whole tree may change, whatever its flags say.
      return whole();
  }
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
  /**
   * Set when a limit cut the reading short (a very long command, too many targets, nesting too
   * deep, a path too long, no time left): what was not read may write files, so the targets are
   * not the whole answer.
   */
  limit: string | null;
  /**
   * False when the line is not one Mindly reads fully (see {@link understoodLine}) and was not
   * read: its one target is the whole working tree, a possible write.
   */
  understood: boolean;
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
  /**
   * Whether a path (relative to where the command starts, or absolute) is a symbolic link. A
   * `cd` through one makes where later commands run unknown. Without it, none is.
   */
  linked?: (path: string) => boolean;
  /**
   * Whether a path (relative to where the command starts, or absolute) is a folder on disk. With
   * `understoodOnly`, a leading `cd` to one that is not there makes the line one not read fully.
   */
  isDir?: (path: string) => boolean;
  /**
   * Read only a line Mindly reads fully; any other stands for a possible write of the whole
   * working tree, never a certain one.
   */
  understoodOnly?: boolean;
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
  const fully = options.understoodOnly ? understanding(command) : true;
  const reading: Reading = {
    out: new Map(),
    limit: null,
    home: options.home ?? null,
    top: options.top ?? null,
    timeUp: options.timeUp ?? (() => false),
    commands: 0,
    // A line not read fully is only read for the paths it names, within a smaller budget.
    maxCommands: fully === true ? MAX_COMMANDS : MAX_UNREAD_COMMANDS,
    gitEnv: false,
    later: [],
    deferred: new Set(),
    added: new Set(),
    splitChars: 0,
    // Only the leading `cd` of a line read fully is asked about on disk.
    linked: fully === true ? (options.linked ?? null) : null,
    linksMade: false,
    made: [],
    madeDirs: new Set(),
    isDir: fully === true ? (options.isDir ?? null) : null,
    unmatched: false,
  };
  collectTargets(command, '', 0, reading);
  // A variable git reads is set somewhere on the line: the git commands read before it may change
  // the whole tree too.
  if (reading.gitEnv) for (const then of reading.later) then();
  // A line not read fully, or with a wildcard that may match what the line makes first (`mkdir
  // keys && cp x k*/`): what it writes is not known here. It may write the whole tree, and what
  // it names is a possible write, never a certain one.
  if (fully !== true || (options.understoodOnly && reading.unmatched)) {
    const unread = unreadLine(options.top ?? null);
    // What it names may be written, and files of names not known here may land in it (`mkdir
    // vendor && cp x v*/`).
    // The first few only: they add to a warning the whole tree gets anyway.
    const named = [...reading.out.values()]
      .slice(0, MAX_UNREAD_TARGETS)
      .flatMap((t) => [
        { ...t, certain: false },
        ...(t.how === 'write' && !t.glob
          ? [{ ...t, certain: false, how: 'land' as const, entries: [], sources: [] }]
          : []),
      ]);
    return {
      ...unread,
      targets: [...named, ...unread.targets],
      limit: typeof fully === 'string' ? fully : null,
    };
  }
  return {
    targets: [...reading.out.values()],
    limit: reading.limit,
    understood: true,
  };
}

/** Paths of a line not read fully kept as possible writes. */
const MAX_UNREAD_TARGETS = 32;

/** Simple commands read of a line not read fully, for the paths it names. */
const MAX_UNREAD_COMMANDS = 2000;

/** Simple commands a line read fully may hold; one with more is read as not read fully. */
const MAX_UNDERSTOOD_COMMANDS = 4000;

/** A word as the one pass over a line sees it. */
interface PlainWord {
  text: string;
  /** Some of it was quoted. */
  quoted: boolean;
  /** Where in `text` the first quoted part starts; -1 for none. */
  quoteAt: number;
}

/**
 * How a program's words are read when Mindly reads it fully: the single letters and the long
 * names of its options as the reader takes them, those of them that take the next word as a
 * value, and `any` for a program none of whose options writes a file or runs a program. A long
 * name must be given whole; an abbreviation, or an option not listed, makes the line one not read
 * fully. `refuse`: options that make even an `any` program one not read fully.
 */
interface ReadFully {
  letters?: string;
  long?: readonly string[];
  /** Letters that take the next word, given alone (`-t dir`). */
  values?: string;
  /** Long names that take the next word, or a value after `=`. */
  longValues?: readonly string[];
  any?: boolean;
  refuse?: RegExp;
}

/**
 * The programs whose writes the reader models completely, with every option it takes as the
 * program does. Any other program makes a line one not read fully: sort, uniq, awk, sed, rg,
 * interpreters, compilers, package managers and anything not known here.
 */
const READ_FULLY: Readonly<Record<string, ReadFully>> = {
  // git: its own tables say what each subcommand and option does, and anything not known there
  // is a possible change of the whole tree.
  git: { any: true },
  rm: {
    letters: 'fridIv',
    long: [
      '--force',
      '--recursive',
      '--dir',
      '--interactive',
      '--verbose',
      '--preserve-root',
      '--no-preserve-root',
      '--one-file-system',
    ],
  },
  // `-T` (the destination itself takes the source's place) is not modelled.
  mv: {
    letters: 'finuv',
    values: 't',
    long: [
      '--force',
      '--interactive',
      '--no-clobber',
      '--update',
      '--verbose',
      '--strip-trailing-slashes',
    ],
    longValues: ['--target-directory'],
  },
  cp: {
    letters: 'aRrdfiHLlnPpsuvx',
    values: 't',
    long: [
      '--archive',
      '--recursive',
      '--force',
      '--interactive',
      '--no-clobber',
      '--dereference',
      '--no-dereference',
      '--link',
      '--symbolic-link',
      '--preserve',
      '--no-preserve',
      '--update',
      '--verbose',
      '--one-file-system',
      '--remove-destination',
      '--strip-trailing-slashes',
      '--attributes-only',
      '--sparse',
      '--reflink',
    ],
    longValues: ['--target-directory'],
  },
  ln: {
    letters: 'sfnvrLP',
    values: 't',
    long: [
      '--symbolic',
      '--force',
      '--no-dereference',
      '--verbose',
      '--relative',
      '--logical',
      '--physical',
    ],
    longValues: ['--target-directory'],
  },
  mkdir: { letters: 'pv', values: 'm', long: ['--parents', '--verbose'], longValues: ['--mode'] },
  rmdir: { letters: 'v', long: ['--ignore-fail-on-non-empty', '--verbose'] },
  touch: { letters: 'acmh', long: ['--no-create', '--no-dereference', '--time'] },
  chmod: {
    letters: 'Rvcf',
    long: [
      '--recursive',
      '--verbose',
      '--changes',
      '--silent',
      '--quiet',
      '--preserve-root',
      '--no-preserve-root',
    ],
  },
  chown: {
    letters: 'RvcfhHLP',
    long: [
      '--recursive',
      '--verbose',
      '--changes',
      '--silent',
      '--quiet',
      '--dereference',
      '--no-dereference',
      '--preserve-root',
      '--no-preserve-root',
    ],
  },
  cat: { any: true },
  ls: { any: true },
  head: { any: true },
  tail: { any: true },
  wc: { any: true },
  // Not into folders: what it reads there is not read here.
  grep: { any: true, refuse: /^-[^-]*[rRd]|^--(recursive|dereference-recursive|directories)/ },
  echo: { any: true },
  printf: { any: true, refuse: /^-[^-]*v/ },
  // Builtins that change nothing git runs with while their words are plain text.
  cd: {},
  true: { any: true },
  false: { any: true },
  ':': { any: true },
  pwd: { any: true },
  exit: {},
  test: { any: true, refuse: /^-[vR]$/ },
  '[': { any: true, refuse: /^-[vR]$/ },
};

/** Programs a pipe may feed on a line read fully: they only filter what they are given. */
const READ_FULLY_FILTERS = new Set(['head', 'tail', 'grep', 'wc', 'cat']);

/** Keywords around commands that a line read fully may use. */
const UNDERSTOOD_KEYWORDS = new Set(['if', 'then', 'elif', 'else']);

/**
 * Whether a wildcard path may match one of `made` (paths written earlier on the line), or a
 * folder above one: part by part, `*` and `?` within a part, `**` across parts.
 */
function mayMatchMade(pattern: string, made: readonly string[]): boolean {
  if (made.length === 0) return false;
  const parts = pattern.split('/');
  if (parts.includes('**')) return made.length > 0;
  const res = parts.map(
    (p) =>
      new RegExp(
        `^${p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')}$`,
      ),
  );
  return made.some((m) => {
    const ms = m.split('/');
    const n = Math.min(ms.length, res.length);
    for (let i = 0; i < n; i++) if (!(res[i] as RegExp).test(ms[i] as string)) return false;
    return true;
  });
}

/** How many of a program's words are operands, not options or their values. */
function operandCount(table: ReadFully, args: readonly PlainWord[]): number {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    const t = (args[i] as PlainWord).text;
    if (t === '--') return n + args.length - i - 1;
    if (!t.startsWith('-') || t === '-') n++;
    else if (/^-.$/.test(t) && (table.values ?? '').includes(t.slice(1))) i++;
    else if ((table.longValues ?? []).includes(t)) i++;
  }
  return n;
}

/** Whether a program's words are all ones its table reads as the program does. */
function optionsReadFully(table: ReadFully, args: readonly PlainWord[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = (args[i] as PlainWord).text;
    if (t === '--') return true;
    if (table.refuse?.test(t)) return false;
    if (table.any || !t.startsWith('-') || t === '-') continue;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      if ((table.longValues ?? []).includes(name)) {
        if (eq === -1) i++;
        continue;
      }
      if (!(table.long ?? []).includes(name)) return false;
      continue;
    }
    // A cluster of letters; one that takes a value stands alone, its value the next word.
    const letters = t.slice(1);
    if (letters.length === 1 && (table.values ?? '').includes(letters)) {
      i++;
      continue;
    }
    if (![...letters].every((l) => (table.letters ?? '').includes(l))) return false;
  }
  return true;
}

/**
 * Whether a command line is one Mindly reads fully, and so checks exactly: every part of it is
 * plain text the reader takes as the shell does, and every program on it is one whose writes the
 * reader models completely, given only options it reads as the program does (see
 * {@link READ_FULLY}). Words of plain characters (`*` and `?` included, as long as they cannot
 * match what an earlier command of the line makes), single-quoted text, double-quoted text with no
 * `$`, backtick or backslash; `&&`, `||`, `;` and line ends between commands; `>`, `>>`, `2>`,
 * `&>` to a plain path, `2>&1`, `</dev/null`; a pipe into `head`, `tail`, `grep`, `wc` or `cat`;
 * assignments by the shell's rules, to lower-case variables or harmless upper-case ones (`LANG`,
 * `TZ`); `env` with no option of its own; and the keywords of `if`. Anything else (a `$`, a
 * backtick, a backslash, parentheses, braces, a `[…]` class, `!`, a here-document or
 * here-string, a process substitution, a background `&`, a function, a loop, any other builtin,
 * any other program or option, a program given by its path, an assignment to `HOME`, `PWD`,
 * `CDPATH` or another variable a program reads, more than a few thousand commands) makes it a line
 * not read fully. One pass over the text.
 */
export function understoodLine(command: string): boolean {
  return understanding(command) === true;
}

/** Whether a line is read fully; when it is not for its size alone, why (a limit). */
function understanding(command: string): true | false | string {
  if (command.length > MAX_COMMAND_CHARS)
    return `only the first ${MAX_COMMAND_CHARS} characters were read`;
  const said = { tooMany: false };
  if (scanLine(command, said)) return true;
  return said.tooMany ? `more than ${MAX_UNDERSTOOD_COMMANDS} commands` : false;
}

/** The one pass of {@link understoodLine}; `said.tooMany`: it stopped for the count alone. */
function scanLine(command: string, said: { tooMany: boolean }): boolean {
  // Each command, whether a pipe feeds it, and whether `&&` follows it.
  const commands: { words: PlainWord[]; piped: boolean; and: boolean }[] = [];
  let words: PlainWord[] = [];
  let piped = false;
  let text = '';
  let quoted = false;
  // Where in the word the first quoted text starts (`A='x'`: after `A=`); -1 for none.
  let quoteAt = -1;
  let open = false;
  // A bracket outside quotes is only `[` or `]` as a word of its own (`test`).
  let bracket = false;
  const endWord = (): boolean => {
    if (!open) return true;
    if (bracket && !(text === '[' || text === ']')) return false;
    words.push({ text, quoted, quoteAt });
    text = '';
    quoted = false;
    quoteAt = -1;
    open = false;
    bracket = false;
    return true;
  };
  const endCommand = (nextPiped: boolean, and = false): boolean => {
    if (!endWord()) return false;
    // `a ; ; b`, `| x`: an empty command between separators is a syntax the reader does not take.
    if (words.length === 0 && (nextPiped || piped)) return false;
    if (words.length > 0) commands.push({ words, piped, and });
    // More than are read in good time is not read exactly.
    if (commands.length > MAX_UNDERSTOOD_COMMANDS) {
      said.tooMany = true;
      return false;
    }
    words = [];
    piped = nextPiped;
    return true;
  };
  /** A redirection's target: a plain word after it, read whole. */
  let target: 'any' | 'null' | null = null;
  // `*` and `?` are read as the shell matches them, against the files that exist.
  const plainChar = /[A-Za-z0-9_./:@=+,%^~*?-]/;
  const s = command;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === ' ' || c === '\t') {
      if (target === null && !endWord()) return false;
      if (target !== null && open) {
        if (!endTarget()) return false;
      }
      continue;
    }
    if (c === '\n' || c === ';') {
      if (target !== null && !endTarget()) return false;
      if (c === ';' && s[i + 1] === ';') return false;
      if (!endCommand(false)) return false;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return false;
      if (!quoted) quoteAt = text.length;
      text += s.slice(i + 1, end);
      quoted = true;
      open = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let end = i + 1;
      while (end < s.length && s[end] !== '"') {
        const d = s[end] as string;
        if (d === '$' || d === '`' || d === '\\') return false;
        end++;
      }
      if (end >= s.length) return false;
      if (!quoted) quoteAt = text.length;
      text += s.slice(i + 1, end);
      quoted = true;
      open = true;
      i = end;
      continue;
    }
    if (c === '&' || c === '|') {
      if (target !== null && !endTarget()) return false;
      if (s[i + 1] === c) {
        if (!endCommand(false, c === '&')) return false;
        i++;
        continue;
      }
      if (c === '&' && s[i + 1] === '>') {
        // `&>file`, `&>>file`.
        if (!endWord()) return false;
        i += s[i + 2] === '>' ? 2 : 1;
        target = 'any';
        continue;
      }
      // A background `&`, `|&`: not taken.
      if (c === '&' || s[i + 1] === '&') return false;
      if (!endCommand(true)) return false;
      continue;
    }
    if (c === '>' || c === '<') {
      if (target !== null) return false;
      // A file descriptor written right before it (`2>`) is part of the redirection.
      if (open && !quoted && /^\d+$/.test(text)) {
        text = '';
        open = false;
      } else if (!endWord()) return false;
      if (c === '<') {
        if (s[i + 1] === '<' || s[i + 1] === '(' || s[i + 1] === '&' || s[i + 1] === '>')
          return false;
        target = 'null';
        continue;
      }
      if (s[i + 1] === '(' || s[i + 1] === '|') return false;
      if (s[i + 1] === '&') {
        // `2>&1`, `>&2`: one stream into another.
        let j = i + 2;
        while (j < s.length && /\d/.test(s[j] as string)) j++;
        if (j === i + 2 || (s[j] !== undefined && !/[\s;&|]/.test(s[j] as string))) return false;
        i = j - 1;
        continue;
      }
      if (s[i + 1] === '>') i++;
      target = 'any';
      continue;
    }
    if (c === '#' && !open) return false;
    if (c === '[' || c === ']') {
      bracket = true;
      text += c;
      open = true;
      continue;
    }
    if (plainChar.test(c) || c.charCodeAt(0) > 127 || (c === '#' && open)) {
      text += c;
      open = true;
      continue;
    }
    // `$`, a backtick, a backslash, parentheses, braces, a glob, `!`, a control character.
    return false;
  }
  function endTarget(): boolean {
    if (!open || bracket) return false;
    if (target === 'null' && text !== '/dev/null') return false;
    text = '';
    quoted = false;
    quoteAt = -1;
    open = false;
    target = null;
    return true;
  }
  if (target !== null && !endTarget()) return false;
  if (!endCommand(false)) return false;
  // Where a `cd` lands is not followed: only one at the start, to a folder, followed by `&&`
  // (the rest runs there or not at all), is read. Any other `cd`, `pushd` or `popd` is not.
  return commands.every((cmd, at) => {
    const first = cmd.words[0];
    const moves = cmd.words.some(
      (w, k) =>
        ['cd', 'pushd', 'popd'].includes(w.text) &&
        cmd.words.slice(0, k).every((x) => UNDERSTOOD_KEYWORDS.has(x.text) || assignment(x)),
    );
    if (moves) {
      const operand = cmd.words[1];
      return (
        at === 0 &&
        cmd.and &&
        first?.text === 'cd' &&
        cmd.words.length === 2 &&
        operand !== undefined &&
        !operand.text.startsWith('-')
      );
    }
    return understoodCommand(cmd.words, cmd.piped);
  });
}

/** Whether a word is an assignment by the shell's rules: a name and `=` outside quotes. */
const assignment = (w: PlainWord): boolean => {
  const m = /^[A-Za-z_][A-Za-z0-9_]*\+?=/.exec(w.text);
  return m !== null && (w.quoteAt === -1 || w.quoteAt >= m[0].length);
};

/** Whether a simple command of plain words is one the reader takes as the shell does. */
function understoodCommand(all: readonly PlainWord[], piped: boolean): boolean {
  let at = 0;
  // Keywords of `if` in front of the command; `fi` on its own.
  while (at < all.length && !all[at]?.quoted && UNDERSTOOD_KEYWORDS.has(all[at]?.text ?? '')) at++;
  if (at === all.length) return at > 0 || all.length === 0;
  if (all.length - at === 1 && all[at]?.text === 'fi' && !all[at]?.quoted) return true;
  for (let launched = false; ; launched = true) {
    // Assignments by the shell's rules: a name and `=` outside quotes, whatever the value. One
    // to a variable git or a builtin reads (`HOME`, `PWD`, `CDPATH`, any upper-case one but the
    // harmless) is not read here.
    while (at < all.length) {
      const w = all[at] as PlainWord;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(w.text);
      if (!m || (w.quoteAt !== -1 && w.quoteAt < m[0].length)) break;
      const name = m[1] as string;
      const value = w.text.slice(m[0].length);
      if (!/^[a-z_][a-z0-9_]*$/.test(name) && !harmlessVariable(name, value, m[2] === '+'))
        return false;
      at++;
    }
    const first = all[at];
    if (first === undefined) return !launched;
    // `env` with no option of its own, then more assignments and the program.
    if (first.text === 'env' && !launched) {
      at++;
      if (all[at]?.text.startsWith('-')) return false;
      continue;
    }
    // A program by its name alone: one by its path may be anything.
    if (first.text.includes('/')) return false;
    const table = Object.hasOwn(READ_FULLY, first.text) ? READ_FULLY[first.text] : undefined;
    if (table === undefined) return false;
    if (piped && !READ_FULLY_FILTERS.has(first.text)) return false;
    const args = all.slice(at + 1);
    // `ln target` with no link name links into the folder it runs in: not modelled.
    if (
      first.text === 'ln' &&
      operandCount(table, args) < 2 &&
      !args.some((w) => /^(-t|--target-directory)/.test(w.text))
    )
      return false;
    return optionsReadFully(table, args);
  }
}

/** A reading of a line not read fully: what it may write is the whole working tree. */
function unreadLine(top: string | null): ShellReading {
  return {
    targets: [
      {
        path: top ?? '.',
        glob: false,
        dotfiles: false,
        nocase: false,
        tree: true,
        how: 'write',
        entries: [],
        sources: [],
        certain: false,
        only: null,
        ifExists: false,
        touches: ANY_FILE,
      },
    ],
    limit: null,
    understood: false,
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
  /** Simple commands read at most. */
  maxCommands: number;
  /**
   * Something on the line, anywhere and in any shell, may set a variable git reads: every git
   * command on it may then change the whole tree.
   */
  gitEnv: boolean;
  /** For each git command read before that was known: what it may change if so. */
  later: (() => void)[];
  /** The git commands (and where they run) already in `later`. */
  deferred: Set<string>;
  /** What `add` was already given, so a repeat of it costs nothing. */
  added: Set<string>;
  /** Characters `env -S` strings gave to read, over the whole line. */
  splitChars: number;
  /** Whether a path, placed as targets are, is a symbolic link; null when not asked. */
  linked: ((path: string) => boolean) | null;
  /** A command read so far makes symbolic links (`ln -s`). */
  linksMade: boolean;
  /** Paths earlier commands of the line write, as placed. */
  made: string[];
  /** Folders earlier commands of the line make (`mkdir`), as placed. */
  madeDirs: Set<string>;
  /** Whether a path, placed as targets are, is a folder on disk; null when not asked. */
  isDir: ((path: string) => boolean) | null;
  /** A wildcard may match what an earlier command of the line makes. */
  unmatched: boolean;
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
    if (r.out.size >= MAX_TARGETS) {
      r.limit ??= `more than ${MAX_TARGETS} write targets`;
      return;
    }
    const w = item.pattern ? { ...item.word, mask: 'u'.repeat(item.word.text.length) } : item.word;
    if (w.dynamic || w.text === '' || w.text === '-') return;
    if (w.cut) r.limit ??= `a brace expansion of more than ${MAX_BRACE_WORDS} words`;
    // The same word, given the same way from the same place, adds nothing new: a long line of
    // repeats is read in the time of one.
    if (item.entries === undefined) {
      const flags = `${item.tree ? 't' : ''}${item.certain === false ? 'u' : ''}${item.ifExists ? 'e' : ''}${item.pattern ? 'p' : ''}${item.dotfiles ? 'd' : ''}${item.nocase ? 'c' : ''}`;
      const kinds = item.touches
        ? `${item.touches.tracked ? 't' : ''}${item.touches.untracked ? 'u' : ''}${item.touches.ignored ? 'i' : ''}`
        : '-';
      // What earlier commands made is part of it: a wildcard may match it now (`ln -s` between).
      const same = `${r.made.length}\0${from === null ? '\u0001' : from}\0${previous === null ? '\u0001' : previous}\0${w.text}\0${w.mask}\0${flags}\0${item.how ?? ''}\0${kinds}\0${item.only?.join('/') ?? '\u0001'}`;
      if (r.added.has(same)) return;
      if (r.added.size < MAX_COMMANDS) r.added.add(same);
    }
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
    // No more than are kept are placed.
    const entries = (item.entries ?? []).slice(0, MAX_ENTRIES).map((e) => ({
      name: e.name,
      source: e.from === null || e.from.dynamic ? null : place(e.from.text, tilde(e.from), from),
    }));
    for (const form of forms) {
      const path = place(form.text, tilde(w), from);
      // A wildcard the shell matches against what is there when it runs: one that may match
      // what an earlier command of the line makes (`mkdir keys && cp x k*/`) is not read here.
      if (path !== null && form.glob && !item.pattern && mayMatchMade(path, r.made)) {
        r.unmatched = true;
      }
      if (path === null && from === null && !posix.isAbsolute(form.text)) {
        r.limit ??= 'a command runs in a folder the text does not tell';
      }
      if (path === null || /^\/(dev|proc)\//.test(path)) continue;
      const touches = item.touches ?? null;
      const kinds = touches
        ? `${touches.tracked ? 't' : ''}${touches.untracked ? 'u' : ''}${touches.ignored ? 'i' : ''}`
        : '';
      const key = `${path}\0${form.glob ? 'g' : ''}${item.ifExists ? 'e' : ''}${item.nocase ? 'c' : ''}${how}\0${kinds}`;
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
        touches,
      });
    }
  };
  /** Where a `cd` to `to` leads from `from`; null when unknown. */
  const enter = (to: Word, from: string | null): string | null =>
    to.dynamic ? null : place(to.text, tilde(to), from);
  /**
   * Whether the way from `from` to `to` passes a symbolic link, as the caller's `linked` finds
   * on disk: the shell's `..` after it, and the paths git is given there, lead elsewhere than the
   * text says. Unknown (too many parts, no time) counts as yes.
   */
  const throughLink = (to: Word, from: string | null): boolean => {
    if (to.dynamic) return false;
    // A line that makes symbolic links may make one on the way: any way that names a folder.
    if (r.linksMade && to.text.split('/').some((p) => p !== '' && p !== '.' && p !== '..'))
      return true;
    if (r.linked === null) return false;
    const parts = to.text.split('/');
    if (parts.length > 64) return true;
    let cur: string | null = parts[0] === '' ? '/' : place(parts[0] as string, tilde(to), from);
    if (cur === null) return false;
    if (parts[0] !== '' && parts[0] !== '.' && parts[0] !== '..' && r.linked(cur)) return true;
    for (const part of parts.slice(1)) {
      if (part === '' || part === '.') continue;
      cur = posix.join(cur, part);
      if (part !== '..' && r.linked(cur)) return true;
    }
    return false;
  };
  /** Whether a directory is inside the working tree the command line starts in, as far as known. */
  const insideTop = (at: string | null): boolean =>
    at !== null &&
    (/^(\/|~|\.\.(\/|$))/.test(at)
      ? r.top !== null && (at === r.top || at.startsWith(`${r.top}/`))
      : true);

  type GitVerdict = Extract<Verdict, { kind: 'git' }>;
  /**
   * Where a git command works: where it runs (or where `-C` sends it), the working tree it reads
   * paths in (`--work-tree`), and whether that is the tree the line starts in. Null, with the
   * reason said, when the text does not tell, or it is a working tree outside this one.
   */
  const gitWhere = (
    verdict: GitVerdict,
    here: string | null,
  ): { at: string; base: string; top: boolean } | null => {
    let at = verdict.dir ? enter(verdict.dir, here) : here;
    if (verdict.dir && at !== null && throughLink(verdict.dir, here)) at = null;
    if (at === null) {
      r.limit ??= 'a git command runs in a folder the text does not tell';
      return null;
    }
    let base = at;
    if (verdict.workTree !== null) {
      const tree = enter(verdict.workTree, at);
      if (tree === null || !insideTop(tree)) {
        r.limit ??= 'a git command works on another working tree';
        return null;
      }
      base = tree;
    }
    return { at, base, top: r.top !== null && verdict.workTree === null && insideTop(at) };
  };
  /**
   * A git command may change any file of these kinds in the whole working tree: from its top
   * when it is the tree the line starts in. `git clean` cleans where it runs.
   */
  const wholeTree = (
    verdict: GitVerdict,
    where: { base: string; top: boolean },
    kinds: FileKinds,
  ): void =>
    add(
      {
        word: word(where.top && verdict.how === undefined ? TOP : '.'),
        tree: true,
        certain: false,
        how: verdict.how ?? 'write',
        touches: kinds,
      },
      where.base,
    );

  // How many targets earlier commands of this reading wrote.
  let made = r.out.size;
  /**
   * A copy, move or link into a path an earlier command of the line made: into a folder `mkdir`
   * made, what it brings lands inside (`dest/name`); into anything else made there, whether it is
   * a folder is not known here, and the line is not read fully.
   */
  const intoMade = (items: readonly Item[], from: string | null): Item[] => {
    if (r.made.length === 0) return [...items];
    const out: Item[] = [];
    for (const item of items) {
      const dest =
        item.entries === undefined ? null : place(item.word.text, tilde(item.word), from);
      if (dest === null || item.word.dynamic) {
        out.push(item);
        continue;
      }
      if (r.madeDirs.has(dest)) {
        // `mkdir` may have failed, or not run: the destination itself is written too.
        out.push(item);
        for (const e of item.entries ?? []) {
          if (e.name === '*') {
            r.unmatched = true;
            continue;
          }
          const name = e.name === '.' ? '' : `/${e.name}`;
          const text = `${item.word.text}${name}`;
          out.push({
            word: { ...item.word, text, mask: `${item.word.mask}${'q'.repeat(name.length)}` },
            tree: true,
          });
        }
        continue;
      }
      if (r.made.some((m) => m === dest || dest.startsWith(`${m}/`))) r.unmatched = true;
      out.push(item);
    }
    return out;
  };
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
    if (r.commands > r.maxCommands) {
      r.limit ??= `more than ${r.maxCommands} commands`;
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
    const runs = programWords(cmd.words);
    const { chdir } = runs;
    let { words } = runs;
    const here = chdir ? enter(chdir, at) : at;
    for (const red of cmd.redirects) if (red.op.startsWith('>')) add({ word: red.target }, here);
    // A builtin, an expansion or a word that may set what git runs with, anywhere on the line,
    // counts for every git command on it (see `commandTaints`).
    const taint = commandTaints(cmd);
    if (taint.taints) r.gitEnv = true;
    // `xargs git …`: git, given words from the input, is read from its name on.
    if (taint.gitAt !== null) words = cmd.words.slice(taint.gitAt);
    // `env -S '…'` splits a string into the words it runs: read as a line of its own, within a
    // budget for the whole line (a split string may hold another).
    const split = envSplitString(cmd.words);
    if (split !== null) {
      r.splitChars += split.length;
      if (r.splitChars > MAX_COMMAND_CHARS || r.timeUp()) {
        r.limit ??= 'env -S splits more than was read';
        r.gitEnv = true;
      } else collectTargets(split, here, depth + 1, r);
    }
    // What the program reads on standard input, when the text shows it: its own here-document,
    // or what an `echo` / `printf` / `cat <<EOF` before the pipe prints.
    let stdin = cmd.stdin;
    let stdinDynamic = cmd.stdinDynamic;
    const stdinPiped = stdin === null && cmd.piped;
    if (stdin === null && cmd.piped && before !== null) {
      const feeder = programWords(before.words).words;
      const name = feeder[0] && !feeder[0].dynamic ? programName(feeder[0]) : '';
      if (name === 'echo' || name === 'printf') {
        stdinDynamic = feeder.some((w) => w.dynamic);
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
      } else if (name === 'cat' && feeder.length === 1) {
        stdin = before.stdin;
        stdinDynamic = before.stdinDynamic;
      }
    }
    before = cmd;
    // A variable set for git, or a line that may set what it runs with (above), may make it do
    // anything to the tree.
    const assigned = cmd.words
      .slice(0, words[0] ? cmd.words.indexOf(words[0]) : cmd.words.length)
      .some((w) => isAssignment(w) && unsafeVariable(w));
    const settings = assigned || r.gitEnv;
    const verdict = classify(words, stdin, 0, {
      settings,
      timeUp: r.timeUp,
      stdinDynamic,
      stdinPiped,
    });
    // A program not known here that is given `git` and words after it (`taskset -c 0 git …`,
    // `strace -f git …`) may run git with settings of its own: read from there as git given one.
    const gitAt =
      verdict.kind === 'unknown' && words[0] !== undefined && programName(words[0]) !== 'git'
        ? words.findIndex(
            (w, i) => i > 0 && i < words.length - 1 && !w.dynamic && /(^|\/)git$/.test(w.text),
          )
        : -1;
    const launched =
      gitAt === -1
        ? null
        : classify(words.slice(gitAt), stdin, 0, { settings: true, timeUp: r.timeUp });
    const runsGit = !settings && words.some((w) => !w.dynamic && programName(w) === 'git');
    // A short command given again is read again only once.
    const deferral =
      runsGit && words.length <= 64
        ? JSON.stringify([here, previous, stdin, words.map((w) => [w.text, w.mask, w.dynamic])])
        : null;
    if (runsGit && (deferral === null || !r.deferred.has(deferral))) {
      // Read again, as given a setting, if one turns up later on the line.
      if (deferral !== null) r.deferred.add(deferral);
      const from = { here, previous };
      r.later.push(() => {
        const again = classify(words, stdin, 0, { settings: true, timeUp: r.timeUp });
        if (again.kind !== 'git' || again.whole === null) return;
        const kept = previous;
        previous = from.previous;
        const where = gitWhere(again, from.here);
        if (where) wholeTree(again, where, again.whole);
        previous = kept;
      });
    }
    /** Code this command runs: a shell's, git's own, or this shell's (`eval`, `trap`). */
    const nested = (code: string, from: string | null): void =>
      collectTargets(code, from, depth + 1, r);
    const judge = (verdict: Verdict): void => {
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
          // Through a symbolic link, `..` and the paths git is given lead elsewhere than the text
          // says: where later commands run is not known.
          if (to !== null && next !== null && throughLink(to, dir)) {
            next = null;
            r.unmatched = true;
          }
          // A folder that is not there: the `cd` fails, and what follows does not run.
          if (next !== null && r.isDir !== null && !r.isDir(next)) r.unmatched = true;
          if (verdict.how === 'pushd' && stack.length < 256) stack.push(dir);
          previous = dir;
          dir = next;
          break;
        }
        case 'writes':
          for (const item of intoMade(verdict.items, here)) add(item, here);
          break;
        case 'unread':
          r.limit ??= verdict.why;
          if (verdict.taints) r.gitEnv = true;
          break;
        case 'inline':
          nested(verdict.code, here);
          if (verdict.unread !== undefined) {
            r.limit ??= verdict.unread;
            r.gitEnv = true;
          }
          break;
        case 'git': {
          const where = gitWhere(verdict, here);
          if (where === null) break;
          const { at, base, top } = where;
          const how = verdict.how ?? 'write';
          const possibly = (kinds: FileKinds): void => wholeTree(verdict, where, kinds);
          if (verdict.whole !== null) possibly(verdict.whole);
          for (const code of verdict.exec ?? []) nested(code, at);
          // Files and folders named as such, where git runs: an output file, a folder a clone or
          // a new working tree is put in.
          for (const p of verdict.paths) {
            if (p.literal)
              add({ word: p.word, tree: p.tree ?? false, how: p.land ? 'land' : 'write' }, at);
          }
          const pathspecs = verdict.paths.filter((p) => !p.literal);
          if (pathspecs.some((p) => p.word.dynamic)) break;
          // Pathspecs that only leave files out stand for everything else. One given again (the
          // same text, read the same way) adds nothing.
          const seen = new Set<string>();
          const given: { p: GitPath; magic: ReturnType<typeof pathspecMagic> }[] = [];
          let excluded = false;
          for (const p of pathspecs) {
            const key = `${p.word.text}\0${p.word.mask}\0${p.ifExists ? 'e' : ''}${p.tracked ? 't' : ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const magic = pathspecMagic(p.word.text);
            if (magic.exclude) excluded = true;
            else given.push({ p, magic });
          }
          if (given.length === 0 && excluded) possibly(ANY_FILE);
          for (const { p, magic } of given) {
            if (r.out.size >= MAX_TARGETS) {
              r.limit ??= `more than ${MAX_TARGETS} write targets`;
              break;
            }
            const bare = magic.rest === '' ? '.' : magic.rest;
            const fromTop = magic.top && top;
            // The tree where it runs named as `.` (or the top, `:/`): any tracked file there.
            if (bare === '.' && !magic.literal) {
              add(
                {
                  word: word(fromTop ? TOP : '.'),
                  tree: true,
                  certain: false,
                  how,
                  touches: ANY_FILE,
                },
                base,
              );
              continue;
            }
            const patterns = magic.literal || magic.glob ? [bare] : gitWildcards(bare);
            for (const pattern of patterns) {
              const text = fromTop ? `${TOP}/${pattern}` : pattern;
              add(
                {
                  word: {
                    text,
                    mask: (magic.literal ? 'q' : 'u').repeat(text.length),
                    dynamic: false,
                    cut: p.word.cut,
                  },
                  tree: true,
                  how,
                  ifExists: p.ifExists ?? false,
                  // git's wildcards also match names that start with a dot.
                  dotfiles: true,
                  nocase: verdict.nocase || magic.icase,
                  // `git rm` only removes tracked files.
                  ...(p.tracked ? { touches: TRACKED_FILES } : {}),
                },
                base,
              );
            }
          }
          break;
        }
        case 'script': {
          const found = readCode(verdict.code);
          for (const p of found.paths) {
            // A bare name is a path only when a file of that name exists.
            const item: Item = { word: word(p.text, true), certain: p.certain, tree: p.tree };
            if (looksLikePath(p.text)) add(item, here);
            else if (p.certain && /^[\w@+.-]+$/.test(p.text))
              add({ ...item, ifExists: true }, here);
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
    };
    judge(verdict);
    if (launched !== null) judge(launched);
    // A program that may make or move a symbolic link (`ln -s`, `cp -P` / `-a` / `-R`, `mv`, an
    // archive unpacked, git checking one out): a later `cd` may pass through it.
    if (makesLinks(words)) r.linksMade = true;
    // What it writes is there for the wildcards of later commands; a folder `mkdir` makes (with
    // its parents, under `-p`) is one for the copies of later commands.
    if (r.out.size > made && r.made.length < MAX_TARGETS) {
      r.made = [...r.out.values()].map((t) => t.path).slice(0, MAX_TARGETS);
    }
    made = r.out.size;
    if (verdict.kind === 'writes' && words[0] !== undefined && programName(words[0]) === 'mkdir') {
      for (const item of verdict.items) {
        const at = item.word.dynamic ? null : place(item.word.text, tilde(item.word), here);
        for (let p = at; p !== null && p !== '' && p !== '.' && p !== '/'; p = posix.dirname(p)) {
          if (r.madeDirs.size < MAX_TARGETS) r.madeDirs.add(p);
          if (!hasOption(words, 'p', ['--parents'])) break;
        }
      }
    }
  }
}

/** The commands of `$(…)` and backtick substitutions in a text the shell expands. */
function substitutions(text: string, most = 20): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < most; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] === '(') {
      // Arithmetic, not a command: what it holds is read on.
      i += 2;
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
