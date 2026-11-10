import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@mindly/store';
import { modeIfThere } from '../src/commands/doctor.js';
import { cli, sandbox, tempDir } from './helpers.js';

function json<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text) as T;
}

describe('doctor', () => {
  it('doctor reads the database format without upgrading it', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    const path = join(sb.mindlyHome, 'mindly.db');
    const latest = MIGRATIONS.length;
    const version = (): number => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      } finally {
        db.close();
      }
    };
    const setVersion = (v: number): void => {
      const db = new DatabaseSync(path);
      try {
        db.exec(`PRAGMA user_version = ${v}`);
      } finally {
        db.close();
      }
    };

    // A database written by a newer Mindly: the remedy is to update, not to close processes.
    setVersion(latest + 3);
    const newer = await cli(sb, ['doctor']);
    expect(newer.code).toBe(1);
    expect(newer.stdout).toContain(`newer Mindly (format v${latest + 3}`);
    expect(newer.stdout).toContain('npm install -g mindly-cli');
    expect(newer.stdout).not.toContain('mindly daemon stop');
    expect(newer.stdout).not.toContain('could not be opened as a project');
    const newerJson = json<{
      ok: boolean;
      checks: { name: string; status: string; detail: string }[];
    }>((await cli(sb, ['doctor', '--json'])).stdout);
    expect(newerJson.ok).toBe(false);
    expect(newerJson.checks.find((c) => c.name === 'database')).toEqual({
      name: 'database',
      status: 'fail',
      detail: `schema v${latest + 3} (expected v${latest})`,
    });
    expect(version()).toBe(latest + 3);

    // An older database is reported and left as it is: the diagnostic changes nothing.
    rmSync(path);
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    const old = new DatabaseSync(path);
    try {
      for (const sql of MIGRATIONS.slice(0, latest - 1)) old.exec(sql);
      old.exec(`PRAGMA user_version = ${latest - 1}`);
    } finally {
      old.close();
    }
    chmodSync(path, 0o600);
    const older = await cli(sb, ['doctor']);
    expect(older.code).toBe(0);
    expect(older.stdout).not.toContain('Database is up to date');
    expect(older.stdout).toContain(`format v${latest - 1}`);
    expect(older.stdout).toContain('upgraded');
    expect(version()).toBe(latest - 1);
    const olderJson = json<{
      ok: boolean;
      checks: { name: string; status: string; detail: string }[];
    }>((await cli(sb, ['doctor', '--json'])).stdout);
    expect(olderJson.ok).toBe(true);
    expect(olderJson.checks.find((c) => c.name === 'database')).toEqual({
      name: 'database',
      status: 'info',
      detail: `schema v${latest - 1} (expected v${latest})`,
    });
    expect(version()).toBe(latest - 1);

    // The next command that works with the store upgrades it, and doctor says so afterwards.
    expect((await cli(sb, ['status'])).code).toBe(0);
    expect(version()).toBe(latest);
    expect((await cli(sb, ['doctor'])).stdout).toContain('[ok] Database is up to date');
  });

  it('doctor reads the mode of a file that may be gone by now', () => {
    const dir = tempDir('mindly-cli-mode-');
    const file = join(dir, 'mindly.db-wal');
    // SQLite removes its -wal and -shm files when the last process closes the database.
    expect(modeIfThere(file, 'file')).toBeNull();
    expect(modeIfThere(join(dir, 'gone'))).toBeNull();
    writeFileSync(file, '', { mode: 0o600 });
    chmodSync(file, 0o640);
    expect(modeIfThere(file, 'file')).toBe(0o640);
    expect(modeIfThere(dir, 'file')).toBeNull();
    chmodSync(dir, 0o700);
    expect(modeIfThere(dir)).toBe(0o700);
  });
});
