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
const CLI_ENTRY_RE = /(^|[\\/])(mindly-cli|apps[\\/]cli)[\\/]dist[\\/]main\.js$/;
const RUNTIME_RE = /^(node|bun|deno)(\.exe)?$/;
const PACKAGE_RUNNER_RE = /^(npx|pnpm|pnpx|yarn|bunx)(\.cmd|\.exe)?$/;

/**
 * True when `launcher` (the words before `hook`, `statusline` or `mcp`) starts Mindly: the
 * `mindly` executable, a JavaScript runtime running the CLI's `dist/main.js`, or a package runner
 * asked for `mindly`/`mindly-cli`. Options after the program are allowed.
 */
export function isMindlyLauncher(launcher: readonly string[]): boolean {
  const [first, ...rest] = launcher;
  if (first === undefined) return false;
  const bin = baseName(first);
  if (MINDLY_BIN_RE.test(bin)) return true;
  if (RUNTIME_RE.test(bin)) return rest.some((w) => CLI_ENTRY_RE.test(w));
  if (PACKAGE_RUNNER_RE.test(bin)) return rest.some((w) => MINDLY_BIN_RE.test(w));
  return false;
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
