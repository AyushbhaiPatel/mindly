import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMindlyError, type Severity } from '@mindly/core';
import { openDatabaseReadOnly, readGlance, Store } from '../src/index.js';

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
