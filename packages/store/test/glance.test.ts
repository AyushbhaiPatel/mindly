import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isMindlyError, type Severity } from '@mindly/core';
import {
  MIGRATIONS,
  openDatabaseReadOnly,
  peekSchemaVersion,
  readGlance,
  startOfLocalDay,
  Store,
} from '../src/index.js';

const user = { type: 'user' as const, sessionId: null, agentKind: null };
const NOW = Date.now();

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-glance-')));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  const path = join(dir, 'mindly.db');
  const store = Store.open(path);
  const project = store.projects.upsertByRoot(root, 'repo');
  const session = (externalId: string, agentKind: string, branch: string | null) =>
    store.sessions.upsert({
      projectId: project.id,
      agentKind,
      externalId,
      worktree: root,
      branch,
      transcriptPath: null,
    }).session;
  return { dir, root, path, store, project, session };
}

describe('readGlance', () => {
  it('counts rules in effect, updates for the session and conflicts that need the user', () => {
    const { root, path, store, project, session } = fixture();
    const me = session('cc-1', 'claude-code', 'feature');
    const other = session('cx-1', 'codex', 'main');
    const rule = (title: string, trust: 'approved' | 'verified' | 'proposed', branch?: string) =>
      store.memories.create({
        projectId: project.id,
        kind: 'rule',
        title,
        body: '',
        trust,
        source: user,
        ...(branch ? { scope: { branch } } : {}),
      });
    rule('use pnpm', 'approved');
    rule('verified one', 'verified');
    rule('on my branch', 'approved', 'feature');
    rule('on another branch', 'approved', 'main');
    rule('not approved yet', 'proposed');
    const archived = rule('archived', 'approved');
    store.memories.update(archived.id, { status: 'archived' }, user, null);
    store.memories.create({
      projectId: project.id,
      kind: 'fact',
      title: 'a fact',
      body: '',
      trust: 'approved',
      source: user,
    });

    const deliver = (target: string | null, kind: string | null, source: string | null) =>
      store.deliveries.enqueue({
        projectId: project.id,
        targetSessionId: target,
        targetAgentKind: kind,
        kind: 'impact',
        title: 't',
        body: 'b',
        sourceSessionId: source,
        ttlMs: 60_000,
      });
    deliver(me.id, null, other.id);
    deliver(null, 'claude-code', other.id);
    deliver(null, null, me.id); // my own broadcast
    deliver(other.id, null, me.id); // for someone else
    const delivered = deliver(me.id, null, other.id);
    store.deliveries.markDelivered([delivered.id], me.id);

    const conflict = (severity: Severity, fingerprint: string) =>
      store.conflicts.report({
        projectId: project.id,
        kind: 'file_overlap',
        severity,
        title: fingerprint,
        detail: '',
        sessionIds: [me.id, other.id],
        paths: ['a.ts'],
        fingerprint,
      }).conflict;
    conflict('critical', 'c1');
    conflict('warning', 'c2');
    conflict('info', 'c3');
    store.conflicts.setStatus(conflict('critical', 'c4').id, 'acknowledged');
    store.close();

    const db = openDatabaseReadOnly(path);
    try {
      expect(
        readGlance(db, {
          dir: join(root, 'src', 'deep'),
          agentKind: 'claude-code',
          externalSessionId: 'cc-1',
          now: NOW,
        }),
      ).toEqual({ projectName: 'repo', rules: 3, updates: 2, conflicts: 2 });
      // An unknown session sees every branch's rules and only broadcasts.
      expect(
        readGlance(db, { dir: root, agentKind: 'claude-code', externalSessionId: null, now: NOW }),
      ).toEqual({ projectName: 'repo', rules: 4, updates: 2, conflicts: 2 });
      // Expired deliveries do not count.
      expect(
        readGlance(db, {
          dir: root,
          agentKind: 'claude-code',
          externalSessionId: 'cc-1',
          now: NOW + 120_000,
        })?.updates,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('counts confirmed saves of today with one indexed query, within the status-line budget', () => {
    const { root, path, store, project } = fixture();
    const today = startOfLocalDay(NOW);
    const add = (
      n: number,
      status: 'caught' | 'confirmed' | 'expired' | 'rejected',
      at: number,
    ) => {
      const insert = store.db.prepare(
        `INSERT INTO saves (id, project_id, kind, status, title, fingerprint, created_at)
         VALUES (?, ?, 'rule_enforced', ?, 't', ?, ?)`,
      );
      store.transaction(() => {
        for (let i = 0; i < n; i++) {
          const id = `${status}-${at}-${i}`;
          insert.run(id, project.id, status, id, at);
        }
      });
    };
    // A long history: many saves before today and many that do not count.
    add(20_000, 'confirmed', today - 86_400_000);
    add(5_000, 'expired', today + 1);
    add(5_000, 'caught', today + 1);
    add(1, 'rejected', today + 1);
    add(2, 'confirmed', today + 1);
    store.close();

    const db = openDatabaseReadOnly(path);
    try {
      const input = { dir: root, agentKind: 'claude-code', externalSessionId: null, now: NOW };
      expect(readGlance(db, input)?.saves).toBe(2);
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM saves
           WHERE project_id = ? AND status = 'confirmed' AND created_at >= ?`,
        )
        .all(project.id, today) as { detail: string }[];
      expect(plan.map((p) => p.detail).join(' ')).toMatch(/USING (COVERING )?INDEX saves_project/);
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        readGlance(db, input);
        times.push(performance.now() - started);
      }
      // The whole glance (four counts) stays far below the status line's budget.
      expect(Math.min(...times)).toBeLessThan(50);
      expect(() => db.exec('DELETE FROM saves')).toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a database a writer has not migrated to v2 yet, without changing it', () => {
    const { path, store } = fixture();
    store.db.exec(
      'DROP TABLE sentinel_watches; DROP INDEX file_changes_created; DROP TABLE line_survival; DROP TABLE file_change_lines; DROP TABLE saves; PRAGMA user_version = 1;',
    );
    store.close();
    const before = readFileSync(path);
    let error: unknown;
    try {
      openDatabaseReadOnly(path).close();
    } catch (err) {
      error = err;
    }
    expect(isMindlyError(error, 'unavailable')).toBe(true);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('returns null outside known projects and never writes', () => {
    const { dir, path, store } = fixture();
    store.close();
    const before = readFileSync(path);
    const db = openDatabaseReadOnly(path);
    try {
      expect(
        readGlance(db, { dir, agentKind: 'claude-code', externalSessionId: 'x', now: NOW }),
      ).toBeNull();
      expect(() => db.exec('DELETE FROM projects')).toThrow();
    } finally {
      db.close();
    }
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('refuses a missing database without creating it', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'mindly-glance-')), 'mindly.db');
    let error: unknown;
    try {
      openDatabaseReadOnly(missing);
    } catch (err) {
      error = err;
    }
    expect(isMindlyError(error, 'not_found')).toBe(true);
    expect(() => statSync(missing)).toThrow();
  });
});

describe('peekSchemaVersion', () => {
  it('reads the version of any database without changing or creating it', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-peek-')));
    const path = join(dir, 'mindly.db');
    expect(peekSchemaVersion(path)).toBeNull();
    expect(existsSync(path)).toBe(false);

    // An older database: every migration but the last.
    const old = new DatabaseSync(path);
    for (const sql of MIGRATIONS.slice(0, -1)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    old.close();
    const before = readFileSync(path);
    expect(peekSchemaVersion(path)).toBe(MIGRATIONS.length - 1);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);

    // A newer one is read too; opening the store is what refuses it.
    const newer = new DatabaseSync(path);
    newer.exec(`PRAGMA user_version = ${MIGRATIONS.length + 2}`);
    newer.close();
    expect(peekSchemaVersion(path)).toBe(MIGRATIONS.length + 2);
    expect(() => Store.open(path)).toThrow(/newer than this Mindly/);
  });

  it('creates no file next to a cleanly closed database and reads through a journal', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-peek-')));
    const path = join(dir, 'mindly.db');
    Store.open(path).close();
    expect(readdirSync(dir)).toEqual(['mindly.db']);
    expect(peekSchemaVersion(path)).toBe(MIGRATIONS.length);
    expect(readdirSync(dir)).toEqual(['mindly.db']);

    // An empty file has no schema yet.
    const empty = join(dir, 'empty.db');
    writeFileSync(empty, '');
    expect(peekSchemaVersion(empty)).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['empty.db', 'mindly.db']);

    // Not a database at all.
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'x'.repeat(200));
    expect(() => peekSchemaVersion(junk)).toThrow();

    // A version that so far is only in the journal (another process holds the database open)
    // is the one reported, not the stale one in the file's header.
    const live = new DatabaseSync(path);
    try {
      live.exec('PRAGMA wal_autocheckpoint = 0');
      live.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(readFileSync(path).readUInt32BE(60)).toBe(MIGRATIONS.length);
      expect(peekSchemaVersion(path)).toBe(MIGRATIONS.length + 5);
    } finally {
      live.close();
    }
  });
});
