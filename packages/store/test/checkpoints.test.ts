import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_MAX_PATHS, isMindlyError, type CheckpointKind } from '@mindly/core';
import { MIGRATIONS, Store, schemaVersion, type CheckpointCreate } from '../src/index.js';
import { MIGRATION_V4_BISECT } from '../src/migrations/v4-bisect.js';
import { setup } from './helpers.js';

/** The `runs` table as v1 created it, before `bisect` was a run kind. */
const RUNS_V1 = `
CREATE TABLE runs_v1 (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('shadow_merge', 'replay', 'review', 'contract_sweep')),
  status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error', 'cancelled')),
  title        TEXT NOT NULL,
  input        TEXT NOT NULL,
  result       TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  created_at   INTEGER NOT NULL
);
INSERT INTO runs_v1 SELECT id, project_id, kind, status, title, input, result, started_at, finished_at, created_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v1 RENAME TO runs;
CREATE INDEX runs_project ON runs (project_id, kind, created_at);
`;

function tempDb(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'mindly.db');
}

/** Opens a fresh store with one project and one `review` run, then downgrades it with `sql`. */
function downgrade(path: string, sql: string): { projectId: string; runId: string } {
  const store = Store.open(path);
  const project = store.projects.upsertByRoot('/repo', 'repo');
  const run = store.runs.create({
    projectId: project.id,
    kind: 'review',
    title: 'old review',
    input: { from: 'v3' },
  });
  store.db.exec(sql);
  // The downgrade is real: the old kind check rejects a bisect run until the migration runs.
  expect(() =>
    store.db
      .prepare(
        `INSERT INTO runs (id, project_id, kind, status, title, input, created_at)
         VALUES ('old-bisect', ?, 'bisect', 'queued', 't', '{}', 1)`,
      )
      .run(project.id),
  ).toThrow(/CHECK/);
  store.close();
  return { projectId: project.id, runId: run.id };
}

function expectUpgraded(path: string, ids: { projectId: string; runId: string }): void {
  const store = Store.open(path);
  expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
  const kept = store.runs.get(ids.runId);
  expect(kept).toMatchObject({ id: ids.runId, kind: 'review', title: 'old review' });
  const index = store.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runs_project'")
    .get() as { sql: string } | undefined;
  expect(index?.sql).toContain('(project_id, kind, created_at)');
  const bisect = store.runs.create({
    projectId: ids.projectId,
    kind: 'bisect',
    title: 'bisect',
    input: {},
  });
  expect(store.runs.get(bisect.id).kind).toBe('bisect');
  const tables = (
    store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  expect(tables).toContain('checkpoints');
  expect(tables).not.toContain('runs_v4');
  store.close();
}

describe('checkpoints schema (v4)', () => {
  it('is the fourth migration', () => {
    expect(MIGRATIONS[3]).toBe(MIGRATION_V4_BISECT);
    expect(MIGRATIONS[3]).toContain('CREATE TABLE checkpoints');
    expect(MIGRATIONS[2]).not.toContain('checkpoints');
  });

  it('upgrades a v3 database, keeping its runs and accepting bisect runs', () => {
    const path = tempDb('syn-checkpoints-v3-');
    const ids = downgrade(
      path,
      `DROP INDEX file_changes_created; DROP TABLE line_survival; DROP TABLE file_change_lines; DROP TABLE checkpoints; ${RUNS_V1} PRAGMA user_version = 3;`,
    );
    expectUpgraded(path, ids);
  });

  it('upgrades a v1 database through every migration', () => {
    const path = tempDb('syn-checkpoints-v1-');
    const ids = downgrade(
      path,
      `DROP INDEX file_changes_created; DROP TABLE line_survival; DROP TABLE file_change_lines; DROP TABLE checkpoints; DROP TABLE saves; DROP TABLE split_parts; DROP TABLE splits;
       ALTER TABLE handoffs DROP COLUMN worktree; ${RUNS_V1} PRAGMA user_version = 1;`,
    );
    expectUpgraded(path, ids);
  });

  it('only accepts known kinds and one seq per working tree', () => {
    const { store, project } = setup();
    const insert = (id: string, kind: string, seq: number) =>
      store.db
        .prepare(
          `INSERT INTO checkpoints (id, project_id, worktree, seq, commit_sha, kind, created_at)
           VALUES (?, ?, '/repo', ?, 'c1', ?, 1)`,
        )
        .run(id, project.id, seq, kind);
    expect(() => insert('a', 'other', 1)).toThrow(/CHECK/);
    expect(() => insert('a', 'agent', 1)).not.toThrow();
    expect(() => insert('b', 'agent', 1)).toThrow(/UNIQUE/);
    expect(() => insert('b', 'outside', 2)).not.toThrow();
  });
});

function input(
  projectId: string,
  seq: number,
  extra: Partial<CheckpointCreate> = {},
): CheckpointCreate {
  return {
    projectId,
    worktree: '/repo',
    seq,
    commit: `c${seq}`,
    parentCommit: seq > 1 ? `c${seq - 1}` : null,
    kind: seq === 1 ? 'baseline' : ('agent' as CheckpointKind),
    sessionId: seq === 1 ? null : 's1',
    fileChangeId: null,
    promptEventId: null,
    tool: seq === 1 ? null : 'Edit',
    paths: seq === 1 ? [] : [`src/${seq}.ts`],
    gap: false,
    ...extra,
  };
}

describe('CheckpointRepo', () => {
  it('creates rows with parsed paths and a boolean gap, capping the paths', () => {
    const { store, project, clock } = setup();
    const row = store.checkpoints.create(
      input(project.id, 1, {
        kind: 'agent',
        sessionId: 's1',
        fileChangeId: 'fc1',
        promptEventId: 'ev1',
        tool: 'Edit',
        paths: ['src/a.ts', 'src/b.ts'],
        gap: true,
      }),
    );
    expect(row).toMatchObject({
      projectId: project.id,
      worktree: '/repo',
      seq: 1,
      commit: 'c1',
      parentCommit: null,
      kind: 'agent',
      sessionId: 's1',
      fileChangeId: 'fc1',
      promptEventId: 'ev1',
      tool: 'Edit',
      paths: ['src/a.ts', 'src/b.ts'],
      gap: true,
      createdAt: clock.t,
    });
    expect(store.checkpoints.get(row.id)).toEqual(row);
    const many = Array.from({ length: CHECKPOINT_MAX_PATHS + 10 }, (_, i) => `src/f${i}.ts`);
    const capped = store.checkpoints.create(input(project.id, 2, { paths: many }));
    expect(capped.paths).toEqual(many.slice(0, CHECKPOINT_MAX_PATHS));
    expect(capped.gap).toBe(false);
  });

  it('throws not_found for unknown ids', () => {
    const { store } = setup();
    let err: unknown = null;
    try {
      store.checkpoints.get('00000000-0000-7000-8000-000000000000');
    } catch (e) {
      err = e;
    }
    expect(isMindlyError(err, 'not_found')).toBe(true);
  });

  it('finds the latest and a given step of a working tree', () => {
    const { store, project } = setup();
    expect(store.checkpoints.latest(project.id, '/repo')).toBeNull();
    expect(store.checkpoints.bySeq(project.id, '/repo', 1)).toBeNull();
    for (const seq of [1, 2, 3]) store.checkpoints.create(input(project.id, seq));
    store.checkpoints.create(input(project.id, 7, { worktree: '/other' }));
    expect(store.checkpoints.latest(project.id, '/repo')?.seq).toBe(3);
    expect(store.checkpoints.latest(project.id, '/other')?.seq).toBe(7);
    expect(store.checkpoints.bySeq(project.id, '/repo', 2)?.commit).toBe('c2');
    expect(store.checkpoints.bySeq(project.id, '/repo', 7)).toBeNull();
    expect(store.checkpoints.bySeq(project.id, '/other', 7)?.worktree).toBe('/other');
  });

  it('lists by time, step range, order and limit', () => {
    const { store, project, clock } = setup();
    const start = clock.t;
    for (const seq of [1, 2, 3, 4, 5]) {
      store.checkpoints.create(input(project.id, seq));
      clock.advance(1000);
    }
    store.checkpoints.create(input(project.id, 1, { worktree: '/other' }));
    const seqs = (opts?: Parameters<typeof store.checkpoints.list>[2]) =>
      store.checkpoints.list(project.id, '/repo', opts).map((c) => c.seq);
    expect(seqs()).toEqual([1, 2, 3, 4, 5]);
    expect(seqs({ since: start + 3000 })).toEqual([4, 5]);
    expect(seqs({ fromSeq: 2 })).toEqual([2, 3, 4, 5]);
    expect(seqs({ toSeq: 3 })).toEqual([1, 2, 3]);
    expect(seqs({ fromSeq: 2, toSeq: 4 })).toEqual([2, 3, 4]);
    expect(seqs({ order: 'desc' })).toEqual([5, 4, 3, 2, 1]);
    expect(seqs({ order: 'desc', limit: 2 })).toEqual([5, 4]);
    expect(seqs({ limit: 2 })).toEqual([1, 2]);
    expect(seqs({ since: start + 3000, order: 'desc', limit: 1 })).toEqual([5]);
    expect(store.checkpoints.list(project.id, '/nowhere')).toEqual([]);
  });

  it('knows the working trees of a project and counts its rows', () => {
    const { store, project } = setup();
    const other = store.projects.upsertByRoot('/elsewhere', 'elsewhere');
    expect(store.checkpoints.worktrees(project.id)).toEqual([]);
    expect(store.checkpoints.count(project.id)).toBe(0);
    store.checkpoints.create(input(project.id, 1, { worktree: '/repo/wt-b' }));
    store.checkpoints.create(input(project.id, 1));
    store.checkpoints.create(input(project.id, 2));
    store.checkpoints.create(input(other.id, 1));
    expect(store.checkpoints.worktrees(project.id)).toEqual(['/repo', '/repo/wt-b']);
    expect(store.checkpoints.count(project.id)).toBe(3);
    expect(store.checkpoints.count(other.id)).toBe(1);
  });

  it('expires rows by age and beyond the newest N of each working tree', () => {
    const { store, project, clock } = setup();
    const other = store.projects.upsertByRoot('/elsewhere', 'elsewhere');
    const start = clock.t;
    for (const seq of [1, 2, 3, 4, 5]) {
      store.checkpoints.create(input(project.id, seq));
      clock.advance(1000);
    }
    for (const seq of [1, 2]) {
      store.checkpoints.create(input(project.id, seq, { worktree: '/repo/wt-b' }));
      clock.advance(1000);
    }
    store.checkpoints.create(input(other.id, 1));
    const expired = (before: number, keep: number) =>
      store.checkpoints.expired(project.id, before, keep).map((r) => `${r.worktree}#${r.seq}`);
    // By age alone: the first two of /repo were created before start + 2000.
    expect(expired(start + 2000, 100)).toEqual(['/repo#1', '/repo#2']);
    // By count alone, per working tree: /repo keeps 5 and 4, /repo/wt-b keeps both.
    expect(expired(0, 2)).toEqual(['/repo#1', '/repo#2', '/repo#3']);
    expect(expired(0, 1)).toEqual(['/repo#1', '/repo#2', '/repo#3', '/repo#4', '/repo/wt-b#1']);
    // keep is clamped to at least one: the newest row of a working tree is never expired by count.
    expect(expired(0, 0)).toEqual(expired(0, 1));
    // Both reasons together, without duplicates.
    expect(expired(start + 6000, 3)).toEqual([
      '/repo#1',
      '/repo#2',
      '/repo#3',
      '/repo#4',
      '/repo#5',
      '/repo/wt-b#1',
    ]);
    expect(expired(0, 100)).toEqual([]);
    const ref = store.checkpoints.expired(project.id, start + 1, 100)[0];
    expect(ref).toEqual({ id: expect.any(String), worktree: '/repo', seq: 1, commit: 'c1' });
    expect(store.checkpoints.expired(other.id, 0, 1)).toEqual([]);
  });

  it('lists every ref of a project and deletes by id', () => {
    const { store, project } = setup();
    const other = store.projects.upsertByRoot('/elsewhere', 'elsewhere');
    const rows = [
      store.checkpoints.create(input(project.id, 1, { worktree: '/repo/wt-b' })),
      store.checkpoints.create(input(project.id, 1)),
      store.checkpoints.create(input(project.id, 2)),
    ];
    store.checkpoints.create(input(other.id, 1));
    expect(store.checkpoints.refs(project.id)).toEqual([
      { id: rows[1]!.id, worktree: '/repo', seq: 1, commit: 'c1' },
      { id: rows[2]!.id, worktree: '/repo', seq: 2, commit: 'c2' },
      { id: rows[0]!.id, worktree: '/repo/wt-b', seq: 1, commit: 'c1' },
    ]);
    expect(store.checkpoints.delete([rows[0]!.id, rows[2]!.id, 'missing'])).toBe(2);
    expect(store.checkpoints.delete([])).toBe(0);
    expect(store.checkpoints.refs(project.id).map((r) => r.id)).toEqual([rows[1]!.id]);
    expect(store.checkpoints.count(other.id)).toBe(1);
  });

  it('cascades project deletion', () => {
    const { store, project } = setup();
    store.checkpoints.create(input(project.id, 1));
    store.checkpoints.create(input(project.id, 2));
    store.projects.delete(project.id);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toEqual({ n: 0 });
  });
});
