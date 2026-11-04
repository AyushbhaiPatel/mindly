import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SynapseError } from '@synapse/core';
import { MIGRATIONS } from './migrations.js';

export type Db = DatabaseSync;
export type SqlValue = SQLInputValue;
export type Row = Record<string, SqlValue>;

export interface OpenOptions {
  /** Milliseconds to wait for a lock held by another process (hooks, MCP, daemon). */
  busyTimeoutMs?: number;
}

/**
 * Opens (creating if necessary) the Synapse database with hardened settings and applies pending
 * migrations. Safe to call concurrently from several processes: WAL mode allows one writer and
 * many readers, and `busy_timeout` makes writers queue instead of failing.
 */
export function openDatabase(path: string, options: OpenOptions = {}): Db {
  if (path !== ':memory:' && !existsSync(path)) {
    // Create the file ourselves so it is owner-only from the first byte.
    closeSync(openSync(path, 'a', 0o600));
  }
  if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Schema objects (triggers, views) must not be able to call application-defined functions.
  db.exec('PRAGMA trusted_schema = OFF');
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: Db): void {
  const current = schemaVersion(db);
  const latest = MIGRATIONS.length;
  if (current > latest) {
    throw new SynapseError(
      'unavailable',
      `database schema v${current} is newer than this Synapse (v${latest}); upgrade Synapse`,
    );
  }
  for (let v = current; v < latest; v++) {
    const sql = MIGRATIONS[v] as string;
    transaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

let savepointCounter = 0;
const depth = new WeakMap<Db, number>();

/**
 * Runs `fn` inside a transaction. Top-level calls use `BEGIN IMMEDIATE` to take the write lock up
 * front (avoids SQLITE_BUSY upgrade deadlocks between processes); nested calls use savepoints.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = level > 0 ? `sp_${++savepointCounter}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    } catch {
      // The original error is more useful than a rollback failure.
    }
    throw err;
  } finally {
    depth.set(db, level);
  }
}

// ---------------------------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------------------------

export function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new SynapseError('internal', `column ${key} is not text`);
  return v;
}

export function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : String(v);
}

export function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new SynapseError('internal', `column ${key} is not numeric`);
}

export function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? Number(v) : (v as number);
}

export function bool(row: Row, key: string): boolean {
  return num(row, key) !== 0;
}

export function json<T>(row: Row, key: string, fallback: T): T {
  const v = row[key];
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Clamps a caller-supplied LIMIT to a sane range. */
export function limit(value: number | undefined, fallback = 50, max = 500): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value)), max);
}
