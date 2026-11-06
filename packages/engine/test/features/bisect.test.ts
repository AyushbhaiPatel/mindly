import { describe, expect, it } from 'vitest';
import type { Checkpoint, ContextItem } from '@mindly/core';
import {
  BisectAborted,
  bisectOf,
  bisectSearch,
  estimateRuns,
  sessionLabel,
  USER,
  type BisectProgress,
  type BisectRunner,
  type StepOutcome,
} from '../../src/index.js';
import { setup } from '../helpers.js';

function steps(n: number): Checkpoint[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `cp-${i + 1}`,
    projectId: 'p1',
    worktree: '/repo',
    seq: i + 1,
    commit: `commit-${i + 1}`,
    parentCommit: i === 0 ? null : `commit-${i}`,
    kind: i === 0 ? 'baseline' : 'agent',
    sessionId: i === 0 ? null : 's1',
    fileChangeId: null,
    promptEventId: null,
    tool: i === 0 ? null : 'Edit',
    paths: i === 0 ? [] : [`src/${i + 1}.ts`],
    gap: false,
    createdAt: 1_750_000_000_000 + i * 1000,
  }));
}

/** A runner answering from `decide(seq, nth)`, where `nth` counts how often that step was asked. */
function runner(decide: (seq: number, nth: number) => StepOutcome) {
  const asked = new Map<number, number>();
  const calls: number[] = [];
  const phases: BisectProgress['phase'][] = [];
  const progress: BisectProgress[] = [];
  const r: BisectRunner = {
    run: async (step) => {
      const nth = (asked.get(step.seq) ?? 0) + 1;
      asked.set(step.seq, nth);
      calls.push(step.seq);
      const outcome = decide(step.seq, nth);
      return {
        seq: step.seq,
        outcome,
        skipReason: outcome === 'skip' ? 'exit_125' : null,
        exitCode: outcome === 'good' ? 0 : outcome === 'bad' ? 1 : 125,
        durationMs: 1,
        output: '',
        setupRan: false,
      };
    },
  };
  const onProgress = (p: BisectProgress) => {
    phases.push(p.phase);
    progress.push(p);
  };
  return { runner: r, calls, phases, progress, onProgress };
}

const failsFrom = (n: number) => (seq: number) => (seq >= n ? 'bad' : 'good');

describe('bisectSearch', () => {
  it('finds the first failing step within the estimated number of runs', async () => {
    const all = steps(24);
    for (const n of [2, 3, 12, 13, 17, 23, 24]) {
      const r = runner(failsFrom(n));
      const result = await bisectSearch(all, r.runner, { onProgress: r.onProgress });
      expect(result.status, `first bad ${n}`).toBe('found');
      expect(result.firstBad?.seq).toBe(n);
      expect(result.lastGood?.seq).toBe(n - 1);
      expect(result.flaky).toBe(false);
      expect(result.skipped).toEqual([]);
      expect(result.checks).toHaveLength(r.calls.length);
      expect(r.calls.length, `runs for ${n}`).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(23)) + 2);
      expect(r.calls.slice(0, 2)).toEqual([1, 24]);
      expect(r.calls.slice(-2)).toEqual([n - 1, n]);
      expect(r.phases.slice(0, 2)).toEqual(['verify', 'verify']);
      expect(r.phases.slice(-2)).toEqual(['confirm', 'confirm']);
      expect(r.phases.slice(2, -2).every((p) => p === 'search')).toBe(true);
      expect(r.progress.map((p) => p.run)).toEqual(r.calls.map((_, i) => i + 1));
      expect(r.progress[0]?.estimatedRuns).toBe(estimateRuns(24));
    }
  });

  it('searches around a skipped step', async () => {
    const all = steps(24);
    const r = runner((seq) => (seq === 12 ? 'skip' : failsFrom(17)(seq)));
    const result = await bisectSearch(all, r.runner);
    expect(result.status).toBe('found');
    expect(result.firstBad?.seq).toBe(17);
    expect(result.lastGood?.seq).toBe(16);
    expect(result.skipped).toEqual([]);
    expect(r.calls).toContain(12);
    expect(result.checks.find((c) => c.seq === 12)).toMatchObject({
      outcome: 'skip',
      skipReason: 'exit_125',
    });
  });

  it('is inconclusive when every step between the ends is skipped', async () => {
    const all = steps(5);
    const r = runner((seq) => (seq === 1 ? 'good' : seq === 5 ? 'bad' : 'skip'));
    const result = await bisectSearch(all, r.runner, { onProgress: r.onProgress });
    expect(result.status).toBe('inconclusive');
    expect(result.lastGood?.seq).toBe(1);
    expect(result.firstBad?.seq).toBe(5);
    expect(result.skipped.map((s) => s.seq)).toEqual([2, 3, 4]);
    expect(result.flaky).toBe(false);
    expect(r.calls).toHaveLength(5);
    expect(r.phases).not.toContain('confirm');
  });

  it('calls a command that changes its answer unreliable', async () => {
    const all = steps(24);
    const r = runner((seq, nth) => (seq === 17 && nth === 2 ? 'good' : failsFrom(17)(seq)));
    const result = await bisectSearch(all, r.runner, { onProgress: r.onProgress });
    expect(result.status).toBe('unreliable');
    expect(result.flaky).toBe(true);
    expect(result.lastGood?.seq).toBe(16);
    expect(result.firstBad?.seq).toBe(17);
    expect(r.phases.slice(-2)).toEqual(['confirm', 'confirm']);
    expect(result.checks.filter((c) => c.seq === 17).map((c) => c.outcome)).toEqual([
      'bad',
      'good',
    ]);
  });

  it('stops when an end does not behave as expected', async () => {
    const all = steps(6);
    const bad = runner(() => 'bad');
    expect(await bisectSearch(all, bad.runner)).toMatchObject({
      status: 'good_fails',
      firstBad: all[0],
      lastGood: null,
      skipped: [],
      flaky: false,
    });
    expect(bad.calls).toEqual([1]);

    const good = runner(() => 'good');
    expect(await bisectSearch(all, good.runner)).toMatchObject({
      status: 'bad_passes',
      firstBad: null,
      lastGood: all[5],
      skipped: [],
    });
    expect(good.calls).toEqual([1, 6]);

    const goodSkipped = runner(() => 'skip');
    expect(await bisectSearch(all, goodSkipped.runner)).toMatchObject({
      status: 'good_skipped',
      firstBad: null,
      lastGood: null,
      skipped: [all[0]],
    });
    expect(goodSkipped.calls).toEqual([1]);

    const badSkipped = runner((seq) => (seq === 6 ? 'skip' : 'good'));
    expect(await bisectSearch(all, badSkipped.runner)).toMatchObject({
      status: 'bad_skipped',
      firstBad: null,
      lastGood: null,
      skipped: [all[5]],
    });
    expect(badSkipped.calls).toEqual([1, 6]);
  });

  it('needs at least two steps', async () => {
    const r = runner(() => 'good');
    await expect(bisectSearch(steps(1), r.runner)).rejects.toThrow(/at least two/);
    await expect(bisectSearch([], r.runner)).rejects.toThrow(/at least two/);
    expect(r.calls).toEqual([]);
  });

  it('throws BisectAborted before the next run once the signal is aborted', async () => {
    const all = steps(24);
    const controller = new AbortController();
    const inner = runner(failsFrom(17));
    const aborting: BisectRunner = {
      run: async (step) => {
        const check = await inner.runner.run(step);
        if (inner.calls.length === 3) controller.abort();
        return check;
      },
    };
    await expect(bisectSearch(all, aborting, { signal: controller.signal })).rejects.toBeInstanceOf(
      BisectAborted,
    );
    expect(inner.calls).toHaveLength(3);

    const already = new AbortController();
    already.abort();
    const untouched = runner(failsFrom(17));
    await expect(bisectSearch(all, untouched.runner, { signal: already.signal })).rejects.toThrow(
      'bisect cancelled',
    );
    expect(untouched.calls).toEqual([]);
  });

  it('estimates the runs a search takes', () => {
    expect(estimateRuns(1)).toBe(4);
    expect(estimateRuns(2)).toBe(4);
    expect(estimateRuns(3)).toBe(5);
    expect(estimateRuns(9)).toBe(7);
    expect(estimateRuns(24)).toBe(9);
    expect(estimateRuns(1025)).toBe(14);
  });
});

async function serviceSetup() {
  const { root, clock, mindly } = setup();
  const ctx = await mindly.projects.resolve(root);
  const pid = ctx.project.id;
  const session = mindly.store.sessions.upsert({
    projectId: pid,
    agentKind: 'claude-code',
    externalId: 'cc-1',
    worktree: root,
    branch: 'main',
    transcriptPath: null,
  }).session;
  let seq = 0;
  const checkpoint = (extra: Partial<Checkpoint> = {}): Checkpoint => {
    seq += 1;
    return mindly.store.checkpoints.create({
      projectId: pid,
      worktree: root,
      seq,
      commit: `commit-${seq}`,
      parentCommit: seq > 1 ? `commit-${seq - 1}` : null,
      kind: 'agent',
      sessionId: session.id,
      fileChangeId: null,
      promptEventId: null,
      tool: 'Edit',
      paths: ['src/auth.ts'],
      gap: false,
      ...extra,
    });
  };
  return { root, clock, mindly, pid, session, checkpoint, svc: bisectOf(mindly) };
}

describe('BisectService', () => {
  it('describes an agent step with its session and prompt', async () => {
    const { mindly, pid, session, checkpoint, svc } = await serviceSetup();
    const prompt = mindly.store.events.append({
      projectId: pid,
      sessionId: session.id,
      type: 'prompt.submitted',
      payload: { prompt: 'add the admin role to login', summary: 'add the admin role', length: 27 },
    });
    const step = checkpoint({ promptEventId: prompt.id, fileChangeId: 'fc-1', gap: true });
    const info = svc.describe(step);
    expect(info).toEqual({
      seq: 1,
      kind: 'agent',
      gap: true,
      at: step.createdAt,
      commit: 'commit-1',
      parentCommit: null,
      worktree: step.worktree,
      sessionId: session.id,
      agentKind: 'claude-code',
      sessionLabel: sessionLabel(session),
      tool: 'Edit',
      paths: ['src/auth.ts'],
      prompt: 'add the admin role',
      promptState: 'kept',
      rules: [],
    });
    expect(info.sessionLabel).toMatch(/^claude-code #[0-9a-f]{8}$/);
  });

  it('tells a missing prompt from none, and an outside step from an agent one', async () => {
    const { mindly, pid, checkpoint, svc } = await serviceSetup();
    const gone = svc.describe(
      checkpoint({ promptEventId: '00000000-0000-7000-8000-000000000000' }),
    );
    expect(gone).toMatchObject({ prompt: null, promptState: 'gone' });
    const none = svc.describe(checkpoint({ promptEventId: null }));
    expect(none).toMatchObject({ prompt: null, promptState: 'none' });
    const other = mindly.store.events.append({
      projectId: pid,
      sessionId: null,
      type: 'session.started',
      payload: {},
    });
    expect(svc.describe(checkpoint({ promptEventId: other.id }))).toMatchObject({
      prompt: null,
      promptState: 'gone',
    });
    const outside = svc.describe(
      checkpoint({ kind: 'outside', sessionId: null, tool: null, paths: ['README.md'] }),
    );
    expect(outside).toMatchObject({
      kind: 'outside',
      sessionId: null,
      agentKind: null,
      sessionLabel: null,
      tool: null,
      paths: ['README.md'],
      promptState: 'none',
    });
  });

  it('lists the approved rules that covered the step when it was made', async () => {
    const { root, clock, mindly, pid, session, checkpoint, svc } = await serviceSetup();
    const remember = (title: string, scopePaths: string[]) =>
      mindly.memory.remember({
        projectId: pid,
        projectRoot: root,
        kind: 'rule',
        title,
        body: `${title}.`,
        scopePaths,
        source: USER,
      });
    const generated = remember('Never edit generated code', ['src/generated/**']);
    const docs = remember('Docs are written by hand', ['docs/**']);
    const told = remember('Generated clients are regenerated, not patched', ['src/generated/*.ts']);
    clock.advance(1000);
    const item = (ref: string): ContextItem => ({
      ref,
      kind: 'memory',
      title: 't',
      score: 1,
      tokens: 10,
      reason: 'rule',
    });
    mindly.store.contextPackets.record({
      projectId: pid,
      sessionId: session.id,
      trigger: 'prompt',
      query: null,
      included: [item(told.id), item('something-else')],
      omitted: [item(generated.id)],
      tokenBudget: 1000,
      tokensUsed: 10,
    });
    clock.advance(1000);
    const step = checkpoint({ paths: ['src/generated/api.ts'] });
    clock.advance(1000);
    const later = remember('Rule made after the step', ['src/generated/**']);
    expect(later.createdAt).toBeGreaterThan(step.createdAt);

    const rules = svc.describe(step).rules;
    expect(rules.map((r) => r.id).sort()).toEqual([generated.id, told.id].sort());
    expect(rules.find((r) => r.id === generated.id)).toEqual({
      id: generated.id,
      kind: 'rule',
      title: 'Never edit generated code',
      told: false,
    });
    expect(rules.find((r) => r.id === told.id)).toMatchObject({ told: true });
    expect(rules.map((r) => r.id)).not.toContain(docs.id);
    expect(rules.map((r) => r.id)).not.toContain(later.id);

    // A step without paths is under no rule; an outside step was told nothing.
    expect(svc.describe(checkpoint({ paths: [] })).rules).toEqual([]);
    const outside = svc.describe(
      checkpoint({ kind: 'outside', sessionId: null, paths: ['src/generated/api.ts'] }),
    );
    expect(outside.rules.map((r) => [r.id, r.told])).toEqual(
      expect.arrayContaining([
        [generated.id, false],
        [told.id, false],
      ]),
    );
  });

  it('records a bisect run with its events', async () => {
    const { clock, mindly, pid, svc } = await serviceSetup();
    const run = svc.startRun(pid, 'bisect pnpm test', { command: 'pnpm test', from: 1, to: 9 });
    expect(run).toMatchObject({
      projectId: pid,
      kind: 'bisect',
      title: 'bisect pnpm test',
      input: { command: 'pnpm test', from: 1, to: 9 },
    });
    expect(mindly.store.runs.get(run.id)).toMatchObject({ status: 'running', startedAt: clock.t });
    clock.advance(5000);
    const finished = svc.finishRun(run, 'passed', { status: 'found', firstBad: 7 });
    expect(finished).toMatchObject({
      id: run.id,
      kind: 'bisect',
      status: 'passed',
      result: { status: 'found', firstBad: 7 },
      finishedAt: clock.t,
    });
    expect(mindly.store.runs.list(pid, { kind: 'bisect' }).map((r) => r.id)).toEqual([run.id]);
    const events = mindly.store.events.query(pid, { types: ['run.started', 'run.finished'] });
    expect(events.map((e) => [e.type, e.sessionId, e.payload])).toEqual([
      ['run.started', null, { runId: run.id, kind: 'bisect', title: 'bisect pnpm test' }],
      ['run.finished', null, { runId: run.id, kind: 'bisect', status: 'passed' }],
    ]);
  });

  it('remembers a found step as a mistake scoped to its paths', async () => {
    const { root, mindly, pid, session, checkpoint, svc } = await serviceSetup();
    const prompt = mindly.store.events.append({
      projectId: pid,
      sessionId: session.id,
      type: 'prompt.submitted',
      payload: { prompt: 'make login faster', summary: 'make login faster', length: 17 },
    });
    const step = svc.describe(
      checkpoint({
        promptEventId: prompt.id,
        paths: ['src/auth.ts', 'src/session.ts', 'src/token.ts', 'src/user.ts'],
      }),
    );
    const memory = svc.recordMistake({
      projectId: pid,
      projectRoot: root,
      step,
      command: 'pnpm test -- --token=abcdef123456',
    });
    expect(memory).not.toBeNull();
    expect(memory).toMatchObject({
      projectId: pid,
      kind: 'mistake',
      status: 'active',
      trust: 'approved',
      source: USER,
      scope: {
        paths: ['src/auth.ts', 'src/session.ts', 'src/token.ts', 'src/user.ts'],
        branch: null,
      },
    });
    expect(memory!.title).toMatch(/^claude-code step 1 broke `pnpm test/);
    expect(memory!.title).not.toContain('abcdef123456');
    expect(memory!.body).toContain('Edit src/auth.ts src/session.ts src/token.ts and 1 more');
    expect(memory!.body).not.toContain('make login faster');
    expect(memory!.body).toContain('mindly bisect show 1');
    expect(memory!.body).toContain('mindly bisect revert 1');
    expect(memory!.body).not.toContain('abcdef123456');
    expect(memory!.tags).toEqual(expect.arrayContaining(['mistake', 'bisect']));
    expect(mindly.store.memories.list(pid, { kinds: ['mistake'] }).map((m) => m.id)).toEqual([
      memory!.id,
    ]);

    const outside = svc.describe(
      checkpoint({ kind: 'outside', sessionId: null, tool: null, paths: ['src/auth.ts'] }),
    );
    expect(
      svc.recordMistake({ projectId: pid, projectRoot: root, step: outside, command: 'pnpm test' }),
    ).toBeNull();
    expect(mindly.store.memories.list(pid, { kinds: ['mistake'] })).toHaveLength(1);
  });
});
