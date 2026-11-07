import { readFileSync, statSync } from 'node:fs';
import {
  invalidInput,
  isDeniedPath,
  sanitizeLine,
  tryResolveInsideRoot,
  type Checkpoint,
} from '@mindly/core';
import type { PendingSurvival, TrackEditGroup, TrackSurvivalGroup } from '@mindly/store';
import type { Kernel } from '../kernel.js';
import type { Mindly } from '../mindly.js';
import { serviceOf } from './shared.js';

/*
 * `mindly track`: a per-repository track record of each agent, from outcomes Mindly already
 * stored. Nothing here scores or ranks agents: every measure is shown on its own with its counts,
 * rates only appear with enough data, and "clear difference" means 95% Wilson intervals that do
 * not overlap. An outcome counts against an agent only when the stored evidence ties it to
 * exactly one of its sessions.
 */

const DAY_MS = 86_400_000;

/** Files at the repository root form this area. */
export const ROOT_AREA = '(root)';
/** Default window of `mindly track`. */
export const TRACK_DEFAULT_WINDOW_MS = 30 * DAY_MS;
/** An edit's lines are checked once it is this old. */
export const SURVIVAL_AGE_MS = 7 * DAY_MS;
/** Files larger than this are skipped by the survival check (never read, never counted). */
export const SURVIVAL_MAX_FILE_BYTES = 512 * 1024;
/** At most this many areas in a report. */
export const TRACK_MAX_AREAS = 200;
/** z for a two-sided 95% interval. */
export const WILSON_Z = 1.959963984540054;

/** The breakage measures, the only ones agents are compared on. */
export const TRACK_BREAKAGE_MEASURES = ['breakages', 'bisect', 'contracts', 'mergeChecks'] as const;
export type TrackBreakageMeasure = (typeof TRACK_BREAKAGE_MEASURES)[number];

/** The fixed one-line definition of each measure (`mindly track --explain`, docs). */
export const TRACK_EXPLAIN = {
  edits:
    'Edits: agent edits Mindly recorded in the area, the sessions that made them, and lines added and removed. Volume, not quality.',
  bisect:
    "Broke a check: reliable mindly bisect runs whose first failing step is one edit of this agent (not a gap or outside step), once per run, in the areas of that step's files.",
  contracts:
    "Broke a decision: recorded decisions (contracts) that started failing, when the conflict names exactly one session and it is this agent's, in the contract's files.",
  mergeChecks:
    "Failed merge checks: shadow-merge and split merge checks that failed or conflicted, when the conflict names exactly one session and it is this agent's, in its files.",
  breakages:
    'Broke: the three above added up, out of the edits in the area. Outcomes involving several sessions count for nobody; dismissed conflicts do not count.',
  ruleAttempts:
    'Tried to break a rule: confirmed saves where an enforced rule blocked a write of this agent. Attempts, not damage.',
  kept: 'Kept: of the lines this agent added at least 7 days ago, how many are still in the file. Later rewrites by anyone count as not kept; deny-listed files and files over 512 KB are skipped.',
  usageLimits:
    'Usage limits: sessions of this agent seen in the window that hit a usage limit or handed work off because of one. Per agent, not per area.',
} as const;

/** The minimum-data rule in one line. */
export function trackMinimumRule(minEdits: number, minSessions: number): string {
  return `Rates appear only for an agent with at least ${minEdits} edits and ${minSessions} sessions in an area; "clear difference" means their 95% Wilson intervals do not overlap.`;
}

// Terminal escape sequences: dropped whole, not just their escape character.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** A path, area or name from the store, safe to print and to put in a prompt. */
export function trackLabel(text: string, max = 200): string {
  return sanitizeLine(text.replace(ANSI_RE, ''), max);
}

// ---------------------------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------------------------

function posixPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

/** The area of a tree-relative path: its first `depth` folders, or `(root)` for root files. */
export function areaOf(path: string, depth: number): string {
  const segs = posixPath(path)
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (segs.length <= 1) return ROOT_AREA;
  const d = Math.max(1, Math.min(4, Math.trunc(depth)));
  return segs.slice(0, Math.min(d, segs.length - 1)).join('/');
}

/** Normalises an `--area` prefix. Throws `invalid_input` for anything that is not a plain folder path. */
export function parseAreaPrefix(input: string): string {
  const raw = input.trim();
  if (raw === ROOT_AREA) return ROOT_AREA;
  // eslint-disable-next-line no-control-regex
  if (raw === '' || raw.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) {
    throw invalidInput('area must be a folder path such as src/api, or (root)');
  }
  const p = posixPath(raw).replace(/\/+$/, '');
  const segs = p.split('/');
  if (p === '' || segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw invalidInput('area must be a folder path such as src/api, or (root)');
  }
  return segs.join('/');
}

/** True when `path` lies in the area `prefix` (any depth). */
export function inArea(path: string, prefix: string): boolean {
  const p = posixPath(path);
  if (prefix === ROOT_AREA) return !p.includes('/');
  return p === prefix || p.startsWith(`${prefix}/`);
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

export interface TrackInterval {
  low: number;
  high: number;
}

/** The Wilson score interval of `k` successes in `n` trials (95% by default); null without trials. */
export function wilson(k: number, n: number, z = WILSON_Z): TrackInterval | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const kk = Math.max(0, Math.min(k, n));
  const p = kk / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Rounding noise at the ends (0 of n, n of n) is not a rate.
  const low = center - half < 1e-12 ? 0 : center - half;
  const high = center + half > 1 - 1e-12 ? 1 : center + half;
  return { low, high };
}

/** True when interval `a` lies entirely below `b` (touching or overlapping is no difference). */
export function clearlyBelow(a: TrackInterval | null, b: TrackInterval | null): boolean {
  return a !== null && b !== null && a.high < b.low;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

/** A count out of a denominator. `rate` and `interval` are null below the minimum data. */
export interface TrackRate {
  count: number;
  of: number;
  rate: number | null;
  interval: TrackInterval | null;
}

/** One agent in one area. */
export interface TrackAgentArea {
  agent: string;
  edits: number;
  /** Sessions with at least one edit in the area. */
  sessions: number;
  linesAdded: number;
  linesRemoved: number;
  /** At least the minimum edits and sessions: only then are rates shown. */
  enoughData: boolean;
  /** Broke a check + broke a decision + failed merge checks, out of edits. */
  breakages: TrackRate;
  bisect: TrackRate;
  contracts: TrackRate;
  mergeChecks: TrackRate;
  /** Writes blocked by an enforced rule, out of edits. */
  ruleAttempts: TrackRate;
  /** Line hashes still in the file, out of those added at least 7 days ago. */
  kept: TrackRate;
}

/** One agent's breakage interval lies entirely below another's on `measure`. */
export interface TrackDifference {
  measure: TrackBreakageMeasure;
  better: { agent: string; count: number; of: number };
  worse: { agent: string; count: number; of: number };
}

export interface TrackArea {
  area: string;
  edits: number;
  /** Most edits first. */
  agents: TrackAgentArea[];
  clearDifference: TrackDifference[];
}

export interface TrackUsage {
  agent: string;
  limited: number;
  sessions: number;
}

export interface TrackReport {
  window: { since: string; from: number; to: number };
  areaDepth: number;
  filter: { area: string | null; agent: string | null };
  minimum: { edits: number; sessions: number };
  totals: { agents: number; edits: number; areas: number };
  /** Most edits first, at most {@link TRACK_MAX_AREAS}. */
  areas: TrackArea[];
  usageLimits: TrackUsage[];
  survival: { pending: number; checkedNow: number };
}

/** An outcome pinned to one agent, with the paths it is about. */
export interface TrackOutcome {
  agent: string;
  paths: readonly string[];
  measure: 'bisect' | 'contracts' | 'mergeChecks' | 'ruleAttempts';
}

/** Everything a report is built from (all already tied to an agent). */
export interface TrackInputs {
  edits: readonly TrackEditGroup[];
  survival: readonly TrackSurvivalGroup[];
  outcomes: readonly TrackOutcome[];
  sessions: readonly { id: string; agentKind: string; status: string }[];
  limited: ReadonlySet<string>;
}

export interface TrackReportOptions {
  window: { since: string; from: number; to: number };
  areaDepth: number;
  minEdits: number;
  minSessions: number;
  area?: string | null;
  agent?: string | null;
  survivalPending?: number;
  checkedNow?: number;
}

interface Acc {
  edits: number;
  sessions: Set<string>;
  added: number;
  removed: number;
  bisect: number;
  contracts: number;
  mergeChecks: number;
  ruleAttempts: number;
  keptTotal: number;
  kept: number;
}

function rateOf(count: number, of: number, show: boolean): TrackRate {
  return {
    count,
    of,
    rate: show && of > 0 ? count / of : null,
    interval: show ? wilson(count, of) : null,
  };
}

/** Builds the report from inputs already tied to agents. Pure; tested directly. */
export function buildTrackReport(inputs: TrackInputs, o: TrackReportOptions): TrackReport {
  const areaFilter = o.area ?? null;
  const agentFilter = o.agent ?? null;
  const areasOf = (paths: readonly string[]): string[] => {
    if (areaFilter !== null) return paths.some((p) => inArea(p, areaFilter)) ? [areaFilter] : [];
    return [...new Set(paths.map((p) => areaOf(p, o.areaDepth)))];
  };
  const byArea = new Map<string, Map<string, Acc>>();
  const acc = (area: string, agent: string): Acc => {
    let agents = byArea.get(area);
    if (!agents) byArea.set(area, (agents = new Map()));
    let a = agents.get(agent);
    if (!a) {
      a = {
        edits: 0,
        sessions: new Set(),
        added: 0,
        removed: 0,
        bisect: 0,
        contracts: 0,
        mergeChecks: 0,
        ruleAttempts: 0,
        keptTotal: 0,
        kept: 0,
      };
      agents.set(agent, a);
    }
    return a;
  };
  const wanted = (agent: string): boolean => agentFilter === null || agent === agentFilter;

  for (const e of inputs.edits) {
    if (!wanted(e.agentKind)) continue;
    for (const area of areasOf([e.path])) {
      const a = acc(area, e.agentKind);
      a.edits += e.edits;
      a.sessions.add(e.sessionId);
      a.added += e.addedLines;
      a.removed += e.removedLines;
    }
  }
  for (const s of inputs.survival) {
    if (!wanted(s.agentKind)) continue;
    for (const area of areasOf([s.path])) {
      const a = acc(area, s.agentKind);
      a.keptTotal += s.totalHashes;
      a.kept += s.keptHashes;
    }
  }
  for (const out of inputs.outcomes) {
    if (!wanted(out.agent)) continue;
    // Once per outcome in each area it touches.
    for (const area of areasOf(out.paths)) acc(area, out.agent)[out.measure] += 1;
  }

  const areas: TrackArea[] = [];
  for (const [area, agents] of byArea) {
    const rows: TrackAgentArea[] = [...agents]
      .map(([agent, a]): TrackAgentArea => {
        const enough = a.edits >= o.minEdits && a.sessions.size >= o.minSessions;
        const broke = a.bisect + a.contracts + a.mergeChecks;
        return {
          agent: trackLabel(agent, 40),
          edits: a.edits,
          sessions: a.sessions.size,
          linesAdded: a.added,
          linesRemoved: a.removed,
          enoughData: enough,
          breakages: rateOf(broke, a.edits, enough),
          bisect: rateOf(a.bisect, a.edits, enough),
          contracts: rateOf(a.contracts, a.edits, enough),
          mergeChecks: rateOf(a.mergeChecks, a.edits, enough),
          ruleAttempts: rateOf(a.ruleAttempts, a.edits, enough),
          kept: rateOf(a.kept, a.keptTotal, enough && a.keptTotal > 0),
        };
      })
      .sort((x, y) => y.edits - x.edits || x.agent.localeCompare(y.agent));
    areas.push({
      area: trackLabel(area, 200),
      edits: rows.reduce((n, r) => n + r.edits, 0),
      agents: rows,
      clearDifference: differences(rows),
    });
  }
  areas.sort((x, y) => y.edits - x.edits || x.area.localeCompare(y.area));

  const usage = new Map<string, TrackUsage>();
  for (const s of inputs.sessions) {
    if (!wanted(s.agentKind)) continue;
    const u = usage.get(s.agentKind) ?? {
      agent: trackLabel(s.agentKind, 40),
      limited: 0,
      sessions: 0,
    };
    u.sessions += 1;
    if (inputs.limited.has(s.id) || s.status === 'rate_limited') u.limited += 1;
    usage.set(s.agentKind, u);
  }

  const agentsWithEdits = new Set<string>();
  let edits = 0;
  for (const a of areas) {
    edits += a.edits;
    for (const r of a.agents) if (r.edits > 0) agentsWithEdits.add(r.agent);
  }
  return {
    window: o.window,
    areaDepth: o.areaDepth,
    filter: { area: areaFilter === null ? null : trackLabel(areaFilter), agent: agentFilter },
    minimum: { edits: o.minEdits, sessions: o.minSessions },
    totals: { agents: agentsWithEdits.size, edits, areas: areas.length },
    areas: areas.slice(0, TRACK_MAX_AREAS),
    usageLimits: [...usage.values()].sort(
      (x, y) => y.sessions - x.sessions || x.agent.localeCompare(y.agent),
    ),
    survival: { pending: o.survivalPending ?? 0, checkedNow: o.checkedNow ?? 0 },
  };
}

/** Pairs of agents with enough data whose breakage intervals do not overlap. */
function differences(rows: readonly TrackAgentArea[]): TrackDifference[] {
  const eligible = rows.filter((r) => r.enoughData);
  const out: TrackDifference[] = [];
  for (const measure of TRACK_BREAKAGE_MEASURES) {
    for (const a of eligible) {
      for (const b of eligible) {
        if (a === b) continue;
        if (!clearlyBelow(a[measure].interval, b[measure].interval)) continue;
        out.push({
          measure,
          better: { agent: a.agent, count: a[measure].count, of: a[measure].of },
          worse: { agent: b.agent, count: b[measure].count, of: b[measure].of },
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Split integration
// ---------------------------------------------------------------------------------------------

/** Clear breakage differences of an area among `agents` (all agents when null). */
function areaDifferences(area: TrackArea, agents: ReadonlySet<string> | null): TrackDifference[] {
  return area.clearDifference.filter(
    (d) =>
      d.measure === 'breakages' &&
      (agents === null || (agents.has(d.better.agent) && agents.has(d.worse.agent))),
  );
}

/**
 * Lines of counts for the split planner, one per area with a clear difference among `agents`:
 * `track record (counts only): src/api — codex broke 1 of 212 edits, claude-code 7 of 188`.
 */
export function trackPromptLines(
  report: TrackReport,
  agents: readonly string[],
  max = 10,
): string[] {
  const allowed = new Set(agents);
  const lines: string[] = [];
  for (const area of report.areas) {
    if (lines.length >= max) break;
    if (areaDifferences(area, allowed).length === 0) continue;
    const rows = area.agents
      .filter((r) => r.enoughData && allowed.has(r.agent))
      .sort((x, y) => (x.breakages.rate ?? 0) - (y.breakages.rate ?? 0));
    const parts = rows.map((r, i) =>
      i === 0
        ? `${r.agent} broke ${r.breakages.count} of ${r.edits} edits`
        : `${r.agent} ${r.breakages.count} of ${r.edits}`,
    );
    lines.push(`track record (counts only): ${area.area} — ${parts.join(', ')}`);
  }
  return lines;
}

/** A suggested agent for a split part, with the counts behind it. */
export interface TrackSuggestion {
  agent: string;
  area: string;
  count: number;
  of: number;
  versus: { agent: string; count: number; of: number };
}

/** True when the owns glob covers files in `area`. */
export function globTouchesArea(glob: string, area: string): boolean {
  const g = posixPath(glob.trim()).toLowerCase();
  const a = area.toLowerCase();
  const segs = g.split('/');
  const fixed: string[] = [];
  for (const s of segs) {
    if (/[*?[\]{}!]/.test(s)) break;
    fixed.push(s);
  }
  const literal = fixed.length === segs.length;
  const next = segs[fixed.length];
  if (area === ROOT_AREA) return segs.length === 1 || (fixed.length === 0 && next === '**');
  const base = fixed.join('/');
  if (base === a || base.startsWith(`${a}/`)) return true;
  return !literal && next === '**' && (base === '' || a.startsWith(`${base}/`));
}

/**
 * The agent the track record favours for each part, by the area the part owns with the most
 * edits: an agent clearly below another on breakages and clearly above none. Parts without such
 * an area get nothing. Never changes the plan.
 */
export function suggestAgents(
  report: TrackReport,
  parts: readonly { key: string; agent: string; owns: readonly string[] }[],
  agents: readonly string[],
): Map<string, TrackSuggestion> {
  const allowed = new Set(agents);
  const out = new Map<string, TrackSuggestion>();
  for (const part of parts) {
    for (const area of report.areas) {
      if (!part.owns.some((g) => globTouchesArea(g, area.area))) continue;
      const diffs = areaDifferences(area, allowed);
      if (diffs.length === 0) continue;
      const worseOnes = new Set(diffs.map((d) => d.worse.agent));
      const best = diffs
        .filter((d) => !worseOnes.has(d.better.agent))
        .sort((x, y) => x.better.count / x.better.of - y.better.count / y.better.of)[0];
      if (!best) continue;
      const vs =
        diffs.find((d) => d.better.agent === best.better.agent && d.worse.agent === part.agent) ??
        diffs
          .filter((d) => d.better.agent === best.better.agent)
          .sort((x, y) => y.worse.count / y.worse.of - x.worse.count / x.worse.of)[0] ??
        best;
      out.set(part.key, {
        agent: best.better.agent,
        area: area.area,
        count: best.better.count,
        of: best.better.of,
        versus: vs.worse,
      });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export interface TrackOptions {
  /** Window length in milliseconds and how it was written (`30d`). */
  windowMs: number;
  since: string;
  area?: string | null;
  agent?: string | null;
  minEdits?: number;
  minSessions?: number;
  areaDepth?: number;
  /** Survival checks done just before (reported back). */
  checkedNow?: number;
}

export interface SurvivalRun {
  checked: number;
  /** Edits in scope still waiting for their check. */
  pending: number;
}

export class TrackService {
  constructor(private readonly k: Kernel) {}

  /** The track record of a project. Reads only. */
  report(projectId: string, o: TrackOptions): TrackReport {
    const store = this.k.store;
    const cfg = this.k.config.track;
    const now = this.k.clock.now();
    const from = now - o.windowMs;
    const areaDepth = o.areaDepth ?? cfg.areaDepth;
    const agentKinds = store.track.agentKinds(projectId);
    const outcomes: TrackOutcome[] = [
      ...this.bisectBlames(projectId, from, agentKinds),
      ...this.conflictBlames(projectId, from, agentKinds),
      ...this.ruleAttempts(projectId, from, agentKinds),
    ];
    const survivedBefore = now - SURVIVAL_AGE_MS;
    return buildTrackReport(
      {
        edits: store.track.editGroups(projectId, from),
        survival:
          survivedBefore >= from ? store.track.survivalGroups(projectId, from, survivedBefore) : [],
        outcomes,
        sessions: store.track.sessionsSeen(projectId, from),
        limited: store.track.limitedSessionIds(projectId, from),
      },
      {
        window: { since: o.since, from, to: now },
        areaDepth,
        minEdits: o.minEdits ?? cfg.minEdits,
        minSessions: o.minSessions ?? cfg.minSessions,
        area: o.area ?? null,
        agent: o.agent ?? null,
        survivalPending:
          survivedBefore >= from
            ? store.track.countPendingSurvival(projectId, survivedBefore, from)
            : 0,
        checkedNow: o.checkedNow ?? 0,
      },
    );
  }

  /** Reliable bisect results whose first bad step is one agent edit (not a gap, not outside). */
  private bisectBlames(
    projectId: string,
    from: number,
    agentKinds: ReadonlyMap<string, string>,
  ): TrackOutcome[] {
    const out: TrackOutcome[] = [];
    for (const run of this.k.store.track.bisectRuns(projectId, from)) {
      const r = run.result;
      if (r['status'] !== 'found' || r['flaky'] === true) continue;
      const step = this.blamedStep(projectId, run.input, r);
      if (!step || step.kind !== 'agent' || step.gap || !step.sessionId) continue;
      const agent = agentKinds.get(step.sessionId);
      if (!agent || step.paths.length === 0) continue;
      out.push({ agent, paths: step.paths, measure: 'bisect' });
    }
    return out;
  }

  /**
   * The first bad step of a bisect run: the copy stored with the result, else the checkpoint
   * row (older runs), looked up by working tree and step number.
   */
  private blamedStep(
    projectId: string,
    input: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Pick<Checkpoint, 'kind' | 'gap' | 'sessionId' | 'paths'> | null {
    const blame = result['blame'];
    if (blame !== null && typeof blame === 'object') {
      const b = blame as Record<string, unknown>;
      return {
        kind: b['kind'] === 'agent' ? 'agent' : 'outside',
        gap: b['gap'] !== false,
        sessionId: typeof b['sessionId'] === 'string' ? b['sessionId'] : null,
        paths: Array.isArray(b['paths'])
          ? b['paths'].filter((p): p is string => typeof p === 'string').slice(0, 200)
          : [],
      };
    }
    const seq = result['firstBad'];
    const range = input['range'];
    const worktree =
      range !== null && typeof range === 'object'
        ? (range as Record<string, unknown>)['worktree']
        : undefined;
    if (typeof seq !== 'number' || typeof worktree !== 'string') return null;
    return this.k.store.checkpoints.bySeq(projectId, worktree, seq);
  }

  /** Contract and merge-check conflicts that name exactly one session. */
  private conflictBlames(
    projectId: string,
    from: number,
    agentKinds: ReadonlyMap<string, string>,
  ): TrackOutcome[] {
    const out: TrackOutcome[] = [];
    const conflicts = this.k.store.track.conflicts(
      projectId,
      ['contract_broken', 'check_failed', 'merge_conflict'],
      from,
    );
    for (const c of conflicts) {
      if (c.status === 'dismissed') continue;
      const ids = [...new Set(c.sessionIds)];
      if (ids.length !== 1) continue;
      const agent = agentKinds.get(ids[0] as string);
      if (!agent) continue;
      out.push({
        agent,
        paths: c.paths,
        measure: c.kind === 'contract_broken' ? 'contracts' : 'mergeChecks',
      });
    }
    return out;
  }

  /** Confirmed saves where an enforced rule blocked a write (the blocked session is the first). */
  private ruleAttempts(
    projectId: string,
    from: number,
    agentKinds: ReadonlyMap<string, string>,
  ): TrackOutcome[] {
    const out: TrackOutcome[] = [];
    const saves = this.k.store.saves.list(projectId, {
      since: from,
      statuses: ['confirmed'],
      kinds: ['rule_enforced'],
      limit: 1000,
    });
    for (const s of saves) {
      const agent = agentKinds.get(s.sessionIds[0] ?? '');
      if (agent) out.push({ agent, paths: s.paths, measure: 'ruleAttempts' });
    }
    return out;
  }

  /**
   * Computes line survival for edits at least 7 days old that have none: hashes the current
   * file's lines and counts how many of the edit's stored hashes are still there. A missing file
   * keeps nothing; deny-listed and large files are skipped (stored as 0 of 0, never read).
   * Bounded by `max` edits and, when given, `budgetMs` of wall-clock time.
   */
  async computeSurvival(o: {
    projectId: string | null;
    max: number;
    budgetMs?: number;
    from?: number;
  }): Promise<SurvivalRun> {
    const store = this.k.store;
    const before = this.k.clock.now() - SURVIVAL_AGE_MS;
    const started = Date.now();
    const pending = store.track.pendingSurvival(o.projectId, before, o.max, o.from ?? 0);
    const roots = new Map<string, string | null>();
    let checked = 0;
    for (const p of pending) {
      if (o.budgetMs !== undefined && Date.now() - started > o.budgetMs) break;
      const root = await this.rootOf(p, roots);
      const hashes = store.track.hashes(p.changeId);
      const kept = root === null ? 0 : this.keptHashes(root, p.path, hashes);
      store.track.recordSurvival({
        changeId: p.changeId,
        projectId: p.projectId,
        totalHashes: kept === null ? 0 : hashes.length,
        keptHashes: kept ?? 0,
      });
      checked++;
    }
    const left =
      o.projectId === null ? 0 : store.track.countPendingSurvival(o.projectId, before, o.from ?? 0);
    return { checked, pending: left };
  }

  /** The tree an edit's path is relative to: the session's checkout, else the project root. */
  private async rootOf(
    p: PendingSurvival,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    if (cache.has(p.sessionId)) return cache.get(p.sessionId) ?? null;
    let root: string | null = null;
    try {
      if (statSync(p.worktree).isDirectory())
        root = await this.k.ports.git.findRepoRoot(p.worktree);
    } catch {
      root = null;
    }
    if (root === null) {
      try {
        root = this.k.store.projects.get(p.projectId).root;
      } catch {
        root = null;
      }
    }
    cache.set(p.sessionId, root);
    return root;
  }

  /** Kept hashes of one edit, or null when the file is skipped (deny-listed, too large, outside). */
  private keptHashes(root: string, path: string, hashes: readonly string[]): number | null {
    if (isDeniedPath(path, this.k.config.redaction.denyPaths)) return null;
    if (hashes.length === 0) return 0;
    const resolved = tryResolveInsideRoot(root, path);
    // A path that now leads outside the tree (a symlink) or to a deny-listed file is never read.
    if (!resolved || isDeniedPath(resolved.rel, this.k.config.redaction.denyPaths)) return null;
    if (resolved.rel === '') return 0;
    let content: string;
    try {
      const st = statSync(resolved.abs);
      if (!st.isFile()) return 0;
      if (st.size > SURVIVAL_MAX_FILE_BYTES) return null;
      content = readFileSync(resolved.abs, 'utf8');
    } catch {
      return 0;
    }
    const current = new Set(this.k.ports.git.hunkHashes(content));
    return hashes.filter((h) => current.has(h)).length;
  }
}

/** The track record service of `mindly`. */
export function trackOf(mindly: Mindly): TrackService {
  return serviceOf(mindly, 'track', () => new TrackService(mindly.kernel));
}
