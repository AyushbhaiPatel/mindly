import { readFileSync, statSync } from 'node:fs';
import { invalidInput, isDeniedPath, sanitizeLine, tryResolveInsideRoot } from '@mindly/core';
import {
  TRACK_MAX_ROWS,
  type PendingSurvival,
  type TrackEditGroup,
  type TrackSurvivalGroup,
} from '@mindly/store';
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
/**
 * Agents are compared only when the higher breakage count comes from at least this many
 * sessions: edits of one session are not independent, so one bad session is not a pattern.
 */
export const TRACK_MIN_BREAK_SESSIONS = 2;
/** z for a two-sided 95% interval. */
export const WILSON_Z = 1.959963984540054;

/** The breakage measures. Agents are compared on `breakages` (their sum) only. */
export const TRACK_BREAKAGE_MEASURES = ['breakages', 'bisect', 'contracts', 'mergeChecks'] as const;
export type TrackBreakageMeasure = (typeof TRACK_BREAKAGE_MEASURES)[number];

/** The fixed one-line definition of each measure (`mindly track --explain`, docs). */
export const TRACK_EXPLAIN = {
  edits:
    'Edits: agent edits Mindly recorded in the area, the sessions that made them, and lines added and removed. Volume, not quality.',
  bisect:
    "Broke a check: reliable mindly bisect results whose first failing step is one edit of this agent (not a gap or outside step), once per step, at the time of that edit, in its files' areas.",
  contracts:
    "Broke a decision: each time a recorded decision (contract) started failing right after an edit of this agent in the project's own checkout, in the contract's files.",
  mergeChecks:
    "Failed merge checks: merge conflicts found by shadow merges and split merge checks that name exactly one session, this agent's. Failing checks are not counted: a merge check cannot tell whose change made one fail.",
  breakages:
    'Broke: the three above added up, out of the edits in the area. Agents are compared on this only, and only when the higher count comes from at least 2 sessions. Outcomes involving several sessions count for nobody; dismissed conflicts do not count.',
  ruleAttempts:
    'Tried to break a rule: confirmed saves where an enforced rule blocked a write of this agent. A count of attempts, not damage, and not a rate: blocked writes are not edits.',
  kept: 'Kept: of the lines this agent added or changed at least 7 days ago (tracked lines, whole lines of the file), how many are still in the file on the branch it worked on. Later rewrites by anyone count as not kept; deny-listed files and files over 512 KB are skipped.',
  usageLimits:
    'Usage limits: sessions of this agent seen in the window that hit a usage limit or handed work off because of one. Per agent, not per area.',
} as const;

/** The minimum-data rule in one line. */
export function trackMinimumRule(minEdits: number, minSessions: number): string {
  return `Rates appear only for an agent with at least ${minEdits} edits and ${minSessions} sessions in an area (for kept lines: that many checked edits and sessions); "clear difference" means their 95% Wilson intervals do not overlap.`;
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

/**
 * The Wilson score interval of `k` successes in `n` trials (95% by default); null without trials
 * or when `k` is not between 0 and `n` (then it is not a proportion).
 */
export function wilson(k: number, n: number, z = WILSON_Z): TrackInterval | null {
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(k) || k < 0 || k > n) return null;
  const p = k / n;
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

/**
 * A count out of a denominator. `rate` and `interval` are null below the minimum data, and when
 * the count is not a share of the denominator (larger than it, or not a rate at all).
 */
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
  /** Distinct sessions behind the breakages. */
  breakageSessions: number;
  bisect: TrackRate;
  contracts: TrackRate;
  mergeChecks: TrackRate;
  /** Writes blocked by an enforced rule: a count only (`rate` is always null). */
  ruleAttempts: TrackRate;
  /** Tracked lines still in the file, out of those added at least 7 days ago. */
  kept: TrackRate;
  /** Edits and sessions behind `kept` (its own minimum data). */
  keptFrom: { edits: number; sessions: number };
}

/** One agent's breakage interval lies entirely below another's. */
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
  /** Most edits first, at most {@link TRACK_MAX_AREAS} (`totals.areas` counts them all). */
  areas: TrackArea[];
  usageLimits: TrackUsage[];
  survival: { pending: number; checkedNow: number };
  /** True when a query hit its row limit, so some data was left out. */
  truncated: boolean;
}

/** An outcome pinned to one session of one agent, with the paths it is about. */
export interface TrackOutcome {
  agent: string;
  sessionId: string;
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
  truncated?: boolean;
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
  breakSessions: Set<string>;
  ruleAttempts: number;
  keptTotal: number;
  kept: number;
  keptEdits: number;
  keptSessions: Set<string>;
}

function rateOf(count: number, of: number, show: boolean): TrackRate {
  const ok = show && of > 0 && count <= of;
  return { count, of, rate: ok ? count / of : null, interval: ok ? wilson(count, of) : null };
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
        breakSessions: new Set(),
        ruleAttempts: 0,
        keptTotal: 0,
        kept: 0,
        keptEdits: 0,
        keptSessions: new Set(),
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
      a.keptEdits += s.edits;
      a.keptSessions.add(s.sessionId);
    }
  }
  for (const out of inputs.outcomes) {
    if (!wanted(out.agent)) continue;
    // Once per outcome in each area it touches.
    for (const area of areasOf(out.paths)) {
      const a = acc(area, out.agent);
      a[out.measure] += 1;
      if (out.measure !== 'ruleAttempts') a.breakSessions.add(out.sessionId);
    }
  }

  const areas: TrackArea[] = [];
  for (const [area, agents] of byArea) {
    const rows: TrackAgentArea[] = [...agents]
      .map(([agent, a]): TrackAgentArea => {
        const enough = a.edits >= o.minEdits && a.sessions.size >= o.minSessions;
        const keptEnough =
          enough && a.keptEdits >= o.minEdits && a.keptSessions.size >= o.minSessions;
        return {
          agent: trackLabel(agent, 40),
          edits: a.edits,
          sessions: a.sessions.size,
          linesAdded: a.added,
          linesRemoved: a.removed,
          enoughData: enough,
          breakages: rateOf(a.bisect + a.contracts + a.mergeChecks, a.edits, enough),
          breakageSessions: a.breakSessions.size,
          bisect: rateOf(a.bisect, a.edits, enough),
          contracts: rateOf(a.contracts, a.edits, enough),
          mergeChecks: rateOf(a.mergeChecks, a.edits, enough),
          ruleAttempts: rateOf(a.ruleAttempts, a.edits, false),
          kept: rateOf(a.kept, a.keptTotal, keptEnough),
          keptFrom: { edits: a.keptEdits, sessions: a.keptSessions.size },
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
    truncated: inputs.truncated === true,
  };
}

/**
 * Pairs of agents with enough data whose breakage intervals do not overlap, where the higher
 * count comes from at least {@link TRACK_MIN_BREAK_SESSIONS} sessions. Only the sum is compared:
 * more comparisons would make a chance "difference" somewhere likely.
 */
function differences(rows: readonly TrackAgentArea[]): TrackDifference[] {
  const eligible = rows.filter((r) => r.enoughData);
  const out: TrackDifference[] = [];
  for (const a of eligible) {
    for (const b of eligible) {
      if (a === b || b.breakageSessions < TRACK_MIN_BREAK_SESSIONS) continue;
      if (!clearlyBelow(a.breakages.interval, b.breakages.interval)) continue;
      out.push({
        measure: 'breakages',
        better: { agent: a.agent, count: a.breakages.count, of: a.breakages.of },
        worse: { agent: b.agent, count: b.breakages.count, of: b.breakages.of },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Split integration
// ---------------------------------------------------------------------------------------------

/** Clear breakage differences of an area among `agents`. */
function areaDifferences(area: TrackArea, agents: ReadonlySet<string>): TrackDifference[] {
  return area.clearDifference.filter(
    (d) => agents.has(d.better.agent) && agents.has(d.worse.agent),
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
      .filter((r) => r.enoughData && r.breakages.rate !== null && allowed.has(r.agent))
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

/**
 * The single area an owns glob lies in at `depth`: `src/api/billing/**` is `src/api`, `src/*.ts`
 * is `src`, `*.md` is `(root)`. Null when it spans several areas (`src/**` at depth 2, `**`).
 */
export function globArea(glob: string, depth: number): string | null {
  const segs = posixPath(glob.trim())
    .split('/')
    .filter((s) => s !== '');
  if (segs.length === 0) return null;
  const fixed: string[] = [];
  for (const s of segs) {
    if (/[*?[\]{}!]/.test(s)) break;
    fixed.push(s);
  }
  if (fixed.length === segs.length) return areaOf(segs.join('/'), depth);
  const d = Math.max(1, Math.min(4, Math.trunc(depth)));
  if (fixed.length >= d) return fixed.slice(0, d).join('/');
  // A pattern for the files of one folder (`src/*.ts`, `*.md`) lies in that folder's area.
  if (fixed.length === segs.length - 1 && segs[segs.length - 1] !== '**') {
    return fixed.length === 0 ? ROOT_AREA : fixed.join('/');
  }
  return null;
}

/** The area most of a part's owns globs lie in (the first one on a tie), or null. */
export function mainArea(owns: readonly string[], depth: number): string | null {
  const counts = new Map<string, number>();
  for (const g of owns) {
    const a = globArea(g, depth);
    if (a !== null) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [a, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = a;
  return best;
}

/**
 * The agent the track record favours for each part, in the part's main area: an agent clearly
 * below another on breakages and clearly above none. Nothing when there is no clear difference
 * there, or when it is the agent the plan already chose. Never changes the plan.
 */
export function suggestAgents(
  report: TrackReport,
  parts: readonly { key: string; agent: string; owns: readonly string[] }[],
  agents: readonly string[],
): Map<string, TrackSuggestion> {
  const allowed = new Set(agents);
  const out = new Map<string, TrackSuggestion>();
  for (const part of parts) {
    const main = mainArea(part.owns, report.areaDepth)?.toLowerCase();
    const area = report.areas.find((a) => a.area.toLowerCase() === main);
    if (!area) continue;
    const diffs = areaDifferences(area, allowed);
    if (diffs.length === 0) continue;
    const worseOnes = new Set(diffs.map((d) => d.worse.agent));
    const best = diffs
      .filter((d) => !worseOnes.has(d.better.agent))
      .sort((x, y) => x.better.count / x.better.of - y.better.count / y.better.of)[0];
    if (!best || best.better.agent === part.agent) continue;
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
  /** Edits left unchecked this time because their file could not be read (tried again later). */
  deferred: number;
  /** Edits in scope still waiting for their check (0 for the all-projects run). */
  pending: number;
}

/** The blamed step of a bisect run, as far as attribution needs it. */
interface BlamedStep {
  key: string;
  kind: 'agent' | 'outside' | 'baseline';
  gap: boolean;
  sessionId: string | null;
  paths: string[];
  at: number;
}

/** What survival compares against: the lines of the file, nothing (gone), skip, or try later. */
type FileLines = Set<string> | 'absent' | 'skip' | 'defer';

/** The checkout an edit's path is relative to, and its current branch. */
interface Tree {
  root: string;
  branch: string | null;
}

export class TrackService {
  /** Where the all-projects survival scan stopped, so edits it cannot read never block others. */
  private cursor: { createdAt: number; id: string } | null = null;

  constructor(private readonly k: Kernel) {}

  /** The track record of a project. Reads only. */
  report(projectId: string, o: TrackOptions): TrackReport {
    const store = this.k.store;
    const cfg = this.k.config.track;
    const now = this.k.clock.now();
    const from = now - o.windowMs;
    const agentKinds = store.track.agentKinds(projectId);
    const bisect = this.bisectBlames(projectId, from, agentKinds);
    const conflicts = this.conflictBlames(projectId, from, agentKinds);
    const rules = this.ruleAttempts(projectId, from, agentKinds);
    const survivedBefore = now - SURVIVAL_AGE_MS;
    const edits = store.track.editGroups(projectId, from);
    const survival =
      survivedBefore >= from ? store.track.survivalGroups(projectId, from, survivedBefore) : [];
    const sessions = store.track.sessionsSeen(projectId, from);
    const truncated =
      agentKinds.size >= TRACK_MAX_ROWS ||
      bisect.truncated === true ||
      conflicts.truncated === true ||
      rules.truncated === true ||
      [edits, survival, sessions].some((r) => r.length >= TRACK_MAX_ROWS);
    return buildTrackReport(
      {
        edits,
        survival,
        outcomes: [...bisect, ...conflicts, ...rules],
        sessions,
        limited: store.track.limitedSessionIds(projectId, from),
        truncated,
      },
      {
        window: { since: o.since, from, to: now },
        areaDepth: o.areaDepth ?? cfg.areaDepth,
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

  /**
   * Reliable bisect results whose first bad step is one agent edit (not a gap, not outside),
   * counted once per step and only when that edit is in the window.
   */
  private bisectBlames(
    projectId: string,
    from: number,
    agentKinds: ReadonlyMap<string, string>,
  ): TrackOutcome[] & { truncated?: boolean } {
    const out: TrackOutcome[] & { truncated?: boolean } = [];
    const runs = this.k.store.track.bisectRuns(projectId, from);
    out.truncated = runs.length >= TRACK_MAX_ROWS;
    const seen = new Set<string>();
    for (const run of runs) {
      const r = run.result;
      if (r['status'] !== 'found' || r['flaky'] === true) continue;
      const step = this.blamedStep(projectId, run.input, r, run.createdAt);
      if (!step || step.kind !== 'agent' || step.gap || !step.sessionId) continue;
      if (step.at < from || seen.has(step.key)) continue;
      seen.add(step.key);
      const agent = agentKinds.get(step.sessionId);
      if (!agent || step.paths.length === 0) continue;
      out.push({ agent, sessionId: step.sessionId, paths: step.paths, measure: 'bisect' });
    }
    return out;
  }

  /**
   * The first bad step of a bisect run: the copy stored with the result, else the checkpoint
   * row (runs recorded before the copy was kept), looked up by working tree and step number.
   */
  private blamedStep(
    projectId: string,
    input: Record<string, unknown>,
    result: Record<string, unknown>,
    runAt: number,
  ): BlamedStep | null {
    const seq = result['firstBad'];
    const range = input['range'];
    const worktree =
      range !== null && typeof range === 'object'
        ? (range as Record<string, unknown>)['worktree']
        : undefined;
    const blame = result['blame'];
    if (blame !== null && typeof blame === 'object') {
      const b = blame as Record<string, unknown>;
      return {
        key:
          typeof b['checkpointId'] === 'string'
            ? b['checkpointId']
            : `${String(worktree)}\u0000${String(seq)}`,
        kind: b['kind'] === 'agent' ? 'agent' : 'outside',
        gap: b['gap'] !== false,
        sessionId: typeof b['sessionId'] === 'string' ? b['sessionId'] : null,
        paths: Array.isArray(b['paths'])
          ? b['paths'].filter((p): p is string => typeof p === 'string').slice(0, 200)
          : [],
        at: typeof b['at'] === 'number' ? b['at'] : runAt,
      };
    }
    if (typeof seq !== 'number' || typeof worktree !== 'string') return null;
    const step = this.k.store.checkpoints.bySeq(projectId, worktree, seq);
    if (!step) return null;
    return {
      key: step.id,
      kind: step.kind,
      gap: step.gap,
      sessionId: step.sessionId,
      paths: step.paths,
      at: step.createdAt,
    };
  }

  /**
   * Each opening of a contract or merge conflict that named exactly one session, from the
   * `conflict.opened` event of that opening (the conflict row is overwritten by later reports).
   * A contract counts only when the edit that broke it was made in the project's own checkout,
   * since that is what the contract is checked against. Dismissed conflicts never count.
   */
  private conflictBlames(
    projectId: string,
    from: number,
    agentKinds: ReadonlyMap<string, string>,
  ): TrackOutcome[] & { truncated?: boolean } {
    const out: TrackOutcome[] & { truncated?: boolean } = [];
    const openings = this.k.store.track.conflictOpenings(
      projectId,
      ['contract_broken', 'merge_conflict'],
      from,
    );
    out.truncated = openings.length >= TRACK_MAX_ROWS;
    const dismissed = this.k.store.track.dismissedConflicts(projectId);
    for (const c of openings) {
      if (dismissed.has(c.conflictId) || c.sessionIds === null) continue;
      const ids = [...new Set(c.sessionIds)];
      if (ids.length !== 1) continue;
      if (c.kind === 'contract_broken' && c.actorInRoot !== true) continue;
      const sessionId = ids[0] as string;
      const agent = agentKinds.get(sessionId);
      if (!agent) continue;
      out.push({
        agent,
        sessionId,
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
  ): TrackOutcome[] & { truncated?: boolean } {
    const out: TrackOutcome[] & { truncated?: boolean } = [];
    const saves = this.k.store.track.confirmedSaves(projectId, 'rule_enforced', from);
    out.truncated = saves.length >= TRACK_MAX_ROWS;
    for (const s of saves) {
      const sessionId = s.sessionIds[0] ?? '';
      const agent = agentKinds.get(sessionId);
      if (agent) out.push({ agent, sessionId, paths: s.paths, measure: 'ruleAttempts' });
    }
    return out;
  }

  /**
   * Computes line survival for edits at least 7 days old that have none: how many of the whole
   * lines the edit added are still in the file, on the branch the session worked on (the working
   * file when that branch is checked out, else the branch tip). A missing file keeps nothing.
   * Deny-listed files, files over 512 KB and edits whose branch is unknown or gone are skipped
   * (stored as 0 of 0, never counted); edits whose checkout cannot be read now are left for a
   * later run. Bounded by `max` edits and, when given, `budgetMs` of wall-clock time.
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
    const all = o.projectId === null;
    const pending = store.track.pendingSurvival(
      o.projectId,
      before,
      o.max,
      o.from ?? 0,
      all ? this.cursor : null,
    );
    const trees = new Map<string, Tree | null>();
    const files = new Map<string, FileLines>();
    let checked = 0;
    let deferred = 0;
    let last: PendingSurvival | null = null;
    let stopped = false;
    for (const p of pending) {
      if (o.budgetMs !== undefined && Date.now() - started > o.budgetMs) {
        stopped = true;
        break;
      }
      last = p;
      const hashes = store.track.hashes(p.changeId);
      let lines: FileLines = 'skip';
      if (hashes.length > 0 && !isDeniedPath(p.path, this.k.config.redaction.denyPaths)) {
        lines = await this.linesOf(p, trees, files);
      }
      if (lines === 'defer') {
        deferred++;
        continue;
      }
      store.track.recordSurvival({
        changeId: p.changeId,
        projectId: p.projectId,
        totalHashes: lines === 'skip' ? 0 : hashes.length,
        keptHashes: typeof lines === 'object' ? hashes.filter((h) => lines.has(h)).length : 0,
      });
      checked++;
    }
    if (all) {
      // Continue after the last edit looked at; start over once the scan reached the end.
      this.cursor =
        (stopped || pending.length >= o.max) && last
          ? { createdAt: last.createdAt, id: last.changeId }
          : null;
    }
    return {
      checked,
      deferred,
      pending:
        o.projectId === null
          ? 0
          : store.track.countPendingSurvival(o.projectId, before, o.from ?? 0),
    };
  }

  /** The current lines of an edit's file (cached per checkout, branch and path within a run). */
  private async linesOf(
    p: PendingSurvival,
    trees: Map<string, Tree | null>,
    files: Map<string, FileLines>,
  ): Promise<FileLines> {
    const tree = await this.treeOf(p, trees);
    if (tree === null) return 'defer';
    // Without the branch the edit was made on there is no telling which code it should be in.
    if (p.branch === null) return 'skip';
    const key = `${tree.root}\u0000${p.branch}\u0000${p.path}`;
    const cached = files.get(key);
    if (cached !== undefined) return cached;
    const lines =
      tree.branch === p.branch
        ? this.workingLines(tree.root, p.path)
        : await this.branchLines(tree.root, p.branch, p.path);
    files.set(key, lines);
    return lines;
  }

  /**
   * The checkout an edit's path is relative to: the session's own, else the project's (a split
   * worktree removed after merging). Null when neither can be read now.
   */
  private async treeOf(p: PendingSurvival, cache: Map<string, Tree | null>): Promise<Tree | null> {
    if (cache.has(p.sessionId)) return cache.get(p.sessionId) ?? null;
    const git = this.k.ports.git;
    let root: string | null = null;
    if (isDirectory(p.worktree)) root = await git.findRepoRoot(p.worktree);
    if (root === null) {
      try {
        const projectRoot = this.k.store.projects.get(p.projectId).root;
        if (isDirectory(projectRoot)) root = projectRoot;
      } catch {
        root = null;
      }
    }
    const tree = root === null ? null : { root, branch: await git.currentBranch(root) };
    cache.set(p.sessionId, tree);
    return tree;
  }

  /** Lines of the file in the checkout itself. */
  private workingLines(root: string, path: string): FileLines {
    const resolved = tryResolveInsideRoot(root, path);
    // A path that now leads outside the tree (a symlink) or to a deny-listed file is never read.
    if (!resolved || resolved.rel === '') return 'skip';
    if (isDeniedPath(resolved.rel, this.k.config.redaction.denyPaths)) return 'skip';
    let content: string;
    try {
      const st = statSync(resolved.abs);
      if (!st.isFile()) return 'absent';
      if (st.size > SURVIVAL_MAX_FILE_BYTES) return 'skip';
      content = readFileSync(resolved.abs, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'defer';
    }
    return new Set(this.k.ports.git.hunkHashes(content));
  }

  /** Lines of the file at the tip of `branch`, without checking it out. */
  private async branchLines(root: string, branch: string, path: string): Promise<FileLines> {
    const git = this.k.ports.git;
    if (!git.fileStateAtRef) return 'skip';
    const at = await git.fileStateAtRef(
      root,
      `refs/heads/${branch}`,
      path,
      SURVIVAL_MAX_FILE_BYTES,
    );
    if (at === null) return 'defer';
    switch (at.state) {
      case 'file':
        return new Set(git.hunkHashes(at.content));
      case 'absent':
        return 'absent';
      case 'no_ref':
      case 'too_large':
        return 'skip';
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The track record service of `mindly`. */
export function trackOf(mindly: Mindly): TrackService {
  return serviceOf(mindly, 'track', () => new TrackService(mindly.kernel));
}
