import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@mindly/core';
import {
  areaOf,
  bisectOf,
  buildTrackReport,
  clearlyBelow,
  globTouchesArea,
  inArea,
  installDefaultModules,
  Mindly,
  parseAreaPrefix,
  ROOT_AREA,
  suggestAgents,
  SURVIVAL_AGE_MS,
  trackLabel,
  trackOf,
  trackPromptLines,
  USER,
  wilson,
  type GitPort,
  type TrackInputs,
  type TrackReportOptions,
} from '../../src/index.js';
import { event, FakeClock, fakeGit, writeTool } from '../helpers.js';

const DAY = 86_400_000;
const WINDOW = 30 * DAY;

// ---------------------------------------------------------------------------------------------
// A temp project driven through hook events
// ---------------------------------------------------------------------------------------------

interface World {
  root: string;
  clock: FakeClock;
  mindly: Mindly;
  pid: string;
  session(agent: string, id: string, cwd?: string): Promise<Session>;
  edit(agent: string, id: string, rel: string, content: string, cwd?: string): Promise<void>;
  write(rel: string, content: string, base?: string): void;
}

/** A project whose linked worktrees (`<root>-wt-*`) map to the main checkout, as git does. */
async function world(): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-track-')));
  const git: GitPort = {
    ...fakeGit,
    findRepoRoot: async (cwd) => {
      const wt = /^(.*-wt-[a-z0-9]+)(?:\/|$)/.exec(cwd);
      return wt ? (wt[1] as string) : cwd.startsWith(root) ? root : null;
    },
    projectRoot: async () => root,
  };
  const clock = new FakeClock();
  const mindly = Mindly.open({ inMemory: true, clock, ports: { git } });
  installDefaultModules(mindly);
  const write = (rel: string, content: string, base = root): void => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), content);
  };
  let pid = '';
  const session = async (agent: string, id: string, cwd = root): Promise<Session> => {
    await mindly.hooks.handle(event(cwd, agent, id, 'session_start'));
    pid = mindly.store.projects.list()[0]!.id;
    return mindly.store.sessions.findByExternal(pid, agent, id)!;
  };
  const edit = async (agent: string, id: string, rel: string, content: string, cwd = root) => {
    write(rel, content, cwd);
    await mindly.hooks.handle(
      event(cwd, agent, id, 'post_tool', { tool: writeTool(join(cwd, rel), content) }),
    );
    clock.advance(1000);
  };
  await session('claude-code', 'boot');
  return {
    root,
    clock,
    mindly,
    get pid() {
      return pid;
    },
    session,
    edit,
    write,
  };
}

function report(w: World, opts: { area?: string; agent?: string; minEdits?: number } = {}) {
  return trackOf(w.mindly).report(w.pid, { windowMs: WINDOW, since: '30d', ...opts });
}

// ---------------------------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------------------------

describe('areas', () => {
  it('takes the first 1 to 4 folders of a path, and (root) for root files', () => {
    const p = 'packages/engine/src/features/track.ts';
    expect(areaOf(p, 1)).toBe('packages');
    expect(areaOf(p, 2)).toBe('packages/engine');
    expect(areaOf(p, 3)).toBe('packages/engine/src');
    expect(areaOf(p, 4)).toBe('packages/engine/src/features');
    expect(areaOf(p, 9)).toBe('packages/engine/src/features');
    // Never the file itself: a file one folder deep belongs to that folder.
    expect(areaOf('src/index.ts', 2)).toBe('src');
    expect(areaOf('README.md', 2)).toBe(ROOT_AREA);
    expect(areaOf('./package.json', 1)).toBe(ROOT_AREA);
    expect(areaOf('src\\api\\a.ts', 2)).toBe('src/api');
  });

  it('filters by a prefix at any depth', () => {
    expect(parseAreaPrefix('./src/api/')).toBe('src/api');
    expect(parseAreaPrefix('(root)')).toBe(ROOT_AREA);
    expect(inArea('src/api/v1/users.ts', 'src/api/v1')).toBe(true);
    expect(inArea('src/api/v1/users.ts', 'src')).toBe(true);
    expect(inArea('src/apiary/x.ts', 'src/api')).toBe(false);
    expect(inArea('README.md', ROOT_AREA)).toBe(true);
    expect(inArea('src/a.ts', ROOT_AREA)).toBe(false);
    for (const bad of ['', '../x', 'src/../etc', 'a\u001b[31m', 'a//b']) {
      expect(() => parseAreaPrefix(bad), bad).toThrow();
    }
  });

  it('honours track.areaDepth and --area in the report', async () => {
    const w = await world();
    await w.session('codex', 'cx');
    await w.edit('codex', 'cx', 'src/api/v1/users.ts', 'export const users = [];\n');
    await w.edit('codex', 'cx', 'src/api/v2/users.ts', 'export const users = [];\n');
    await w.edit('codex', 'cx', 'src/ui/page.ts', 'export const page = 1;\n');
    await w.edit('codex', 'cx', 'README.md', '# readme\n');
    const byDepth = (d: number) =>
      trackOf(w.mindly)
        .report(w.pid, { windowMs: WINDOW, since: '30d', areaDepth: d })
        .areas.map((a) => [a.area, a.edits]);
    expect(byDepth(1)).toEqual([
      ['src', 3],
      [ROOT_AREA, 1],
    ]);
    expect(byDepth(2)).toEqual([
      ['src/api', 2],
      [ROOT_AREA, 1],
      ['src/ui', 1],
    ]);
    expect(byDepth(3).map(([a]) => a)).toEqual(['(root)', 'src/api/v1', 'src/api/v2', 'src/ui']);
    expect(report(w, { area: 'src/api/v2' }).areas.map((a) => [a.area, a.edits])).toEqual([
      ['src/api/v2', 1],
    ]);
    expect(report(w, { area: ROOT_AREA }).areas.map((a) => [a.area, a.edits])).toEqual([
      [ROOT_AREA, 1],
    ]);
  });

  it('puts edits made in a split worktree in the same area as the main checkout', async () => {
    const w = await world();
    const wt = `${w.root}-wt-billing`;
    mkdirSync(wt, { recursive: true });
    await w.session('codex', 'main');
    await w.edit('codex', 'main', 'src/api/a.ts', 'export const a = 1;\n');
    await w.session('claude-code', 'part', wt);
    await w.edit('claude-code', 'part', 'src/api/b.ts', 'export const b = 1;\n', wt);
    const paths = w.mindly.store.fileChanges.since(w.pid, 0).map((c) => c.path);
    expect(paths.sort()).toEqual(['src/api/a.ts', 'src/api/b.ts']);
    const areas = report(w).areas;
    expect(areas.map((a) => a.area)).toEqual(['src/api']);
    expect(areas[0]!.agents.map((a) => [a.agent, a.edits])).toEqual([
      ['claude-code', 1],
      ['codex', 1],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Statistics and the honesty rules of the report
// ---------------------------------------------------------------------------------------------

describe('wilson interval', () => {
  it('matches known values', () => {
    const cases: [number, number, number, number][] = [
      [0, 10, 0, 0.2775],
      [5, 10, 0.2366, 0.7634],
      [10, 10, 0.7225, 1],
      [1, 20, 0.0089, 0.2361],
      [81, 263, 0.2553, 0.3662],
    ];
    for (const [k, n, low, high] of cases) {
      const i = wilson(k, n)!;
      expect(i.low, `${k}/${n}`).toBeCloseTo(low, 4);
      expect(i.high, `${k}/${n}`).toBeCloseTo(high, 4);
    }
    expect(wilson(0, 0)).toBeNull();
  });

  it('calls a difference clear only when the intervals do not overlap', () => {
    expect(clearlyBelow(wilson(0, 140), wilson(2, 20))).toBe(true);
    expect(clearlyBelow(wilson(0, 100), wilson(2, 20))).toBe(false);
    expect(clearlyBelow(wilson(1, 212), wilson(7, 188))).toBe(false);
    expect(clearlyBelow(wilson(2, 20), wilson(0, 140))).toBe(false);
    expect(clearlyBelow({ low: 0, high: 0.1 }, { low: 0.1, high: 0.2 })).toBe(false);
    expect(clearlyBelow(null, wilson(5, 10))).toBe(false);
  });
});

function synthetic(
  rows: { agent: string; edits: number; sessions: number; broke: number }[],
): TrackInputs {
  const edits: TrackInputs['edits'][number][] = [];
  const outcomes: TrackInputs['outcomes'][number][] = [];
  for (const r of rows) {
    for (let s = 0; s < r.sessions; s++) {
      const share = Math.floor(r.edits / r.sessions) + (s < r.edits % r.sessions ? 1 : 0);
      edits.push({
        path: 'src/api/a.ts',
        sessionId: `${r.agent}-${s}`,
        agentKind: r.agent,
        edits: share,
        addedLines: share * 2,
        removedLines: share,
      });
    }
    for (let i = 0; i < r.broke; i++) {
      outcomes.push({ agent: r.agent, paths: ['src/api/a.ts'], measure: 'bisect' });
    }
  }
  return { edits, survival: [], outcomes, sessions: [], limited: new Set() };
}

const OPTS: TrackReportOptions = {
  window: { since: '30d', from: 0, to: WINDOW },
  areaDepth: 2,
  minEdits: 20,
  minSessions: 3,
};

describe('report', () => {
  it('shows no rate below the minimum data, only counts', () => {
    const r = buildTrackReport(
      synthetic([
        { agent: 'codex', edits: 12, sessions: 4, broke: 1 },
        { agent: 'cursor', edits: 30, sessions: 2, broke: 0 },
        { agent: 'claude-code', edits: 20, sessions: 3, broke: 1 },
      ]),
      OPTS,
    );
    const by = new Map(r.areas[0]!.agents.map((a) => [a.agent, a]));
    const codex = by.get('codex')!;
    expect(codex.enoughData).toBe(false);
    expect(codex.breakages).toEqual({ count: 1, of: 12, rate: null, interval: null });
    expect(codex.kept.rate).toBeNull();
    expect(by.get('cursor')!.enoughData).toBe(false);
    const cc = by.get('claude-code')!;
    expect(cc.enoughData).toBe(true);
    expect(cc.breakages.rate).toBeCloseTo(0.05);
    expect(cc.breakages.interval!.low).toBeCloseTo(wilson(1, 20)!.low);
    // One agent with enough data: nothing to compare.
    expect(r.areas[0]!.clearDifference).toEqual([]);
    const lower = buildTrackReport(
      synthetic([{ agent: 'codex', edits: 12, sessions: 4, broke: 1 }]),
      { ...OPTS, minEdits: 10 },
    );
    expect(lower.areas[0]!.agents[0]!.breakages.rate).toBeCloseTo(1 / 12);
  });

  it('reports no clear difference when the intervals overlap, and one when they do not', () => {
    const overlap = buildTrackReport(
      synthetic([
        { agent: 'codex', edits: 212, sessions: 5, broke: 1 },
        { agent: 'claude-code', edits: 188, sessions: 5, broke: 7 },
      ]),
      OPTS,
    );
    expect(overlap.areas[0]!.clearDifference).toEqual([]);
    const clear = buildTrackReport(
      synthetic([
        { agent: 'codex', edits: 140, sessions: 5, broke: 0 },
        { agent: 'claude-code', edits: 20, sessions: 3, broke: 2 },
      ]),
      OPTS,
    );
    expect(clear.areas[0]!.clearDifference).toEqual([
      {
        measure: 'breakages',
        better: { agent: 'codex', count: 0, of: 140 },
        worse: { agent: 'claude-code', count: 2, of: 20 },
      },
      {
        measure: 'bisect',
        better: { agent: 'codex', count: 0, of: 140 },
        worse: { agent: 'claude-code', count: 2, of: 20 },
      },
    ]);
    // Never on agents below the minimum data, however different the counts look.
    const thin = buildTrackReport(
      synthetic([
        { agent: 'codex', edits: 140, sessions: 5, broke: 0 },
        { agent: 'claude-code', edits: 19, sessions: 3, broke: 15 },
      ]),
      OPTS,
    );
    expect(thin.areas[0]!.clearDifference).toEqual([]);
  });

  it('strips escape codes from paths and agent names', () => {
    const r = buildTrackReport(
      {
        edits: [
          {
            path: 'src/\u001b[31mevil\u001b[0m/x.ts',
            sessionId: 's',
            agentKind: 'codex',
            edits: 1,
            addedLines: 1,
            removedLines: 0,
          },
        ],
        survival: [],
        outcomes: [],
        sessions: [],
        limited: new Set(),
      },
      OPTS,
    );
    expect(r.areas[0]!.area).toBe('src/evil');
    expect(trackLabel('a\u001b]8;;http://x\u0007link\u001b]8;;\u0007\u0007b')).toBe('alinkb');
  });
});

// ---------------------------------------------------------------------------------------------
// Attribution: only what stored evidence pins to one agent
// ---------------------------------------------------------------------------------------------

describe('attribution', () => {
  async function twoAgents() {
    const w = await world();
    const cc = await w.session('claude-code', 'cc');
    const cx = await w.session('codex', 'cx');
    await w.edit('claude-code', 'cc', 'src/api/a.ts', 'export const a = 1;\n');
    await w.edit('codex', 'cx', 'src/api/b.ts', 'export const b = 1;\n');
    return { w, cc, cx };
  }

  function step(
    w: World,
    seq: number,
    kind: 'agent' | 'outside',
    sessionId: string | null,
    gap = false,
  ) {
    return w.mindly.store.checkpoints.create({
      projectId: w.pid,
      worktree: w.root,
      seq,
      commit: `${seq}`.padStart(40, 'a'),
      parentCommit: null,
      kind,
      sessionId,
      fileChangeId: null,
      promptEventId: null,
      tool: 'Edit',
      paths: ['src/api/a.ts'],
      gap,
    });
  }

  function bisectRun(
    w: World,
    seq: number,
    result: Record<string, unknown>,
    status: 'passed' | 'failed' = 'passed',
  ) {
    const svc = bisectOf(w.mindly);
    const run = svc.startRun(w.pid, 'Bisect node test.cjs', {
      command: ['node', 'test.cjs'],
      range: { good: 1, bad: seq + 1, worktree: w.root, since: '24h' },
    });
    svc.finishRun(run, status, { firstBad: seq, ...result });
  }

  const broke = (w: World, agent: string) =>
    report(w, { minEdits: 1 })
      .areas.find((a) => a.area === 'src/api')!
      .agents.find((a) => a.agent === agent)!;

  it('counts a bisect blame on an agent step (stored with the result or looked up)', async () => {
    const { w, cc } = await twoAgents();
    const s1 = step(w, 1, 'agent', cc.id);
    bisectRun(w, 1, {
      status: 'found',
      flaky: false,
      blame: { checkpointId: s1.id, kind: 'agent', gap: false, sessionId: cc.id, paths: s1.paths },
    });
    step(w, 2, 'agent', cc.id);
    bisectRun(w, 2, { status: 'found', flaky: false });
    expect(broke(w, 'claude-code').bisect.count).toBe(2);
    expect(broke(w, 'claude-code').breakages.count).toBe(2);
    expect(broke(w, 'codex').bisect.count).toBe(0);
  });

  it('does not count outside, gap or unreliable bisects', async () => {
    const { w, cc } = await twoAgents();
    step(w, 1, 'outside', null);
    bisectRun(w, 1, { status: 'found', flaky: false });
    step(w, 2, 'agent', cc.id, true);
    bisectRun(w, 2, { status: 'found', flaky: false });
    step(w, 3, 'agent', cc.id);
    bisectRun(w, 3, { status: 'unreliable', flaky: true }, 'failed');
    bisectRun(w, 3, { status: 'found', flaky: true });
    bisectRun(w, 3, { status: 'inconclusive', flaky: false }, 'failed');
    bisectRun(w, 3, {
      status: 'found',
      flaky: false,
      blame: { kind: 'agent', gap: true, sessionId: cc.id, paths: ['src/api/a.ts'] },
    });
    expect(broke(w, 'claude-code').bisect.count).toBe(0);
  });

  it('counts a contract broken by one session, and nothing for conflicts of several', async () => {
    const { w, cc, cx } = await twoAgents();
    w.write('src/api/auth.ts', 'export const role = "admin";\n');
    const memory = w.mindly.memory.remember({
      projectId: w.pid,
      projectRoot: w.root,
      kind: 'decision',
      title: 'auth keeps the role',
      body: 'The role stays in the response.',
      source: USER,
    });
    const { contractsOf } = await import('../../src/index.js');
    contractsOf(w.mindly).create(
      memory.id,
      'pattern_present',
      { path: 'src/api/auth.ts', pattern: 'role' },
      USER,
    );
    await w.edit('claude-code', 'cc', 'src/api/auth.ts', 'export const ok = true;\n');
    const broken = w.mindly.store.conflicts.list(w.pid).filter((c) => c.kind === 'contract_broken');
    expect(broken.map((c) => c.sessionIds)).toEqual([[cc.id]]);

    const report2 = (
      kind: 'check_failed' | 'merge_conflict' | 'contract_broken',
      ids: string[],
      fp: string,
    ) =>
      w.mindly.store.conflicts.report({
        projectId: w.pid,
        kind,
        severity: 'critical',
        title: fp,
        detail: fp,
        sessionIds: ids,
        paths: ['src/api/b.ts'],
        fingerprint: fp,
      });
    report2('merge_conflict', [cc.id, cx.id], 'two');
    report2('check_failed', [cc.id, cx.id], 'two-check');
    report2('contract_broken', [], 'nobody');
    report2('check_failed', [cx.id], 'one-check');
    const dismissed = report2('merge_conflict', [cx.id], 'dismissed').conflict;
    w.mindly.store.conflicts.setStatus(dismissed.id, 'dismissed');

    expect(broke(w, 'claude-code').contracts.count).toBe(1);
    expect(broke(w, 'claude-code').mergeChecks.count).toBe(0);
    expect(broke(w, 'codex').contracts.count).toBe(0);
    expect(broke(w, 'codex').mergeChecks.count).toBe(1);
  });

  it('counts only confirmed rule_enforced saves, as attempts', async () => {
    const { w, cc } = await twoAgents();
    const save = (fp: string) =>
      w.mindly.store.saves.record({
        projectId: w.pid,
        kind: 'rule_enforced',
        title: 'blocked',
        sessionIds: [cc.id],
        paths: ['src/api/a.ts'],
        evidence: ['e1'],
        fingerprint: fp,
        refs: { ruleId: 'r' },
      }).save;
    w.mindly.store.saves.settle(save('confirmed').id, 'confirmed');
    save('caught');
    w.mindly.store.saves.settle(save('expired').id, 'expired');
    w.mindly.store.saves.settle(save('rejected').id, 'rejected');
    const a = broke(w, 'claude-code');
    expect(a.ruleAttempts.count).toBe(1);
    // Attempts, not damage: not part of the breakages.
    expect(a.breakages.count).toBe(0);
  });

  it('counts usage limits per agent from rate-limit events and handoffs', async () => {
    const { w, cc } = await twoAgents();
    w.mindly.store.events.append({
      projectId: w.pid,
      sessionId: cc.id,
      type: 'session.rate_limited',
      payload: {},
    });
    const usage = report(w).usageLimits;
    expect(usage).toEqual([
      { agent: 'claude-code', limited: 1, sessions: 2 },
      { agent: 'codex', limited: 0, sessions: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Survival
// ---------------------------------------------------------------------------------------------

describe('line survival', () => {
  const LINES = ['export const first = 1;', 'export const second = 2;', 'export const third = 3;'];
  const body = (lines: string[]) => `${lines.join('\n')}\n`;

  it('counts kept, changed and deleted lines, only for edits at least 7 days old', async () => {
    const w = await world();
    await w.session('codex', 'cx');
    await w.edit('codex', 'cx', 'src/api/kept.ts', body(LINES));
    await w.edit('codex', 'cx', 'src/api/changed.ts', body(LINES));
    await w.edit('codex', 'cx', 'src/api/gone.ts', body(LINES));
    w.write('src/api/changed.ts', body([LINES[0]!, 'export const second = 20;', LINES[2]!]));
    rmSync(join(w.root, 'src/api/gone.ts'));
    const svc = trackOf(w.mindly);

    w.clock.advance(SURVIVAL_AGE_MS - DAY);
    expect(await svc.computeSurvival({ projectId: w.pid, max: 100 })).toEqual({
      checked: 0,
      pending: 0,
    });
    expect(report(w, { minEdits: 1 }).survival.pending).toBe(0);

    w.clock.advance(2 * DAY);
    expect(report(w, { minEdits: 1 }).survival.pending).toBe(3);
    expect(await svc.computeSurvival({ projectId: w.pid, max: 100 })).toEqual({
      checked: 3,
      pending: 0,
    });
    const rows = w.mindly.store.db
      .prepare(
        `SELECT c.path AS path, l.total_hashes AS total, l.kept_hashes AS kept
         FROM line_survival l JOIN file_changes c ON c.id = l.change_id ORDER BY c.path`,
      )
      .all();
    expect(rows).toEqual([
      { path: 'src/api/changed.ts', total: 3, kept: 2 },
      { path: 'src/api/gone.ts', total: 3, kept: 0 },
      { path: 'src/api/kept.ts', total: 3, kept: 3 },
    ]);
    const kept = report(w, { minEdits: 1, area: 'src/api' }).areas[0]!.agents[0]!.kept;
    expect(kept.count).toBe(5);
    expect(kept.of).toBe(9);
    // Computed once: later changes to the file do not change the stored result.
    rmSync(join(w.root, 'src/api/kept.ts'));
    await svc.computeSurvival({ projectId: w.pid, max: 100 });
    expect(report(w, { minEdits: 1 }).areas[0]!.agents[0]!.kept.count).toBe(5);
  });

  it('skips deny-listed and large files without reading or counting them', async () => {
    const w = await world();
    const cx = await w.session('codex', 'cx');
    w.write('.env', 'SECRET=1\n');
    // Unreadable: reading it would fail the check instead of skipping it.
    chmodSync(join(w.root, '.env'), 0o000);
    w.mindly.store.fileChanges.record({
      projectId: w.pid,
      sessionId: cx.id,
      path: '.env',
      tool: 'Edit',
      hunkHashes: w.mindly.kernel.ports.git.hunkHashes('SECRET=1'),
      addedLines: 1,
      removedLines: 0,
      promptEventId: null,
    });
    const big = `${'export const x = "0123456789";\n'.repeat(20_000)}`;
    await w.edit('codex', 'cx', 'src/big.ts', big);
    await w.edit('codex', 'cx', 'src/small.ts', body(LINES));
    w.clock.advance(SURVIVAL_AGE_MS + DAY);
    const r = await trackOf(w.mindly).computeSurvival({ projectId: w.pid, max: 100 });
    expect(r).toEqual({ checked: 3, pending: 0 });
    const rows = w.mindly.store.db
      .prepare(
        `SELECT c.path AS path, l.total_hashes AS total, l.kept_hashes AS kept
         FROM line_survival l JOIN file_changes c ON c.id = l.change_id ORDER BY c.path`,
      )
      .all();
    expect(rows).toEqual([
      { path: '.env', total: 0, kept: 0 },
      { path: 'src/big.ts', total: 0, kept: 0 },
      { path: 'src/small.ts', total: 3, kept: 3 },
    ]);
  });

  it('is bounded on demand and reports what is still pending', async () => {
    const w = await world();
    await w.session('codex', 'cx');
    for (let i = 0; i < 5; i++) await w.edit('codex', 'cx', `src/f${i}.ts`, body(LINES));
    w.clock.advance(SURVIVAL_AGE_MS + DAY);
    const svc = trackOf(w.mindly);
    expect(await svc.computeSurvival({ projectId: w.pid, max: 2 })).toEqual({
      checked: 2,
      pending: 3,
    });
    // The time budget stops early too: every check here "takes" 2 seconds.
    let t = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (t += 2000));
    const r = await svc.computeSurvival({ projectId: w.pid, max: 200, budgetMs: 3000 });
    now.mockRestore();
    expect(r.checked).toBeGreaterThan(0);
    expect(r.checked).toBeLessThan(3);
    expect(r.pending).toBe(3 - r.checked);
    expect(report(w).survival.pending).toBe(r.pending);
  });
});

// ---------------------------------------------------------------------------------------------
// Split suggestions
// ---------------------------------------------------------------------------------------------

describe('split suggestions', () => {
  const clear = () =>
    buildTrackReport(
      synthetic([
        { agent: 'codex', edits: 140, sessions: 5, broke: 0 },
        { agent: 'claude-code', edits: 20, sessions: 3, broke: 2 },
      ]),
      OPTS,
    );

  it('maps owns globs to areas', () => {
    expect(globTouchesArea('src/api/billing/**', 'src/api')).toBe(true);
    expect(globTouchesArea('src/api/**', 'src/api')).toBe(true);
    expect(globTouchesArea('src/**', 'src/api')).toBe(true);
    expect(globTouchesArea('**/*.ts', 'src/api')).toBe(true);
    expect(globTouchesArea('src/*.ts', 'src/api')).toBe(false);
    expect(globTouchesArea('src/ui/**', 'src/api')).toBe(false);
    expect(globTouchesArea('src/apiary/**', 'src/api')).toBe(false);
    expect(globTouchesArea('SRC/API/x.ts', 'src/api')).toBe(true);
    expect(globTouchesArea('README.md', ROOT_AREA)).toBe(true);
    expect(globTouchesArea('src/x.ts', ROOT_AREA)).toBe(false);
  });

  it('suggests an agent only with a clear difference, with the counts', () => {
    const parts = [
      { key: 'api', agent: 'claude-code', owns: ['src/api/**'] },
      { key: 'ui', agent: 'claude-code', owns: ['src/ui/**'] },
    ];
    const s = suggestAgents(clear(), parts, ['codex', 'claude-code']);
    expect([...s.keys()]).toEqual(['api']);
    expect(s.get('api')).toEqual({
      agent: 'codex',
      area: 'src/api',
      count: 0,
      of: 140,
      versus: { agent: 'claude-code', count: 2, of: 20 },
    });
    // Agents that cannot take a part are never suggested.
    expect(suggestAgents(clear(), parts, ['claude-code']).size).toBe(0);
    const overlap = buildTrackReport(
      synthetic([
        { agent: 'codex', edits: 212, sessions: 5, broke: 1 },
        { agent: 'claude-code', edits: 188, sessions: 5, broke: 7 },
      ]),
      OPTS,
    );
    expect(suggestAgents(overlap, parts, ['codex', 'claude-code']).size).toBe(0);
    expect(trackPromptLines(overlap, ['codex', 'claude-code'])).toEqual([]);
  });

  it('writes counts-only lines for the planner', () => {
    expect(trackPromptLines(clear(), ['codex', 'claude-code'])).toEqual([
      'track record (counts only): src/api — codex broke 0 of 140 edits, claude-code 2 of 20',
    ]);
  });
});
