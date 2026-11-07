import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Memory, Project, Run, Session } from '@mindly/core';
import { USER } from '@mindly/engine';
import type { Daemon } from '../src/index.js';
import {
  bearer,
  git,
  HOST,
  repo,
  seedSession,
  testDaemon,
  write,
  type TestDaemon,
} from './helpers.js';

const LINE = 'export function login(user: string) { return user.trim(); }';

let t: TestDaemon;
let d: Daemon;
let root: string;
let project: Project;
let session: Session;
let rule: Memory;
let fact: Memory;

beforeEach(async () => {
  t = await testDaemon();
  d = t.daemon;
  root = repo();
  write(root, 'src/auth.ts', `// auth\n${LINE}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'auth');
  session = seedSession(d, root, { agentKind: 'claude-code' });
  project = d.mindly.store.projects.get(session.projectId);
  const m = d.mindly;
  const agent = { type: 'agent' as const, sessionId: session.id, agentKind: 'claude-code' };
  rule = m.memory.remember({
    projectId: project.id,
    projectRoot: root,
    kind: 'rule',
    title: 'Use pnpm, never npm',
    body: 'The repo uses pnpm workspaces.',
    source: agent,
  });
  fact = m.memory.remember({
    projectId: project.id,
    projectRoot: root,
    kind: 'fact',
    title: 'Login trims the user name',
    body: 'See src/auth.ts',
    source: USER,
    evidence: [{ path: 'src/auth.ts', excerpt: LINE }],
  });
  m.tasks.create({ projectId: project.id, title: 'Add login', owner: session, plan: ['a', 'b'] });
  m.store.intents.declare({
    projectId: project.id,
    sessionId: session.id,
    summary: 'edit auth',
    targets: { files: ['src/auth.ts'], symbols: [] },
    ttlMs: 60_000,
  });
  m.store.conflicts.report({
    projectId: project.id,
    kind: 'file_overlap',
    severity: 'critical',
    title: 'Two agents edit src/auth.ts',
    detail: 'overlap',
    sessionIds: [session.id],
    paths: ['src/auth.ts'],
    fingerprint: 'fp-1',
  });
  m.telepathy.send({
    projectId: project.id,
    from: null,
    to: { sessionIds: [session.id] },
    kind: 'message',
    title: 'hello',
    body: 'world',
  });
  m.store.handoffs.create({
    projectId: project.id,
    fromSessionId: session.id,
    toAgentKind: 'codex',
    taskId: null,
    reason: 'manual',
    summary: 'continue',
    packet: {
      goal: 'g',
      plan: [],
      filesChanged: [],
      recentPrompts: [],
      decisions: [],
      blockers: [],
      nextSteps: [],
      branch: 'main',
      headCommit: null,
    },
  });
  m.store.contextPackets.record({
    projectId: project.id,
    sessionId: session.id,
    trigger: 'session_start',
    query: null,
    included: [
      { ref: rule.id, kind: 'memory', title: rule.title, score: 1, tokens: 10, reason: 'rule' },
    ],
    omitted: [],
    tokenBudget: 100,
    tokensUsed: 10,
  });
  const prompt = m.store.events.append({
    projectId: project.id,
    sessionId: session.id,
    type: 'prompt.submitted',
    payload: { summary: 'make login trim names' },
  });
  m.store.fileChanges.record({
    projectId: project.id,
    sessionId: session.id,
    path: 'src/auth.ts',
    tool: 'Edit',
    hunkHashes: m.kernel.ports.git.hunkHashes(LINE),
    addedLines: 1,
    removedLines: 0,
    promptEventId: prompt.id,
  });
});

afterEach(async () => {
  await d.stop();
});

const get = (url: string) => d.app.inject({ method: 'GET', url, headers: bearer(d) });
const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  d.app.inject({
    method,
    url,
    headers: bearer(d, payload === undefined ? {} : { 'content-type': 'application/json' }),
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

describe('read endpoints', () => {
  it('lists projects and the overview', async () => {
    expect((await get('/api/projects')).json()).toEqual([project]);
    const res = await get(`/api/projects/${project.id}/overview`);
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.project.id).toBe(project.id);
    expect(o.sessions.map((s: Session) => s.id)).toEqual([session.id]);
    expect(o.tasks).toHaveLength(1);
    expect(o.intents).toHaveLength(1);
    expect(o.conflicts).toHaveLength(1);
    expect(o.memoryCounts.proposed).toBe(1);
    expect(o.pendingDeliveries).toBe(1);
    expect(o.lastShadowMerge).toBeNull();
    expect(o.needsYou).toEqual({
      proposedRules: 1,
      proposedMemories: 0,
      criticalConflicts: 1,
      openConflicts: 1,
      pendingHandoffs: 1,
      blockedParts: 0,
      failedMergeChecks: 0,
    });
    expect(o.split).toBeNull();
    expect(o.lastSeq).toBe(d.mindly.store.events.maxSeq());
  });

  it('lists sessions, events, tasks, intents, deliveries, handoffs, conflicts, runs', async () => {
    expect((await get(`/api/projects/${project.id}/sessions?limit=5`)).json()).toHaveLength(1);
    const events = (
      await get(
        `/api/projects/${project.id}/events?types=memory.created,task.created&order=desc&limit=10`,
      )
    ).json();
    expect(events.map((e: { type: string }) => e.type).sort()).toEqual([
      'memory.created',
      'memory.created',
      'task.created',
    ]);
    const after = (
      await get(`/api/projects/${project.id}/events?afterSeq=${events[0].seq}`)
    ).json();
    expect(after.every((e: { seq: number }) => e.seq > events[0].seq)).toBe(true);
    expect((await get(`/api/projects/${project.id}/tasks?status=in_progress`)).json()).toHaveLength(
      1,
    );
    expect((await get(`/api/projects/${project.id}/tasks?status=done`)).json()).toHaveLength(0);
    expect((await get(`/api/projects/${project.id}/intents`)).json()).toHaveLength(1);
    expect(
      (await get(`/api/projects/${project.id}/deliveries?status=pending`)).json(),
    ).toHaveLength(1);
    expect((await get(`/api/projects/${project.id}/handoffs`)).json()).toHaveLength(1);
    expect((await get(`/api/projects/${project.id}/conflicts`)).json()).toHaveLength(1);
    expect(
      (await get(`/api/projects/${project.id}/conflicts?status=resolved`)).json(),
    ).toHaveLength(0);
    expect((await get(`/api/projects/${project.id}/runs?kind=review&limit=5`)).json()).toEqual([]);
  });

  it('lists and searches memories, and returns memory detail', async () => {
    const all = (await get(`/api/projects/${project.id}/memories`)).json();
    expect(all.map((m: Memory) => m.id).sort()).toEqual([rule.id, fact.id].sort());
    expect((await get(`/api/projects/${project.id}/memories?kind=rule`)).json()).toHaveLength(1);
    expect(
      (await get(`/api/projects/${project.id}/memories?trust=approved&kind=`)).json(),
    ).toHaveLength(1);
    const hits = (await get(`/api/projects/${project.id}/memories?q=pnpm`)).json();
    expect(hits.map((m: Memory) => m.id)).toEqual([rule.id]);
    const detail = (await get(`/api/memories/${fact.id}`)).json();
    expect(detail.memory.id).toBe(fact.id);
    expect(detail.versions).toHaveLength(1);
    expect(detail.evidence).toHaveLength(1);
    expect(detail.contracts).toEqual([]);
    const ruleDetail = (await get(`/api/memories/${rule.id}`)).json();
    expect(ruleDetail.xray).toHaveLength(1);
  });

  it('serves x-ray, provenance and standup', async () => {
    const xray = (await get(`/api/sessions/${session.id}/xray?limit=5`)).json();
    expect(xray).toHaveLength(1);
    expect(xray[0].included[0].ref).toBe(rule.id);
    const prov = await get(`/api/projects/${project.id}/provenance?file=src/auth.ts&line=2`);
    expect(prov.statusCode).toBe(200);
    expect(prov.json()).toMatchObject({
      file: 'src/auth.ts',
      line: 2,
      found: true,
      sessionId: session.id,
      agentKind: 'claude-code',
      tool: 'Edit',
      promptSummary: 'make login trim names',
    });
    expect(prov.json().memories.map((m: Memory) => m.id)).toEqual([fact.id]);
    const none = (
      await get(`/api/projects/${project.id}/provenance?file=src/auth.ts&line=1`)
    ).json();
    expect(none.found).toBe(false);
    const outside = await get(
      `/api/projects/${project.id}/provenance?file=../../etc/passwd&line=1`,
    );
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error.code).toBe('path_outside_project');
    write(root, '.env', 'SECRET=1\n');
    const denied = await get(`/api/projects/${project.id}/provenance?file=.env&line=1`);
    expect(denied.statusCode).toBe(403);
    const standup = (await get(`/api/projects/${project.id}/standup?since=0`)).json();
    expect(standup.markdown).toContain('#');
    expect(standup.digest.projectName).toBe('repo');
  });

  it('returns trust status', async () => {
    const res = (await get(`/api/projects/${project.id}/trust`)).json();
    expect(res).toEqual({ trusted: false, configHash: null, configError: null, checks: [] });
  });
});

describe('mutations', () => {
  it('creates, edits, approves, rejects, archives and deletes memories as the user', async () => {
    const created = await send('POST', `/api/projects/${project.id}/memories`, {
      kind: 'rule',
      title: 'Never commit .env files',
      body: 'Secrets stay local.',
      tags: ['Security'],
      scopePaths: ['**/*.ts'],
      enforce: true,
      pinned: true,
    });
    expect(created.statusCode).toBe(201);
    const m = created.json() as Memory;
    expect(m.source.type).toBe('user');
    expect(m.trust).toBe('approved');
    expect(m.enforce).toBe(true);
    expect(m.tags).toEqual(['security']);

    const patched = await send('PATCH', `/api/memories/${m.id}`, {
      body: 'Updated',
      scopePaths: ['src/**'],
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      body: 'Updated',
      version: 2,
      scope: { paths: ['src/**'] },
    });

    expect((await send('POST', `/api/memories/${rule.id}/approve`)).json().trust).toBe('approved');
    expect((await send('POST', `/api/memories/${rule.id}/reject`)).json().trust).toBe('rejected');
    expect((await send('POST', `/api/memories/${rule.id}/archive`)).json().status).toBe('archived');
    expect((await send('DELETE', `/api/memories/${m.id}`)).statusCode).toBe(204);
    expect((await get(`/api/memories/${m.id}`)).statusCode).toBe(404);
  });

  it('changes conflict status and records an event', async () => {
    const [c] = (await get(`/api/projects/${project.id}/conflicts`)).json();
    const res = await send('POST', `/api/conflicts/${c.id}/status`, { status: 'acknowledged' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('acknowledged');
    const events = d.mindly.store.events.query(project.id, { types: ['conflict.updated'] });
    expect(events).toHaveLength(1);
  });

  it('creates, diffs and restores snapshots', async () => {
    const snap = await send('POST', `/api/projects/${project.id}/snapshots`, { label: 'before' });
    expect(snap.statusCode).toBe(201);
    const s = snap.json();
    expect(s.gitRef).toMatch(/^refs\/mindly\/snapshots\//);
    expect((await get(`/api/projects/${project.id}/snapshots`)).json()).toHaveLength(1);
    write(root, 'a.txt', 'changed\n');
    d.mindly.memory.remember({
      projectId: project.id,
      projectRoot: root,
      kind: 'note',
      title: 'later',
      body: 'x',
      source: USER,
    });
    const diff = (await get(`/api/snapshots/${s.id}/diff`)).json();
    expect(diff.memories).toEqual({ added: 1, changed: 0, removed: 0 });
    expect(diff.tasks).toEqual({ added: 0, changed: 0, removed: 0 });
    expect(diff.files).toEqual([{ path: 'a.txt', status: 'changed', added: 1, removed: 3 }]);
    const restored = await send('POST', `/api/snapshots/${s.id}/restore`, {
      branch: 'mindly/restore-1',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ branch: 'mindly/restore-1', memoriesArchived: 1 });
    expect(git(root, 'branch', '--list', 'mindly/restore-1')).toContain('mindly/restore-1');
    const bad = await send('POST', `/api/snapshots/${s.id}/restore`, { branch: '../evil' });
    expect(bad.statusCode).toBe(400);
  });

  it('trusts the project config', async () => {
    write(
      root,
      '.mindly/config.json',
      JSON.stringify({ checks: [{ name: 'test', argv: ['node', '-v'] }] }),
    );
    const before = (await get(`/api/projects/${project.id}/trust`)).json();
    expect(before.trusted).toBe(false);
    expect(before.checks).toEqual([{ name: 'test', argv: ['node', '-v'] }]);
    expect((await send('POST', `/api/projects/${project.id}/trust`)).statusCode).toBe(400);
    const stale = await send('POST', `/api/projects/${project.id}/trust`, {
      configHash: 'ab'.repeat(32),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('conflict');
    const res = await send('POST', `/api/projects/${project.id}/trust`, {
      configHash: before.configHash,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().trusted).toBe(true);
    write(root, '.mindly/config.json', JSON.stringify({ checks: [] }));
    expect((await get(`/api/projects/${project.id}/trust`)).json().trusted).toBe(false);
  });

  it('queues review and replay runs (202) and stores dashboard-shaped results', async () => {
    write(root, 'a.txt', 'line 1\nline 2 changed\nline 3\n');
    const review = await send('POST', `/api/projects/${project.id}/review`, {
      sessionId: session.id,
      reviewer: 'codex',
    });
    expect(review.statusCode).toBe(202);
    expect(review.json()).toMatchObject({ kind: 'review', status: 'queued' });
    const replay = await send('POST', `/api/projects/${project.id}/replay`, {
      prompt: 'add a test',
      agents: ['claude-code', 'codex'],
    });
    expect(replay.statusCode).toBe(202);
    await d.scheduler.idle();
    const reviewRun = d.mindly.store.runs.get(review.json().id) as Run;
    expect(reviewRun.status).toBe('passed');
    expect(reviewRun.result).toMatchObject({
      reviewer: 'codex',
      findings: [{ severity: 'critical', file: 'a.txt', line: 2, message: 'Bug: off by one' }],
    });
    const reviewInput = t.runners.calls.find((c) => c.kind === 'review')?.input as { diff: string };
    expect(reviewInput.diff).toContain('+line 2 changed');
    expect(d.mindly.store.deliveries.list(project.id).some((x) => x.kind === 'review')).toBe(true);
    const replayRun = d.mindly.store.runs.get(replay.json().id) as Run;
    expect(replayRun.status).toBe('passed');
    expect(replayRun.result).toMatchObject({
      checksSkipped: 'untrusted',
      agents: [
        { agent: 'claude-code', filesChanged: 2, addedLines: 5, removedLines: 1, costUsd: 0.5 },
        { agent: 'codex', filesChanged: 2 },
      ],
    });
    const replayInput = t.runners.calls.find((c) => c.kind === 'replay')?.input as {
      checks: unknown;
      runId: string;
    };
    expect(replayInput.checks).toBeNull();
    expect(replayInput.runId).toBe(replayRun.id);
  });

  it('queues a shadow merge (202)', async () => {
    const res = await send('POST', `/api/projects/${project.id}/shadow-merge`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ kind: 'shadow_merge', status: 'queued' });
    await d.scheduler.idle();
    // Only one live worktree: nothing to merge.
    expect(d.mindly.store.runs.get(res.json().id).status).toBe('cancelled');
  });
});

describe('validation', () => {
  it('rejects malformed ids, queries and bodies with 400 and unknown ids with 404', async () => {
    const cases: [string, Promise<{ statusCode: number }>][] = [
      ['bad project id', get('/api/projects/not-a-uuid/overview')],
      ['bad limit', get(`/api/projects/${project.id}/sessions?limit=0`)],
      ['bad event type', get(`/api/projects/${project.id}/events?types=nope`)],
      ['bad order', get(`/api/projects/${project.id}/events?order=sideways`)],
      ['bad trust', get(`/api/projects/${project.id}/memories?trust=maybe`)],
      ['line 0', get(`/api/projects/${project.id}/provenance?file=a.txt&line=0`)],
      ['missing file', get(`/api/projects/${project.id}/provenance?line=1`)],
      [
        'bad kind',
        send('POST', `/api/projects/${project.id}/memories`, { kind: 'x', title: 't', body: 'b' }),
      ],
      [
        'extra key',
        send('POST', `/api/projects/${project.id}/memories`, {
          kind: 'fact',
          title: 't',
          body: 'b',
          trust: 'verified',
        }),
      ],
      ['empty patch', send('PATCH', `/api/memories/${fact.id}`, {})],
      ['bad status', send('POST', `/api/conflicts/${rule.id}/status`, { status: 'open' })],
      [
        'bad reviewer',
        send('POST', `/api/projects/${project.id}/review`, {
          sessionId: session.id,
          reviewer: 'cursor',
        }),
      ],
      [
        'same reviewer',
        send('POST', `/api/projects/${project.id}/review`, {
          sessionId: session.id,
          reviewer: 'claude-code',
        }),
      ],
      [
        'no agents',
        send('POST', `/api/projects/${project.id}/replay`, { prompt: 'p', agents: [] }),
      ],
      [
        'bad base',
        send('POST', `/api/projects/${project.id}/replay`, {
          prompt: 'p',
          agents: ['codex'],
          baseCommit: '--upload-pack=x',
        }),
      ],
      ['no label', send('POST', `/api/projects/${project.id}/snapshots`, {})],
    ];
    for (const [name, p] of cases) {
      const res = await p;
      expect(res.statusCode, name).toBe(400);
    }
    const missing = '0190a000-0000-7000-8000-000000000000';
    expect((await get(`/api/projects/${missing}/overview`)).statusCode).toBe(404);
    expect((await get(`/api/memories/${missing}`)).statusCode).toBe(404);
    expect(
      (await send('POST', `/api/conflicts/${missing}/status`, { status: 'resolved' })).statusCode,
    ).toBe(404);
    expect((await get(`/api/sessions/${missing}/xray`)).statusCode).toBe(404);
    expect(
      (
        await send('POST', `/api/projects/${project.id}/review`, {
          sessionId: missing,
          reviewer: 'codex',
        })
      ).statusCode,
    ).toBe(404);
    const unknown = await get('/api/nope');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('not_found');
  });
});

describe('track record', () => {
  const url = (pid: string, query = '') => `/api/projects/${pid}/track${query}`;

  it('needs the token', async () => {
    const res = await d.app.inject({
      method: 'GET',
      url: url(project.id),
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns the report of one project only', async () => {
    // Another project with many edits: none of them may show up here.
    const otherRoot = repo();
    const other = seedSession(d, otherRoot, { agentKind: 'codex' });
    for (let i = 0; i < 5; i++) {
      d.mindly.store.fileChanges.record({
        projectId: other.projectId,
        sessionId: other.id,
        path: `lib/x${i}.ts`,
        tool: 'Edit',
        hunkHashes: [],
        addedLines: 1,
        removedLines: 0,
        promptEventId: null,
      });
    }
    const res = await get(url(project.id));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window.since).toBe('30d');
    expect(body.totals).toEqual({ agents: 1, edits: 1, areas: 1 });
    expect(body.areas).toHaveLength(1);
    expect(body.areas[0].area).toBe('src');
    expect(body.areas[0].agents[0]).toMatchObject({
      agent: 'claude-code',
      edits: 1,
      enoughData: false,
      breakages: { count: 0, of: 1, rate: null, interval: null },
    });
    const otherBody = (await get(url(other.projectId, '?area=lib&since=7d&agent=codex'))).json();
    expect(otherBody.window.since).toBe('7d');
    expect(otherBody.filter).toEqual({ area: 'lib', agent: 'codex' });
    expect(otherBody.totals.edits).toBe(5);
    const narrowed = (await get(url(project.id, '?area=lib'))).json();
    expect(narrowed.totals.edits).toBe(0);
    expect((await get(url(project.id, '?minEdits=1'))).json().minimum.edits).toBe(1);
  });

  it('validates the query and the project', async () => {
    for (const q of [
      '?since=soon',
      '?since=0d',
      '?since=99999w',
      '?area=../etc',
      '?area=%1b%5b31m',
      '?agent=Not%20An%20Agent',
      '?minEdits=0',
    ]) {
      expect((await get(url(project.id, q))).statusCode, q).toBe(400);
    }
    expect((await get('/api/projects/not-a-uuid/track')).statusCode).toBe(400);
    expect((await get(url('0190a000-0000-7000-8000-000000000000'))).statusCode).toBe(404);
  });
});
