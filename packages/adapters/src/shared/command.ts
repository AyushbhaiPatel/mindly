import { invalidInput } from '@synapse/core';

/** Name under which Synapse registers its MCP server in every agent config. */
export const MCP_SERVER_NAME = 'synapse';

const SAFE_ARG_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4096;

/**
 * Validates the Synapse launcher argv from `InstallOptions.command`. Rejects empty argv, empty
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `command` is a hook command Synapse installed for `agentKind`, i.e. it contains the
 * words `hook <agentKind>` (bare or single-quoted) followed by an event name.
 */
export function isSynapseHookCommand(command: unknown, agentKind: string): boolean {
  if (typeof command !== 'string') return false;
  const kind = escapeRe(agentKind);
  const re = new RegExp(`(^|\\s)'?hook'?\\s+'?${kind}'?\\s+\\S`);
  return re.test(command);
}
