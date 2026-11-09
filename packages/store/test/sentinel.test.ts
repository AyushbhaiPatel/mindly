import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SentinelCheck } from '@mindly/core';
import { MIGRATIONS, Store, schemaVersion } from '../src/index.js';
import { MIGRATION_V6_SENTINEL } from '../src/migrations/v6-sentinel.js';
import { setup } from './helpers.js';

/** The `runs` table as v4 created it, before `sentinel` was a run kind. */
const RUNS_V4 = `
CREATE TABLE runs_v4 (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('shadow_merge', 'replay', 'review', 'contract_sweep', 'bisect')),
  status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error', 'cancelled')),
  title        TEXT NOT NULL,
  input        TEXT NOT NULL,
  result       TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  created_at   INTEGER NOT NULL
);
INSERT INTO runs_v4 SELECT id, project_id, kind, status, title, input, result, started_at, finished_at, created_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v4 RENAME TO runs;
CREATE INDEX runs_project ON runs (project_id, kind, created_at);
`;

function check(extra: Partial<SentinelCheck> = {}): SentinelCheck {
  return {
    argvHash: 'h1',
    state: 'passing',
    goodSeq: 4,
    failingSeq: null,
    brokeAt: null,
    culpritSessionId: null,
    conflictId: null,
    note: null,
    since: 10,
    ...extra,
  };
}

const tables = (store: Store): string[] =>
  (
    store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((t) => t.name);

describe('sentinel schema (v6)', () => {
  it('is the sixth migration', () => {
    expect(MIGRATIONS[5]).toBe(MIGRATION_V6_SENTINEL);
    expect(MIGRATIONS[5]).toContain('CREATE TABLE sentinel_watches');
    expect(MIGRATIONS[4]).not.toContain('sentinel');
    // Earlier migrations keep the run kinds they shipped with.
    expect(MIGRATIONS[3]).not.toContain("'sentinel'");
  });

  it('upgrades a v5 database, keeping its runs and accepting sentinel runs', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mindly-sentinel-v5-')), 'mindly.db');
    const old = Store.open(path);
    const project = old.projects.upsertByRoot('/repo', 'repo');
    const run = old.runs.create({ projectId: project.id, kind: 'bisect', title: 'b', input: {} });
    old.db.exec(`DROP TABLE sentinel_watches; ${RUNS_V4} PRAGMA user_version = 5;`);
    // The downgrade is real: the old kind check rejects a sentinel run until the migration runs.
    expect(() =>
      old.db
        .prepare(
          `INSERT INTO runs (id, project_id, kind, status, title, input, created_at)
           VALUES ('old', ?, 'sentinel', 'queued', 't', '{}', 1)`,
        )
        .run(project.id),
    ).toThrow(/CHECK/);
    old.close();

    const store = Store.open(path);
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
    expect(store.runs.get(run.id)).toMatchObject({ kind: 'bisect', title: 'b' });
    const s = store.runs.create({ projectId: project.id, kind: 'sentinel', title: 's', input: {} });
    expect(store.runs.get(s.id).kind).toBe('sentinel');
    expect(tables(store)).toContain('sentinel_watches');
    expect(tables(store)).not.toContain('runs_v6');
    store.close();
  });
});

describe('SentinelRepo', () => {
  it('saves, reads back and lists the watch of each working tree', () => {
    const { store, project, clock } = setup();
    expect(store.sentinel.get(project.id, '/repo')).toBeNull();
    const saved = store.sentinel.save(project.id, '/repo', {
      checkedSeq: 7,
      checkedAt: clock.now(),
      setupCommit: 'abc',
      checks: { unit: check(), lint: check({ state: 'failing', goodSeq: null, failingSeq: 7 }) },
    });
    expect(saved).toMatchObject({
      projectId: project.id,
      worktree: '/repo',
      checkedSeq: 7,
      setupCommit: 'abc',
      updatedAt: clock.now(),
    });
    expect(saved.checks['unit']).toEqual(check());
    expect(saved.checks['lint']?.state).toBe('failing');

    clock.advance(1000);
    store.sentinel.save(project.id, '/repo', { ...saved, checkedSeq: 9 });
    store.sentinel.save(project.id, '/repo-part', {
      checkedSeq: 1,
      checkedAt: null,
      setupCommit: null,
      checks: {},
    });
    expect(store.sentinel.get(project.id, '/repo')?.checkedSeq).toBe(9);
    expect(store.sentinel.list(project.id).map((w) => w.worktree)).toEqual(['/repo', '/repo-part']);

    store.sentinel.clearSetup(project.id, '/repo');
    expect(store.sentinel.get(project.id, '/repo')?.setupCommit).toBeNull();
    expect(store.sentinel.delete(project.id, '/repo')).toBe(true);
    expect(store.sentinel.delete(project.id, '/repo')).toBe(false);
    expect(store.sentinel.list(project.id)).toHaveLength(1);
  });

  it('drops malformed per-check entries instead of failing', () => {
    const { store, project } = setup();
    store.db
      .prepare(
        `INSERT INTO sentinel_watches (project_id, worktree, checks, updated_at) VALUES (?, '/repo', ?, 1)`,
      )
      .run(
        project.id,
        JSON.stringify({
          unit: { state: 'failing', goodSeq: 'x', brokeAt: 3, culpritSessionId: 5 },
          bogus: { state: 'exploded' },
          nothing: null,
        }),
      );
    const w = store.sentinel.get(project.id, '/repo');
    expect(Object.keys(w?.checks ?? {})).toEqual(['unit']);
    expect(w?.checks['unit']).toMatchObject({
      state: 'failing',
      goodSeq: null,
      brokeAt: 3,
      culpritSessionId: null,
      argvHash: '',
    });
  });

  it('is deleted with its project', () => {
    const { store, project } = setup();
    store.sentinel.save(project.id, '/repo', {
      checkedSeq: 1,
      checkedAt: 1,
      setupCommit: null,
      checks: { unit: check() },
    });
    store.projects.delete(project.id);
    expect(store.sentinel.list(project.id)).toEqual([]);
  });
});

describe('RunRepo.countSince', () => {
  it('counts runs of a kind since a time, optionally by an input field', () => {
    const { store, project, clock } = setup();
    store.runs.create({ projectId: project.id, kind: 'bisect', title: 'a', input: {} });
    clock.advance(10_000);
    const since = clock.now();
    store.runs.create({ projectId: project.id, kind: 'bisect', title: 'b', input: {} });
    store.runs.create({
      projectId: project.id,
      kind: 'bisect',
      title: 'c',
      input: { trigger: 'sentinel' },
    });
    store.runs.create({ projectId: project.id, kind: 'sentinel', title: 'd', input: {} });
    expect(store.runs.countSince(project.id, 'bisect', 0)).toBe(3);
    expect(store.runs.countSince(project.id, 'bisect', since)).toBe(2);
    expect(
      store.runs.countSince(project.id, 'bisect', since, { field: 'trigger', value: 'sentinel' }),
    ).toBe(1);
    expect(() =>
      store.runs.countSince(project.id, 'bisect', 0, { field: "a') OR 1=1 --", value: 'x' }),
    ).toThrow(/unsafe/);
  });
});
