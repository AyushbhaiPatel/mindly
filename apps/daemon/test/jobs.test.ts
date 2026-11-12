import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, nullSink, type Project, type Session } from '@mindly/core';
import { commandHash, contractsOf, USER } from '@mindly/engine';
import {
  createShadowMergeRun,
  executeShadowMerge,
  failoverTick,
  housekeepingTick,
  runCommandContracts,
  Scheduler,
  shadowMergeTick,
  SURVIVAL_PER_TICK,
  trackSurvivalTick,
  type Daemon,
} from '../src/index.js';
import {
  git,
  linkedWorktree,
  repo,
  seedSession,
  tempDir,
  testDaemon,
  write,
  type TestDaemon,
} from './helpers.js';

const node = process.execPath;
let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.daemon.stop();
  t = null;
});

interface Setup {
  d: Daemon;
  root: string;
  wt: string;
  a: Session;
  b: Session;
  project: Project;
}

async function twoWorktrees(): Promise<Setup> {
  t = await testDaemon();
  const d = t.daemon;
  const root = repo();
  const wt = linkedWorktree(root, 'feature');
  const a = seedSession(d, root, { agentKind: 'claude-code' });
  const b = seedSession(d, root, { agentKind: 'codex', worktree: wt });
  return { d, root, wt, a, b, project: d.mindly.store.projects.get(a.projectId) };
}

function setChecks(root: string, checks: { name: string; argv: string[] }[]): void {
  write(root, '.mindly/config.json', JSON.stringify({ checks }));
}

async function merge(s: Setup) {
  const run = await executeShadowMerge(
    s.d.jobs,
    createShadowMergeRun(s.d.jobs, s.project.id, 'user'),
  );
  return run;
}

describe('shadow merge job', () => {
  it('merges two clean worktrees and records a passed run', async () => {
    const s = await twoWorktrees();
    write(s.root, 'a.txt', 'line 1 by A\nline 2\nline 3\n');
    write(s.wt, 'b.txt', 'b 1\nb 2 by B\n');
    const run = await merge(s);
    expect(run.status).toBe('passed');
    expect(run.result).toMatchObject({
      clean: true,
      conflictedPaths: [],
      checks: [],
      checksSkipped: 'none_configured',
      mergedTree: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect((run.result?.['sessionIds'] as string[]).sort()).toEqual([s.a.id, s.b.id].sort());
    expect(s.d.mindly.store.conflicts.list(s.project.id)).toEqual([]);
    const types = s.d.mindly.store.events.query(s.project.id).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['run.started', 'run.finished']));
    // Working trees are untouched.
    expect(git(s.root, 'status', '--porcelain')).toContain('a.txt');
    expect(git(s.wt, 'status', '--porcelain')).toContain('b.txt');
  });

  it('reports a merge conflict per path set and resolves it when it disappears', async () => {
    const s = await twoWorktrees();
    write(s.root, 'a.txt', 'line 1\nline 2 by A\nline 3\n');
    write(s.wt, 'a.txt', 'line 1\nline 2 by B\nline 3\n');
    setChecks(s.root, [{ name: 'fail', argv: [node, '-e', 'process.exit(1)'] }]);
    const run = await merge(s);
    expect(run.status).toBe('failed');
    expect(run.result).toMatchObject({
      clean: false,
      conflictedPaths: ['a.txt'],
      checksSkipped: 'conflicts',
    });
    const [c] = s.d.mindly.store.conflicts.list(s.project.id);
    expect(c).toMatchObject({ kind: 'merge_conflict', severity: 'critical', paths: ['a.txt'] });
    expect(c?.sessionIds.sort()).toEqual([s.a.id, s.b.id].sort());
    // Same conflict again: same row, not a second one.
    await merge(s);
    expect(s.d.mindly.store.conflicts.list(s.project.id)).toHaveLength(1);
    const opened = s.d.mindly.store.events.query(s.project.id, { types: ['conflict.opened'] });
    expect(opened).toHaveLength(1);
    // The event keeps who and what at this opening (the row is overwritten by later reports).
    expect((opened[0]!.payload['sessionIds'] as string[]).sort()).toEqual([s.a.id, s.b.id].sort());
    expect(opened[0]!.payload['paths']).toEqual(['a.txt']);
    // B gives up its change: the conflict is resolved.
    git(s.wt, 'checkout', '--', 'a.txt');
    const clean = await merge(s);
    expect(clean.result?.['clean']).toBe(true);
    expect(s.d.mindly.store.conflicts.get(c!.id).status).toBe('resolved');
  });

  it('never runs checks for an untrusted project config', async () => {
    const s = await twoWorktrees();
    write(s.wt, 'b.txt', 'b changed\n');
    const marker = join(tempDir('mindly-marker-'), 'ran');
    setChecks(s.root, [
      {
        name: 'marker',
        argv: [node, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`],
      },
    ]);
    const run = await merge(s);
    expect(run.status).toBe('passed');
    expect(run.result).toMatchObject({ clean: true, checks: [], checksSkipped: 'untrusted' });
    expect(existsSync(marker)).toBe(false);
  });

  it('runs trusted checks in a temp tree, reports check_failed and resolves it when fixed', async () => {
    const s = await twoWorktrees();
    write(s.root, 'a.txt', 'line 1 by A\nline 2\nline 3\n');
    write(s.wt, 'b.txt', 'b changed\n');
    setChecks(s.root, [
      { name: 'ok', argv: [node, '-e', 'process.exit(0)'] },
      { name: 'fail', argv: [node, '-e', 'console.log("b.txt is wrong"); process.exit(1)'] },
    ]);
    s.d.mindly.projects.trust(
      s.project.id,
      s.d.mindly.projects.byId(s.project.id).configHash ?? '',
    );
    const run = await merge(s);
    expect(run.status).toBe('failed');
    const result = run.result as {
      checks: { name: string; ok: boolean; exitCode: number; outputTail: string }[];
    };
    expect(result.checks.map((c) => [c.name, c.ok, c.exitCode])).toEqual([
      ['ok', true, 0],
      ['fail', false, 1],
    ]);
    expect(result.checks[1]?.outputTail).toContain('b.txt is wrong');
    const [c] = s.d.mindly.store.conflicts.list(s.project.id);
    expect(c).toMatchObject({ kind: 'check_failed', severity: 'critical' });
    // Output mentions b.txt, which only B changed.
    expect(c?.sessionIds).toEqual([s.b.id]);
    // No leftover temporary worktrees.
    expect(git(s.root, 'worktree', 'list').trim().split('\n')).toHaveLength(2);

    setChecks(s.root, [{ name: 'fail', argv: [node, '-e', 'process.exit(0)'] }]);
    s.d.mindly.projects.trust(
      s.project.id,
      s.d.mindly.projects.byId(s.project.id).configHash ?? '',
    );
    const fixed = await merge(s);
    expect(fixed.status).toBe('passed');
    expect(s.d.mindly.store.conflicts.get(c!.id).status).toBe('resolved');
  });

  it('the scheduled tick only merges projects with two live worktrees', async () => {
    const s = await twoWorktrees();
    const lone = seedSession(s.d, repo());
    await shadowMergeTick(s.d.jobs);
    await s.d.scheduler.idle();
    expect(s.d.mindly.store.runs.list(s.project.id, { kind: 'shadow_merge' })).toHaveLength(1);
    expect(s.d.mindly.store.runs.list(lone.projectId, { kind: 'shadow_merge' })).toHaveLength(0);
  });
});

describe('command contracts', () => {
  it('run only for a trusted project and an approved hash; pass to fail opens a conflict', async () => {
    t = await testDaemon();
    const d = t.daemon;
    const root = repo();
    const s = seedSession(d, root);
    const pid = s.projectId;
    const memory = d.mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'The build must pass',
      body: 'checked by a command',
      source: USER,
    });
    const okArgv = [node, '-e', 'process.exit(0)'];
    const contract = contractsOf(d.mindly).create(memory.id, 'command', { argv: okArgv }, USER);
    expect(contract.approvedHash).toBe(commandHash(okArgv));

    // Untrusted project: nothing runs.
    expect(await runCommandContracts(d.jobs, pid)).toBeNull();
    write(root, '.mindly/config.json', '{}');
    d.mindly.projects.trust(pid, d.mindly.projects.byId(pid).configHash ?? '');

    const first = await runCommandContracts(d.jobs, pid);
    expect(first?.status).toBe('passed');
    expect(d.mindly.store.contracts.get(contract.id).state).toBe('passing');

    // Spec changed without re-approval: the contract must not run.
    const failArgv = [node, '-e', 'process.exit(3)'];
    d.mindly.store.db
      .prepare('UPDATE contracts SET spec = ? WHERE id = ?')
      .run(JSON.stringify({ argv: failArgv }), contract.id);
    expect(await runCommandContracts(d.jobs, pid)).toBeNull();
    expect(d.mindly.store.contracts.get(contract.id).state).toBe('passing');

    // Re-approved: runs, fails, opens a critical contract_broken conflict.
    d.mindly.store.contracts.approve(contract.id, commandHash(failArgv));
    const second = await runCommandContracts(d.jobs, pid);
    expect(second?.status).toBe('failed');
    expect(d.mindly.store.contracts.get(contract.id).state).toBe('failing');
    const [c] = d.mindly.store.conflicts.list(pid);
    expect(c).toMatchObject({ kind: 'contract_broken', severity: 'critical' });
  });

  it('a timeout between a pass and a fail still opens the conflict, and tells live agents', async () => {
    t = await testDaemon();
    const d = t.daemon;
    const root = repo();
    const s = seedSession(d, root);
    const pid = s.projectId;
    const memory = d.mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'The build must pass',
      body: 'checked by a command',
      source: USER,
    });
    write(root, '.mindly/config.json', '{}');
    d.mindly.projects.trust(pid, d.mindly.projects.byId(pid).configHash ?? '');
    const contract = contractsOf(d.mindly).create(
      memory.id,
      'command',
      { argv: [node, '-e', 'process.exit(0)'] },
      USER,
    );
    const runWith = async (script: string) => {
      const spec = { argv: [node, '-e', script], timeoutSec: 1 };
      d.mindly.store.db
        .prepare('UPDATE contracts SET spec = ? WHERE id = ?')
        .run(JSON.stringify(spec), contract.id);
      d.mindly.store.contracts.approve(contract.id, commandHash(spec.argv));
      await runCommandContracts(d.jobs, pid);
      return d.mindly.store.contracts.get(contract.id).state;
    };
    const open = () =>
      d.mindly.store.conflicts
        .list(pid, { statuses: ['open', 'acknowledged'] })
        .filter((x) => x.kind === 'contract_broken');
    const hang = 'setTimeout(() => {}, 60000)';

    expect(await runWith('process.exit(0)')).toBe('passing');
    expect(await runWith(hang)).toBe('error');
    expect(open()).toHaveLength(0);
    expect(await runWith('process.exit(3)')).toBe('failing');
    expect(open()).toHaveLength(1);
    const told = d.mindly.store.deliveries
      .list(pid)
      .filter((x) => x.kind === 'conflict' && x.targetSessionId === s.id);
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toContain("Decision 'The build must pass' no longer holds");

    // Still failing: not reported again. A timeout and then a pass closes it.
    expect(await runWith('process.exit(3)')).toBe('failing');
    expect(d.mindly.store.deliveries.list(pid).filter((x) => x.kind === 'conflict')).toHaveLength(
      1,
    );
    expect(await runWith(hang)).toBe('error');
    expect(open()).toHaveLength(1);
    expect(await runWith('process.exit(0)')).toBe('passing');
    expect(open()).toHaveLength(0);
  });
});

describe('maintenance and failover', () => {
  it('housekeeping applies prompt retention and expires stale state', async () => {
    t = await testDaemon();
    const d = t.daemon;
    const s = seedSession(d, repo());
    const store = d.mindly.store;
    store.events.append({
      projectId: s.projectId,
      sessionId: s.id,
      type: 'prompt.submitted',
      payload: { prompt: 'old text', summary: 'old' },
    });
    store.db.prepare('UPDATE events SET created_at = ?').run(Date.now() - 40 * 86_400_000);
    store.db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 7 * 3_600_000);
    // A write in flight the session never finished: it goes when the session is ended.
    store.kv.set(`checkpoints:writing:${s.id}`, [{ at: Date.now() }]);
    const r = housekeepingTick(d.jobs);
    expect(r.promptsCompacted).toBe(1);
    expect(r.sessionsEnded).toBe(1);
    expect(store.kv.get(`checkpoints:writing:${s.id}`)).toBeNull();
    const [e] = store.events.query(s.projectId, { types: ['prompt.submitted'] });
    expect(e?.payload).toEqual({ summary: 'old' });
  });

  it('computes line survival for edits at least 7 days old, a bounded number per tick', async () => {
    t = await testDaemon();
    const d = t.daemon;
    const root = repo();
    const s = seedSession(d, root);
    const store = d.mindly.store;
    const record = (path: string) =>
      store.fileChanges.record({
        projectId: s.projectId,
        sessionId: s.id,
        path,
        tool: 'Edit',
        hunkHashes: d.mindly.kernel.ports.git.hunkHashes('line 1\nline 2\nline 3'),
        lineHashes: d.mindly.kernel.ports.git.hunkHashes('line 1\nline 2\nline 3'),
        addedLines: 3,
        removedLines: 0,
        promptEventId: null,
      });
    // The session worked on main, which is checked out.
    store.db.prepare("UPDATE sessions SET branch = 'main' WHERE id = ?").run(s.id);
    const old = record('a.txt');
    const fresh = record('b.txt');
    store.db
      .prepare('UPDATE file_changes SET created_at = ? WHERE id = ?')
      .run(Date.now() - 8 * 86_400_000, old.id);
    expect(SURVIVAL_PER_TICK).toBe(500);
    expect(await trackSurvivalTick(d.jobs)).toBe(1);
    const rows = store.db
      .prepare('SELECT change_id, total_hashes, kept_hashes FROM line_survival')
      .all();
    expect(rows).toEqual([{ change_id: old.id, total_hashes: 3, kept_hashes: 3 }]);
    expect(await trackSurvivalTick(d.jobs)).toBe(0);
    expect(store.track.countPendingSurvival(s.projectId, Date.now())).toBe(1);
    expect(fresh.id).not.toBe(old.id);
  });

  it('auto-launches a pending rate-limit handoff at most once, only when enabled', async () => {
    const home = tempDir('mindly-failover-home-');
    t = await testDaemon({ home });
    const root = repo();
    let s = seedSession(t.daemon, root);
    const handoff = () =>
      t!.daemon.mindly.store.handoffs.create({
        projectId: s.projectId,
        fromSessionId: s.id,
        toAgentKind: 'codex',
        taskId: null,
        reason: 'rate_limit',
        summary: 'limit',
        packet: {
          goal: 'g',
          plan: [],
          filesChanged: [],
          recentPrompts: [],
          decisions: [],
          blockers: [],
          nextSteps: [],
          branch: null,
          headCommit: null,
        },
      });
    handoff();
    await failoverTick(t.daemon.jobs);
    expect(t.runners.calls.filter((c) => c.kind === 'launch')).toHaveLength(0);
    await t.daemon.stop();

    writeFileSync(join(home, 'config.json'), JSON.stringify({ failover: { autoLaunch: true } }));
    t = await testDaemon({ home });
    s = t.daemon.mindly.store.sessions.get(s.id);
    const h = t.daemon.mindly.store.handoffs.list(s.projectId)[0]!;
    await failoverTick(t.daemon.jobs);
    await failoverTick(t.daemon.jobs);
    await t.daemon.scheduler.idle();
    const launches = t.runners.calls.filter((c) => c.kind === 'launch');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.input).toMatchObject({ agent: 'codex', cwd: root });
    expect(String((launches[0]?.input as { prompt: string }).prompt)).toContain(h.id);
  });

  it('launches the next agent in the worktree of the session that hit its limit', async () => {
    const home = tempDir('mindly-failover-wt-home-');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ failover: { autoLaunch: true } }));
    t = await testDaemon({ home });
    const root = repo();
    const wt = linkedWorktree(root, 'feature');
    const gone = linkedWorktree(root, 'gone');
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
    const handoffFrom = (worktree: string) => {
      const s = seedSession(t!.daemon, root, { agentKind: 'claude-code', worktree });
      return t!.daemon.mindly.store.handoffs.create({
        projectId: s.projectId,
        fromSessionId: s.id,
        toAgentKind: 'codex',
        taskId: null,
        reason: 'rate_limit',
        summary: 'limit',
        packet,
      });
    };
    const inWorktree = handoffFrom(wt);
    // A worktree that was removed meanwhile: the main checkout is the fallback.
    const inGone = handoffFrom(gone);
    git(root, 'worktree', 'remove', '--force', gone);
    await failoverTick(t.daemon.jobs);
    await t.daemon.scheduler.idle();
    const cwdOf = (handoffId: string): unknown =>
      (
        t!.runners.calls.find(
          (c) =>
            c.kind === 'launch' &&
            String((c.input as { prompt: string }).prompt).includes(handoffId),
        )?.input as { cwd?: string } | undefined
      )?.cwd;
    expect(cwdOf(inWorktree.id)).toBe(wt);
    expect(cwdOf(inGone.id)).toBe(root);
  });

  it('cancels runs a previous daemon left queued', async () => {
    const home = tempDir('mindly-stale-home-');
    t = await testDaemon({ home });
    const s = seedSession(t.daemon, repo());
    const run = createShadowMergeRun(t.daemon.jobs, s.projectId, 'user');
    await t.daemon.stop();
    t = await testDaemon({ home });
    expect(t.daemon.mindly.store.runs.get(run.id).status).toBe('cancelled');
  });
});

describe('scheduler', () => {
  it('never overlaps a key and isolates failures', async () => {
    const sched = new Scheduler(createLogger({ sink: nullSink }));
    const order: string[] = [];
    let release!: () => void;
    const p1 = sched.enqueue(
      'k',
      () => new Promise<void>((r) => (release = () => (order.push('a'), r()))),
    );
    expect(sched.runExclusive('k', () => void order.push('skipped'))).toBeNull();
    const p2 = sched.enqueue('k', () => {
      order.push('b');
      throw new Error('boom');
    });
    const p3 = sched.enqueue('k', () => void order.push('c'));
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(await sched.stop(100)).toBe(true);
  });
});
