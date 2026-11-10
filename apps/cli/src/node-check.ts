/*
 * Which Node.js versions Mindly runs on, checked before anything loads the built-in `node:sqlite`.
 * npm only warns about `engines`, so an unsupported Node gets the package installed; without this
 * check every command would fail on the SQLite import with an error that sends the user to
 * `mindly doctor`, which fails the same way.
 *
 * `node:sqlite` needs no flag from 22.13 on the 22 line and from 23.4 on the 23 line. Keep this in
 * line with `engines` in apps/cli/package.json and the release build.
 */

/** The supported range, as written in `engines`. */
export const SUPPORTED_NODE = '^22.13.0 || >=23.4.0';

/** The sentence telling the user which Node they need. */
export const NODE_REQUIREMENT =
  'Mindly needs Node.js 22.13 or newer (23.4 or newer on the 23 line)';

function parse(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `version` (as in `process.version`) is in {@link SUPPORTED_NODE}. */
export function nodeVersionSupported(version: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const [major, minor] = v;
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major > 23;
}

/** Commands that work without SQLite, so they skip the check. */
function needsNoSqlite(argv: readonly string[]): boolean {
  if (argv.length === 0) return true;
  const first = argv[0];
  return (
    first === '-v' ||
    first === '--version' ||
    first === '-h' ||
    first === '--help' ||
    (first === 'help' && argv.length <= 2)
  );
}

export interface NodeCheck {
  version: string;
  /** Loads `node:sqlite`; rejects when this Node does not provide it. */
  loadSqlite: () => Promise<unknown>;
}

/**
 * Null when this Node can run the command in `argv`, else the line to print. The SQLite import is
 * tried even on a supported version: a Node built without it, or started with
 * `--no-experimental-sqlite`, fails the same way an old one does.
 */
export async function nodeProblem(
  argv: readonly string[],
  check: NodeCheck,
): Promise<string | null> {
  if (needsNoSqlite(argv)) return null;
  if (!nodeVersionSupported(check.version)) return `${NODE_REQUIREMENT}; this is ${check.version}.`;
  try {
    await check.loadSqlite();
    return null;
  } catch {
    return `${NODE_REQUIREMENT} with its built-in SQLite; this Node (${check.version}) does not provide it.`;
  }
}

/**
 * Commands an agent runs on its own. They must never print to the agent or fail it, so on an
 * unsupported Node they end quietly with success, as any other hook failure does.
 */
export function failsOpen(argv: readonly string[]): boolean {
  return argv[0] === 'hook' || argv[0] === 'statusline';
}
