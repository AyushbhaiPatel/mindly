import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fingerprint,
  type HookEventName,
  type NormalizedHookEvent,
  type Session,
} from '@mindly/core';
import { SENTINEL_FINGERPRINT_PREFIX, sentinelOf } from '@mindly/engine';
import {
  createShadowMergeRun,
  executeShadowMerge,
  Scheduler,
  sentinelPruneTick,
  sentinelTick,
} from '../src/index.js';
import {
  bearer,
  git,
  linkedWorktree,
  repo,
  tempDir,
  testDaemon,
  write,
  type TestDaemon,
} from './helpers.js';
import { createLogger, nullSink } from '@mindly/core';

/*
 * The sentinel job against a real repository: real hook events take real checkpoints, and the
 * checks are real node processes run in the warm scratch tree.
 */

const node = process.execPath;
let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.daemon.stop();
  t = null;
});

const CHECK = `
const calc = require('./src/calc.js');
if (calc.add(2, 2) !== 4) { console.log('add(2,2) is ' + calc.add(2, 2)); process.exit(1); }
console.log('ok');
`;
const calc = (broken: boolean, n: number): string =>
  `// edit ${n}\nmodule.exports = { add: (a, b) => a + b${broken ? ' + 1' : ''} };\n`;

function hookEvent(
  root: string,
  agentKind: string,
  id: string,
  name: HookEventName,
  extra: Partial<NormalizedHookEvent> = {},
): NormalizedHookEvent {
  return {
    agentKind,
    event: name,
    externalSessionId: id,
    cwd: root,
    transcriptPath: null,
    startSource: null,
    prompt: null,
    tool: null,
    lastMessage: null,
    ...extra,
  };
}

async function setup(sentinel: Record<string, unknown> = { enabled: true, everySteps: 1 }) {
  const home = tempDir('mindly-daemon-home-');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ sentinel }));
  t = await testDaemon({ home });
  const d = t.daemon;
  const root = repo();
  write(root, 'check.cjs', CHECK);
  write(root, 'src/calc.js', calc(false, 0));
  write(
    root,
    '.mindly/config.json',
    JSON.stringify({ checks: [{ name: 'unit', argv: [node, 'check.cjs'] }] }),
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'calc');
  await d.mindly.hooks.handle(hookEvent(root, 'claude-code', 'cc', 'session_start'));
  await d.mindly.hooks.handle(hookEvent(root, 'codex', 'cx', 'session_start'));
  const pid = d.mindly.store.projects.list()[0]!.id;
  d.mindly.projects.trust(pid, d.mindly.projects.byId(pid).configHash ?? '');
  const session = (kind: string, id: string): Session =>
    d.mindly.store.sessions.findByExternal(pid, kind, id) as Session;
  /** One agent edit of src/calc.js, with its checkpoint. */
  const edit = async (agent: 'claude-code' | 'codex', broken: boolean, n: number) => {
    const content = calc(broken, n);
    write(root, 'src/calc.js', content);
    await d.mindly.hooks.handle(
      hookEvent(root, agent, agent === 'codex' ? 'cx' : 'cc', 'post_tool', {
        tool: {
          name: 'Edit',
          writes: true,
          shell: false,
          edits: [
            {
              path: join(root, 'src/calc.js'),
              addedText: content,
              removedText: '',
              wholeFile: true,
            },
          ],
          command: null,
          failed: false,
          outputExcerpt: null,
        },
      }),
    );
  };
  return { d, root, pid, edit, cc: session('claude-code', 'cc'), cx: session('codex', 'cx') };
}

describe('sentinel job', () => {
  it('does nothing while the sentinel is off', async () => {
    const s = await setup({ enabled: false });
    await s.edit('claude-code', false, 1);
    expect(await sentinelTick(s.d.jobs)).toBe(0);
    expect(s.d.mindly.store.runs.list(s.pid, { kind: 'sentinel' })).toEqual([]);

    // Turned on in the config file while the daemon runs: the next tick picks it up.
    writeFileSync(
      join(t!.home, 'config.json'),
      JSON.stringify({ sentinel: { enabled: true, everySteps: 1, quietSec: 10 } }),
    );
    await sentinelOf(s.d.mindly).pass(s.pid, s.root, { trigger: 'user', force: true });
    await s.edit('claude-code', false, 2);
    expect(await sentinelTick(s.d.jobs)).toBe(1);
    expect(s.d.mindly.config.sentinel).toMatchObject({ enabled: true, everySteps: 1 });
  });

  it('finds the edit that broke a check, in a warm tree outside the checkout', async () => {
    const s = await setup();
    await s.edit('claude-code', false, 1);
    // First look at this checkout: a baseline (the schedule would wait for the agents to pause).
    const base = await sentinelOf(s.d.mindly).pass(s.pid, s.root, { trigger: 'user', force: true });
    expect(base.checks[0]).toMatchObject({ outcome: 'pass', transition: 'baseline_pass' });
    const status = git(s.root, 'status', '--porcelain');
    const head = git(s.root, 'rev-parse', 'HEAD');

    await s.edit('claude-code', false, 2);
    await s.edit('codex', true, 3);
    await s.edit('claude-code', true, 4);
    expect(await sentinelTick(s.d.jobs)).toBe(1);

    const [conflict] = s.d.mindly.store.conflicts.list(s.pid);
    expect(conflict).toMatchObject({ kind: 'check_failed', sessionIds: [s.cx.id] });
    expect(conflict?.fingerprint.startsWith(SENTINEL_FINGERPRINT_PREFIX)).toBe(true);
    expect(conflict?.title).toMatch(/^Check "unit" broke at step \d+: codex #/);
    const [delivery] = s.d.mindly.store.deliveries.list(s.pid, { limit: 10 });
    expect(delivery).toMatchObject({
      targetSessionId: s.cx.id,
      title: 'Your edit broke check "unit"',
    });
    expect(delivery?.body).toContain('add(2,2) is 5');
    const [bisect] = s.d.mindly.store.runs.list(s.pid, { kind: 'bisect' });
    expect(bisect).toMatchObject({ status: 'passed', input: { trigger: 'sentinel' } });

    // The user's checkout was never touched; the warm tree lives in Mindly's home.
    expect(git(s.root, 'status', '--porcelain')).toBe(status);
    expect(git(s.root, 'rev-parse', 'HEAD')).toBe(head);
    const warm = sentinelOf(s.d.mindly).warmPath(s.pid, s.root);
    expect(warm.startsWith(t!.home)).toBe(true);
    expect(git(s.root, 'worktree', 'list')).toContain(warm);

    // The API shows it.
    const res = await s.d.app.inject({
      method: 'GET',
      url: `/api/projects/${s.pid}/sentinel`,
      headers: bearer(s.d),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { watches: { checks: { name: string; state: string }[] }[] };
    expect(body.watches[0]?.checks[0]).toMatchObject({ name: 'unit', state: 'failing' });

    // Fixed by the next edit: the conflict closes.
    await s.edit('codex', false, 5);
    expect(await sentinelTick(s.d.jobs)).toBe(1);
    expect(s.d.mindly.store.conflicts.get(conflict!.id).status).toBe('resolved');

    // Idle warm trees are removed by the prune job, and the repository forgets them.
    s.d.mindly.store.db.prepare('UPDATE sentinel_watches SET updated_at = 0').run();
    await sentinelPruneTick(s.d.jobs);
    expect(existsSync(warm)).toBe(false);
    expect(git(s.root, 'worktree', 'list')).not.toContain(warm);
  });

  it('watches the worktree of each agent separately', async () => {
    const s = await setup();
    const wt = linkedWorktree(s.root, 'feature');
    await s.d.mindly.hooks.handle(hookEvent(wt, 'codex', 'cx-2', 'session_start'));
    write(wt, 'src/calc.js', calc(false, 1));
    await s.d.mindly.hooks.handle(
      hookEvent(wt, 'codex', 'cx-2', 'post_tool', {
        tool: {
          name: 'Edit',
          writes: true,
          shell: false,
          edits: [
            { path: join(wt, 'src/calc.js'), addedText: 'x', removedText: '', wholeFile: true },
          ],
          command: null,
          failed: false,
          outputExcerpt: null,
        },
      }),
    );
    await s.edit('claude-code', false, 1);
    const svc = sentinelOf(s.d.mindly);
    await svc.pass(s.pid, s.root, { trigger: 'user', force: true });
    await svc.pass(s.pid, wt, { trigger: 'user', force: true });
    expect(
      svc
        .status(s.pid)
        .watches.map((w) => w.worktree)
        .sort(),
    ).toEqual([s.root, wt].sort());
    expect(svc.warmPath(s.pid, s.root)).not.toBe(svc.warmPath(s.pid, wt));
  });

  it('waits for the merge checks of the same project instead of running beside them', async () => {
    const s = await setup();
    await s.edit('claude-code', false, 1);
    let release!: () => void;
    const merging = new Promise<void>((r) => (release = r));
    void s.d.jobs.scheduler.enqueue(`shadow:${s.pid}`, () => merging);
    const tick = sentinelTick(s.d.jobs);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.d.mindly.store.runs.list(s.pid, { kind: 'sentinel' })).toHaveLength(0);
    release();
    expect(await tick).toBe(1);
    expect(s.d.mindly.store.runs.list(s.pid, { kind: 'sentinel' })).toHaveLength(1);
  });

  it('leaves its conflicts alone when a shadow merge finds checks passing', async () => {
    const s = await setup();
    const wt = linkedWorktree(s.root, 'feature');
    s.d.mindly.store.sessions.upsert({
      projectId: s.pid,
      agentKind: 'codex',
      externalId: 'cx-wt',
      worktree: wt,
      branch: 'feature',
      transcriptPath: null,
    });
    const { conflict } = s.d.mindly.store.conflicts.report({
      projectId: s.pid,
      kind: 'check_failed',
      severity: 'critical',
      title: 'Check "unit" broke at step 3',
      detail: 'x',
      sessionIds: [s.cx.id],
      paths: [],
      fingerprint: `${SENTINEL_FINGERPRINT_PREFIX}${fingerprint('x')}`,
    });
    const other = s.d.mindly.store.conflicts.report({
      projectId: s.pid,
      kind: 'check_failed',
      severity: 'critical',
      title: 'Check "old" fails on the merged work of live agents',
      detail: 'x',
      sessionIds: [],
      paths: [],
      fingerprint: fingerprint('check_failed', 'old'),
    }).conflict;
    const run = await executeShadowMerge(s.d.jobs, createShadowMergeRun(s.d.jobs, s.pid, 'user'));
    expect(run.status).toBe('passed');
    expect(s.d.mindly.store.conflicts.get(conflict.id).status).toBe('open');
    expect(s.d.mindly.store.conflicts.get(other.id).status).toBe('resolved');
  });
});

describe('scheduler signal', () => {
  it('is aborted when the scheduler stops', async () => {
    const scheduler = new Scheduler(createLogger({ sink: nullSink }));
    expect(scheduler.signal.aborted).toBe(false);
    await scheduler.stop();
    expect(scheduler.signal.aborted).toBe(true);
  });
});
