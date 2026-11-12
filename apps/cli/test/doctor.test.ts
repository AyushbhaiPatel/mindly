import { chmodSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@mindly/store';
import { classifyDatabaseError, databaseErrorItem, modeIfThere } from '../src/commands/doctor.js';
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

  it('doctor treats an empty database file like a missing one', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    const path = join(sb.mindlyHome, 'mindly.db');
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    // What a process leaves when it dies between creating the file and setting it up.
    writeFileSync(path, '', { mode: 0o600 });
    const r = await cli(sb, ['doctor']);
    expect(r.stdout).toContain('[ok] Database is up to date');
    expect(r.stdout).not.toContain('older format');
    const checks = json<{ checks: { name: string; status: string; detail: string }[] }>(
      (await cli(sb, ['doctor', '--json'])).stdout,
    ).checks;
    expect(checks.find((c) => c.name === 'database')).toMatchObject({ status: 'ok' });
    for (const name of ['project', 'checkpoints', 'sentinel']) {
      expect(checks.find((c) => c.name === name)?.detail, name).not.toMatch(/^not checked/);
    }
  });

  it('doctor keeps every check name when the database cannot be used as it is', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    const path = join(sb.mindlyHome, 'mindly.db');
    const latest = MIGRATIONS.length;
    type Checks = { ok: boolean; checks: { name: string; status: string; detail: string }[] };
    const names = ['project', 'checkpoints', 'sentinel'];
    const usual = json<Checks>((await cli(sb, ['doctor', '--json'])).stdout).checks;
    for (const name of names)
      expect(
        usual.some((c) => c.name === name),
        name,
      ).toBe(true);

    const setVersion = (v: number): void => {
      const db = new DatabaseSync(path);
      try {
        db.exec(`PRAGMA user_version = ${v}`);
      } finally {
        db.close();
      }
    };
    setVersion(latest + 1);
    const newer = json<Checks>((await cli(sb, ['doctor', '--json'])).stdout);
    expect(newer.ok).toBe(false);
    for (const name of names) {
      expect(
        newer.checks.filter((c) => c.name === name),
        name,
      ).toEqual([{ name, status: 'info', detail: 'not checked: the database cannot be opened' }]);
    }
    const said = (await cli(sb, ['doctor'])).stdout.replace(/\s+/g, ' ');
    expect(said).toContain('not checked');

    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    const old = new DatabaseSync(path);
    try {
      for (const sql of MIGRATIONS.slice(0, latest - 1)) old.exec(sql);
      old.exec(`PRAGMA user_version = ${latest - 1}`);
    } finally {
      old.close();
    }
    chmodSync(path, 0o600);
    const older = json<Checks>((await cli(sb, ['doctor', '--json'])).stdout);
    expect(older.ok).toBe(true);
    for (const name of names) {
      expect(
        older.checks.filter((c) => c.name === name),
        name,
      ).toEqual([
        { name, status: 'info', detail: 'not checked: the database is in an older format' },
      ]);
    }
    const human = (await cli(sb, ['doctor'])).stdout.replace(/\s+/g, ' ');
    expect(human).toContain('not checked until the database is upgraded');
  });

  it('doctor lets SQLite confirm a database that does not look up to date', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    const path = join(sb.mindlyHome, 'mindly.db');
    const latest = MIGRATIONS.length;
    type Checks = { ok: boolean; checks: { name: string; status: string; detail: string }[] };
    const database = async (): Promise<{
      ok: boolean;
      status: string;
      detail: string;
      text: string;
    }> => {
      const j = json<Checks>((await cli(sb, ['doctor', '--json'])).stdout);
      const c = j.checks.find((x) => x.name === 'database');
      const text = (await cli(sb, ['doctor'])).stdout.replace(/\s+/g, ' ');
      return { ok: j.ok, status: c?.status ?? '', detail: c?.detail ?? '', text };
    };

    // The header says "one format behind", but most of the file is gone.
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec(`PRAGMA user_version = ${latest - 1}`);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    for (const f of [`${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    truncateSync(path, 5000);
    const cut = await database();
    expect(cut.ok).toBe(false);
    expect(cut.status).toBe('fail');
    expect(cut.detail).not.toMatch(/^schema v/);
    expect(cut.text).not.toContain('older format');
    expect(cut.text).not.toContain('upgraded');

    // The start of a database file with anything after it is not a newer Mindly's database.
    writeFileSync(
      path,
      Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0x41)]),
      {
        mode: 0o600,
      },
    );
    const junk = await database();
    expect(junk.ok).toBe(false);
    expect(junk.status).toBe('fail');
    expect(junk.text).not.toContain('newer Mindly');
    expect(junk.text).not.toContain('npm install -g mindly-cli');

    // A sound database with a version no Mindly ever wrote is damage too, not "newer".
    rmSync(path);
    const odd = new DatabaseSync(path);
    try {
      odd.exec('CREATE TABLE t (x)');
      odd.exec(`PRAGMA user_version = ${latest + 5000}`);
    } finally {
      odd.close();
    }
    chmodSync(path, 0o600);
    const absurd = await database();
    expect(absurd.status).toBe('fail');
    expect(absurd.text).not.toContain('newer Mindly');
  });

  it('doctor lists the same checks whatever state the database is in', async () => {
    const latest = MIGRATIONS.length;
    type Checks = { ok: boolean; checks: { name: string; status: string; detail: string }[] };
    const always = [
      'node',
      'node:sqlite',
      'git',
      'home',
      'permissions',
      'database',
      'daemon',
      'project',
      'checkpoints',
      'sentinel',
    ];
    const fresh = async (): Promise<{ sb: ReturnType<typeof sandbox>; path: string }> => {
      const sb = sandbox();
      // No command has used the store for this project yet, so doctor has to write to open it.
      expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
      return { sb, path: join(sb.mindlyHome, 'mindly.db') };
    };
    const wipe = (path: string): void => {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    };
    const setVersion = (path: string, v: number): void => {
      const db = new DatabaseSync(path);
      try {
        db.exec(`PRAGMA user_version = ${v}`);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
    };
    const states: Record<string, (path: string) => unknown> = {
      'up to date': () => undefined,
      missing: (path) => wipe(path),
      empty: (path) => {
        wipe(path);
        writeFileSync(path, '', { mode: 0o600 });
      },
      older: (path) => {
        wipe(path);
        const db = new DatabaseSync(path);
        try {
          for (const sql of MIGRATIONS.slice(0, latest - 1)) db.exec(sql);
          db.exec(`PRAGMA user_version = ${latest - 1}`);
        } finally {
          db.close();
        }
        chmodSync(path, 0o600);
      },
      newer: (path) => setVersion(path, latest + 1),
      damaged: (path) => {
        setVersion(path, latest - 1);
        for (const f of [`${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
        truncateSync(path, 5000);
      },
      locked: (path) => {
        const holder = new DatabaseSync(path);
        holder.exec('BEGIN EXCLUSIVE');
        return () => {
          holder.exec('ROLLBACK');
          holder.close();
        };
      },
    };
    for (const [state, prepare] of Object.entries(states)) {
      const { sb, path } = await fresh();
      const release = prepare(path);
      try {
        const j = json<Checks>((await cli(sb, ['doctor', '--json'])).stdout);
        const names = j.checks.map((c) => c.name);
        for (const name of always) expect(names, `${state}: ${name}`).toContain(name);
        for (const c of j.checks) expect(c.detail, `${state}: ${c.name}`).not.toBe('');
        const status = (name: string): string | undefined =>
          j.checks.find((c) => c.name === name)?.status;
        if (state === 'locked') {
          expect(status('project')).toBe('warn');
          for (const name of ['checkpoints', 'sentinel']) {
            expect(j.checks.find((c) => c.name === name)).toEqual({
              name,
              status: 'info',
              detail: 'not checked: the project could not be opened',
            });
          }
        }
        if (state === 'damaged' || state === 'newer') expect(status('database')).toBe('fail');
        if (state === 'older') expect(status('database')).toBe('info');
        if (['up to date', 'missing', 'empty', 'locked'].includes(state)) {
          expect(status('database'), state).toBe('ok');
        }
      } finally {
        if (typeof release === 'function') (release as () => void)();
      }
    }
  }, 60_000);

  it('doctor tells a busy database from a damaged one and from one it may not read', async () => {
    const sqlite = (errcode: number, message: string): Error =>
      Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode, errstr: message });
    const fsError = (code: string): Error =>
      Object.assign(new Error(`${code}: operation not permitted`), { code });
    expect(classifyDatabaseError(sqlite(5, 'database is locked'))).toBe('busy');
    expect(classifyDatabaseError(sqlite(6, 'database table is locked'))).toBe('busy');
    expect(classifyDatabaseError(sqlite(517, 'database is locked'))).toBe('busy');
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      expect(classifyDatabaseError(fsError(code)), code).toBe('permission');
    }
    expect(classifyDatabaseError(sqlite(8, 'attempt to write a readonly database'))).toBe(
      'permission',
    );
    expect(classifyDatabaseError(sqlite(26, 'file is not a database'))).toBe('damaged');
    expect(classifyDatabaseError(sqlite(11, 'database disk image is malformed'))).toBe('damaged');
    expect(classifyDatabaseError(sqlite(14, 'unable to open database file'))).toBe('other');

    const advice = (err: Error): string => {
      const i = databaseErrorItem(err, '/home/me/.mindly/mindly.db');
      return `${i.text} ${i.fix?.cmd ?? ''} ${i.fix?.why ?? ''}`;
    };
    expect(advice(sqlite(5, 'database is locked'))).toContain('mindly daemon stop');
    expect(advice(sqlite(5, 'database is locked'))).not.toContain('move it away');
    expect(advice(fsError('EACCES'))).toContain('/home/me/.mindly/mindly.db');
    expect(advice(fsError('EACCES'))).not.toContain('move it away');
    expect(advice(sqlite(26, 'file is not a database'))).toContain('move it away');

    // End to end: an older database (rollback journal) that another process holds.
    const sb = sandbox();
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    const path = join(sb.mindlyHome, 'mindly.db');
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    const latest = MIGRATIONS.length;
    const old = new DatabaseSync(path);
    try {
      for (const sql of MIGRATIONS.slice(0, latest - 1)) old.exec(sql);
      old.exec(`PRAGMA user_version = ${latest - 1}`);
    } finally {
      old.close();
    }
    chmodSync(path, 0o600);
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN EXCLUSIVE');
    holder.exec('PRAGMA user_version = 1');
    try {
      const said = (await cli(sb, ['doctor'])).stdout.replace(/\s+/g, ' ');
      expect(said).toContain('The database is busy');
      expect(said).toContain('mindly daemon stop');
      expect(said).not.toContain('move it away');
      expect(said).not.toContain('cannot be read as a Mindly database');
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 30_000);
});
