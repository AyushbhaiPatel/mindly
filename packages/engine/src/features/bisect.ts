import {
  matchesAnyGlob,
  redactText,
  sanitizeLine,
  type Checkpoint,
  type CheckpointKind,
  type Memory,
  type MemoryKind,
  type Run,
  type RunStatus,
} from '@mindly/core';
import { sessionLabel } from '../coordination/work.js';
import type { Kernel } from '../kernel.js';
import { SYSTEM, USER, type MemoryService } from '../memory/service.js';

/*
 * `mindly bisect`: binary search over checkpoints for the first step where a command fails. The
 * search itself is pure (it only asks a runner for outcomes); the service around it explains a
 * step (who, from which prompt, under which rules) and records the run and the lesson.
 */

/** What running the command at one step said: like `git bisect run`, 0 good, 125 skip, else bad. */
export type StepOutcome = 'good' | 'bad' | 'skip';

/** The outcome of running the command once at one step. */
export interface StepCheck {
  seq: number;
  outcome: StepOutcome;
  /** Why the step was skipped, when it was. */
  skipReason: 'exit_125' | 'timeout' | 'setup_failed' | 'error' | null;
  exitCode: number | null;
  durationMs: number;
  /** Tail of the command's output (redacted and bounded by the runner). */
  output: string;
  /** True when the setup command ran before this check. */
  setupRan: boolean;
}

/** Runs the command under test at a step (the CLI does it in a scratch worktree). */
export interface BisectRunner {
  run(step: Checkpoint): Promise<StepCheck>;
}

/** What the search found. */
export type BisectStatus =
  | 'found'
  | 'unreliable'
  | 'inconclusive'
  | 'good_fails'
  | 'bad_passes'
  | 'good_skipped'
  | 'bad_skipped';

export interface BisectSearchResult {
  status: BisectStatus;
  checks: StepCheck[];
  firstBad: Checkpoint | null;
  lastGood: Checkpoint | null;
  /** Steps between the last good and the first bad that could not be tested. */
  skipped: Checkpoint[];
  /** True when re-running the two ends gave a different answer (a flaky command). */
  flaky: boolean;
}

export interface BisectProgress {
  step: Checkpoint;
  run: number;
  estimatedRuns: number;
  /** `verify`: checking the two ends; `search`: the binary search; `confirm`: the flaky re-run. */
  phase: 'verify' | 'search' | 'confirm';
}

/** Thrown when the search is cancelled (Ctrl-C). */
export class BisectAborted extends Error {
  constructor() {
    super('bisect cancelled');
    this.name = 'BisectAborted';
  }
}

/** How many runs a search over `n` steps takes: the two ends, log2 of the rest, two re-runs. */
export function estimateRuns(n: number): number {
  return 2 + Math.ceil(Math.log2(Math.max(1, n - 1))) + 2;
}

/**
 * Finds the first step at which the command fails. `steps` are consecutive checkpoints, oldest
 * first; the first is expected to pass and the last to fail, which is verified before searching.
 * Skipped steps (exit 125, timeouts) are left out the way git does: the search moves to the
 * untested step nearest the middle, and gives up (`inconclusive`) when every step between the
 * last good and the first bad was skipped. The two ends of the answer are run once more; when
 * they disagree the result is `unreliable` instead of blaming anyone.
 */
export async function bisectSearch(
  steps: readonly Checkpoint[],
  runner: BisectRunner,
  options: { onProgress?: (p: BisectProgress) => void; signal?: AbortSignal } = {},
): Promise<BisectSearchResult> {
  if (steps.length < 2) throw new Error('bisect needs at least two steps');
  const checks: StepCheck[] = [];
  const estimatedRuns = estimateRuns(steps.length);
  const run = async (i: number, phase: BisectProgress['phase']): Promise<StepCheck> => {
    if (options.signal?.aborted) throw new BisectAborted();
    const step = steps[i] as Checkpoint;
    options.onProgress?.({ step, run: checks.length + 1, estimatedRuns, phase });
    const check = await runner.run(step);
    if (options.signal?.aborted) throw new BisectAborted();
    checks.push(check);
    return check;
  };
  const result = (
    status: BisectStatus,
    lo: number | null,
    hi: number | null,
    skipped: number[] = [],
    flaky = false,
  ): BisectSearchResult => ({
    status,
    checks,
    firstBad: hi === null ? null : (steps[hi] as Checkpoint),
    lastGood: lo === null ? null : (steps[lo] as Checkpoint),
    skipped: skipped.map((i) => steps[i] as Checkpoint),
    flaky,
  });

  let lo = 0;
  let hi = steps.length - 1;
  const first = await run(lo, 'verify');
  if (first.outcome === 'bad') return result('good_fails', null, lo);
  if (first.outcome === 'skip') return result('good_skipped', null, null, [lo]);
  const last = await run(hi, 'verify');
  if (last.outcome === 'good') return result('bad_passes', hi, null);
  if (last.outcome === 'skip') return result('bad_skipped', null, null, [hi]);

  const skipped = new Set<number>();
  while (hi - lo > 1) {
    const middle = (lo + hi) / 2;
    let pick = -1;
    for (let i = lo + 1; i < hi; i++) {
      if (skipped.has(i)) continue;
      if (pick === -1 || Math.abs(i - middle) < Math.abs(pick - middle)) pick = i;
    }
    if (pick === -1) {
      const gap: number[] = [];
      for (let i = lo + 1; i < hi; i++) gap.push(i);
      return result('inconclusive', lo, hi, gap);
    }
    const check = await run(pick, 'search');
    if (check.outcome === 'good') lo = pick;
    else if (check.outcome === 'bad') hi = pick;
    else skipped.add(pick);
  }

  // Once more at both ends: a flaky command must not get an agent blamed.
  const again = await run(lo, 'confirm');
  const badAgain = await run(hi, 'confirm');
  if (again.outcome !== 'good' || badAgain.outcome !== 'bad') {
    return result('unreliable', lo, hi, [], true);
  }
  return result('found', lo, hi);
}

/** A rule or decision that applied to a step's paths when the step was made. */
export interface StepRule {
  id: string;
  kind: MemoryKind;
  title: string;
  /** True when the delivery records show the step's session received it before the step. */
  told: boolean;
}

/** One step explained: who, what, from which prompt, under which rules. */
export interface StepInfo {
  seq: number;
  kind: CheckpointKind;
  gap: boolean;
  at: number;
  commit: string;
  parentCommit: string | null;
  worktree: string;
  sessionId: string | null;
  agentKind: string | null;
  /** The engine's session label (`codex #dd7a9a10`), null for `outside` steps. */
  sessionLabel: string | null;
  tool: string | null;
  paths: string[];
  /** Redacted one-line summary of the prompt that led to the edit. */
  prompt: string | null;
  /** `kept`: shown; `gone`: the prompt event is no longer kept; `none`: no prompt recorded. */
  promptState: 'kept' | 'gone' | 'none';
  rules: StepRule[];
}

const MAX_RULE_MEMORIES = 300;
// Terminal escape sequences pasted into a prompt: dropped whole, not just their escape character.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

export class BisectService {
  constructor(
    private readonly k: Kernel,
    private readonly memory: MemoryService,
  ) {}

  /** Explains a step from what Mindly recorded around it. */
  describe(step: Checkpoint): StepInfo {
    const session = step.sessionId ? this.k.store.sessions.find(step.sessionId) : null;
    const prompt = this.promptSummary(step);
    return {
      seq: step.seq,
      kind: step.kind,
      gap: step.gap,
      at: step.createdAt,
      commit: step.commit,
      parentCommit: step.parentCommit,
      worktree: step.worktree,
      sessionId: step.sessionId,
      agentKind: session?.agentKind ?? null,
      sessionLabel: session ? sessionLabel(session) : null,
      tool: step.tool,
      paths: step.paths,
      prompt: prompt.summary,
      promptState: prompt.state,
      rules: this.rulesInEffect(step),
    };
  }

  private promptSummary(step: Checkpoint): {
    summary: string | null;
    state: StepInfo['promptState'];
  } {
    if (!step.promptEventId) return { summary: null, state: 'none' };
    const evt = this.k.store.events.getById(step.promptEventId);
    if (!evt || evt.projectId !== step.projectId || evt.type !== 'prompt.submitted') {
      return { summary: null, state: 'gone' };
    }
    const summary = evt.payload['summary'];
    if (typeof summary !== 'string' || summary === '') return { summary: null, state: 'gone' };
    return { summary: sanitizeLine(redactText(summary.replace(ANSI_RE, '')), 200), state: 'kept' };
  }

  /**
   * Approved rules and decisions whose scope matched the step's paths and that were active when
   * the step was made, read from the memory versions of that time. `told` says whether the
   * context packets or rule deliveries show the step's session received the rule before then.
   */
  private rulesInEffect(step: Checkpoint): StepRule[] {
    if (step.paths.length === 0) return [];
    const pid = step.projectId;
    const at = step.createdAt;
    const candidates: Memory[] = [
      ...this.k.store.memories.list(pid, {
        kinds: ['rule', 'decision'],
        limit: MAX_RULE_MEMORIES,
      }),
      ...this.k.store.memories.list(pid, {
        kinds: ['rule', 'decision'],
        status: 'archived',
        limit: MAX_RULE_MEMORIES,
      }),
    ];
    const told = this.toldBefore(step);
    const out: StepRule[] = [];
    for (const m of candidates) {
      if (m.createdAt > at) continue;
      const then = this.k.store.memories
        .versions(m.id)
        .filter((v) => v.createdAt <= at)
        .sort((a, b) => b.version - a.version)[0];
      if (!then || then.status !== 'active') continue;
      if (then.trust !== 'approved' && then.trust !== 'verified') continue;
      if (then.scope.paths.length === 0) continue;
      if (!step.paths.some((p) => matchesAnyGlob(p, then.scope.paths))) continue;
      out.push({ id: m.id, kind: m.kind, title: then.title, told: told.has(m.id) });
      if (out.length >= 10) break;
    }
    return out;
  }

  /** Memory ids the step's session had received (context packets, rule deliveries) by then. */
  private toldBefore(step: Checkpoint): Set<string> {
    const ids = new Set<string>();
    if (!step.sessionId) return ids;
    for (const p of this.k.store.contextPackets.forSession(step.sessionId, 100)) {
      if (p.createdAt > step.createdAt) continue;
      for (const i of p.included) if (i.kind === 'memory') ids.add(i.ref);
    }
    for (const d of this.k.store.deliveries.list(step.projectId, {
      statuses: ['delivered', 'acked'],
      limit: 500,
    })) {
      if (d.targetSessionId !== step.sessionId || d.kind !== 'rule') continue;
      if ((d.deliveredAt ?? d.createdAt) > step.createdAt) continue;
      const m = /^rule:([^:]+):/.exec(d.dedupeKey ?? '');
      if (m) ids.add(m[1] as string);
    }
    return ids;
  }

  /** Creates and starts the run record of a bisect. */
  startRun(projectId: string, title: string, input: Record<string, unknown>): Run {
    const run = this.k.store.runs.create({ projectId, kind: 'bisect', title, input });
    this.k.store.runs.start(run.id);
    this.k.store.events.append({
      projectId,
      sessionId: null,
      type: 'run.started',
      payload: { runId: run.id, kind: run.kind, title: run.title },
    });
    return this.k.store.runs.get(run.id);
  }

  finishRun(
    run: Run,
    status: Exclude<RunStatus, 'queued' | 'running'>,
    result: Record<string, unknown>,
  ): Run {
    const saved = this.k.store.runs.finish(run.id, status, result);
    this.k.store.events.append({
      projectId: run.projectId,
      sessionId: null,
      type: 'run.finished',
      payload: { runId: run.id, kind: run.kind, status },
    });
    return saved;
  }

  /**
   * The stored result of a bisect run, the same for `mindly bisect` and the sentinel. The blamed
   * step is kept as it was when found, so `mindly track` can still attribute the run after the
   * checkpoint itself is pruned. `checks` must already be sanitized.
   */
  resultRecord(input: {
    status: BisectStatus | 'cancelled';
    search: BisectSearchResult | null;
    checks: readonly StepCheck[];
    firstBad: StepInfo | null;
    lastGood: StepInfo | null;
    output: string | null;
    durationMs: number;
    mistakeId: string | null;
  }): Record<string, unknown> {
    const { status, search } = input;
    return {
      status,
      checks: input.checks,
      firstBad: input.firstBad?.seq ?? null,
      blame:
        status === 'found' && search?.firstBad
          ? {
              checkpointId: search.firstBad.id,
              kind: search.firstBad.kind,
              gap: search.firstBad.gap,
              sessionId: search.firstBad.sessionId,
              paths: search.firstBad.paths,
              at: search.firstBad.createdAt,
            }
          : null,
      lastGood: input.lastGood?.seq ?? null,
      flaky: search?.flaky ?? false,
      skipped: (search?.skipped ?? []).map((s) => s.seq),
      output: input.output,
      runs: input.checks.length,
      durationMs: input.durationMs,
      mistakeId: input.mistakeId,
    };
  }

  /**
   * Remembers a reliable result as a mistake in the project, scoped to the step's paths, so agents
   * are warned before they repeat it. Found by the user (`mindly bisect`), it is approved; found by
   * the sentinel on its own, nobody looked at it, so it is only proposed. Only agent steps are
   * recorded: nobody is blamed for a change made outside any agent.
   */
  recordMistake(input: {
    projectId: string;
    projectRoot: string;
    step: StepInfo;
    command: string;
    foundBy?: 'user' | 'sentinel';
  }): Memory | null {
    const bySentinel = input.foundBy === 'sentinel';
    const { step } = input;
    // A gap step may hold more than one edit, so nobody is blamed for it.
    if (step.kind !== 'agent' || !step.agentKind || step.gap) return null;
    const command = sanitizeLine(redactText(input.command), 120);
    const paths = step.paths.slice(0, 20);
    const what = [step.tool ? sanitizeLine(step.tool, 40) : 'an edit', ...paths.slice(0, 3)]
      .map((s) => sanitizeLine(s, 160))
      .join(' ');
    const body = [
      `${step.agentKind} step ${step.seq} (${what}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}) broke \`${command}\`.`,
      `Found with ${bySentinel ? "Mindly's sentinel" : 'mindly bisect'}. See the edit and its prompt with: mindly bisect show ${step.seq}; undo that edit alone with: mindly bisect revert ${step.seq}`,
    ].join(' ');
    return this.memory.remember({
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      kind: 'mistake',
      title: `${step.agentKind} step ${step.seq} broke \`${command}\``,
      body,
      tags: ['mistake', 'bisect'],
      scopePaths: paths,
      source: bySentinel ? SYSTEM : USER,
      reason: bySentinel ? "found by Mindly's sentinel" : 'found by mindly bisect',
    });
  }
}
