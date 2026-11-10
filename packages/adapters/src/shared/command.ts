import { invalidInput } from '@mindly/core';

/** Name under which Mindly registers its MCP server in every agent config. */
export const MCP_SERVER_NAME = 'mindly';

const SAFE_ARG_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;

/**
 * Validates the Mindly launcher argv from `InstallOptions.command`. Rejects empty argv, empty
 * elements and anything containing NUL, CR or LF (which cannot be safely embedded in an agent's
 * single-line command string).
 */
export function validateArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGS) {
    throw invalidInput('command must be a non-empty argv array');
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg === '' || arg.length > MAX_ARG_CHARS) {
      throw invalidInput('command arguments must be non-empty strings');
    }
    if (/[\0\r\n]/.test(arg)) {
      throw invalidInput('command arguments must not contain newlines or NUL bytes');
    }
  }
}

/**
 * Quotes one argument for a POSIX shell. Arguments made only of safe characters are left bare;
 * everything else is wrapped in single quotes with embedded quotes written as `'\''`.
 */
export function shellQuote(arg: string): string {
  if (SAFE_ARG_RE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Joins a validated argv into a POSIX shell command string. */
export function shellJoin(argv: readonly string[]): string {
  validateArgv(argv);
  return argv.map(shellQuote).join(' ');
}

/** The command string an agent runs for a hook: `<command> hook <agentKind> <nativeEvent>`. */
export function hookCommand(
  command: readonly string[],
  agentKind: string,
  nativeEvent: string,
): string {
  return shellJoin([...command, 'hook', agentKind, nativeEvent]);
}

/** The MCP server launch spec: `<command> mcp --agent <agentKind>`. */
export function mcpLaunch(
  command: readonly string[],
  agentKind: string,
): { command: string; args: string[] } {
  validateArgv(command);
  const [bin, ...rest] = command as [string, ...string[]];
  return { command: bin, args: [...rest, 'mcp', '--agent', agentKind] };
}

/**
 * Splits a command into words when it uses only the quoting {@link shellJoin} produces (bare safe
 * characters and single-quoted segments). Returns null for anything else: pipes, redirections,
 * variables, other quoting.
 */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  const re = /\s+|[A-Za-z0-9_@%+=:,./-]+|'[^']*'|\\'/gy;
  let word: string | null = null;
  let consumed = 0;
  for (const m of command.matchAll(re)) {
    if (m.index !== consumed) return null;
    consumed += m[0].length;
    const token = m[0];
    if (/^\s/.test(token)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      const text = token === "\\'" ? "'" : token.startsWith("'") ? token.slice(1, -1) : token;
      word = (word ?? '') + text;
    }
  }
  if (consumed !== command.length) return null;
  if (word !== null) words.push(word);
  return words;
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? '';
const MINDLY_BIN_RE = /^mindly(-cli)?(\.cmd|\.exe)?$/;
/**
 * The program a package runner runs: `mindly-cli`, optionally pinned to a version or a tag
 * (`mindly-cli@0.5.0`, `mindly-cli@latest`), as `mindly init` records it when run with npx; or
 * the `mindly` command of an installed `mindly-cli`, unpinned (`mindly@1.0.0` would be the npm
 * package called `mindly`, which is not this one).
 */
const MINDLY_PACKAGE_RE = /^(mindly-cli(@[A-Za-z0-9][A-Za-z0-9._+-]*)?|mindly)$/;
/** Runner options that take the next word as their value. */
const RUNNER_VALUE_OPTIONS = new Set(['-p', '--package']);
/** Runner options after which the command is not a program and its arguments. */
const RUNNER_SHELL_OPTIONS = new Set(['-c', '--call', '--shell-mode']);
/** Subcommands of runners that run a package (`pnpm dlx x`, `yarn exec x`). */
const RUNNER_SUBCOMMANDS = new Set(['dlx', 'exec', 'x']);
const CLI_ENTRY_RE = /(^|[\\/])(mindly-cli|apps[\\/]cli)[\\/]dist[\\/]main\.js$/;
const RUNTIME_RE = /^(node|bun|deno)(\.exe)?$/;
const PACKAGE_RUNNER_RE = /^(npx|pnpm|pnpx|yarn|bunx)(\.cmd|\.exe)?$/;

/**
 * True when `launcher` runs Mindly through a package runner (`npx --yes mindly-cli@0.5.0`), whatever
 * version it was pinned to: after an upgrade, what an older install wrote is still Mindly's. Only
 * the program the runner runs counts: `npx -p mindly-cli other-tool` runs `other-tool`.
 */
export function isPackageRunnerLauncher(launcher: readonly string[]): boolean {
  const [first, ...rest] = launcher;
  if (first === undefined || !PACKAGE_RUNNER_RE.test(baseName(first))) return false;
  let subcommandSeen = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string;
    if (word === '--') {
      const program = rest[i + 1];
      return program !== undefined && MINDLY_PACKAGE_RE.test(program);
    }
    if (word.startsWith('-')) {
      const name = word.split('=')[0] as string;
      if (RUNNER_SHELL_OPTIONS.has(name)) return false;
      if (RUNNER_VALUE_OPTIONS.has(name) && !word.includes('=')) i++;
      continue;
    }
    if (!subcommandSeen && RUNNER_SUBCOMMANDS.has(word)) {
      subcommandSeen = true;
      continue;
    }
    return MINDLY_PACKAGE_RE.test(word);
  }
  return false;
}

/**
 * True when `launcher` (the words before `hook`, `statusline` or `mcp`) starts Mindly: the
 * `mindly` executable, a JavaScript runtime running the CLI's `dist/main.js`, or a package runner
 * asked for `mindly`/`mindly-cli` (any pinned version). Options after the program are allowed.
 */
export function isMindlyLauncher(launcher: readonly string[]): boolean {
  const [first, ...rest] = launcher;
  if (first === undefined) return false;
  const bin = baseName(first);
  if (MINDLY_BIN_RE.test(bin)) return true;
  if (RUNTIME_RE.test(bin)) return rest.some((w) => CLI_ENTRY_RE.test(w));
  return isPackageRunnerLauncher(launcher);
}

/**
 * True when `command` is a hook command Mindly installed for `agentKind`: exactly
 * `<launcher> hook <agentKind> <event>`, where the launcher is `launcher` (the one in use now) or
 * one Mindly may have written before (see {@link isMindlyLauncher}). Another tool's command that
 * merely ends in the same words, or a user's own wrapper around Mindly's (a pipe, `|| true`), is
 * not Mindly's and is left alone.
 */
export function isMindlyHookCommand(
  command: unknown,
  agentKind: string,
  launcher?: readonly string[],
): boolean {
  if (typeof command !== 'string') return false;
  const words = shellWords(command.trim());
  if (words === null || words.length < 4) return false;
  const [hook, kind, event] = words.slice(-3) as [string, string, string];
  if (hook !== 'hook' || kind !== agentKind || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(event)) {
    return false;
  }
  const used = words.slice(0, -3);
  if (launcher !== undefined && sameWords(used, launcher)) return true;
  return isMindlyLauncher(used);
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}
