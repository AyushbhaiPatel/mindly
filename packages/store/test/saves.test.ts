import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SaveKind } from '@mindly/core';
import { MIGRATIONS, Store, schemaVersion } from '../src/index.js';
import { setup } from './helpers.js';

function save(
  store: Store,
  projectId: string,
  fingerprint: string,
  opts: { kind?: SaveKind; evidence?: string[]; confirmed?: boolean } = {},
) {
  const res = store.saves.record({
    projectId,
    kind: opts.kind ?? 'rule_enforced',
    title: 'A write by Codex was blocked by your rule',
    sessionIds: ['s1'],
    paths: ['src/generated/api.ts'],
    evidence: opts.evidence ?? ['e1'],
    fingerprint,
    refs: { ruleId: 'r1' },
  });
  if (!opts.confirmed) return res;
  return { ...res, save: store.saves.settle(res.save.id, 'confirmed')! };
}

describe('saves schema (v2)', () => {
  it('upgrades a v1 database in a new migration and leaves v1 alone', () => {
    expect(MIGRATIONS[0]).not.toContain('saves');
    expect(MIGRATIONS[1]).toContain('CREATE TABLE saves');
    const path = join(mkdtempSync(join(tmpdir(), 'syn-saves-')), 'mindly.db');
    const v1 = Store.open(path);
    v1.db.exec('DROP TABLE saves; PRAGMA user_version = 1;');
    v1.close();
    const store = Store.open(path);
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
    const index = store.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'saves_project'")
      .get() as { sql: string };
    expect(index.sql).toContain('(project_id, status, created_at)');
    store.close();
  });

  it('only accepts known kinds and statuses', () => {
    const { store, project } = setup();
    const insert = (kind: string, status: string) =>
      store.db
        .prepare(
          `INSERT INTO saves (id, project_id, kind, status, title, fingerprint, created_at)
           VALUES (?, ?, ?, ?, 't', ?, 1)`,
        )
        .run(`${kind}-${status}`, project.id, kind, status, `${kind}-${status}`);
    expect(() => insert('hours_saved', 'caught')).toThrow(/CHECK/);
    expect(() => insert('rule_enforced', 'dismissed')).toThrow(/CHECK/);
    expect(() => insert('rule_enforced', 'caught')).not.toThrow();
  });

  it('cascades project deletion', () => {
    const { store, project } = setup();
    save(store, project.id, 'f1');
    store.projects.delete(project.id);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM saves').get()).toEqual({ n: 0 });
  });
});

describe('SaveRepo', () => {
  it('records one save per fingerprint and project', () => {
    const { store, project } = setup();
    const first = save(store, project.id, 'f1');
    expect(first.created).toBe(true);
    expect(first.save).toMatchObject({ status: 'caught', evidence: ['e1'], confirmedAt: null });
    const again = save(store, project.id, 'f1', { evidence: ['e2'] });
    expect(again).toEqual({ save: first.save, created: false });
    const other = store.projects.upsertByRoot('/other', 'other');
    expect(save(store, other.id, 'f1').created).toBe(true);
    expect(store.saves.list(project.id)).toHaveLength(1);
  });

  it('only moves forward: caught to confirmed, expired or rejected; confirmed to rejected', () => {
    const { store, project, clock } = setup();
    const a = save(store, project.id, 'a').save;
    clock.advance(5000);
    const confirmed = store.saves.settle(a.id, 'confirmed', { evidence: ['e2'] });
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      evidence: ['e1', 'e2'],
      confirmedAt: clock.t,
    });
    expect(store.saves.settle(a.id, 'expired')).toBeNull();
    expect(store.saves.settle(a.id, 'confirmed')).toBeNull();
    expect(store.saves.settle(a.id, 'rejected')?.status).toBe('rejected');
    expect(store.saves.settle(a.id, 'confirmed')).toBeNull();

    const b = save(store, project.id, 'b').save;
    expect(store.saves.settle(b.id, 'expired')?.status).toBe('expired');
    expect(store.saves.settle(b.id, 'confirmed')).toBeNull();
    expect(store.saves.settle(b.id, 'rejected')).toBeNull();
    expect(store.saves.settle('missing', 'confirmed')).toBeNull();
  });

  it('keeps the first evidence and the latest ones, at most 20', () => {
    const { store, project } = setup();
    const s = save(store, project.id, 'f', { evidence: ['first'] }).save;
    const many = Array.from({ length: 30 }, (_, i) => `e${i}`);
    const settled = store.saves.settle(s.id, 'confirmed', { evidence: many })!;
    expect(settled.evidence).toHaveLength(20);
    expect(settled.evidence[0]).toBe('first');
    expect(settled.evidence.at(-1)).toBe('e29');
  });

  it('lists by status, kind and time, and counts confirmed saves with the index', () => {
    const { store, project, clock } = setup();
    const start = clock.t;
    const c1 = save(store, project.id, 'c1', { confirmed: true }).save;
    clock.advance(1000);
    save(store, project.id, 'caught', { kind: 'mistake_avoided' });
    clock.advance(1000);
    const c2 = save(store, project.id, 'c2', { kind: 'limit_handoff', confirmed: true }).save;
    const r = save(store, project.id, 'r', { confirmed: true }).save;
    store.saves.settle(r.id, 'rejected');
    expect(c1.confirmedAt).toBe(start);
    expect(store.saves.list(project.id).map((s) => s.fingerprint)).toEqual([
      'r',
      'c2',
      'caught',
      'c1',
    ]);
    expect(store.saves.list(project.id, { statuses: ['confirmed'] }).map((s) => s.id)).toEqual([
      c2.id,
      c1.id,
    ]);
    expect(store.saves.list(project.id, { kinds: ['mistake_avoided'] })).toHaveLength(1);
    expect(store.saves.list(project.id, { since: start + 1 })).toHaveLength(3);
    expect(store.saves.countConfirmed(project.id, start)).toBe(2);
    expect(store.saves.countConfirmed(project.id, start + 1)).toBe(1);
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM saves
         WHERE project_id = ? AND status = 'confirmed' AND created_at >= ?`,
      )
      .all(project.id, start) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toMatch(/USING (COVERING )?INDEX saves_project/);
  });
});
