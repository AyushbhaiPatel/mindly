import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, Store, schemaVersion, toFtsQuery } from '../src/index.js';
import { setup } from './helpers.js';

const user = { type: 'user' as const, sessionId: null, agentKind: null };

describe('database', () => {
  it('migrates, uses WAL and owner-only file permissions', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'syn-db-')), 'mindly.db');
    const store = Store.open(path);
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length);
    const mode = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    store.close();
    // Reopening is idempotent.
    Store.open(path).close();
  });

  it('rolls back failed transactions including nested ones', () => {
    const { store, project } = setup();
    expect(() =>
      store.transaction(() => {
        store.tasks.create({ projectId: project.id, title: 'kept?' });
        store.transaction(() => store.tasks.create({ projectId: project.id, title: 'inner' }));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.tasks.list(project.id)).toHaveLength(0);
  });

  it('cascades project deletion', () => {
    const { store, project, a } = setup();
    store.memories.create({
      projectId: project.id,
      kind: 'fact',
      title: 't',
      body: 'b',
      trust: 'approved',
      source: user,
    });
    store.events.append({
      projectId: project.id,
      sessionId: a.id,
      type: 'session.started',
      payload: {},
    });
    store.projects.delete(project.id);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });
});

describe('sessions', () => {
  it('upserts by external id and reactivates', () => {
    const { store, project, a } = setup();
    store.sessions.setStatus(a.id, 'ended');
    const again = store.sessions.upsert({
      projectId: project.id,
      agentKind: 'claude-code',
      externalId: 'cc-1',
      worktree: '/repo',
      branch: null,
      transcriptPath: null,
    });
    expect(again.created).toBe(false);
    expect(again.session.status).toBe('active');
    expect(again.session.branch).toBe('main');
  });

  it('lists live sessions and ends stale ones', () => {
    const { store, project, clock, a } = setup();
    clock.advance(60_000);
    store.sessions.touch(a.id);
    expect(store.sessions.listLive(project.id, 30_000).map((s) => s.id)).toEqual([a.id]);
    expect(store.sessions.endStale(project.id, 30_000)).toHaveLength(1);
  });
});

describe('events', () => {
  it('appends idempotently and queries by type/seq', () => {
    const { store, project, a } = setup();
    const e1 = store.events.append({
      id: 'fixed-id',
      projectId: project.id,
      sessionId: a.id,
      type: 'prompt.submitted',
      payload: { prompt: 'x' },
    });
    const dup = store.events.append({
      id: 'fixed-id',
      projectId: project.id,
      sessionId: a.id,
      type: 'prompt.submitted',
      payload: { prompt: 'y' },
    });
    expect(dup.seq).toBe(e1.seq);
    expect(dup.payload).toEqual({ prompt: 'x' });
    store.events.append({
      projectId: project.id,
      sessionId: a.id,
      type: 'tool.after',
      payload: {},
    });
    expect(store.events.query(project.id, { types: ['tool.after'] })).toHaveLength(1);
    expect(store.events.query(project.id, { afterSeq: e1.seq })).toHaveLength(1);
  });

  it('compacts old prompt text', () => {
    const { store, project, a, clock } = setup();
    store.events.append({
      projectId: project.id,
      sessionId: a.id,
      type: 'prompt.submitted',
      payload: { prompt: 'secret plan', summary: 's' },
    });
    clock.advance(10);
    expect(store.events.compactPrompts(clock.now())).toBe(1);
    expect(store.events.query(project.id)[0]?.payload).toEqual({ summary: 's' });
  });
});

describe('memories', () => {
  it('versions updates and supports time travel', () => {
    const { store, project, clock, a } = setup();
    const m = store.memories.create({
      projectId: project.id,
      kind: 'decision',
      title: 'Auth',
      body: 'Use JWT',
      trust: 'proposed',
      source: { type: 'agent', sessionId: a.id, agentKind: 'claude-code' },
    });
    const t1 = clock.now();
    clock.advance(1000);
    const m2 = store.memories.update(
      m.id,
      { body: 'Use sessions', trust: 'approved' },
      user,
      'switched',
    );
    expect(m2.version).toBe(2);
    const versions = store.memories.versions(m.id);
    expect(versions.map((v) => v.body)).toEqual(['Use JWT', 'Use sessions']);
    expect(versions[1]?.reason).toBe('switched');
    expect(store.memories.asOf(m.id, t1)?.body).toBe('Use JWT');
    // Non-content updates do not create versions.
    expect(store.memories.update(m.id, { pinned: true }, user, null).version).toBe(2);
  });

  it('searches with FTS and filters by trust and branch', () => {
    const { store, project } = setup();
    store.memories.create({
      projectId: project.id,
      kind: 'rule',
      title: 'Package manager',
      body: 'Always use pnpm, never npm',
      trust: 'approved',
      source: user,
    });
    store.memories.create({
      projectId: project.id,
      kind: 'fact',
      title: 'Testing',
      body: 'Run vitest for unit tests',
      trust: 'proposed',
      source: user,
      scope: { branch: 'feat/x' },
    });
    expect(store.memories.search(project.id, 'which package manager?')[0]?.memory.title).toBe(
      'Package manager',
    );
    expect(store.memories.search(project.id, 'tests', { trust: ['approved'] })).toHaveLength(0);
    expect(store.memories.search(project.id, 'tests', { branch: 'main' })).toHaveLength(0);
    expect(store.memories.search(project.id, 'tests', { branch: 'feat/x' })).toHaveLength(1);
    expect(store.memories.search(project.id, '"); DROP TABLE memories; --')).toEqual([]);
    expect(store.memories.search(project.id, 'title:pnpm OR NEAR(a b)')).toBeInstanceOf(Array);
  });

  it('promotes branch memories', () => {
    const { store, project } = setup();
    const m = store.memories.create({
      projectId: project.id,
      kind: 'fact',
      title: 'x',
      body: 'y',
      trust: 'approved',
      source: user,
      scope: { branch: 'feat/a' },
    });
    expect(store.memories.promoteBranch(project.id, 'feat/a', null, user)).toBe(1);
    expect(store.memories.get(m.id).scope.branch).toBeNull();
  });

  it('tracks evidence by file', () => {
    const { store, project } = setup();
    const m = store.memories.create({
      projectId: project.id,
      kind: 'fact',
      title: 'x',
      body: 'y',
      trust: 'verified',
      source: user,
    });
    const e = store.memories.addEvidence({
      memoryId: m.id,
      projectId: project.id,
      type: 'file',
      ref: 'src/a.ts',
      excerpt: 'export a',
      contentHash: 'h',
    });
    expect(store.memories.evidenceForFile(project.id, 'src/a.ts')).toHaveLength(1);
    store.memories.markEvidence(e.id, false);
    expect(store.memories.evidenceFor(m.id)[0]?.valid).toBe(false);
  });

  it('builds safe FTS queries', () => {
    expect(toFtsQuery('Hello "world" NEAR(x)')).toBe('"hello"* OR "world"* OR "near"*');
    expect(toFtsQuery('!!!')).toBeNull();
  });
});

describe('intents and file changes', () => {
  it('finds overlapping intents of other sessions and expires them', () => {
    const { store, project, a, b, clock } = setup();
    store.intents.declare({
      projectId: project.id,
      sessionId: a.id,
      summary: 'edit auth',
      targets: { files: ['src/auth.ts'], symbols: ['login'] },
      ttlMs: 60_000,
    });
    expect(store.intents.othersTargetingFiles(project.id, b.id, ['src/auth.ts'])).toHaveLength(1);
    expect(store.intents.othersTargetingFiles(project.id, a.id, ['src/auth.ts'])).toHaveLength(0);
    clock.advance(120_000);
    expect(store.intents.expire()).toBe(1);
    expect(store.intents.active(project.id)).toHaveLength(0);
  });

  it('maps hunk hashes back to changes', () => {
    const { store, project, a, b } = setup();
    store.fileChanges.record({
      projectId: project.id,
      sessionId: a.id,
      path: 'src/a.ts',
      tool: 'Edit',
      hunkHashes: ['h1', 'h2', 'h1'],
      addedLines: 2,
      removedLines: 0,
      promptEventId: null,
    });
    expect(store.fileChanges.findByHash(project.id, 'src/a.ts', 'h2')[0]?.sessionId).toBe(a.id);
    expect(store.fileChanges.otherEditors(project.id, b.id, 'src/a.ts', 0)).toEqual([a.id]);
  });

  it('keeps the working tree a change was made in, null when not given', () => {
    const { store, project, a } = setup();
    const base = {
      projectId: project.id,
      sessionId: a.id,
      tool: 'Edit',
      hunkHashes: [],
      addedLines: 1,
      removedLines: 0,
      promptEventId: null,
    };
    expect(store.fileChanges.record({ ...base, path: 'x.ts', worktree: '/wt' }).worktree).toBe(
      '/wt',
    );
    expect(store.fileChanges.record({ ...base, path: 'y.ts' }).worktree).toBeNull();
    expect(store.fileChanges.forPath(project.id, 'x.ts')[0]?.worktree).toBe('/wt');
    expect(store.fileChanges.since(project.id, 0).map((c) => [c.path, c.worktree])).toEqual(
      expect.arrayContaining([
        ['x.ts', '/wt'],
        ['y.ts', null],
      ]),
    );
  });
});

describe('conflicts', () => {
  it('deduplicates by fingerprint, respects dismissal and reopens resolved ones', () => {
    const { store, project, a } = setup();
    const base = {
      projectId: project.id,
      kind: 'file_overlap' as const,
      severity: 'warning' as const,
      title: 't',
      detail: 'd',
      sessionIds: [a.id],
      paths: ['x'],
      fingerprint: 'fp',
    };
    const first = store.conflicts.report(base);
    expect(first.isNew).toBe(true);
    expect(store.conflicts.report(base).isNew).toBe(false);
    store.conflicts.setStatus(first.conflict.id, 'resolved');
    expect(store.conflicts.report(base).isNew).toBe(true);
    store.conflicts.setStatus(first.conflict.id, 'dismissed');
    expect(store.conflicts.report(base).conflict.status).toBe('dismissed');
    expect(store.conflicts.list(project.id, { sessionId: a.id })).toHaveLength(0);
  });

  it('resolves conflicts that disappeared', () => {
    const { store, project } = setup();
    for (const fp of ['a', 'b']) {
      store.conflicts.report({
        projectId: project.id,
        kind: 'merge_conflict',
        severity: 'critical',
        title: fp,
        detail: '',
        sessionIds: [],
        paths: [],
        fingerprint: fp,
      });
    }
    expect(store.conflicts.resolveMissing(project.id, 'merge_conflict', ['a'])).toBe(1);
    expect(store.conflicts.list(project.id).map((c) => c.fingerprint)).toEqual(['a']);
  });
});

describe('deliveries', () => {
  it('delivers once, by session or agent kind, never back to the source', () => {
    const { store, project, a, b } = setup();
    store.deliveries.enqueue({
      projectId: project.id,
      targetSessionId: null,
      targetAgentKind: 'codex',
      kind: 'impact',
      title: 'API changed',
      body: '...',
      sourceSessionId: a.id,
      ttlMs: 60_000,
    });
    store.deliveries.enqueue({
      projectId: project.id,
      targetSessionId: null,
      targetAgentKind: null,
      kind: 'message',
      title: 'all',
      body: '',
      sourceSessionId: a.id,
      ttlMs: 60_000,
    });
    expect(store.deliveries.pendingFor(project.id, a.id, 'claude-code')).toHaveLength(0);
    const pending = store.deliveries.pendingFor(project.id, b.id, 'codex');
    expect(pending).toHaveLength(2);
    store.deliveries.markDelivered(
      pending.map((d) => d.id),
      b.id,
    );
    expect(store.deliveries.pendingFor(project.id, b.id, 'codex')).toHaveLength(0);
    expect(
      store.deliveries.ack(
        pending.map((d) => d.id),
        b.id,
      ),
    ).toBe(2);
  });

  it('dedupes and re-queues on new content', () => {
    const { store, project, a, b } = setup();
    const base = {
      projectId: project.id,
      targetSessionId: b.id,
      targetAgentKind: null,
      kind: 'impact' as const,
      body: '',
      sourceSessionId: a.id,
      ttlMs: 60_000,
      dedupeKey: 'k',
    };
    const d1 = store.deliveries.enqueue({ ...base, title: 'v1' });
    store.deliveries.markDelivered([d1.id], b.id);
    const d2 = store.deliveries.enqueue({ ...base, title: 'v2' });
    expect(d2.id).toBe(d1.id);
    expect(d2.status).toBe('pending');
    expect(d2.title).toBe('v2');
  });

  it('expires stale deliveries', () => {
    const { store, project, b, clock } = setup();
    store.deliveries.enqueue({
      projectId: project.id,
      targetSessionId: b.id,
      targetAgentKind: null,
      kind: 'message',
      title: 'x',
      body: '',
      sourceSessionId: null,
      ttlMs: 1000,
    });
    clock.advance(2000);
    expect(store.deliveries.expire()).toBe(1);
  });
});

describe('misc repos', () => {
  it('claims handoffs atomically', () => {
    const { store, project, a, b } = setup();
    const packet = {
      goal: 'g',
      plan: [],
      filesChanged: [],
      recentPrompts: [],
      decisions: [],
      blockers: [],
      nextSteps: [],
      branch: null,
      headCommit: null,
    };
    const h = store.handoffs.create({
      projectId: project.id,
      fromSessionId: a.id,
      toAgentKind: 'codex',
      taskId: null,
      reason: 'rate_limit',
      summary: 's',
      packet,
    });
    expect(store.handoffs.pendingFor(project.id, 'codex', b.id)).toHaveLength(1);
    expect(store.handoffs.claim(h.id, b.id)).toBe(true);
    expect(store.handoffs.claim(h.id, a.id)).toBe(false);
  });

  it('records context packets and finds mentions', () => {
    const { store, project, b } = setup();
    store.contextPackets.record({
      projectId: project.id,
      sessionId: b.id,
      trigger: 'prompt',
      query: 'q',
      included: [{ ref: 'm1', kind: 'memory', title: 't', score: 1, tokens: 3, reason: 'match' }],
      omitted: [{ ref: 'm2', kind: 'memory', title: 't', score: 0.1, tokens: 3, reason: 'budget' }],
      tokenBudget: 100,
      tokensUsed: 3,
    });
    expect(store.contextPackets.mentioning(project.id, 'm2')).toHaveLength(1);
    expect(store.contextPackets.forSession(b.id)[0]?.included[0]?.ref).toBe('m1');
  });

  it('stores contracts, runs, snapshots and kv', () => {
    const { store, project } = setup();
    const m = store.memories.create({
      projectId: project.id,
      kind: 'decision',
      title: 'x',
      body: 'y',
      trust: 'approved',
      source: user,
    });
    const c = store.contracts.create({
      projectId: project.id,
      memoryId: m.id,
      kind: 'pattern_present',
      spec: { path: 'src/a.ts', pattern: 'role' },
      approvedHash: null,
    });
    expect(store.contracts.forPath(project.id, 'src/a.ts')).toHaveLength(1);
    expect(store.contracts.recordResult(c.id, 'failing', 'missing').state).toBe('failing');
    const r = store.runs.create({
      projectId: project.id,
      kind: 'shadow_merge',
      title: 't',
      input: {},
    });
    store.runs.start(r.id);
    expect(store.runs.finish(r.id, 'passed', { ok: true }).status).toBe('passed');
    const s = store.snapshots.create({
      projectId: project.id,
      label: 'before refactor',
      gitRef: null,
      commit: null,
      state: { tasks: [] },
    });
    expect(store.snapshots.get(s.id).state).toEqual({ tasks: [] });
    store.kv.set('k', { a: 1 });
    expect(store.kv.get('k')).toEqual({ a: 1 });
  });
});
