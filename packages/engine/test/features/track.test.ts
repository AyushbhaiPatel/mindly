import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedHookEvent, Session } from '@mindly/core';
import {
  areaOf,
  bisectOf,
  buildTrackReport,
  clearlyBelow,
  contractsOf,
  globArea,
  inArea,
  installDefaultModules,
  mainArea,
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
  type FileAtRefState,
  type GitPort,
  type TrackInputs,
  type TrackReportOptions,
} from '../../src/index.js';
import { event, FakeClock, fakeGit, shellTool } from '../helpers.js';

const DAY = 86_400_000;
const WINDOW = 30 * DAY;

// ---------------------------------------------------------------------------------------------
// Temp projects driven through hook events
// ---------------------------------------------------------------------------------------------

interface World {
  root: string;
  clock: FakeClock;
  mindly: Mindly;
  pid: string;
  /** The branch checked out now, by checkout root (default `main`). */
  checkedOut: Map<string, string>;
  /** Files at branch tips: `<branch>\0<path>` to content. */
  tips: Map<string, string>;
  session(agent: string, id: string, cwd?: string): Promise<Session>;
  edit(agent: string, id: string, rel: string, content: string, cwd?: string): Promise<void>;
  /** An Edit-style replacement: `added` replaces `removed` inside the file now holding `content`. */
  replace(
    agent: string,
    id: string,
    rel: string,
    content: string,
    added: string,
    removed: string,
  ): Promise<void>;
  write(rel: string, content: string, base?: string): void;
  /** Another project folder, handled by the same Mindly. */
  newRoot(): string;
}

const tempRoot = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'mindly-track-')));

/** A git port for temp folders: `<root>-wt-<x>` is a linked worktree of `<root>`. */
function folderGit(w: Pick<World, 'checkedOut' | 'tips'>): GitPort {
  const parse = (cwd: string) => /^(.*\/mindly-track-[^/]+?)(-wt-[a-z0-9]+)?(?:\/|$)/.exec(cwd);
  return {
    ...fakeGit,
    findRepoRoot: async (cwd) => {
      const m = parse(cwd);
      return m ? `${m[1]}${m[2] ?? ''}` : null;
    },
    projectRoot: async (cwd) => parse(cwd)?.[1] ?? null,
    currentBranch: async (cwd) => {
      const m = parse(cwd);
      return m ? (w.checkedOut.get(`${m[1]}${m[2] ?? ''}`) ?? 'main') : null;
    },
    fileStateAtRef: async (_cwd, ref, path): Promise<FileAtRefState> => {
      const branch = ref.replace(/^refs\/heads\//, '');
      if (![...w.tips.keys()].some((k) => k.startsWith(`${branch}\u0000`))) {
        return { state: 'no_ref' };
      }
      const content = w.tips.get(`${branch}\u0000${path}`);
      return content === undefined ? { state: 'absent' } : { state: 'file', content };
    },
  };
}

function tool(path: string, added: string, removed = ''): NormalizedHookEvent['tool'] {
  return {
    name: 'Edit',
    writes: true,
    shell: false,
    edits: [{ path, addedText: added, removedText: removed, wholeFile: false }],
    command: null,
    failed: false,
    outputExcerpt: null,
  };
}

async function world(): Promise<World> {
  const root = tempRoot();
  const state = { checkedOut: new Map<string, string>(), tips: new Map<string, string>() };
  const clock = new FakeClock();
  const mindly = Mindly.open({ inMemory: true, clock, ports: { git: folderGit(state) } });
  installDefaultModules(mindly);
  const write = (rel: string, content: string, base = root): void => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), content);
  };
  const pidOf = (): string => mindly.store.projects.list().find((p) => p.root === root)?.id ?? '';
  const session = async (agent: string, id: string, cwd = root): Promise<Session> => {
    await mindly.hooks.handle(event(cwd, agent, id, 'session_start'));
    const project = mindly.store.projects.list().find((p) => cwd.startsWith(p.root))!;
    return mindly.store.sessions.findByExternal(project.id, agent, id)!;
  };
  const replace = async (
    agent: string,
    id: string,
    rel: string,
    content: string,
    added: string,
    removed: string,
    cwd = root,
  ) => {
    write(rel, content, cwd);
    await mindly.hooks.handle(
      event(cwd, agent, id, 'post_tool', { tool: tool(join(cwd, rel), added, removed) }),
    );
    clock.advance(1000);
  };
  const edit = (agent: string, id: string, rel: string, content: string, cwd = root) =>
    replace(agent, id, rel, content, content, '', cwd);
  await session('claude-code', 'boot');
  return {
    root,
    clock,
    mindly,
    get pid() {
      return pidOf();
    },
    ...state,
    session,
    edit,
    replace: (agent, id, rel, content, added, removed) =>
      replace(agent, id, rel, content, added, removed),
    write,
    newRoot: tempRoot,
  };
}

function report(w: World, opts: { area?: string; agent?: string; minEdits?: number } = {}) {
  return trackOf(w.mindly).report(w.pid, { windowMs: WINDOW, since: '30d', ...opts });
}

function survivalRows(w: World) {
  return w.mindly.store.db
    .prepare(
      `SELECT c.path AS path, l.total_hashes AS total, l.kept_hashes AS kept
       FROM line_survival l JOIN file_changes c ON c.id = l.change_id ORDER BY c.path`,
    )
    .all();
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
    // Not a proportion: no interval instead of a silently clamped one.
    expect(wilson(3, 2)).toBeNull();
    expect(wilson(-1, 2)).toBeNull();
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

interface Row {
  agent: string;
  edits: number;
  sessions: number;
  broke: number;
  /** Sessions the breakages come from (default: spread over all). */
  breakSessions?: number;
  measure?: 'bisect' | 'contracts' | 'mergeChecks' | 'ruleAttempts';
}

function synthetic(rows: Row[]): TrackInputs {
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
    const spread = r.breakSessions ?? r.sessions;
    for (let i = 0; i < r.broke; i++) {
      outcomes.push({
        agent: r.agent,
        sessionId: `${r.agent}-${i % spread}`,
        paths: ['src/api/a.ts'],
        measure: r.measure ?? 'bisect',
      });
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

  it('reports a clear difference only on breakages, without overlap, from 2+ sessions', () => {
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
    ]);
    expect(clear.areas[0]!.agents.find((a) => a.agent === 'claude-code')!.breakageSessions).toBe(2);
    // The same counts from one session: not a pattern.
    const oneSession = buildTrackReport(
      synthetic([
        { agent: 'codex', edits: 140, sessions: 5, broke: 0 },
        { agent: 'claude-code', edits: 20, sessions: 3, broke: 2, breakSessions: 1 },
      ]),
      OPTS,
    );
    expect(oneSession.areas[0]!.clearDifference).toEqual([]);
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

  it('shows rule attempts and counts above the edits as counts only', () => {
    const r = buildTrackReport(
      synthetic([
        { agent: 'codex', edits: 20, sessions: 3, broke: 25, measure: 'ruleAttempts' },
        { agent: 'cursor', edits: 20, sessions: 3, broke: 21 },
        { agent: 'gemini', edits: 20, sessions: 3, broke: 0 },
      ]),
      OPTS,
    );
    const by = new Map(r.areas[0]!.agents.map((a) => [a.agent, a]));
    expect(by.get('codex')!.ruleAttempts).toEqual({
      count: 25,
      of: 20,
      rate: null,
      interval: null,
    });
    expect(by.get('codex')!.breakages.count).toBe(0);
    expect(by.get('cursor')!.breakages).toEqual({ count: 21, of: 20, rate: null, interval: null });
    expect(r.areas[0]!.clearDifference).toEqual([]);
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

  const row = (w: World, agent: string) =>
    report(w, { minEdits: 1 })
      .areas.find((a) => a.area === 'src/api')!
      .agents.find((a) => a.agent === agent)!;

  it('counts a bisect blame on an agent step once, at the time of the edit', async () => {
    const { w, cc } = await twoAgents();
    const s1 = step(w, 1, 'agent', cc.id);
    const blame = {
      checkpointId: s1.id,
      kind: 'agent',
      gap: false,
      sessionId: cc.id,
      paths: s1.paths,
      at: s1.createdAt,
    };
    bisectRun(w, 1, { status: 'found', flaky: false, blame });
    // A second bisect of the same regression is the same blame.
    bisectRun(w, 1, { status: 'found', flaky: false, blame });
    // A run recorded before the blamed step was stored with it: looked up by step number.
    step(w, 2, 'agent', cc.id);
    bisectRun(w, 2, { status: 'found', flaky: false });
    expect(row(w, 'claude-code').bisect.count).toBe(2);
    expect(row(w, 'claude-code').breakages.count).toBe(2);
    expect(row(w, 'codex').bisect.count).toBe(0);
    // A bisect today that blames an edit from before the window does not count in it.
    bisectRun(w, 3, {
      status: 'found',
      flaky: false,
      blame: { ...blame, checkpointId: 'old', at: w.clock.now() - 45 * DAY },
    });
    expect(row(w, 'claude-code').bisect.count).toBe(2);
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
    expect(row(w, 'claude-code').bisect.count).toBe(0);
  });

  async function withContract(w: World) {
    w.write('src/api/auth.ts', 'export const role = "admin";\n');
    const memory = w.mindly.memory.remember({
      projectId: w.pid,
      projectRoot: w.root,
      kind: 'decision',
      title: 'auth keeps the role',
      body: 'The role stays in the response.',
      source: USER,
    });
    contractsOf(w.mindly).create(
      memory.id,
      'pattern_present',
      { path: 'src/api/auth.ts', pattern: 'role' },
      USER,
    );
  }

  it('counts each time a contract broke right after one agent edit in the checkout', async () => {
    const { w, cc } = await twoAgents();
    await withContract(w);
    const BROKEN = 'export const ok = true;\n';
    const FIXED = 'export const role = "admin";\n';
    await w.edit('claude-code', 'cc', 'src/api/auth.ts', BROKEN);
    const broken = w.mindly.store.conflicts.list(w.pid).filter((c) => c.kind === 'contract_broken');
    expect(broken.map((c) => c.sessionIds)).toEqual([[cc.id]]);
    await w.edit('claude-code', 'cc', 'src/api/auth.ts', FIXED);
    // The same contract broken again, by the other agent: the conflict row is reopened and now
    // names Codex, but the first break stays Claude Code's.
    await w.edit('codex', 'cx', 'src/api/auth.ts', BROKEN);
    await w.edit('codex', 'cx', 'src/api/auth.ts', FIXED);
    await w.edit('claude-code', 'cc', 'src/api/auth.ts', BROKEN);
    expect(
      w.mindly.store.conflicts
        .list(w.pid, { statuses: ['open'] })
        .filter((c) => c.kind === 'contract_broken'),
    ).toHaveLength(1);
    expect(row(w, 'claude-code').contracts.count).toBe(2);
    expect(row(w, 'codex').contracts.count).toBe(1);
  });

  it('says when the window is longer than the kept event log', async () => {
    const { w } = await twoAgents();
    await withContract(w);
    await w.edit('claude-code', 'cc', 'src/api/auth.ts', 'export const ok = true;\n');
    expect(row(w, 'claude-code').contracts.count).toBe(1);
    expect(report(w).eventsSince).toBeNull();

    // A week on, retention removes the events of that day; the edits stay.
    w.clock.advance(7 * DAY);
    const cutoff = w.clock.now();
    await w.edit('codex', 'cx', 'src/api/b.ts', 'export const b = 2;\n');
    w.mindly.store.events.deleteOlderThan(cutoff);
    const r = report(w, { minEdits: 1 });
    // The break is no longer known, although the edit behind it is still counted.
    const cc = r.areas
      .find((a) => a.area === 'src/api')!
      .agents.find((a) => a.agent === 'claude-code')!;
    expect(cc.edits).toBeGreaterThan(0);
    expect(cc.contracts.count).toBe(0);
    expect(r.eventsSince).toBeGreaterThanOrEqual(cutoff);
    // A window inside the kept period is whole.
    expect(
      trackOf(w.mindly).report(w.pid, { windowMs: w.clock.now() - cutoff, since: '1h' })
        .eventsSince,
    ).toBeNull();

    // With every event gone, nothing of the window is known.
    w.mindly.store.events.deleteOlderThan(w.clock.now() + 1);
    const none = report(w, { minEdits: 1 });
    expect(none.totals.edits).toBeGreaterThan(0);
    expect(none.eventsSince).toBe(none.window.to);
  });

  it('does not pin a contract break on an edit made in another worktree', async () => {
    const { w } = await twoAgents();
    await withContract(w);
    const wt = `${w.root}-wt-part`;
    mkdirSync(wt, { recursive: true });
    await w.session('codex', 'part', wt);
    // The main checkout changed under the contract; the edit in the worktree only triggers the check.
    w.write('src/api/auth.ts', 'export const ok = true;\n');
    await w.edit('codex', 'part', 'src/api/auth.ts', 'export const role = "x";\n', wt);
    expect(
      w.mindly.store.conflicts.list(w.pid).filter((c) => c.kind === 'contract_broken'),
    ).toHaveLength(1);
    expect(row(w, 'codex').contracts.count).toBe(0);
  });

  it('counts merge conflicts naming one session, not several, not failing checks', async () => {
    const { w, cc, cx } = await twoAgents();
    const open = (
      kind: 'check_failed' | 'merge_conflict',
      ids: string[] | null,
      fp: string,
    ): string => {
      const { conflict } = w.mindly.store.conflicts.report({
        projectId: w.pid,
        kind,
        severity: 'critical',
        title: fp,
        detail: fp,
        sessionIds: ids ?? [],
        paths: ['src/api/b.ts'],
        fingerprint: fp,
      });
      w.mindly.store.events.append({
        projectId: w.pid,
        sessionId: null,
        type: 'conflict.opened',
        payload: {
          conflictId: conflict.id,
          kind,
          ...(ids ? { sessionIds: ids, paths: ['src/api/b.ts'] } : {}),
        },
      });
      return conflict.id;
    };
    open('merge_conflict', [cc.id, cx.id], 'two');
    open('merge_conflict', [cx.id], 'one');
    open('check_failed', [cx.id], 'check');
    open('merge_conflict', null, 'old-event');
    w.mindly.store.conflicts.setStatus(open('merge_conflict', [cx.id], 'dismissed'), 'dismissed');
    expect(row(w, 'codex').mergeChecks.count).toBe(1);
    expect(row(w, 'claude-code').mergeChecks.count).toBe(0);
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
    const a = row(w, 'claude-code');
    expect(a.ruleAttempts).toEqual({ count: 1, of: 1, rate: null, interval: null });
    // Attempts, not damage: not part of the breakages.
    expect(a.breakages.count).toBe(0);
  });

  it('counts a blocked write for every agent the rule stopped, not only the first', async () => {
    const { w } = await twoAgents();
    w.mindly.memory.remember({
      projectId: w.pid,
      projectRoot: w.root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'produced by codegen',
      scopePaths: ['src/api/generated/**'],
      source: USER,
      enforce: true,
    });
    const blocked = async (agent: string, id: string) => {
      const res = await w.mindly.hooks.handle(
        event(w.root, agent, id, 'pre_tool', {
          tool: tool(join(w.root, 'src/api/generated/client.ts'), 'x'),
        }),
      );
      expect(res.decision).toBe('deny');
      w.clock.advance(1000);
    };
    // Codex is stopped first and its turn ends: the rule held, the save is confirmed.
    await blocked('codex', 'cx');
    await w.mindly.hooks.handle(event(w.root, 'codex', 'cx', 'stop'));
    expect(row(w, 'codex').ruleAttempts.count).toBe(1);
    expect(row(w, 'claude-code').ruleAttempts.count).toBe(0);

    // Claude Code runs into the same rule on the same file, twice in one session and once more
    // in another: the same problem for saves, but its own attempts here, once per session.
    await blocked('claude-code', 'cc');
    await blocked('claude-code', 'cc');
    await w.session('claude-code', 'cc2');
    await blocked('claude-code', 'cc2');
    expect(w.mindly.store.saves.list(w.pid, { kinds: ['rule_enforced'] })).toHaveLength(1);
    expect(row(w, 'codex').ruleAttempts.count).toBe(1);
    expect(row(w, 'claude-code').ruleAttempts.count).toBe(2);

    // Weeks later the save is out of the window; a new attempt still counts.
    w.clock.advance(WINDOW + DAY);
    await w.edit('claude-code', 'cc2', 'src/api/a.ts', 'export const a = 2;\n');
    await w.edit('codex', 'cx', 'src/api/b.ts', 'export const b = 2;\n');
    await blocked('claude-code', 'cc2');
    expect(row(w, 'claude-code').ruleAttempts.count).toBe(1);
    expect(row(w, 'codex').ruleAttempts.count).toBe(0);
  });

  it('counts one attempt per session and rule, however many saves the rule has', async () => {
    const { w } = await twoAgents();
    w.mindly.memory.remember({
      projectId: w.pid,
      projectRoot: w.root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'produced by codegen',
      scopePaths: ['src/api/generated/**', 'src/web/generated/**'],
      source: USER,
      enforce: true,
    });
    const blocked = async (agent: string, id: string, ...files: string[]) => {
      const t = tool(join(w.root, files[0]!), 'x');
      for (const f of files.slice(1)) {
        t!.edits.push({ path: join(w.root, f), addedText: 'x', removedText: '', wholeFile: false });
      }
      const res = await w.mindly.hooks.handle(event(w.root, agent, id, 'pre_tool', { tool: t }));
      expect(res.decision).toBe('deny');
      w.clock.advance(1000);
    };
    const A = 'src/api/generated/a.ts';
    const B = 'src/api/generated/b.ts';
    // Codex is stopped on one file, then on two: two saves of one rule that share a file.
    await blocked('codex', 'cx', A);
    await blocked('codex', 'cx', A, B);
    await w.mindly.hooks.handle(event(w.root, 'codex', 'cx', 'stop'));
    expect(
      w.mindly.store.saves.list(w.pid, { kinds: ['rule_enforced'] }).map((s) => s.status),
    ).toEqual(['confirmed', 'confirmed']);
    // Claude Code is stopped once, on the shared file.
    await blocked('claude-code', 'cc', A);
    expect(row(w, 'codex').ruleAttempts.count).toBe(1);
    expect(row(w, 'claude-code').ruleAttempts.count).toBe(1);

    // The attempt belongs to the area of the file that session was stopped on, not to every
    // area a save of the rule names.
    await w.edit('claude-code', 'cc', 'src/web/x.ts', 'export const x = 1;\n');
    await w.session('gemini', 'gm');
    await w.edit('gemini', 'gm', 'src/web/y.ts', 'export const y = 1;\n');
    await w.edit('gemini', 'gm', 'src/api/c.ts', 'export const c = 1;\n');
    await blocked('gemini', 'gm', 'src/web/generated/w.ts', A);
    await w.mindly.hooks.handle(event(w.root, 'gemini', 'gm', 'stop'));
    await blocked('claude-code', 'cc', A);
    const web = report(w, { minEdits: 1 }).areas.find((a) => a.area === 'src/web')!;
    expect(web.agents.find((a) => a.agent === 'gemini')!.ruleAttempts.count).toBe(1);
    expect(web.agents.find((a) => a.agent === 'claude-code')!.ruleAttempts.count).toBe(0);
    expect(row(w, 'gemini').ruleAttempts.count).toBe(1);
    expect(row(w, 'claude-code').ruleAttempts.count).toBe(1);
  });

  it('does not count an attempt in the area of an unprotected file of an earlier save', async () => {
    const { w, cx } = await twoAgents();
    await w.edit('codex', 'cx', 'src/web/client.ts', 'export const c = 1;\n');
    const rule = w.mindly.memory.remember({
      projectId: w.pid,
      projectRoot: w.root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'produced by codegen',
      scopePaths: ['src/api/generated/**'],
      source: USER,
      enforce: true,
    });
    // As an earlier version recorded it: every path of the denied call.
    const all = ['src/api/generated/a.ts', 'src/web/client.ts'];
    const old = w.mindly.store.saves.record({
      projectId: w.pid,
      kind: 'rule_enforced',
      title: 'blocked',
      sessionIds: [cx.id],
      paths: all,
      evidence: ['e0'],
      fingerprint: 'earlier',
      refs: { ruleId: rule.id },
    }).save;
    w.mindly.store.saves.settle(old.id, 'confirmed');
    const t = tool(join(w.root, all[0]!), 'x');
    t!.edits.push({
      path: join(w.root, all[1]!),
      addedText: 'x',
      removedText: '',
      wholeFile: false,
    });
    const res = await w.mindly.hooks.handle(event(w.root, 'codex', 'cx', 'pre_tool', { tool: t }));
    expect(res.decision).toBe('deny');

    const areas = report(w, { minEdits: 1 }).areas;
    const attempts = (area: string) =>
      areas.find((a) => a.area === area)!.agents.find((a) => a.agent === 'codex')!.ruleAttempts
        .count;
    expect(attempts('src/api')).toBe(1);
    expect(attempts('src/web')).toBe(0);
  });

  it('decides for each session whether the block held, whatever the first session did', async () => {
    const { w } = await twoAgents();
    w.mindly.memory.remember({
      projectId: w.pid,
      projectRoot: w.root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'produced by codegen',
      scopePaths: ['src/api/generated/**'],
      source: USER,
      enforce: true,
    });
    const file = 'src/api/generated/client.ts';
    const blocked = async (agent: string, id: string) => {
      const res = await w.mindly.hooks.handle(
        event(w.root, agent, id, 'pre_tool', { tool: tool(join(w.root, file), 'x') }),
      );
      expect(res.decision).toBe('deny');
      w.clock.advance(1000);
    };
    const attempts = (agent: string) => row(w, agent).ruleAttempts.count;

    // Codex is stopped, then writes the file anyway: the save of the rule and file is rejected.
    await blocked('codex', 'cx');
    await w.edit('codex', 'cx', file, 'export const c = 1;\n');
    expect(
      w.mindly.store.saves.list(w.pid, { kinds: ['rule_enforced'] }).map((s) => s.status),
    ).toEqual(['rejected']);
    expect(attempts('codex')).toBe(0);

    // Claude Code is stopped by the same rule on the same file, and the rule holds.
    await blocked('claude-code', 'cc');
    await w.mindly.hooks.handle(event(w.root, 'claude-code', 'cc', 'stop'));
    expect(attempts('claude-code')).toBe(1);

    // Another Claude Code session is the first to be stopped on another protected file, then
    // copies it over through the shell: that session did not stay blocked.
    const other = 'src/api/generated/other.ts';
    await w.session('claude-code', 'cc2');
    const res = await w.mindly.hooks.handle(
      event(w.root, 'claude-code', 'cc2', 'pre_tool', { tool: tool(join(w.root, other), 'x') }),
    );
    expect(res.decision).toBe('deny');
    w.clock.advance(1000);
    const cp = shellTool(`cp /tmp/x ${other}`);
    await w.mindly.hooks.handle(event(w.root, 'claude-code', 'cc2', 'pre_tool', { tool: cp }));
    await w.mindly.hooks.handle(event(w.root, 'claude-code', 'cc2', 'post_tool', { tool: cp }));
    expect(attempts('claude-code')).toBe(1);
  });

  it('does not count a session that wrote the file after an earlier one held', async () => {
    const { w } = await twoAgents();
    w.mindly.memory.remember({
      projectId: w.pid,
      projectRoot: w.root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'produced by codegen',
      scopePaths: ['src/api/generated/**'],
      source: USER,
      enforce: true,
    });
    const file = 'src/api/generated/client.ts';
    const blocked = async (agent: string, id: string) => {
      const res = await w.mindly.hooks.handle(
        event(w.root, agent, id, 'pre_tool', { tool: tool(join(w.root, file), 'x') }),
      );
      expect(res.decision).toBe('deny');
      w.clock.advance(1000);
    };
    // Codex is stopped and its turn ends: the save is confirmed.
    await blocked('codex', 'cx');
    await w.mindly.hooks.handle(event(w.root, 'codex', 'cx', 'stop'));
    // Claude Code is stopped, then writes the protected file anyway.
    await blocked('claude-code', 'cc');
    await w.edit('claude-code', 'cc', file, 'export const c = 1;\n');
    await w.mindly.hooks.handle(event(w.root, 'claude-code', 'cc', 'stop'));
    expect(row(w, 'codex').ruleAttempts.count).toBe(1);
    expect(row(w, 'claude-code').ruleAttempts.count).toBe(0);
  });

  it('counts usage limits per agent from rate-limit events and handoffs', async () => {
    const { w, cc } = await twoAgents();
    w.mindly.store.events.append({
      projectId: w.pid,
      sessionId: cc.id,
      type: 'session.rate_limited',
      payload: {},
    });
    expect(report(w).usageLimits).toEqual([
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
      deferred: 0,
      pending: 0,
    });
    expect(report(w, { minEdits: 1 }).survival.pending).toBe(0);

    w.clock.advance(2 * DAY);
    expect(report(w, { minEdits: 1 }).survival.pending).toBe(3);
    expect(await svc.computeSurvival({ projectId: w.pid, max: 100 })).toEqual({
      checked: 3,
      deferred: 0,
      pending: 0,
    });
    expect(survivalRows(w)).toEqual([
      { path: 'src/api/changed.ts', total: 3, kept: 2 },
      { path: 'src/api/gone.ts', total: 3, kept: 0 },
      { path: 'src/api/kept.ts', total: 3, kept: 3 },
    ]);
    const agent = report(w, { minEdits: 1, area: 'src/api' }).areas[0]!.agents[0]!;
    expect(agent.kept).toMatchObject({ count: 5, of: 9 });
    expect(agent.keptFrom).toEqual({ edits: 3, sessions: 1 });
    // Computed once: later changes to the file do not change the stored result.
    rmSync(join(w.root, 'src/api/kept.ts'));
    await svc.computeSurvival({ projectId: w.pid, max: 100 });
    expect(report(w, { minEdits: 1 }).areas[0]!.agents[0]!.kept.count).toBe(5);
  });

  it('measures the lines an edit added or changed, as whole lines, for every tool', async () => {
    const w = await world();
    await w.session('claude-code', 'cc');
    await w.session('codex', 'cx');
    w.write('src/a.ts', body(['const x = foo(1);', LINES[1]!]));
    // Edit: `foo(1)` to `foo(2)` inside a line: that whole line is what the edit changed.
    await w.replace(
      'claude-code',
      'cc',
      'src/a.ts',
      body(['const x = foo(2);', LINES[1]!]),
      'foo(2)',
      'foo(1)',
    );
    // A replacement that repeats an unchanged line as context: only the new line counts.
    await w.replace(
      'claude-code',
      'cc',
      'src/a.ts',
      body(['const x = foo(2);', LINES[1]!, LINES[2]!]),
      `${LINES[1]!}\n${LINES[2]!}`,
      LINES[1]!,
    );
    // A change inside a line that is later rewritten: not kept.
    w.write('src/c.ts', body(['const y = bar(1);']));
    await w.replace(
      'claude-code',
      'cc',
      'src/c.ts',
      body(['const y = bar(2);']),
      'bar(2)',
      'bar(1)',
    );
    w.write('src/c.ts', body(['const y = bar(3);']));
    // A fragment found twice cannot be located: only whole added lines would count (none here).
    w.write('src/d.ts', body(['const z = baz(1);', 'const w = baz(2);']));
    await w.replace(
      'claude-code',
      'cc',
      'src/d.ts',
      body(['const z = baz(2);', 'const w = baz(2);']),
      'baz(2)',
      'baz(1)',
    );
    // A patch adding whole lines.
    await w.edit('codex', 'cx', 'src/b.ts', body(LINES));
    w.clock.advance(SURVIVAL_AGE_MS + DAY);
    await trackOf(w.mindly).computeSurvival({ projectId: w.pid, max: 100 });
    expect(survivalRows(w)).toEqual([
      { path: 'src/a.ts', total: 1, kept: 1 },
      { path: 'src/a.ts', total: 1, kept: 1 },
      { path: 'src/b.ts', total: 3, kept: 3 },
      { path: 'src/c.ts', total: 1, kept: 0 },
      { path: 'src/d.ts', total: 0, kept: 0 },
    ]);
  });

  it('shows kept lines for an agent that only edits inside lines', async () => {
    const w = await world();
    for (let i = 0; i < 25; i++) {
      const id = `cc${i % 3}`;
      await w.session('claude-code', id);
      w.write(`src/api/f${i}.ts`, body([`export const v${i} = compute(1);`]));
      await w.replace(
        'claude-code',
        id,
        `src/api/f${i}.ts`,
        body([`export const v${i} = compute(2);`]),
        'compute(2)',
        'compute(1)',
      );
    }
    w.clock.advance(SURVIVAL_AGE_MS + DAY);
    await trackOf(w.mindly).computeSurvival({ projectId: w.pid, max: 100 });
    const cc = report(w, { area: 'src/api' }).areas[0]!.agents[0]!;
    expect(cc).toMatchObject({ agent: 'claude-code', edits: 25, sessions: 3, enoughData: true });
    expect(cc.keptFrom).toEqual({ edits: 25, sessions: 3 });
    expect(cc.kept).toMatchObject({ count: 25, of: 25, rate: 1 });
  });

  it('reads the branch the session worked on, and skips what it cannot tell', async () => {
    const w = await world();
    w.checkedOut.set(w.root, 'feature');
    await w.session('codex', 'cx');
    await w.edit('codex', 'cx', 'src/kept.ts', body(LINES));
    await w.edit('codex', 'cx', 'src/gone.ts', body(LINES));
    w.checkedOut.set(w.root, 'release');
    await w.session('cursor', 'cu');
    await w.edit('cursor', 'cu', 'src/other.ts', body(LINES));
    // Now on main: the working files say nothing about either branch.
    w.checkedOut.set(w.root, 'main');
    rmSync(join(w.root, 'src'), { recursive: true });
    w.tips.set(`feature\u0000src/kept.ts`, body([LINES[0]!, LINES[1]!]));
    w.clock.advance(SURVIVAL_AGE_MS + DAY);
    await trackOf(w.mindly).computeSurvival({ projectId: w.pid, max: 100 });
    expect(survivalRows(w)).toEqual([
      { path: 'src/gone.ts', total: 3, kept: 0 },
      { path: 'src/kept.ts', total: 3, kept: 2 },
      // The release branch is gone: skipped, never counted.
      { path: 'src/other.ts', total: 0, kept: 0 },
    ]);
  });

  it('leaves edits whose checkout cannot be read for later, without blocking others', async () => {
    const w = await world();
    await w.session('codex', 'cx');
    await w.edit('codex', 'cx', 'src/a.ts', body(LINES));
    const other = w.newRoot();
    await w.session('codex', 'cx2', other);
    await w.edit('codex', 'cx2', 'src/b.ts', body(LINES), other);
    // The first project's folder is gone (moved, or a volume not mounted).
    rmSync(w.root, { recursive: true });
    w.clock.advance(SURVIVAL_AGE_MS + DAY);
    const svc = trackOf(w.mindly);
    expect(await svc.computeSurvival({ projectId: w.pid, max: 10 })).toEqual({
      checked: 0,
      deferred: 1,
      pending: 1,
    });
    expect(survivalRows(w)).toEqual([]);
    // The all-projects scan moves on past it.
    expect(await svc.computeSurvival({ projectId: null, max: 1 })).toMatchObject({
      checked: 0,
      deferred: 1,
    });
    expect(await svc.computeSurvival({ projectId: null, max: 1 })).toMatchObject({ checked: 1 });
    expect(survivalRows(w)).toEqual([{ path: 'src/b.ts', total: 3, kept: 3 }]);
    // Back again: checked then.
    mkdirSync(join(w.root, 'src'), { recursive: true });
    writeFileSync(join(w.root, 'src/a.ts'), body(LINES));
    expect(await svc.computeSurvival({ projectId: w.pid, max: 10 })).toMatchObject({
      checked: 1,
      pending: 0,
    });
  });

  it('skips deny-listed and large files without reading or counting them', async () => {
    const w = await world();
    const cx = await w.session('codex', 'cx');
    w.write('.env', 'SECRET=1\n');
    // Unreadable: reading it would fail the check instead of skipping it.
    chmodSync(join(w.root, '.env'), 0o000);
    const hashes = w.mindly.kernel.ports.git.hunkHashes('SECRET=1');
    w.mindly.store.fileChanges.record({
      projectId: w.pid,
      sessionId: cx.id,
      path: '.env',
      tool: 'Edit',
      hunkHashes: hashes,
      lineHashes: hashes,
      addedLines: 1,
      removedLines: 0,
      promptEventId: null,
    });
    const big = `${'export const x = "0123456789";\n'.repeat(20_000)}`;
    await w.edit('codex', 'cx', 'src/big.ts', big);
    await w.edit('codex', 'cx', 'src/small.ts', body(LINES));
    w.clock.advance(SURVIVAL_AGE_MS + DAY);
    const r = await trackOf(w.mindly).computeSurvival({ projectId: w.pid, max: 100 });
    expect(r).toEqual({ checked: 3, deferred: 0, pending: 0 });
    expect(survivalRows(w)).toEqual([
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
      deferred: 0,
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

  it('shows kept lines only with enough checked edits and sessions', async () => {
    const w = await world();
    for (let i = 0; i < 4; i++) {
      await w.session('codex', `cx${i % 2}`);
      await w.edit('codex', `cx${i % 2}`, `src/f${i}.ts`, body(LINES));
    }
    w.clock.advance(SURVIVAL_AGE_MS + DAY);
    await trackOf(w.mindly).computeSurvival({ projectId: w.pid, max: 100 });
    const kept = (minSessions: number) =>
      trackOf(w.mindly).report(w.pid, {
        windowMs: WINDOW,
        since: '30d',
        minEdits: 4,
        minSessions,
      }).areas[0]!.agents[0]!;
    expect(kept(2).kept).toMatchObject({ count: 12, of: 12, rate: 1 });
    // Enough edits but kept lines from too few sessions: counts only.
    expect(kept(3).kept).toEqual({ count: 12, of: 12, rate: null, interval: null });
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

  it('finds the main area of a part from its owns globs', () => {
    expect(globArea('src/api/billing/**', 2)).toBe('src/api');
    expect(globArea('src/api/**', 2)).toBe('src/api');
    expect(globArea('src/api/x.ts', 2)).toBe('src/api');
    expect(globArea('src/*.ts', 2)).toBe('src');
    expect(globArea('*.md', 2)).toBe(ROOT_AREA);
    expect(globArea('README.md', 2)).toBe(ROOT_AREA);
    expect(globArea('src/**', 2)).toBeNull();
    expect(globArea('**/*.ts', 2)).toBeNull();
    expect(globArea('src/**', 1)).toBe('src');
    expect(mainArea(['src/ui/**', 'src/api/a/**', 'src/api/b/**'], 2)).toBe('src/api');
    expect(mainArea(['src/ui/**', 'src/api/**'], 2)).toBe('src/ui');
    expect(mainArea(['**'], 2)).toBeNull();
  });

  it('suggests an agent only with a clear difference in the main area, never the same one', () => {
    const parts = [
      { key: 'api', agent: 'claude-code', owns: ['src/api/**'] },
      { key: 'ui', agent: 'claude-code', owns: ['src/ui/**'] },
      { key: 'api2', agent: 'codex', owns: ['SRC/API/billing/**'] },
      // Touches src/api, but lives mostly in src/ui.
      { key: 'mixed', agent: 'claude-code', owns: ['src/ui/a/**', 'src/ui/b/**', 'src/api/x.ts'] },
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
