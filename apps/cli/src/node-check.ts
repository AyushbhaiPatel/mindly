/*
 * Which Node.js versions Mindly runs on, checked before anything loads the built-in `node:sqlite`.
 * npm only warns about `engines`, so an unsupported Node gets the package installed; without this
 * check every command would fail on the SQLite import, or on the first search index, with an
 * error that sends the user to `mindly doctor`, which fails the same way.
 *
 * Mindly needs `node:sqlite` without a flag and with FTS5 compiled in. The 22 line ships FTS5 from
 * 22.16.0; no 23.x release has it; 24.0.0 and later do. Keep this in line with `engines` in
 * apps/cli/package.json, the root package.json and the release build.
 */

/** The supported range, as written in `engines`. */
export const SUPPORTED_NODE = '^22.16.0 || >=24.0.0';

/** The sentence telling the user which Node they need. */
export const NODE_REQUIREMENT =
  'Mindly needs Node.js 22.16 or newer on the 22 line, or 24 or newer';

function parse(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `version` (as in `process.version`) is in {@link SUPPORTED_NODE}. */
export function nodeVersionSupported(version: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const [major, minor] = v;
  if (major === 22) return minor >= 16;
  return major >= 24;
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

/**
 * Loads `node:sqlite` and creates an FTS5 table in a throwaway in-memory database. Rejects when the
 * module is missing (`--no-experimental-sqlite`, a Node built without it) or when its SQLite lacks
 * FTS5 (a Node linked against a system SQLite built without it).
 */
export async function loadSqliteWithFts5(): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(body)');
  } finally {
    db.close();
  }
}

export interface NodeCheck {
  version: string;
  /** Loads `node:sqlite` and checks it has FTS5; rejects when this Node does not provide them. */
  loadSqlite: () => Promise<unknown>;
}

/**
 * Null when this Node can run the command in `argv`, else the line to print. SQLite is probed even
 * on a supported version: a Node built without it, started with `--no-experimental-sqlite`, or
 * linked against a SQLite without FTS5 fails the same way an old one does.
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
    return `${NODE_REQUIREMENT}, with its built-in SQLite and full-text search (FTS5); this Node (${check.version}) does not provide them.`;
  }
}

/**
 * Commands an agent runs on its own. They must never print to the agent or fail it, so on an
 * unsupported Node they end quietly with success, as any other hook failure does.
 */
export function failsOpen(argv: readonly string[]): boolean {
  return argv[0] === 'hook' || argv[0] === 'statusline';
}
