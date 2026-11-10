import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MindlyError } from '@mindly/core';
import { schemaVersion, type Db } from './db.js';
import { MIGRATIONS } from './migrations.js';

/*
 * A read-only, constant-cost view of one project for status lines. It never writes (no
 * migrations, no project or session rows, no WAL checkpoint), so it is safe to run every few
 * seconds next to hooks, the MCP server and the daemon.
 */

/** Counts shown in an agent's status line. */
export interface Glance {
  projectName: string;
  /** Approved or verified rules in effect (branch-scoped rules only on their branch). */
  rules: number;
  /** Pending, unexpired deliveries waiting for this session (or its agent kind). */
  updates: number;
  /** Open conflicts that need the user (same rule as `conflictNeedsUser`). */
  conflicts: number;
  /** Confirmed saves caught since local midnight (absent means 0). */
  saves?: number;
}

/** Local midnight of the day containing `now`. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Opens the database read-only. Throws when it does not exist or its schema is not the one this
 * Mindly knows (an older database is migrated by the next normal command, not here).
 */
export function openDatabaseReadOnly(path: string, options: { busyTimeoutMs?: number } = {}): Db {
  if (!existsSync(path)) throw new MindlyError('not_found', 'Mindly database does not exist');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 200)}`);
    db.exec('PRAGMA trusted_schema = OFF');
    if (schemaVersion(db) !== MIGRATIONS.length) {
      throw new MindlyError('unavailable', 'Mindly database schema does not match this version');
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

const SQLITE_MAGIC = 'SQLite format 3\0';
/** Offset of the 4-byte big-endian user version in the database header. */
const USER_VERSION_OFFSET = 60;
const SQLITE_HEADER_BYTES = 100;

/** The first `SQLITE_HEADER_BYTES` of the file (fewer when it is shorter). */
function readHeader(path: string): Buffer {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER_BYTES);
    return header.subarray(0, readSync(fd, header, 0, SQLITE_HEADER_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * The schema version of the database at `path`, read without migrating it. Null when there is no
 * database yet; 0 for an empty file, which has no schema yet either. A diagnostic uses it to tell
 * an older or newer database from one this Mindly can work with before it opens the store (which
 * upgrades an older database and refuses a newer one).
 *
 * The version is taken from the file's header, so nothing is opened and no file is created. The
 * header is only behind while a write-ahead log holds changes not yet copied into the file; when
 * such a log is there, the database is opened read-only instead, which reads through the log (and
 * may leave the `-shm` file SQLite needs for that).
 */
export function peekSchemaVersion(
  path: string,
  options: { busyTimeoutMs?: number } = {},
): number | null {
  if (!existsSync(path)) return null;
  if (!isNonEmptyFile(`${path}-wal`)) {
    const header = readHeader(path);
    if (header.length === 0) return 0;
    if (
      header.length === SQLITE_HEADER_BYTES &&
      header.toString('latin1', 0, SQLITE_MAGIC.length) === SQLITE_MAGIC
    ) {
      return header.readUInt32BE(USER_VERSION_OFFSET);
    }
    // Not a database header: let SQLite say what is wrong with the file.
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 200)}`);
    return schemaVersion(db);
  } finally {
    db.close();
  }
}

/** The project whose root is `dir` or its nearest ancestor, or null when Mindly does not know it. */
function findProject(db: Db, dir: string): { id: string; name: string } | null {
  const stmt = db.prepare('SELECT id, name FROM projects WHERE root = ?');
  let current = realpathSync(dir);
  for (;;) {
    const row = stmt.get(current) as { id: string; name: string } | undefined;
    if (row) return row;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function count(db: Db, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { n: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Counts for the project containing `dir`, as seen by the agent session `externalSessionId`
 * of `agentKind` (null when the session is not known yet). Returns null when `dir` is not inside
 * a project Mindly has seen.
 */
export function readGlance(
  db: Db,
  input: { dir: string; agentKind: string; externalSessionId: string | null; now: number },
): Glance | null {
  const project = findProject(db, input.dir);
  if (project === null) return null;
  const session =
    input.externalSessionId === null
      ? undefined
      : (db
          .prepare(
            'SELECT id, branch FROM sessions WHERE project_id = ? AND agent_kind = ? AND external_id = ?',
          )
          .get(project.id, input.agentKind, input.externalSessionId) as
          { id: string; branch: string | null } | undefined);
  const branch = session?.branch ?? null;
  const rules = count(
    db,
    `SELECT COUNT(*) AS n FROM memories
     WHERE project_id = ? AND status = 'active' AND kind = 'rule' AND trust IN ('approved', 'verified')
       ${branch === null ? '' : 'AND (scope_branch IS NULL OR scope_branch = ?)'}`,
    ...(branch === null ? [project.id] : [project.id, branch]),
  );
  const sessionId = session?.id ?? '';
  const updates = count(
    db,
    `SELECT COUNT(*) AS n FROM deliveries
     WHERE project_id = ? AND status = 'pending' AND expires_at >= ?
       AND (target_session_id = ? OR (target_session_id IS NULL AND (target_agent_kind = ? OR target_agent_kind IS NULL)))
       AND (source_session_id IS NULL OR source_session_id != ?)`,
    project.id,
    input.now,
    sessionId,
    input.agentKind,
    sessionId,
  );
  const conflicts = count(
    db,
    `SELECT COUNT(*) AS n FROM conflicts WHERE project_id = ? AND status = 'open' AND severity != 'info'`,
    project.id,
  );
  // One range count on the saves_project index (project_id, status, created_at). The table always
  // exists here: `openDatabaseReadOnly` refuses a database that is not on this schema version.
  const saves = count(
    db,
    `SELECT COUNT(*) AS n FROM saves WHERE project_id = ? AND status = 'confirmed' AND created_at >= ?`,
    project.id,
    startOfLocalDay(input.now),
  );
  return { projectName: project.name, rules, updates, conflicts, ...(saves > 0 ? { saves } : {}) };
}
