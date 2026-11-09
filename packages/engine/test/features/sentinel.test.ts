import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultUserConfig,
  loadProjectConfig,
  type CheckpointKind,
  type UserConfig,
} from '@mindly/core';
import {
  bisectOf,
  installDefaultModules,
  Mindly,
  savesOf,
  sentinelOf,
  SentinelService,
  SENTINEL_FINGERPRINT_PREFIX,
  SKIP_RETRY_MS,
  tryProcessLock,
  trackOf,
  type CheckpointGitPort,
  type CommandRunResult,
  type CommandSpec,
  type SentinelPassOptions,
  type SentinelPassResult,
  type SentinelProgress,
  type StepGitPort,
  type StepWorkspace,
} from '../../src/index.js';
import { event, FakeClock, fakeGit } from '../helpers.js';

/*
 * The sentinel against fake git: steps are rows with fake commits, and a check "passes" or
 * "fails" at a commit as `verdict` says. Everything else (state, bisect, conflicts, deliveries,
 * saves, mistakes, runs) is the real engine.
 */

type Verdict = 'pass' | 'fail' | 'timeout';

interface FakeSteps extends StepGitPort {
  /** Commands run, as `name@commit`. */
  ran: string[];
  warmOpened: string[];
  warmRemoved: string[];
  /** When set, removing a warm tree leaves it in place (it could not be removed). */
  keepOnRemove: boolean;
  /** Paths each commit changed (for the setup reruns). */
  changes: Map<string, string[]>;
}

function fakeSteps(verdict: (check: string, commit: string, nth: number) => Verdict): FakeSteps {
  const where = new Map<string, { current: string }>();
  const asked = new Map<string, number>();
  const port: FakeSteps = {
    ran: [],
    warmOpened: [],
    warmRemoved: [],
    keepOnRemove: false,
    changes: new Map(),
    scratch: () => Promise.reject(new Error('not used')),
    warm: async (_repo, path, commit) => {
      port.warmOpened.push(path);
      const fresh = !existsSync(path);
      mkdirSync(path, { recursive: true });
      const state = { current: commit };
      where.set(path, state);
      const ws: StepWorkspace = {
        path,
        fresh,
        get current() {
          return state.current;
        },
        checkout: async (c) => {
          state.current = c;
        },
        dispose: async () => undefined,
      };
      return ws;
    },
    removeWarm: async (_repo, path) => {
      port.warmRemoved.push(path);
      if (!port.keepOnRemove) rmSync(path, { recursive: true, force: true });
    },
    changedPaths: async (_dir, from, to) => {
      const a = Number(from.replace('c', ''));
      const b = Number(to.replace('c', ''));
      const out: string[] = [];
      for (let i = Math.min(a, b) + 1; i <= Math.max(a, b); i++) {
        out.push(...(port.changes.get(`c${i}`) ?? []));
      }
      return out;
    },
    isManifestPath: (p) => p.endsWith('package.json'),
    run: async (dir, command: CommandSpec): Promise<CommandRunResult> => {
      const commit = where.get(dir)?.current ?? '?';
      port.ran.push(`${command.name}@${commit}`);
      const key = `${command.name}@${commit}`;
      const nth = (asked.get(key) ?? 0) + 1;
      asked.set(key, nth);
      const v = verdict(command.name, commit, nth);
      return {
        name: command.name,
        status: v,
        exitCode: v === 'pass' ? 0 : v === 'fail' ? 1 : null,
        durationMs: 5,
        output:
          v === 'fail'
            ? `\u001b[31mFAIL\u001b[0m ${command.name} at ${commit}\nexpected 4, got 5`
            : 'ok',
      };
    },
  };
  return port;
}

function fakeCheckpoints(): CheckpointGitPort {
  const no = (): never => {
    throw new Error('not used');
  };
  return {
    worktreeRoot: async (cwd) => cwd,
    worktreeId: () => 'w',
    refName: () => 'refs/mindly/steps/w/1',
    capture: no,
    listRefs: async () => [],
    deleteRefs: async () => 0,
    diskUsage: async () => null,
    tryLock: () => ({ release: () => undefined }),
  };
}

interface World {
  root: string;
  clock: FakeClock;
  mindly: Mindly;
  pid: string;
  steps: FakeSteps;
  cc: string;
  cx: string;
  /** Adds steps `from..to` (commits `c<n>`), made by `who(seq)`. */
  addSteps(from: number, to: number, who?: (seq: number) => 'cc' | 'cx' | 'outside'): void;
  pass(opts?: Partial<SentinelPassOptions>): Promise<SentinelPassResult>;
}

async function world(
  verdict: (check: string, commit: string, nth: number) => Verdict,
  opts: {
    config?: (c: UserConfig) => void;
    project?: Record<string, unknown>;
    trust?: boolean;
  } = {},
): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-sentinel-')));
  mkdirSync(join(root, '.mindly'));
  writeFileSync(
    join(root, '.mindly', 'config.json'),
    JSON.stringify(
      opts.project ?? {
        checks: [{ name: 'unit', argv: ['npm', 'test'], timeoutSec: 60 }],
      },
    ),
  );
  const config = defaultUserConfig();
  config.sentinel.enabled = true;
  opts.config?.(config);
  const steps = fakeSteps(verdict);
  const clock = new FakeClock();
  const mindly = Mindly.open({
    inMemory: true,
    clock,
    config,
    ports: { git: { ...fakeGit, checkpoints: fakeCheckpoints(), steps } },
  });
  installDefaultModules(mindly);
  await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
  await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
  const pid = mindly.store.projects.list()[0]!.id;
  if (opts.trust !== false) {
    const hash = loadProjectConfig(join(root, '.mindly', 'config.json')).hash as string;
    mindly.projects.trust(pid, hash);
  }
  const cc = mindly.store.sessions.findByExternal(pid, 'claude-code', 'cc')!.id;
  const cx = mindly.store.sessions.findByExternal(pid, 'codex', 'cx')!.id;
  const w: World = {
    root,
    clock,
    mindly,
    pid,
    steps,
    cc,
    cx,
    addSteps(from, to, who = (seq) => (seq % 2 === 0 ? 'cx' : 'cc')) {
      for (let seq = from; seq <= to; seq++) {
        const by = seq === 1 ? 'outside' : who(seq);
        const kind: CheckpointKind =
          seq === 1 ? 'baseline' : by === 'outside' ? 'outside' : 'agent';
        mindly.store.checkpoints.create({
          projectId: pid,
          worktree: root,
          seq,
          commit: `c${seq}`,
          parentCommit: seq === 1 ? null : `c${seq - 1}`,
          kind,
          sessionId: by === 'cc' ? cc : by === 'cx' ? cx : null,
          fileChangeId: null,
          promptEventId: null,
          tool: kind === 'agent' ? 'Edit' : null,
          paths: kind === 'agent' ? [`src/step-${seq}.ts`] : [],
          gap: false,
        });
        clock.advance(1000);
      }
    },
    pass: (o = {}) => sentinelOf(mindly).pass(pid, root, { trigger: 'user', force: true, ...o }),
  };
  return w;
}

/** Step number of a fake commit. */
const seqOf = (commit: string): number => Number(commit.replace('c', ''));
/** A check that passes before `broke` and fails from it. */
const breaksAt =
  (broke: number) =>
  (_check: string, commit: string): Verdict =>
    seqOf(commit) >= broke ? 'fail' : 'pass';

describe('sentinel readiness', () => {
  it('needs trusted checks, and names the checks and setup it runs', async () => {
    const w = await world(() => 'pass', { trust: false });
    const svc = sentinelOf(w.mindly);
    expect(svc.readiness(w.mindly.projects.byId(w.pid))).toMatchObject({
      ready: false,
      reason: 'untrusted',
    });
    w.addSteps(1, 2);
    expect(await w.pass()).toMatchObject({ status: 'not_ready', reason: 'untrusted' });
    expect(w.steps.ran).toEqual([]);

    const none = await world(() => 'pass', { project: {} });
    expect(sentinelOf(none.mindly).readiness(none.mindly.projects.byId(none.pid)).reason).toBe(
      'no_checks',
    );

    const subset = await world(() => 'pass', {
      project: {
        checks: [
          { name: 'unit', argv: ['npm', 'test'] },
          { name: 'e2e', argv: ['npm', 'run', 'e2e'] },
        ],
        sentinel: { checks: ['unit', 'lint'], setup: ['npm', 'ci'] },
      },
    });
    const r = sentinelOf(subset.mindly).readiness(subset.mindly.projects.byId(subset.pid));
    expect(r).toMatchObject({ ready: true, unknown: ['lint'] });
    expect(r.checks.map((c) => c.name)).toEqual(['unit']);
    expect(r.setup).toEqual({ name: 'setup', argv: ['npm', 'ci'], timeoutSec: 600 });

    const unknown = await world(() => 'pass', {
      project: { checks: [{ name: 'unit', argv: ['x'] }], sentinel: { checks: ['lint'] } },
    });
    expect(
      sentinelOf(unknown.mindly).readiness(unknown.mindly.projects.byId(unknown.pid)).reason,
    ).toBe('unknown_checks');

    const off = await world(() => 'pass', { config: (c) => (c.checkpoints.enabled = false) });
    expect(sentinelOf(off.mindly).readiness(off.mindly.projects.byId(off.pid)).reason).toBe(
      'checkpoints_off',
    );
  });
});

describe('sentinel pass', () => {
  it('finds the edit that broke a check, tells its agent and opens a conflict', async () => {
    const w = await world(breaksAt(7));
    w.addSteps(1, 3);
    const first = await w.pass();
    expect(first).toMatchObject({ status: 'checked', step: 3 });
    expect(first.checks[0]).toMatchObject({
      name: 'unit',
      outcome: 'pass',
      transition: 'baseline_pass',
    });

    w.addSteps(4, 10);
    const progress: SentinelProgress[] = [];
    const r = await w.pass({ onProgress: (p) => progress.push(p) });
    const unit = r.checks[0]!;
    expect(unit).toMatchObject({ outcome: 'fail', transition: 'broke', note: null });
    expect(unit.bisect).toMatchObject({ status: 'found' });
    expect(unit.bisect?.firstBad).toMatchObject({ seq: 7, agentKind: 'claude-code' });
    expect(unit.bisect?.lastGood?.seq).toBe(6);
    // Escape sequences are dropped from the output kept.
    expect(unit.output).toContain('FAIL unit at c7');
    expect(unit.output).not.toContain('\u001b');

    // The conflict names the session and the step.
    const conflict = w.mindly.store.conflicts.get(unit.conflictId!);
    expect(conflict).toMatchObject({ kind: 'check_failed', severity: 'critical', status: 'open' });
    expect(conflict.fingerprint.startsWith(SENTINEL_FINGERPRINT_PREFIX)).toBe(true);
    expect(conflict.sessionIds).toEqual([w.cc]);
    expect(conflict.paths).toEqual(['src/step-7.ts']);
    expect(conflict.title).toContain('Check "unit" broke at step 7');
    expect(conflict.detail).toContain('mindly bisect revert 7');

    // Only the agent that broke it is told, with the failing output.
    expect(unit.told).toEqual([w.cc]);
    const [d] = w.mindly.store.deliveries.list(w.pid, { limit: 10 });
    expect(d).toMatchObject({ targetSessionId: w.cc, kind: 'conflict', priority: 9 });
    expect(d?.title).toBe('Your edit broke check "unit"');
    expect(d?.body).toContain(
      'It passed at step 6 and fails from step 7, your Edit of src/step-7.ts',
    );
    expect(d?.body).toContain(
      'Failing output (last lines): "FAIL unit at c7 | expected 4, got 5".',
    );
    expect(d?.body).toContain('mindly bisect revert 7');

    // State, the bisect run (counted by mindly track), the mistake and the caught save.
    const watch = w.mindly.store.sentinel.get(w.pid, w.root)!;
    expect(watch.checkedSeq).toBe(10);
    expect(watch.checks['unit']).toMatchObject({
      state: 'failing',
      goodSeq: 3,
      failingSeq: 10,
      brokeAt: 7,
      culpritSessionId: w.cc,
      conflictId: conflict.id,
    });
    const bisect = w.mindly.store.runs.get(unit.bisect!.runId!);
    expect(bisect).toMatchObject({ kind: 'bisect', status: 'passed' });
    expect(bisect.input).toMatchObject({ trigger: 'sentinel', check: 'unit' });
    expect(bisect.result).toMatchObject({ status: 'found', firstBad: 7, lastGood: 6 });
    expect((bisect.result?.['blame'] as { sessionId: string }).sessionId).toBe(w.cc);
    const mistake = w.mindly.store.memories.get(bisect.result?.['mistakeId'] as string);
    expect(mistake).toMatchObject({ kind: 'mistake', scope: { paths: ['src/step-7.ts'] } });
    // Nobody looked at it: the sentinel's finding is only proposed, never the user's word.
    expect(mistake.trust).toBe('proposed');
    expect(mistake.source.type).toBe('system');
    const sentinelRun = w.mindly.store.runs.get(r.runId!);
    expect(sentinelRun).toMatchObject({ kind: 'sentinel', status: 'failed' });
    expect(sentinelRun.input).toMatchObject({ trigger: 'user', step: 10, checks: ['unit'] });
    const saves = w.mindly.store.saves.list(w.pid, { limit: 10 });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ kind: 'check_broken_early', status: 'caught' });
    expect(progress.some((p) => p.phase === 'bisect')).toBe(true);

    // Bisect only searched between the last good step and the newest.
    expect(w.steps.ran.filter((x) => x === 'unit@c1' || x === 'unit@c2')).toEqual([]);

    // Still failing at the next pass: nobody is told again.
    w.addSteps(11, 11);
    const again = await w.pass();
    expect(again.checks[0]).toMatchObject({ transition: 'still_failing', conflictId: conflict.id });
    expect(w.mindly.store.deliveries.list(w.pid, { limit: 10 })).toHaveLength(1);
  });

  it('closes the conflict and confirms the save when the check passes again', async () => {
    let fixedFrom = Infinity;
    const w = await world((_c, commit) =>
      seqOf(commit) >= 5 && seqOf(commit) < fixedFrom ? 'fail' : 'pass',
    );
    w.addSteps(1, 2);
    await w.pass();
    w.addSteps(3, 6);
    const broke = await w.pass();
    const conflictId = broke.checks[0]!.conflictId!;
    expect(broke.checks[0]?.bisect?.firstBad?.seq).toBe(5);
    fixedFrom = 7;
    w.addSteps(7, 7);
    const fixed = await w.pass();
    expect(fixed.checks[0]).toMatchObject({ transition: 'fixed', conflictId });
    expect(w.mindly.store.conflicts.get(conflictId).status).toBe('resolved');
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.checks['unit']).toMatchObject({
      state: 'passing',
      goodSeq: 7,
      brokeAt: null,
      conflictId: null,
    });
    const [save] = w.mindly.store.saves.list(w.pid, { limit: 10 });
    expect(save).toMatchObject({ kind: 'check_broken_early', status: 'confirmed' });
    expect(savesOf(w.mindly).summary(w.pid, 0).total).toBe(1);

    // Breaking again later opens a new conflict.
    fixedFrom = Infinity;
    w.addSteps(8, 9);
    const again = await w.pass();
    expect(again.checks[0]?.transition).toBe('broke');
    expect(again.checks[0]?.conflictId).not.toBe(conflictId);
  });

  it('tells the agents in the checkout when the session that broke it has ended', async () => {
    const w = await world(breaksAt(4));
    w.addSteps(1, 3);
    await w.pass();
    w.addSteps(4, 5, (seq) => (seq === 4 ? 'cx' : 'cc'));
    await w.mindly.hooks.handle(event(w.root, 'codex', 'cx', 'session_end'));
    const r = await w.pass();
    expect(r.checks[0]?.bisect?.firstBad?.agentKind).toBe('codex');
    expect(r.checks[0]?.told).toEqual([w.cc]);
    const [d] = w.mindly.store.deliveries.list(w.pid, { limit: 10 });
    expect(d?.title).toBe('Check "unit" broke in this checkout');
    expect(d?.body).toContain('Check whether your work depends on it');
    // The break is still pinned on Codex, but nobody is left to be helped: no save.
    expect(w.mindly.store.conflicts.get(r.checks[0]!.conflictId!).sessionIds).toEqual([w.cx]);
    expect(w.mindly.store.saves.list(w.pid, { limit: 10 })).toEqual([]);
  });

  it('drops the save when the session that broke the check ends with it still failing', async () => {
    const w = await world(breaksAt(4));
    w.addSteps(1, 3);
    await w.pass();
    w.addSteps(4, 4, () => 'cx');
    await w.pass();
    expect(w.mindly.store.saves.list(w.pid, { limit: 10 })[0]?.status).toBe('caught');
    await w.mindly.hooks.handle(event(w.root, 'codex', 'cx', 'session_end'));
    expect(w.mindly.store.saves.list(w.pid, { statuses: ['rejected'], limit: 10 })).toHaveLength(1);
  });

  it('blames nobody for a flaky failure', async () => {
    // Fails the first time it runs at step 6 only.
    const w = await world((_c, commit, nth) => (commit === 'c6' && nth === 1 ? 'fail' : 'pass'));
    w.addSteps(1, 2);
    await w.pass();
    w.addSteps(3, 6);
    const r = await w.pass();
    expect(r.checks[0]).toMatchObject({ outcome: 'fail', transition: 'flaky', conflictId: null });
    expect(r.checks[0]?.bisect?.status).toBe('bad_passes');
    expect(r.checks[0]?.note).toContain('flaky');
    expect(w.mindly.store.conflicts.list(w.pid)).toEqual([]);
    expect(w.mindly.store.deliveries.list(w.pid, { limit: 10 })).toEqual([]);
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.checks['unit']).toMatchObject({
      state: 'passing',
      goodSeq: 2,
    });
    expect(w.mindly.store.memories.list(w.pid, { kinds: ['mistake'] })).toEqual([]);
  });

  it('looks again later when the failing step cannot run a second time', async () => {
    // Fails at step 5, then times out when the bisect checks step 5 again.
    const w = await world((_c, commit, nth) =>
      commit === 'c5' ? (nth === 1 ? 'fail' : 'timeout') : 'pass',
    );
    w.addSteps(1, 2);
    await w.pass();
    w.addSteps(3, 5);
    const r = await w.pass();
    expect(r.checks[0]).toMatchObject({ outcome: 'fail', transition: 'skipped', conflictId: null });
    expect(r.checks[0]?.bisect?.status).toBe('bad_skipped');
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.checks['unit']).toMatchObject({
      state: 'passing',
      goodSeq: 2,
    });
    expect(w.mindly.store.conflicts.list(w.pid)).toEqual([]);
  });

  it('blames nobody when the last good step fails too, or the break is outside any agent', async () => {
    let everything = false;
    const w = await world((_c, commit) => (everything || seqOf(commit) >= 5 ? 'fail' : 'pass'));
    w.addSteps(1, 3);
    await w.pass();
    everything = true;
    w.addSteps(4, 6);
    const r = await w.pass();
    expect(r.checks[0]).toMatchObject({ transition: 'broke' });
    expect(r.checks[0]?.bisect?.status).toBe('good_fails');
    expect(r.checks[0]?.note).toContain('outside the checkpoints changed');
    const c = w.mindly.store.conflicts.get(r.checks[0]!.conflictId!);
    expect(c.sessionIds).toEqual([]);
    expect(c.title).toBe('Check "unit" fails from step 6');
    expect(
      w.mindly.store.deliveries
        .list(w.pid, { limit: 10 })
        .map((d) => d.targetSessionId)
        .sort(),
    ).toEqual([w.cc, w.cx].sort());

    const o = await world(breaksAt(5));
    o.addSteps(1, 4);
    await o.pass();
    o.addSteps(5, 6, (seq) => (seq === 5 ? 'outside' : 'cc'));
    const out = await o.pass();
    expect(out.checks[0]?.bisect?.firstBad?.kind).toBe('outside');
    expect(out.checks[0]?.note).toContain('outside any agent');
    expect(o.mindly.store.conflicts.get(out.checks[0]!.conflictId!).sessionIds).toEqual([]);
    expect(o.mindly.store.memories.list(o.pid, { kinds: ['mistake'] })).toEqual([]);
  });

  it('reports a break without searching once the daily bisect limit is reached', async () => {
    const w = await world(breaksAt(4), { config: (c) => (c.sentinel.maxBisectsPerDay = 0) });
    w.addSteps(1, 3);
    await w.pass();
    w.addSteps(4, 5);
    const r = await w.pass();
    expect(r.checks[0]).toMatchObject({ transition: 'broke' });
    expect(r.checks[0]?.bisect).toMatchObject({ status: 'over_budget', runId: null });
    expect(r.checks[0]?.note).toContain('daily bisect limit');
    expect(w.mindly.store.runs.list(w.pid, { kind: 'bisect' })).toEqual([]);
    expect(w.mindly.store.conflicts.get(r.checks[0]!.conflictId!).status).toBe('open');
    // Nobody is blamed, but the agents in the checkout are told.
    expect([...r.checks[0]!.told].sort()).toEqual([w.cc, w.cx].sort());
  });

  it('blames nobody when a check passed and fails at the very same step', async () => {
    const w = await world((_check, _commit, nth) => (nth === 1 ? 'pass' : 'fail'));
    w.addSteps(1, 3);
    expect((await w.pass()).checks[0]?.transition).toBe('baseline_pass');
    const r = await w.pass();
    expect(r.checks[0]).toMatchObject({ outcome: 'fail', transition: 'flaky', conflictId: null });
    expect(r.checks[0]?.note).toContain('same step');
    expect(w.mindly.store.conflicts.list(w.pid)).toEqual([]);
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.checks['unit']?.state).toBe('passing');
  });

  it('does not search from a step that was never seen passing (the good one was pruned)', async () => {
    const w = await world(breaksAt(5));
    w.addSteps(1, 3);
    await w.pass();
    w.addSteps(4, 8);
    const good = w.mindly.store.checkpoints.bySeq(w.pid, w.root, 3)!;
    w.mindly.store.checkpoints.delete([good.id]);
    const r = await w.pass();
    expect(r.checks[0]).toMatchObject({ transition: 'broke', bisect: null });
    expect(r.checks[0]?.note).toContain('no longer kept');
    expect(w.mindly.store.runs.list(w.pid, { kind: 'bisect' })).toEqual([]);
  });

  it('tells an agent working from a subfolder of the checkout', async () => {
    const w = await world(breaksAt(4));
    const sub = join(w.root, 'src');
    mkdirSync(sub);
    // Fake git sees every folder as its own repository, so the session is recorded directly,
    // as the hooks record one whose agent started in a subfolder.
    const cu = w.mindly.store.sessions.upsert({
      projectId: w.pid,
      agentKind: 'cursor',
      externalId: 'cu',
      worktree: sub,
      branch: null,
      transcriptPath: null,
    }).session.id;
    w.addSteps(1, 3);
    await w.pass();
    w.addSteps(4, 5, (seq) => (seq === 4 ? 'cx' : 'cc'));
    await w.mindly.hooks.handle(event(w.root, 'codex', 'cx', 'session_end'));
    const r = await w.pass();
    expect([...r.checks[0]!.told].sort()).toEqual([w.cc, cu].sort());
  });

  it('records a check already failing as a baseline, without blame', async () => {
    const w = await world(() => 'fail');
    w.addSteps(1, 4);
    const r = await w.pass();
    expect(r.checks[0]).toMatchObject({ transition: 'baseline_fail', conflictId: null });
    expect(w.mindly.store.conflicts.list(w.pid)).toEqual([]);
    expect(w.mindly.store.runs.list(w.pid, { kind: 'bisect' })).toEqual([]);
  });

  it('starts over for a check whose command changed', async () => {
    const w = await world(breaksAt(3));
    w.addSteps(1, 2);
    await w.pass();
    writeFileSync(
      join(w.root, '.mindly', 'config.json'),
      JSON.stringify({ checks: [{ name: 'unit', argv: ['npm', 'run', 'test:unit'] }] }),
    );
    const hash = loadProjectConfig(join(w.root, '.mindly', 'config.json')).hash as string;
    w.mindly.projects.trust(w.pid, hash);
    w.addSteps(3, 4);
    const r = await w.pass();
    expect(r.checks[0]?.transition).toBe('baseline_fail');
  });

  it('closes the conflict of a break when the check passes under an edited command', async () => {
    let fixedFrom = Infinity;
    const w = await world((_c, commit) =>
      seqOf(commit) >= 3 && seqOf(commit) < fixedFrom ? 'fail' : 'pass',
    );
    const retrust = (argv: string[]): void => {
      writeFileSync(
        join(w.root, '.mindly', 'config.json'),
        JSON.stringify({ checks: [{ name: 'unit', argv }] }),
      );
      const hash = loadProjectConfig(join(w.root, '.mindly', 'config.json')).hash as string;
      w.mindly.projects.trust(w.pid, hash);
    };
    w.addSteps(1, 2);
    await w.pass();
    w.addSteps(3, 4);
    const broke = await w.pass();
    const conflictId = broke.checks[0]!.conflictId!;
    expect(w.mindly.store.conflicts.get(conflictId).status).toBe('open');

    // The command is edited while the check still fails: the conflict stays, and stays known.
    retrust(['npm', 'test', '--', '--bail']);
    w.addSteps(5, 5);
    const still = await w.pass();
    expect(still.checks[0]).toMatchObject({ transition: 'baseline_fail', conflictId });
    expect(w.mindly.store.conflicts.get(conflictId).status).toBe('open');
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.checks['unit']?.conflictId).toBe(conflictId);

    // Edited again, and this time the agent fixed the code: it passes, the conflict is closed.
    retrust(['npm', 'run', 'test:unit']);
    fixedFrom = 6;
    w.addSteps(6, 6);
    const fixed = await w.pass();
    expect(fixed.checks[0]).toMatchObject({ transition: 'baseline_pass', conflictId });
    expect(w.mindly.store.conflicts.get(conflictId).status).toBe('resolved');
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.checks['unit']).toMatchObject({
      state: 'passing',
      conflictId: null,
    });
    const [save] = w.mindly.store.saves.list(w.pid, { limit: 10 });
    expect(save).toMatchObject({ kind: 'check_broken_early', status: 'confirmed' });
  });

  it('keeps the conflict of an edited command known while the new command cannot run', async () => {
    let mode: Verdict | null = null;
    const w = await world((_c, commit) => mode ?? breaksAt(3)(_c, commit));
    w.addSteps(1, 2);
    await w.pass();
    w.addSteps(3, 4);
    const conflictId = (await w.pass()).checks[0]!.conflictId!;
    writeFileSync(
      join(w.root, '.mindly', 'config.json'),
      JSON.stringify({ checks: [{ name: 'unit', argv: ['npm', 'run', 'test:unit'] }] }),
    );
    w.mindly.projects.trust(
      w.pid,
      loadProjectConfig(join(w.root, '.mindly', 'config.json')).hash as string,
    );
    mode = 'timeout';
    w.addSteps(5, 5);
    expect((await w.pass()).checks[0]).toMatchObject({ outcome: 'skip' });
    expect(w.mindly.store.conflicts.get(conflictId).status).toBe('open');
    mode = 'pass';
    expect((await w.pass()).checks[0]).toMatchObject({ transition: 'baseline_pass', conflictId });
    expect(w.mindly.store.conflicts.get(conflictId).status).toBe('resolved');
  });

  it('closes the conflict of a check the sentinel no longer runs', async () => {
    const w = await world(
      (check, commit) => (check === 'unit' ? breaksAt(3)(check, commit) : 'pass'),
      {
        project: {
          checks: [
            { name: 'unit', argv: ['npm', 'test'] },
            { name: 'lint', argv: ['npm', 'run', 'lint'] },
          ],
        },
      },
    );
    w.addSteps(1, 2);
    await w.pass();
    w.addSteps(3, 4);
    const broke = await w.pass();
    const conflictId = broke.checks.find((c) => c.name === 'unit')!.conflictId!;
    expect(w.mindly.store.conflicts.get(conflictId).status).toBe('open');
    writeFileSync(
      join(w.root, '.mindly', 'config.json'),
      JSON.stringify({
        checks: [
          { name: 'unit', argv: ['npm', 'test'] },
          { name: 'lint', argv: ['npm', 'run', 'lint'] },
        ],
        sentinel: { checks: ['lint'] },
      }),
    );
    w.mindly.projects.trust(
      w.pid,
      loadProjectConfig(join(w.root, '.mindly', 'config.json')).hash as string,
    );
    w.addSteps(5, 5);
    const r = await w.pass();
    expect(r.checks.map((c) => c.name)).toEqual(['lint']);
    // Nothing would ever see it pass again: closed, but the check was not fixed, so the save
    // of the break is not confirmed.
    expect(w.mindly.store.conflicts.get(conflictId).status).toBe('resolved');
    expect(Object.keys(w.mindly.store.sentinel.get(w.pid, w.root)?.checks ?? {})).toEqual(['lint']);
    expect(w.mindly.store.saves.list(w.pid, { limit: 10 })[0]?.status).not.toBe('confirmed');
  });

  it('treats a check named like an inherited object member as any other check', async () => {
    const w = await world(() => 'fail', {
      project: {
        checks: [
          { name: 'constructor', argv: ['npm', 'test'] },
          { name: 'toString', argv: ['npm', 'run', 'lint'] },
          { name: '__proto__', argv: ['npm', 'run', 'types'] },
        ],
      },
    });
    w.addSteps(1, 2);
    const r = await w.pass();
    // Failing from the first look: a baseline, not a break of something seen passing.
    expect(r.checks.map((c) => [c.name, c.transition])).toEqual([
      ['constructor', 'baseline_fail'],
      ['toString', 'baseline_fail'],
      ['__proto__', 'baseline_fail'],
    ]);
    expect(w.mindly.store.conflicts.list(w.pid)).toEqual([]);
    expect(Object.keys(w.mindly.store.sentinel.get(w.pid, w.root)?.checks ?? {})).toEqual([
      'constructor',
      'toString',
      '__proto__',
    ]);
    w.addSteps(3, 3);
    expect((await w.pass()).checks.map((c) => c.transition)).toEqual([
      'still_failing',
      'still_failing',
      'still_failing',
    ]);
  });

  it('runs the setup command once, again on a manifest change, and skips when it fails', async () => {
    let setupFails = false;
    const w = await world(
      (check, commit) =>
        check === 'setup' ? (setupFails ? 'fail' : 'pass') : breaksAt(99)(check, commit),
      {
        project: {
          checks: [
            { name: 'unit', argv: ['npm', 'test'] },
            { name: 'lint', argv: ['npm', 'run', 'lint'] },
          ],
          sentinel: { setup: ['npm', 'ci'] },
        },
      },
    );
    w.addSteps(1, 3);
    await w.pass();
    w.addSteps(4, 5);
    await w.pass();
    expect(w.steps.ran.filter((x) => x.startsWith('setup@'))).toEqual(['setup@c3']);
    w.steps.changes.set('c7', ['package.json']);
    w.addSteps(6, 8);
    await w.pass();
    expect(w.steps.ran.filter((x) => x.startsWith('setup@'))).toEqual(['setup@c3', 'setup@c8']);
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.setupCommit).toBe('c8');
    // The scratch tree was made again (deleted, broken): nothing is installed in it any more.
    rmSync(sentinelOf(w.mindly).warmPath(w.pid, w.root), { recursive: true, force: true });
    w.addSteps(9, 9);
    await w.pass();
    expect(w.steps.ran.filter((x) => x.startsWith('setup@'))).toEqual([
      'setup@c3',
      'setup@c8',
      'setup@c9',
    ]);

    setupFails = true;
    w.steps.changes.set('c10', ['package.json']);
    w.addSteps(10, 10);
    const r = await w.pass();
    expect(r).toMatchObject({ status: 'checked', setupFailed: true });
    expect(r.checks.map((c) => [c.name, c.outcome, c.transition, c.note])).toEqual([
      ['unit', 'skip', 'skipped', 'the setup command failed'],
      ['lint', 'skip', 'skipped', 'the setup command failed'],
    ]);
    // Without dependencies the checks would fail for the wrong reason: neither ran.
    expect(w.steps.ran.filter((x) => x.endsWith('@c10'))).toEqual(['setup@c10']);
    expect(w.mindly.store.conflicts.list(w.pid)).toEqual([]);
    expect(w.mindly.store.runs.get(r.runId!).status).toBe('error');
    // Nothing ran, so the step is checked again next time.
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.checkedSeq).toBe(9);
  });

  it('records the checkout before making its scratch tree, so a cancelled first pass is cleaned up', async () => {
    const w = await world(() => 'pass');
    w.addSteps(1, 2);
    const ac = new AbortController();
    ac.abort();
    expect((await w.pass({ signal: ac.signal })).status).toBe('cancelled');
    expect(w.mindly.store.sentinel.get(w.pid, w.root)).toMatchObject({ checkedSeq: null });
    expect(await sentinelOf(w.mindly).forget(w.pid)).toMatchObject({ reset: 1 });
    expect(w.steps.warmRemoved).toEqual([sentinelOf(w.mindly).warmPath(w.pid, w.root)]);
  });

  it('keeps what a check settled when the pass is cancelled before the next one', async () => {
    const ac = new AbortController();
    const w = await world(
      (check, commit, nth) => {
        // Both checks break; the pass is cancelled during the second one's bisect, after the
        // first one (broken at step 4) settled.
        if (check === 'lint' && nth >= 2 && w0.armed) ac.abort();
        if (check === 'unit') return seqOf(commit) >= 4 ? 'fail' : 'pass';
        return seqOf(commit) >= 5 ? 'fail' : 'pass';
      },
      {
        project: {
          checks: [
            { name: 'unit', argv: ['npm', 'test'] },
            { name: 'lint', argv: ['npm', 'run', 'lint'] },
          ],
        },
      },
    );
    const w0 = { armed: false };
    w.addSteps(1, 3);
    await w.pass();
    w.addSteps(4, 6);
    w0.armed = true;
    const cancelled = await w.pass({ signal: ac.signal });
    expect(cancelled.status).toBe('cancelled');
    w0.armed = false;
    const unitBisects = (): number =>
      w.mindly.store.runs
        .list(w.pid, { kind: 'bisect' })
        .filter((r) => (r.input as { check?: string }).check === 'unit').length;
    expect(unitBisects()).toBe(1);
    const mistakes = w.mindly.store.memories.list(w.pid, { kinds: ['mistake'] }).length;
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.checks['unit']?.state).toBe('failing');
    const again = await w.pass();
    expect(again.checks.find((c) => c.name === 'unit')?.transition).toBe('still_failing');
    // The settled check is not searched again (the cancelled one is).
    expect(unitBisects()).toBe(1);
    expect(again.checks.find((c) => c.name === 'lint')?.transition).toBe('broke');
    // One new mistake: lint's. Unit's is not recorded twice.
    expect(w.mindly.store.memories.list(w.pid, { kinds: ['mistake'] })).toHaveLength(mistakes + 1);
  });

  it('releases the checkout when a pass fails before it starts checking', async () => {
    const w = await world(() => 'pass');
    const svc = sentinelOf(w.mindly);
    w.addSteps(1, 2);
    const create = w.mindly.store.runs.create.bind(w.mindly.store.runs);
    let fail = true;
    w.mindly.store.runs.create = (input) => {
      if (fail) throw new Error('database is locked');
      return create(input);
    };
    // The run could not be recorded: an error, not an exception, and the lock is not left behind.
    const r = await w.pass();
    expect(r).toMatchObject({ status: 'error', runId: null, reason: 'Error: database is locked' });
    expect(svc.busy(w.pid)).toBe(false);
    fail = false;
    expect((await w.pass()).status).toBe('checked');
    expect(await svc.reset(w.pid, w.root)).toBe('reset');
  });

  it('never throws, whatever fails', async () => {
    const w = await world(() => 'pass');
    w.addSteps(1, 2);
    w.mindly.store.sentinel.get = () => {
      throw new Error('disk I/O error');
    };
    expect(await w.pass()).toMatchObject({ status: 'error', reason: 'Error: disk I/O error' });
  });

  it('makes a scratch tree again when it can no longer be checked out', async () => {
    const w = await world(() => 'pass', {
      project: {
        checks: [{ name: 'unit', argv: ['npm', 'test'] }],
        sentinel: { setup: ['npm', 'ci'] },
      },
    });
    const svc = sentinelOf(w.mindly);
    w.addSteps(1, 2);
    await w.pass();
    const path = svc.warmPath(w.pid, w.root);
    // A lock file a killed git left in the tree: every checkout of it fails from now on.
    const warm = w.steps.warm;
    writeFileSync(join(path, 'index.lock'), '');
    w.steps.warm = async (repo, at, commit) => {
      if (existsSync(join(at, 'index.lock'))) throw new Error('git checkout failed');
      return warm(repo, at, commit);
    };
    w.addSteps(3, 3);
    const r = await w.pass();
    expect(r.status).toBe('checked');
    expect(w.steps.warmRemoved).toEqual([path]);
    // The new tree has nothing installed: the setup command ran again.
    expect(w.steps.ran.filter((x) => x.startsWith('setup@'))).toEqual(['setup@c2', 'setup@c3']);
  });

  it("refuses to run when Mindly's home is inside the repository", async () => {
    const w = await world(() => 'pass');
    const svc = new SentinelService(
      w.mindly.kernel,
      w.mindly.projects,
      bisectOf(w.mindly),
      w.mindly.telepathy,
      null,
      join(w.root, '.mindly-dev', 'sentinel'),
    );
    w.addSteps(1, 2);
    expect(svc.readiness(w.mindly.projects.byId(w.pid)).reason).toBe('scratch_inside_repo');
    expect((await svc.pass(w.pid, w.root, { trigger: 'user', force: true })).status).toBe(
      'not_ready',
    );
    expect(w.steps.ran).toEqual([]);
  });

  it('does not run twice at once, however long a pass takes, and stops when cancelled', async () => {
    const w = await world(() => 'pass');
    w.addSteps(1, 2);
    const svc = sentinelOf(w.mindly);
    // Another process (here: this one) holds the checkout, and has for an hour.
    const file = join(dirname(svc.warmPath(w.pid, w.root)), 'lock');
    mkdirSync(dirname(file), { recursive: true });
    const held = tryProcessLock(file)!;
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, hourAgo, hourAgo);
    expect((await w.pass()).status).toBe('busy');
    expect(await svc.reset(w.pid, w.root)).toBe('busy');
    expect(svc.busy(w.pid)).toBe(false); // no watch yet: nothing of this project is listed
    held.release();
    expect(existsSync(file)).toBe(false);
    const ac = new AbortController();
    ac.abort();
    const r = await w.pass({ signal: ac.signal });
    expect(r.status).toBe('cancelled');
    expect(w.mindly.store.runs.get(r.runId!).status).toBe('cancelled');
  });
});

describe('sentinel schedule', () => {
  it('backs off a step where nothing could run instead of retrying it every tick', async () => {
    let timeout = true;
    const w = await world((c) => (c === 'unit' && timeout ? 'timeout' : 'pass'), {
      config: (c) => (c.sentinel.quietSec = 10),
    });
    const svc = sentinelOf(w.mindly);
    w.addSteps(1, 3);
    w.clock.advance(60_000);
    const tick = async (): Promise<number> => {
      w.clock.advance(15_000);
      if (svc.dueWorktrees(w.pid).length === 0) return 0;
      await svc.pass(w.pid, w.root, { trigger: 'schedule' });
      return 1;
    };
    let passes = 0;
    for (let i = 0; i < 20; i++) passes += await tick(); // 5 minutes of ticks
    expect(passes).toBe(1);
    expect(w.mindly.store.sentinel.get(w.pid, w.root)).toMatchObject({
      checkedSeq: null,
      skips: 1,
      skippedSeq: 3,
    });
    expect(svc.status(w.pid).watches[0]?.retryAt).toBe(
      w.mindly.store.sentinel.get(w.pid, w.root)?.retryAt,
    );

    // After the back-off it is tried again, and the next one waits twice as long.
    w.clock.advance(SKIP_RETRY_MS);
    expect(await tick()).toBe(1);
    const second = w.mindly.store.sentinel.get(w.pid, w.root)!;
    expect(second.skips).toBe(2);
    expect(second.retryAt).toBe(w.clock.now() + 2 * SKIP_RETRY_MS);
    expect(SentinelService.retryDelayMs(10)).toBe(6 * 60 * 60_000);

    // A new step is tried at once; once something runs, the back-off is cleared.
    timeout = false;
    w.addSteps(4, 4);
    w.clock.advance(60_000);
    expect(await tick()).toBe(1);
    expect(w.mindly.store.sentinel.get(w.pid, w.root)).toMatchObject({
      checkedSeq: 4,
      skips: 0,
      skippedSeq: null,
      retryAt: null,
    });
  });

  it('backs off a pass that fails instead of failing again every tick', async () => {
    const w = await world(() => 'pass', { config: (c) => (c.sentinel.quietSec = 10) });
    const svc = sentinelOf(w.mindly);
    let broken = true;
    const warm = w.steps.warm;
    w.steps.warm = async (repo, at, commit) => {
      if (broken) throw new Error('git checkout failed');
      return warm(repo, at, commit);
    };
    w.addSteps(1, 3);
    w.clock.advance(60_000);
    const tick = async (): Promise<string | null> => {
      w.clock.advance(15_000);
      if (svc.dueWorktrees(w.pid).length === 0) return null;
      return (await svc.pass(w.pid, w.root, { trigger: 'schedule' })).status;
    };
    const statuses: (string | null)[] = [];
    for (let i = 0; i < 20; i++) statuses.push(await tick()); // 5 minutes of ticks
    expect(statuses.filter((x) => x !== null)).toEqual(['error']);
    expect(w.mindly.store.runs.list(w.pid, { kind: 'sentinel' })).toHaveLength(1);
    expect(w.mindly.store.sentinel.get(w.pid, w.root)).toMatchObject({
      checkedSeq: null,
      skips: 1,
      skippedSeq: 3,
    });

    // Tried again after the back-off, which doubles while it keeps failing.
    w.clock.advance(SKIP_RETRY_MS);
    expect(await tick()).toBe('error');
    const second = w.mindly.store.sentinel.get(w.pid, w.root)!;
    expect(second.skips).toBe(2);
    expect(second.retryAt).toBe(w.clock.now() + 2 * SKIP_RETRY_MS);

    // `mindly sentinel run` does not wait for it, and a pass that works clears it.
    broken = false;
    expect((await w.pass()).status).toBe('checked');
    expect(w.mindly.store.sentinel.get(w.pid, w.root)).toMatchObject({
      checkedSeq: 3,
      skips: 0,
      skippedSeq: null,
      retryAt: null,
    });
  });

  it('counts the back-off from the end of the pass, not from its start', async () => {
    const clock: { advance?: (ms: number) => void } = {};
    // Every check runs into its five-minute limit.
    const w = await world(
      () => {
        clock.advance?.(5 * 60_000);
        return 'timeout';
      },
      {
        config: (c) => (c.sentinel.quietSec = 10),
        project: {
          checks: [
            { name: 'unit', argv: ['npm', 'test'], timeoutSec: 300 },
            { name: 'lint', argv: ['npm', 'run', 'lint'], timeoutSec: 300 },
            { name: 'types', argv: ['npm', 'run', 'types'], timeoutSec: 300 },
          ],
        },
      },
    );
    clock.advance = (ms) => w.clock.advance(ms);
    const svc = sentinelOf(w.mindly);
    w.addSteps(1, 3);
    w.clock.advance(60_000);
    const started = w.clock.now();
    await svc.pass(w.pid, w.root, { trigger: 'schedule' });
    // The pass took as long as the whole first back-off.
    expect(w.clock.now() - started).toBe(SKIP_RETRY_MS);
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.retryAt).toBe(w.clock.now() + SKIP_RETRY_MS);
    w.clock.advance(15_000);
    expect(svc.dueWorktrees(w.pid)).toEqual([]);
  });

  it('never checks a checkout that was removed, and does not watch it again', async () => {
    const w = await world(() => 'pass', { config: (c) => (c.sentinel.quietSec = 10) });
    const svc = sentinelOf(w.mindly);
    const part = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-part-')));
    const step = (seq: number): void => {
      w.mindly.store.checkpoints.create({
        projectId: w.pid,
        worktree: part,
        seq,
        commit: `c${seq}`,
        parentCommit: seq === 1 ? null : `c${seq - 1}`,
        kind: seq === 1 ? 'baseline' : 'outside',
        sessionId: null,
        fileChangeId: null,
        promptEventId: null,
        tool: null,
        paths: [],
        gap: false,
      });
    };
    step(1);
    await svc.pass(w.pid, part, { trigger: 'user', force: true });
    step(2);
    w.clock.advance(60_000);
    expect(svc.dueWorktrees(w.pid)).toEqual([part]);
    // The split part is merged and its worktree removed, with a step still unchecked.
    rmSync(part, { recursive: true, force: true });
    expect(svc.dueWorktrees(w.pid)).toEqual([]);
    const runs = w.mindly.store.runs.list(w.pid, { kind: 'sentinel' }).length;
    expect(await svc.pass(w.pid, part, { trigger: 'schedule' })).toMatchObject({
      status: 'not_ready',
      reason: 'checkout_gone',
    });
    expect(w.mindly.store.runs.list(w.pid, { kind: 'sentinel' })).toHaveLength(runs);
    // Once cleanup forgot it, nothing brings its watch back.
    expect(await svc.pruneWarm()).toBe(1);
    await svc.pass(w.pid, part, { trigger: 'user', force: true });
    expect(w.mindly.store.sentinel.get(w.pid, part)).toBeNull();
  });

  it('looks at a new checkout once enough steps piled up, even without a pause', async () => {
    const w = await world(() => 'pass', { config: (c) => (c.sentinel.everySteps = 3) });
    const svc = sentinelOf(w.mindly);
    w.addSteps(1, 2);
    expect(svc.dueWorktrees(w.pid)).toEqual([]);
    w.addSteps(3, 3);
    expect(svc.dueWorktrees(w.pid)).toEqual([w.root]);
  });

  it('is due after enough steps, or once the agents paused', async () => {
    const w = await world(() => 'pass', {
      config: (c) => {
        c.sentinel.everySteps = 3;
        c.sentinel.quietSec = 60;
      },
    });
    const svc = sentinelOf(w.mindly);
    expect(svc.dueWorktrees(w.pid)).toEqual([]);
    w.addSteps(1, 2);
    // A first look waits for a pause.
    expect(svc.dueWorktrees(w.pid)).toEqual([]);
    w.clock.advance(60_000);
    expect(svc.dueWorktrees(w.pid)).toEqual([w.root]);
    const auto = (): ReturnType<typeof svc.pass> =>
      svc.pass(w.pid, w.root, { trigger: 'schedule' });
    expect((await auto()).status).toBe('checked');
    expect((await auto()).status).toBe('up_to_date');
    w.addSteps(3, 4);
    expect(svc.dueWorktrees(w.pid)).toEqual([]);
    expect((await auto()).status).toBe('not_due');
    w.addSteps(5, 5);
    expect(svc.dueWorktrees(w.pid)).toEqual([w.root]);
    expect((await auto()).status).toBe('checked');
    // Not looked at once its newest step is a day old.
    w.addSteps(6, 6);
    w.clock.advance(25 * 60 * 60_000);
    expect(svc.dueWorktrees(w.pid)).toEqual([]);
  });
});

describe('sentinel status and cleanup', () => {
  it('shows each watched checkout with its checks and who broke them', async () => {
    const w = await world(breaksAt(4));
    w.addSteps(1, 3);
    await w.pass();
    w.addSteps(4, 6);
    await w.pass();
    w.addSteps(7, 8);
    const s = sentinelOf(w.mindly).status(w.pid);
    expect(s).toMatchObject({ enabled: true, readiness: { ready: true } });
    expect(s.watches).toHaveLength(1);
    expect(s.watches[0]).toMatchObject({
      worktree: w.root,
      latestSeq: 8,
      checkedSeq: 6,
      pending: 2,
    });
    expect(s.watches[0]?.checks[0]).toMatchObject({
      name: 'unit',
      state: 'failing',
      brokeAt: 4,
      culprit: { sessionId: w.cx, agentKind: 'codex' },
    });
    expect(s.recent.map((r) => r.kind)).toEqual(['sentinel', 'sentinel']);
  });

  it('removes warm trees on reset, forget and when idle, never one in use', async () => {
    const w = await world(() => 'pass');
    const svc = sentinelOf(w.mindly);
    w.addSteps(1, 2);
    await w.pass();
    const path = svc.warmPath(w.pid, w.root);
    expect(w.steps.warmOpened).toEqual([path]);
    // Not idle yet.
    expect(await svc.pruneWarm()).toBe(0);
    w.clock.advance(4 * 24 * 60 * 60_000);
    // Idle, but a pass holds the checkout right now: left alone.
    const held = tryProcessLock(join(dirname(path), 'lock'))!;
    expect(await svc.pruneWarm()).toBe(0);
    expect(svc.busy(w.pid)).toBe(true);
    held.release();
    expect(await svc.pruneWarm()).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(w.mindly.store.sentinel.get(w.pid, w.root)?.setupCommit).toBeNull();
    expect(await svc.pruneWarm()).toBe(0);

    // A tree that cannot be removed keeps its state, so cleanup tries again.
    await w.pass();
    w.steps.keepOnRemove = true;
    expect(await svc.reset(w.pid, w.root)).toBe('failed');
    expect(w.mindly.store.sentinel.get(w.pid, w.root)).not.toBeNull();
    expect(await svc.forget(w.pid)).toEqual({ reset: 0, busy: [], failed: [w.root] });
    w.steps.keepOnRemove = false;
    expect(await svc.reset(w.pid, w.root)).toBe('reset');
    expect(w.mindly.store.sentinel.get(w.pid, w.root)).toBeNull();
    expect(await svc.reset(w.pid, w.root)).toBe('none');
    await w.pass();
    expect(await svc.forget(w.pid)).toEqual({ reset: 1, busy: [], failed: [] });
    expect(w.mindly.store.sentinel.list(w.pid)).toEqual([]);
    // A pass holding the checkout: reported as busy, its state kept.
    await w.pass();
    const holding = tryProcessLock(join(dirname(path), 'lock'))!;
    expect(await svc.forget(w.pid)).toEqual({ reset: 0, busy: [w.root], failed: [] });
    expect(w.mindly.store.sentinel.list(w.pid)).toHaveLength(1);
    holding.release();
  });

  it('removes the temp folders an instance without a home made, when it closes', async () => {
    const w = await world(() => 'pass');
    w.addSteps(1, 2);
    await w.pass();
    const sentinelTmp = dirname(dirname(sentinelOf(w.mindly).warmPath(w.pid, w.root)));
    const checkpointsTmp = dirname(w.mindly.checkpoints.privateDir(w.root));
    expect(existsSync(sentinelTmp)).toBe(true);
    expect(existsSync(checkpointsTmp)).toBe(true);
    w.mindly.close();
    expect(existsSync(sentinelTmp)).toBe(false);
    expect(existsSync(checkpointsTmp)).toBe(false);
  });

  it('forgets a checkout that was removed, with its tree, and stops listing it', async () => {
    const w = await world(() => 'pass');
    const svc = sentinelOf(w.mindly);
    const part = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-part-')));
    w.mindly.store.checkpoints.create({
      projectId: w.pid,
      worktree: part,
      seq: 1,
      commit: 'c1',
      parentCommit: null,
      kind: 'baseline',
      sessionId: null,
      fileChangeId: null,
      promptEventId: null,
      tool: null,
      paths: [],
      gap: false,
    });
    await svc.pass(w.pid, part, { trigger: 'user', force: true });
    expect(svc.status(w.pid).watches.map((x) => x.worktree)).toContain(part);
    rmSync(part, { recursive: true, force: true });
    // Gone from the status at once; its tree and state go at the next cleanup.
    expect(svc.status(w.pid).watches.map((x) => x.worktree)).not.toContain(part);
    expect(await svc.pruneWarm()).toBe(1);
    expect(w.steps.warmRemoved).toEqual([svc.warmPath(w.pid, part)]);
    expect(w.mindly.store.sentinel.get(w.pid, part)).toBeNull();
  });
});

describe('sentinel and the track record', () => {
  it("counts the sentinel's bisect against the agent whose edit broke the check", async () => {
    const w = await world(breaksAt(8));
    w.addSteps(1, 2);
    await w.pass();
    w.addSteps(3, 9);
    await w.pass();
    const report = trackOf(w.mindly).report(w.pid, {
      windowMs: 30 * 24 * 60 * 60_000,
      since: '30d',
      minEdits: 1,
      minSessions: 1,
    });
    const rows = report.areas.flatMap((a) => a.agents);
    const bisects = (agent: string): number =>
      rows.filter((r) => r.agent === agent).reduce((n, r) => n + r.bisect.count, 0);
    expect(bisects('codex')).toBe(1);
    expect(bisects('claude-code')).toBe(0);
  });
});
