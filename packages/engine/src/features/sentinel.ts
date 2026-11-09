import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import {
  describeError,
  fingerprint,
  redactText,
  sanitizeForContext,
  sanitizeLine,
  sha256,
  type Checkpoint,
  type Conflict,
  type Run,
  type SentinelCheck,
  type SentinelWatch,
  type Session,
} from '@mindly/core';
import { sessionLabel } from '../coordination/work.js';
import type { TelepathyService } from '../coordination/telepathy.js';
import { LIVE_WINDOW_MS, type Kernel } from '../kernel.js';
import type { CommandSpec, StepGitPort, StepWorkspace } from '../ports.js';
import type { ProjectContext, ProjectService } from '../projects.js';
import {
  BisectAborted,
  bisectSearch,
  type BisectService,
  type BisectStatus,
  type StepCheck,
  type StepInfo,
} from './bisect.js';
import type { SavesService } from './saves.js';
import { SENTINEL_FINGERPRINT_PREFIX } from './shared.js';
import { tryProcessLock, type ProcessLock } from './sentinel-lock.js';
import { outputTail, StepCommandRunner } from './step-runner.js';

export { SENTINEL_FINGERPRINT_PREFIX } from './shared.js';

/*
 * The sentinel: runs the project's trusted checks on the newest checkpoint of each working tree
 * as agents edit, and when a check goes from passing to failing, runs `mindly bisect` over the
 * steps in between, tells the agent whose edit broke it, opens a conflict for the user and
 * remembers the mistake. Everything runs in a warm scratch worktree kept under
 * `$MINDLY_HOME/sentinel`, never in the user's checkout, and only with checks the user trusted.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Working trees whose newest step is older than this are not checked on a schedule. */
export const SENTINEL_ACTIVE_WINDOW_MS = DAY;
/** Warm scratch trees unused this long are removed (made again on the next pass). */
export const SENTINEL_WARM_IDLE_MS = 3 * DAY;
/** First back-off after a pass where nothing could run, doubled each time up to the maximum. */
export const SKIP_RETRY_MS = 15 * MIN;
const SKIP_RETRY_MAX_MS = 6 * HOUR;
/** Working trees the schedule and `mindly sentinel` look at per project. */
const MAX_WORKTREES = 50;
/** Lines of failing output an agent is shown. */
const DELIVERY_OUTPUT_LINES = 12;
const MAX_STEPS = 100_000;

/** Why the sentinel cannot run in a project. */
export type SentinelNotReady =
  | 'no_git'
  | 'checkpoints_off'
  | 'config_error'
  | 'no_checks'
  | 'unknown_checks'
  | 'untrusted'
  /** `$MINDLY_HOME` is inside the repository, so its scratch trees would be too. */
  | 'scratch_inside_repo';

/** What the sentinel would run in a project, or why it cannot. */
export interface SentinelReadiness {
  ready: boolean;
  reason: SentinelNotReady | null;
  /** The checks it runs (a subset of the project's checks when `sentinel.checks` names some). */
  checks: CommandSpec[];
  setup: CommandSpec | null;
  /** Names in `sentinel.checks` that are not checks of the project. */
  unknown: string[];
}

/** How one check's state moved in a pass. */
export type SentinelTransition =
  | 'baseline_pass'
  | 'baseline_fail'
  | 'still_passing'
  | 'still_failing'
  | 'broke'
  | 'fixed'
  | 'flaky'
  | 'skipped';

/** The bisect a pass ran for a check that broke. */
export interface SentinelBisect {
  /** The `bisect` run, or null when none was started. */
  runId: string | null;
  status: BisectStatus | 'cancelled' | 'over_budget';
  runs: number;
  firstBad: StepInfo | null;
  lastGood: StepInfo | null;
}

/** What one check did in one pass. */
export interface SentinelCheckReport {
  name: string;
  /** At the newest step: `skip` when it could not run (timeout, exit 125, setup failed). */
  outcome: 'pass' | 'fail' | 'skip';
  exitCode: number | null;
  durationMs: number;
  transition: SentinelTransition;
  /** Failing output tail (sanitized), when it failed. */
  output: string | null;
  bisect: SentinelBisect | null;
  conflictId: string | null;
  /** Sessions told about the break. */
  told: string[];
  note: string | null;
}

export type SentinelPassStatus =
  'checked' | 'up_to_date' | 'not_due' | 'not_ready' | 'no_steps' | 'busy' | 'cancelled' | 'error';

/** What one pass over one working tree did. */
export interface SentinelPassResult {
  status: SentinelPassStatus;
  worktree: string;
  /** The step checked. */
  step: number | null;
  runId: string | null;
  checks: SentinelCheckReport[];
  /** Why the pass did not run or failed, for `not_ready` and `error`. */
  reason: string | null;
  setupFailed: boolean;
}

export interface SentinelProgress {
  phase: 'setup' | 'check' | 'bisect';
  check: string | null;
  step: number;
  run?: number;
  estimatedRuns?: number;
}

export interface SentinelPassOptions {
  trigger: 'schedule' | 'user';
  /** Run even when the working tree is not due (`mindly sentinel run`). */
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: SentinelProgress) => void;
}

/** One check's state as `mindly sentinel` shows it. */
export interface SentinelCheckStatus extends SentinelCheck {
  name: string;
  culprit: { sessionId: string; label: string; agentKind: string } | null;
}

/** One watched working tree as `mindly sentinel` shows it. */
export interface SentinelWatchStatus {
  worktree: string;
  latestSeq: number | null;
  checkedSeq: number | null;
  checkedAt: number | null;
  /** Steps since the last check. */
  pending: number;
  /** When nothing could run at the newest step: when it is tried again. */
  retryAt: number | null;
  checks: SentinelCheckStatus[];
}

/** Everything `mindly sentinel` shows for a project. */
export interface SentinelStatus {
  enabled: boolean;
  readiness: SentinelReadiness;
  watches: SentinelWatchStatus[];
  recent: Run[];
}

const quoted = (s: string): string => `"${sanitizeLine(s, 64)}"`;
const argvText = (argv: readonly string[]): string =>
  sanitizeLine(redactText(argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')), 200);

/** The paths of a step as a short phrase: `src/a.ts, src/b.ts (+3)`. */
function pathsText(paths: readonly string[], max = 3): string {
  const shown = paths.slice(0, max).map((p) => sanitizeLine(p, 160));
  const more = paths.length - shown.length;
  return shown.length ? `${shown.join(', ')}${more > 0 ? ` (+${more})` : ''}` : 'no files';
}

export class SentinelService {
  private tmpDir: string | null = null;

  constructor(
    private readonly k: Kernel,
    private readonly projects: ProjectService,
    private readonly bisect: BisectService,
    private readonly telepathy: TelepathyService,
    private readonly saves: SavesService | null,
    /** Directory holding one warm scratch tree per watched working tree (`$MINDLY_HOME/sentinel`). */
    private readonly dir: string | null,
  ) {}

  private get steps(): StepGitPort | undefined {
    return this.k.ports.git.steps;
  }

  /** What the sentinel would run in this project, or why it cannot. */
  readiness(project: ProjectContext): SentinelReadiness {
    const cfg = project.config.sentinel;
    const names = cfg?.checks ?? null;
    const all = project.config.checks.map((c) => ({
      name: c.name,
      argv: c.argv,
      timeoutSec: c.timeoutSec,
    }));
    const checks = names ? all.filter((c) => names.includes(c.name)) : all;
    const unknown = names ? names.filter((n) => !all.some((c) => c.name === n)) : [];
    const setup = cfg?.setup
      ? { name: 'setup', argv: cfg.setup, timeoutSec: cfg.setupTimeoutSec }
      : null;
    const no = (reason: SentinelNotReady): SentinelReadiness => ({
      ready: false,
      reason,
      checks,
      setup,
      unknown,
    });
    if (!this.steps || !this.k.ports.git.checkpoints) return no('no_git');
    if (!this.k.config.checkpoints.enabled) return no('checkpoints_off');
    if (project.configError) return no('config_error');
    if (checks.length === 0) return no(unknown.length ? 'unknown_checks' : 'no_checks');
    if (!project.trusted) return no('untrusted');
    if (this.dir !== null && isInside(this.dir, project.root)) return no('scratch_inside_repo');
    return { ready: true, reason: null, checks, setup, unknown };
  }

  /** Working trees of a project the schedule should check now. */
  dueWorktrees(projectId: string): string[] {
    const now = this.k.clock.now();
    const out: string[] = [];
    const since = now - SENTINEL_ACTIVE_WINDOW_MS;
    for (const worktree of this.k.store.checkpoints.activeWorktrees(
      projectId,
      since,
      MAX_WORKTREES,
    )) {
      const latest = this.k.store.checkpoints.latest(projectId, worktree);
      if (!latest || latest.createdAt < since) continue;
      if (this.isDue(this.k.store.sentinel.get(projectId, worktree), latest, now)) {
        out.push(worktree);
      }
    }
    return out;
  }

  /**
   * Due when there is a step newer than the last one checked, and either enough of them piled up
   * (`sentinel.everySteps`) or no new one came for `sentinel.quietSec` (the agents paused).
   */
  private isDue(watch: SentinelWatch | null, latest: Checkpoint, now: number): boolean {
    const checked = watch?.checkedSeq ?? null;
    if (checked !== null && latest.seq <= checked) return false;
    // A step where nothing could run (setup failed, checks timed out) is tried again only after
    // its back-off, unless a newer step came since.
    if (
      watch?.skippedSeq !== null &&
      watch?.skippedSeq !== undefined &&
      latest.seq <= watch.skippedSeq &&
      now < (watch.retryAt ?? 0)
    ) {
      return false;
    }
    const cfg = this.k.config.sentinel;
    if (now - latest.createdAt >= cfg.quietSec * 1000) return true;
    // Steps since the last check; before the first check, the steps of the active window.
    const pending = this.k.store.checkpoints.list(latest.projectId, latest.worktree, {
      ...(checked !== null ? { fromSeq: checked + 1 } : { since: now - SENTINEL_ACTIVE_WINDOW_MS }),
      limit: cfg.everySteps,
    });
    return pending.length >= cfg.everySteps;
  }

  /** Back-off before a step where nothing could run is tried again: 15 min, doubling, 6 h at most. */
  static retryDelayMs(skips: number): number {
    return Math.min(SKIP_RETRY_MAX_MS, SKIP_RETRY_MS * 2 ** Math.max(0, skips - 1));
  }

  /** The lock of a watched checkout, or null while another pass (or cleanup) holds it. */
  private lock(projectId: string, worktree: string): ProcessLock | null {
    try {
      const dir = this.watchDir(projectId, worktree);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return tryProcessLock(join(dir, 'lock'));
    } catch {
      return null;
    }
  }

  /** True while a pass (or a cleanup) holds the lock of one of the project's checkouts. */
  busy(projectId: string): boolean {
    for (const w of this.k.store.sentinel.list(projectId)) {
      const lock = this.lock(projectId, w.worktree);
      if (!lock) return true;
      lock.release();
    }
    return false;
  }

  /**
   * Removes the temp folder an instance without a home made for its scratch trees (with the
   * trees in it); a home's `$MINDLY_HOME/sentinel` is kept.
   */
  dispose(): void {
    if (this.tmpDir === null) return;
    rmSync(this.tmpDir, { recursive: true, force: true });
    this.tmpDir = null;
  }

  /** The private directory of a watched working tree. */
  private watchDir(projectId: string, worktree: string): string {
    const base = this.dir ?? (this.tmpDir ??= mkdtempSync(join(tmpdir(), 'mindly-sentinel-')));
    return join(base, sha256(`${projectId}\u0000${worktree}`).slice(0, 16));
  }

  /** Where the warm scratch tree of a working tree lives. */
  warmPath(projectId: string, worktree: string): string {
    return join(this.watchDir(projectId, worktree), 'tree');
  }

  /**
   * Checks the newest step of one working tree with every check the sentinel runs, and handles
   * what changed: a check that broke is bisected, pinned on the edit that broke it (when one
   * agent edit did) and reported; a check that passes again closes its conflict. Never throws:
   * failures are recorded on the run and returned as `error`.
   */
  async pass(
    projectId: string,
    worktree: string,
    opts: SentinelPassOptions,
  ): Promise<SentinelPassResult> {
    const result = (
      status: SentinelPassStatus,
      extra: Partial<SentinelPassResult> = {},
    ): SentinelPassResult => ({
      status,
      worktree,
      step: null,
      runId: null,
      checks: [],
      reason: null,
      setupFailed: false,
      ...extra,
    });
    const project = this.projects.byId(projectId);
    const ready = this.readiness(project);
    const steps = this.steps;
    if (!ready.ready || !steps) {
      return result('not_ready', { reason: ready.reason ?? 'no_git' });
    }
    const latest = this.k.store.checkpoints.latest(projectId, worktree);
    if (!latest) return result('no_steps');
    const now = this.k.clock.now();
    const notDue = (watch: SentinelWatch | null): SentinelPassResult | null => {
      if (opts.force) return null;
      if (watch?.checkedSeq !== null && watch?.checkedSeq !== undefined) {
        if (latest.seq <= watch.checkedSeq) return result('up_to_date', { step: latest.seq });
      }
      return this.isDue(watch, latest, now) ? null : result('not_due', { step: latest.seq });
    };
    const early = notDue(this.k.store.sentinel.get(projectId, worktree));
    if (early) return early;
    const lock = this.lock(projectId, worktree);
    if (!lock) return result('busy', { step: latest.seq });
    // Read again under the lock: a pass elsewhere (the daemon, `sentinel run`) may have finished
    // between the first read and the lock, and its state must not be redone or overwritten.
    const watch = this.k.store.sentinel.get(projectId, worktree);
    const late = notDue(watch);
    if (late) {
      lock.release();
      return late;
    }
    if (!watch) {
      // Recorded before the scratch tree exists, so cleanup (`reset`, `forget`, `pruneWarm`)
      // finds the tree even when this first pass is cancelled before it saves anything.
      this.k.store.sentinel.save(projectId, worktree, {
        checkedSeq: null,
        checkedAt: null,
        setupCommit: null,
        checks: {},
      });
    }

    const signal = opts.signal ?? new AbortController().signal;
    const run = this.startRun(project, latest, ready, opts.trigger);
    let ws: StepWorkspace | null = null;
    let setupCommit = watch?.setupCommit ?? null;
    const reports: SentinelCheckReport[] = [];
    try {
      ws = await steps.warm(worktree, this.warmPath(projectId, worktree), latest.commit);
      // A tree made again (it was missing or broken) has none of the dependencies installed before.
      if (ws.fresh) setupCommit = null;
      const checks: Record<string, SentinelCheck> = {};
      // Checks the sentinel no longer runs are dropped with their state.
      for (const check of ready.checks) {
        const prev = watch?.checks[check.name];
        if (prev && prev.argvHash === commandHash(check)) checks[check.name] = prev;
      }
      let setupFailed = false;
      const outcomes = new Map<string, StepCheck>();
      for (const check of ready.checks) {
        if (signal.aborted) throw new BisectAborted();
        if (setupFailed) {
          // Without dependencies a check would fail for the wrong reason: it does not run.
          outcomes.set(check.name, {
            seq: latest.seq,
            outcome: 'skip',
            skipReason: 'setup_failed',
            exitCode: null,
            durationMs: 0,
            output: '',
            setupRan: false,
          });
          continue;
        }
        opts.onProgress?.({ phase: 'check', check: check.name, step: latest.seq });
        const runner = new StepCommandRunner(steps, ws, {
          command: check,
          setup: ready.setup,
          setupAt: setupCommit,
          signal,
        });
        const outcome = await runner.run(latest);
        if (outcome.setupRan) setupCommit = runner.setupCommit;
        if (outcome.skipReason === 'setup_failed') setupFailed = true;
        outcomes.set(check.name, outcome);
      }
      for (const check of ready.checks) {
        if (signal.aborted) throw new BisectAborted();
        const outcome = outcomes.get(check.name) as StepCheck;
        const report = await this.settle({
          project,
          worktree,
          latest,
          check,
          setup: ready.setup,
          checks,
          outcome,
          ws,
          setupCommit,
          signal,
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
          onSetup: (c) => {
            setupCommit = c;
          },
        });
        reports.push(report);
        // Saved as each check settles, so a pass cancelled later never redoes this one's bisect
        // (or records its mistake twice).
        this.k.store.sentinel.save(projectId, worktree, {
          checkedSeq: watch?.checkedSeq ?? null,
          checkedAt: watch?.checkedAt ?? null,
          setupCommit,
          checks,
          skips: watch?.skips ?? 0,
          skippedSeq: watch?.skippedSeq ?? null,
          retryAt: watch?.retryAt ?? null,
        });
      }
      const ran = reports.some((r) => r.outcome !== 'skip');
      // A pass where nothing could run leaves the step unchecked, retried after a back-off.
      const skips = ran ? 0 : (watch?.skippedSeq === latest.seq ? watch.skips : 0) + 1;
      this.k.store.sentinel.save(projectId, worktree, {
        checkedSeq: ran ? latest.seq : (watch?.checkedSeq ?? null),
        checkedAt: now,
        setupCommit,
        checks,
        skips,
        skippedSeq: ran ? null : latest.seq,
        retryAt: ran ? null : now + SentinelService.retryDelayMs(skips),
      });
      const failing = reports.some((r) => r.outcome === 'fail');
      this.finishRun(run, setupFailed || !ran ? 'error' : failing ? 'failed' : 'passed', {
        step: latest.seq,
        setupFailed,
        checks: reports,
      });
      return result('checked', { step: latest.seq, runId: run.id, checks: reports, setupFailed });
    } catch (err) {
      if (err instanceof BisectAborted || signal.aborted) {
        this.finishRun(run, 'cancelled', { step: latest.seq, checks: reports });
        return result('cancelled', { step: latest.seq, runId: run.id, checks: reports });
      }
      const reason = sanitizeLine(redactText(describeError(err)), 300);
      this.k.logger.error('sentinel pass failed', { projectId, error: describeError(err) });
      this.finishRun(run, 'error', { step: latest.seq, error: reason, checks: reports });
      return result('error', { step: latest.seq, runId: run.id, checks: reports, reason });
    } finally {
      lock.release();
      await ws?.dispose().catch(() => undefined);
    }
  }

  /** Moves one check's state for the outcome at the newest step, and reports it. */
  private async settle(input: {
    project: ProjectContext;
    worktree: string;
    latest: Checkpoint;
    check: CommandSpec;
    setup: CommandSpec | null;
    checks: Record<string, SentinelCheck>;
    outcome: StepCheck;
    ws: StepWorkspace;
    setupCommit: string | null;
    signal: AbortSignal;
    onProgress?: (p: SentinelProgress) => void;
    onSetup: (commit: string | null) => void;
  }): Promise<SentinelCheckReport> {
    const { check, outcome, latest, checks } = input;
    const now = this.k.clock.now();
    const prev = checks[check.name];
    const report: SentinelCheckReport = {
      name: check.name,
      outcome: outcome.outcome === 'good' ? 'pass' : outcome.outcome === 'bad' ? 'fail' : 'skip',
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      transition: 'skipped',
      output: outcome.outcome === 'bad' ? outcome.output || null : null,
      bisect: null,
      conflictId: null,
      told: [],
      note: outcome.skipReason ? skipNote(outcome.skipReason) : null,
    };
    if (report.outcome === 'skip') return report;
    const fresh = (
      state: SentinelCheck['state'],
      extra: Partial<SentinelCheck>,
    ): SentinelCheck => ({
      argvHash: commandHash(check),
      state,
      goodSeq: null,
      failingSeq: null,
      brokeAt: null,
      culpritSessionId: null,
      conflictId: null,
      note: null,
      since: now,
      ...extra,
    });

    if (!prev) {
      if (report.outcome === 'pass') {
        checks[check.name] = fresh('passing', { goodSeq: latest.seq });
        report.transition = 'baseline_pass';
      } else {
        checks[check.name] = fresh('failing', {
          failingSeq: latest.seq,
          note: 'already failing when the sentinel started watching',
        });
        report.transition = 'baseline_fail';
        report.note = 'already failing when the sentinel started watching';
      }
      return report;
    }

    if (prev.state === 'failing') {
      if (report.outcome === 'fail') {
        report.transition = 'still_failing';
        report.conflictId = prev.conflictId;
        return report;
      }
      checks[check.name] = fresh('passing', { goodSeq: latest.seq });
      report.transition = 'fixed';
      report.conflictId = prev.conflictId;
      if (prev.conflictId) this.resolve(input.project.project.id, prev.conflictId);
      return report;
    }

    // Passing before.
    if (report.outcome === 'pass') {
      checks[check.name] = { ...prev, goodSeq: latest.seq };
      report.transition = 'still_passing';
      return report;
    }
    return this.broke({ ...input, prev, report, fresh });
  }

  /** A check that passed at `prev.goodSeq` fails at the newest step: find the edit, report it. */
  private async broke(input: {
    project: ProjectContext;
    worktree: string;
    latest: Checkpoint;
    check: CommandSpec;
    setup: CommandSpec | null;
    checks: Record<string, SentinelCheck>;
    ws: StepWorkspace;
    setupCommit: string | null;
    signal: AbortSignal;
    onProgress?: (p: SentinelProgress) => void;
    onSetup: (commit: string | null) => void;
    prev: SentinelCheck;
    report: SentinelCheckReport;
    fresh: (state: SentinelCheck['state'], extra: Partial<SentinelCheck>) => SentinelCheck;
  }): Promise<SentinelCheckReport> {
    const { project, worktree, latest, check, prev, report, fresh } = input;
    const pid = project.project.id;
    if (prev.goodSeq === latest.seq) {
      // It passed at this very step before (a forced pass with no new edit): the same code gave
      // two results. Nobody is blamed and nothing is opened; it stays passing.
      input.checks[check.name] = { ...prev };
      report.transition = 'flaky';
      report.note = 'passed at this same step before and fails now: looks flaky, nobody is blamed';
      return report;
    }
    const steps = this.k.store.checkpoints.list(pid, worktree, {
      fromSeq: prev.goodSeq ?? latest.seq,
      toSeq: latest.seq,
      limit: MAX_STEPS,
    });
    const day = this.k.clock.now() - DAY;
    const used = this.k.store.runs.countSince(pid, 'bisect', day, {
      field: 'trigger',
      value: 'sentinel',
    });
    // The search starts at the step it passed at; when that step was pruned, the first step left
    // was never seen passing and cannot serve as the good end.
    const kept = steps.length >= 2 && steps[0]?.seq === prev.goodSeq;
    if (!kept || used >= this.k.config.sentinel.maxBisectsPerDay) {
      const note = !kept
        ? 'the step it last passed at is no longer kept, so the edit cannot be found'
        : 'not searched: the sentinel reached its daily bisect limit (sentinel.maxBisectsPerDay)';
      input.checks[check.name] = fresh('failing', {
        goodSeq: prev.goodSeq,
        failingSeq: latest.seq,
        note,
      });
      report.transition = 'broke';
      report.note = note;
      report.bisect = !kept
        ? null
        : { runId: null, status: 'over_budget', runs: 0, firstBad: null, lastGood: null };
      const conflict = this.open({
        project,
        worktree,
        check,
        latest,
        goodSeq: prev.goodSeq,
        firstBad: null,
        note,
      });
      input.checks[check.name] = {
        ...(input.checks[check.name] as SentinelCheck),
        conflictId: conflict?.id ?? null,
      };
      report.conflictId = conflict?.id ?? null;
      if (conflict) {
        // Nobody is blamed, but the agents working in this checkout should not build on it.
        report.told = this.tell({
          project,
          worktree,
          check,
          conflict,
          goodSeq: prev.goodSeq,
          badSeq: latest.seq,
          firstBad: null,
          culprit: null,
          output: report.output,
        });
      }
      return report;
    }

    // The search, in the same warm tree.
    const runner = new StepCommandRunner(this.steps as StepGitPort, input.ws, {
      command: check,
      setup: input.setup,
      setupAt: input.setupCommit,
      signal: input.signal,
    });
    const run = this.bisect.startRun(pid, sanitizeLine(`Sentinel bisect ${check.name}`, 120), {
      command: check.argv.map((a) => redactText(a)),
      range: { good: steps[0]?.seq, bad: latest.seq, worktree: redactText(worktree), since: null },
      setup: input.setup?.argv.map((a) => redactText(a)) ?? null,
      timeoutSec: check.timeoutSec,
      trigger: 'sentinel',
      check: check.name,
    });
    const started = Date.now();
    let status: BisectStatus | 'cancelled' = 'cancelled';
    let search: Awaited<ReturnType<typeof bisectSearch>> | null = null;
    try {
      search = await bisectSearch(steps, runner, {
        signal: input.signal,
        onProgress: (p) =>
          input.onProgress?.({
            phase: 'bisect',
            check: check.name,
            step: p.step.seq,
            run: p.run,
            estimatedRuns: p.estimatedRuns,
          }),
      });
      status = search.status;
    } catch (err) {
      if (!(err instanceof BisectAborted)) {
        this.bisect.finishRun(run, 'error', { error: outputTail(describeError(err)) });
        throw err;
      }
    } finally {
      input.onSetup(runner.setupCommit);
    }
    const checks = (search?.checks ?? []).map((c) => ({ ...c, output: outputTail(c.output) }));
    const firstBad = search?.firstBad ? this.bisect.describe(search.firstBad) : null;
    const lastGood = search?.lastGood ? this.bisect.describe(search.lastGood) : null;
    const failing =
      status === 'found' && firstBad
        ? [...checks].reverse().find((c) => c.seq === firstBad.seq && c.outcome === 'bad')
        : null;
    const mistake =
      status === 'found' && firstBad
        ? this.bisect.recordMistake({
            projectId: pid,
            projectRoot: project.root,
            step: firstBad,
            command: check.argv.join(' '),
            foundBy: 'sentinel',
          })
        : null;
    this.bisect.finishRun(
      run,
      status === 'found' ? 'passed' : status === 'cancelled' ? 'cancelled' : 'failed',
      this.bisect.resultRecord({
        status,
        search,
        checks,
        firstBad,
        lastGood,
        output: failing?.output || null,
        durationMs: Date.now() - started,
        mistakeId: mistake?.id ?? null,
      }),
    );
    if (status === 'cancelled') throw new BisectAborted();
    report.bisect = { runId: run.id, status, runs: checks.length, firstBad, lastGood };
    if (failing?.output) report.output = failing.output;

    if (status === 'unreliable' || status === 'bad_passes') {
      // Flaky: it failed once but not when run again. Nobody is told; it stays passing.
      input.checks[check.name] = { ...prev };
      report.transition = 'flaky';
      report.note =
        status === 'bad_passes'
          ? 'failed once, then passed when run again: looks flaky, nobody is blamed'
          : 'gave different results when run again: looks flaky, nobody is blamed';
      return report;
    }
    if (status === 'bad_skipped') {
      // It failed, then could not run at all at the same step (timeout, exit 125): nothing is
      // known yet. It stays passing, and the next pass looks again.
      input.checks[check.name] = { ...prev };
      report.transition = 'skipped';
      report.note = 'failed, then could not run when checked again: looked at again next time';
      return report;
    }

    const blamed =
      status === 'found' && firstBad && firstBad.kind === 'agent' && !firstBad.gap
        ? this.k.store.sessions.find(firstBad.sessionId ?? '')
        : null;
    const note =
      status === 'found'
        ? blamed
          ? null
          : firstBad?.kind === 'outside'
            ? 'the step that broke it was a change made outside any agent'
            : firstBad?.gap
              ? 'the step that broke it may hold more than one edit, so nobody is blamed'
              : 'the session that made that edit is no longer known, so nobody is blamed'
        : status === 'good_fails'
          ? `it now also fails at step ${steps[0]?.seq ?? '?'}, where it passed before: something outside the checkpoints changed (dependencies, environment, time)`
          : 'the steps in between could not all be run, so the edit could not be narrowed down';
    input.checks[check.name] = fresh('failing', {
      goodSeq: prev.goodSeq,
      failingSeq: latest.seq,
      brokeAt: status === 'found' ? (firstBad?.seq ?? null) : null,
      culpritSessionId: blamed?.id ?? null,
      note,
    });
    report.transition = 'broke';
    report.note = note;
    const conflict = this.open({
      project,
      worktree,
      check,
      latest,
      goodSeq: lastGood?.seq ?? prev.goodSeq,
      firstBad: status === 'found' ? firstBad : null,
      culprit: blamed,
      note,
    });
    if (conflict) {
      input.checks[check.name] = {
        ...(input.checks[check.name] as SentinelCheck),
        conflictId: conflict.id,
      };
      report.conflictId = conflict.id;
      report.told = this.tell({
        project,
        worktree,
        check,
        conflict,
        goodSeq: lastGood?.seq ?? prev.goodSeq,
        badSeq: status === 'found' && firstBad ? firstBad.seq : latest.seq,
        firstBad: status === 'found' ? firstBad : null,
        culprit: blamed,
        output: report.output,
      });
    }
    return report;
  }

  /** Opens the `check_failed` conflict of a break (and its save and notification). */
  private open(input: {
    project: ProjectContext;
    worktree: string;
    check: CommandSpec;
    latest: Checkpoint;
    goodSeq: number | null;
    firstBad: StepInfo | null;
    culprit?: Session | null;
    note: string | null;
  }): Conflict | null {
    const { project, check, firstBad, culprit } = input;
    const pid = project.project.id;
    const at = firstBad?.seq ?? input.latest.seq;
    const where = input.worktree === project.root ? '' : ` in ${sanitizeLine(input.worktree, 200)}`;
    const title = firstBad
      ? `Check ${quoted(check.name)} broke at step ${firstBad.seq}: ${firstBad.sessionLabel ?? (firstBad.kind === 'outside' ? 'a change outside any agent' : 'an agent')} ${firstBad.tool ? `${sanitizeLine(firstBad.tool, 40)} ` : ''}${pathsText(firstBad.paths)}`
      : `Check ${quoted(check.name)} fails from step ${input.latest.seq}${where}`;
    const detail = [
      `${argvText(check.argv)} passes at step ${input.goodSeq ?? '?'} and fails from step ${at}${where}.`,
      firstBad?.prompt ? `Prompt of that edit: ${firstBad.prompt}` : null,
      input.note ? `${input.note[0]?.toUpperCase() ?? ''}${input.note.slice(1)}.` : null,
      firstBad ? `See it: mindly bisect show ${firstBad.seq} --patch` : null,
      firstBad?.kind === 'agent'
        ? `Undo only that edit: mindly bisect revert ${firstBad.seq}`
        : null,
    ]
      .filter((l): l is string => l !== null)
      .join(' ');
    const fp = `${SENTINEL_FINGERPRINT_PREFIX}${fingerprint('sentinel', input.worktree, check.name, at)}`;
    try {
      const { conflict, isNew } = this.k.store.conflicts.report({
        projectId: pid,
        kind: 'check_failed',
        severity: 'critical',
        title: sanitizeLine(title, 200),
        detail: sanitizeLine(detail, 1000),
        sessionIds: culprit ? [culprit.id] : [],
        paths: (firstBad?.paths ?? []).slice(0, 200),
        fingerprint: fp,
      });
      if (!isNew) return conflict;
      const event = this.k.store.events.append({
        projectId: pid,
        sessionId: null,
        type: 'conflict.opened',
        payload: {
          conflictId: conflict.id,
          kind: conflict.kind,
          severity: conflict.severity,
          title: conflict.title,
          sessionIds: conflict.sessionIds,
          paths: conflict.paths,
          source: 'sentinel',
        },
      });
      // A save needs someone who can still fix it: not a session that already ended.
      if (culprit && culprit.status !== 'ended') {
        this.saves?.sentinelCaught(conflict, event.id, culprit);
      }
      void this.k.ports.notifier
        .send({
          trigger: 'check_failed',
          title: culprit ? 'An agent edit broke a check' : 'A check started failing',
          body: `Check ${quoted(check.name)} fails from step ${at}${culprit ? ` (${sanitizeLine(culprit.agentKind, 32)})` : ''} in ${sanitizeLine(project.project.name, 80)}.`,
          projectName: sanitizeLine(project.project.name, 80),
          priority: 'high',
          dedupeKey: `sentinel:${conflict.id}`,
        })
        .catch(() => undefined);
      return conflict;
    } catch (err) {
      this.k.logger.error('sentinel: conflict not recorded', { error: describeError(err) });
      return null;
    }
  }

  /**
   * Tells the agent whose edit broke the check; when that session is gone, the agents working in
   * the same checkout now. Returns the sessions told.
   */
  private tell(input: {
    project: ProjectContext;
    worktree: string;
    check: CommandSpec;
    conflict: Conflict;
    goodSeq: number | null;
    badSeq: number;
    firstBad: StepInfo | null;
    culprit: Session | null;
    output: string | null;
  }): string[] {
    const { check, firstBad, culprit } = input;
    const pid = input.project.project.id;
    // A session's worktree is the folder its agent started in (maybe a subfolder, or a path
    // through a symlink); it belongs to the most specific checkout holding it.
    const trees = this.k.store.checkpoints.worktrees(pid);
    const live = this.k.store.sessions
      .listLive(pid, LIVE_WINDOW_MS)
      .filter((s) => s.status !== 'ended' && checkoutOf(s.worktree, trees) === input.worktree);
    const own = culprit !== null && culprit.status !== 'ended';
    const to = own ? [culprit.id] : live.map((s) => s.id);
    if (to.length === 0) return [];
    // Context blocks render a delivery on one line, so the output lines are joined with ` | `.
    const tail = (input.output ?? '')
      .split('\n')
      .map((l) => sanitizeLine(l, 200).trim())
      .filter((l) => l !== '')
      .slice(-DELIVERY_OUTPUT_LINES);
    const edit = firstBad
      ? `step ${firstBad.seq}, ${own ? 'your' : `${firstBad.sessionLabel ?? 'an'}`} ${firstBad.tool ? `${sanitizeLine(firstBad.tool, 40)} of ` : 'edit of '}${pathsText(firstBad.paths)}${firstBad.prompt ? ` (prompt: ${firstBad.prompt})` : ''}`
      : null;
    const body = [
      `Mindly's sentinel ran the project check ${quoted(check.name)} (${argvText(check.argv)}) after recent edits. It passed at step ${input.goodSeq ?? '?'} and fails from ${edit ?? `step ${input.badSeq}`}.`,
      tail.length ? `Failing output (last lines): "${tail.join(' | ')}".` : null,
      own
        ? 'Fix this before building more on that change.'
        : 'Check whether your work depends on it before continuing.',
      firstBad?.kind === 'agent'
        ? `The user can undo that one edit with: mindly bisect revert ${firstBad.seq}`
        : null,
    ]
      .filter((l): l is string => l !== null)
      .join('\n');
    const sent = this.telepathy.send({
      projectId: pid,
      from: null,
      to: { sessionIds: to },
      kind: 'conflict',
      priority: 9,
      title: own
        ? `Your edit broke check ${quoted(check.name)}`
        : `Check ${quoted(check.name)} broke in this checkout`,
      body: sanitizeForContext(body, 1500),
      dedupeKey: `sentinel:${input.conflict.id}`,
    });
    return sent.map((d) => d.targetSessionId).filter((id): id is string => id !== null);
  }

  /** Resolves a break's conflict once the check passes again (and confirms its save). */
  private resolve(projectId: string, conflictId: string): void {
    const c = this.k.store.conflicts.find(conflictId);
    if (!c || (c.status !== 'open' && c.status !== 'acknowledged')) return;
    this.k.store.conflicts.setStatus(c.id, 'resolved');
    const event = this.k.store.events.append({
      projectId,
      sessionId: null,
      type: 'conflict.updated',
      payload: { conflictId: c.id, kind: c.kind, status: 'resolved' },
    });
    this.saves?.brokenChecksFixed(projectId, [c.id], event.id);
  }

  private startRun(
    project: ProjectContext,
    step: Checkpoint,
    ready: SentinelReadiness,
    trigger: SentinelPassOptions['trigger'],
  ): Run {
    const run = this.k.store.runs.create({
      projectId: project.project.id,
      kind: 'sentinel',
      title: sanitizeLine(`Sentinel step ${step.seq}`, 120),
      input: {
        trigger,
        worktree: redactText(step.worktree),
        step: step.seq,
        checks: ready.checks.map((c) => c.name),
      },
    });
    this.k.store.runs.start(run.id);
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: null,
      type: 'run.started',
      payload: { runId: run.id, kind: run.kind, title: run.title },
    });
    return run;
  }

  private finishRun(
    run: Run,
    status: 'passed' | 'failed' | 'error' | 'cancelled',
    result: Record<string, unknown>,
  ): void {
    this.k.store.runs.finish(run.id, status, result);
    this.k.store.events.append({
      projectId: run.projectId,
      sessionId: null,
      type: 'run.finished',
      payload: { runId: run.id, kind: run.kind, status },
    });
  }

  /** What `mindly sentinel` shows. */
  status(projectId: string): SentinelStatus {
    const project = this.projects.byId(projectId);
    const watches = new Map(this.k.store.sentinel.list(projectId).map((w) => [w.worktree, w]));
    const now = this.k.clock.now();
    const trees = new Set(watches.keys());
    const since = now - SENTINEL_ACTIVE_WINDOW_MS;
    for (const w of this.k.store.checkpoints.activeWorktrees(projectId, since, MAX_WORKTREES)) {
      trees.add(w);
    }
    const out: SentinelWatchStatus[] = [];
    for (const worktree of [...trees].sort()) {
      // A checkout removed since (a finished split part) is cleaned up by `pruneWarm`.
      if (!existsSync(worktree)) continue;
      const watch = watches.get(worktree) ?? null;
      const latest = this.k.store.checkpoints.latest(projectId, worktree);
      const pending =
        latest && (watch?.checkedSeq ?? null) !== latest.seq
          ? this.k.store.checkpoints.list(projectId, worktree, {
              fromSeq: (watch?.checkedSeq ?? 0) + 1,
              limit: 1000,
            }).length
          : 0;
      out.push({
        worktree,
        latestSeq: latest?.seq ?? null,
        checkedSeq: watch?.checkedSeq ?? null,
        checkedAt: watch?.checkedAt ?? null,
        pending,
        retryAt:
          watch?.skippedSeq !== null && watch?.skippedSeq !== undefined ? watch.retryAt : null,
        checks: Object.entries(watch?.checks ?? {}).map(([name, c]) => {
          const s = c.culpritSessionId ? this.k.store.sessions.find(c.culpritSessionId) : null;
          return {
            name,
            ...c,
            culprit: s ? { sessionId: s.id, label: sessionLabel(s), agentKind: s.agentKind } : null,
          };
        }),
      });
    }
    return {
      enabled: this.k.config.sentinel.enabled,
      readiness: this.readiness(project),
      watches: out,
      recent: this.k.store.runs.list(projectId, { kind: 'sentinel', limit: 10 }),
    };
  }

  /**
   * Forgets one working tree: its state and its warm scratch tree. `busy` while a pass holds it;
   * `failed` (state kept, so cleanup tries again) when the tree could not be removed.
   */
  async reset(projectId: string, worktree: string): Promise<'reset' | 'none' | 'busy' | 'failed'> {
    const lock = this.lock(projectId, worktree);
    if (!lock) return 'busy';
    try {
      if (!(await this.removeWarm(projectId, worktree))) return 'failed';
      return this.k.store.sentinel.delete(projectId, worktree) ? 'reset' : 'none';
    } finally {
      lock.release();
    }
  }

  /**
   * Removes every warm scratch tree of a project (`forget --project`, `uninstall`). Returns how
   * many checkouts were reset, those a pass holds now (`busy`) and those whose tree could not be
   * removed (`failed`).
   */
  async forget(projectId: string): Promise<{ reset: number; busy: string[]; failed: string[] }> {
    const out = { reset: 0, busy: [] as string[], failed: [] as string[] };
    for (const w of this.k.store.sentinel.list(projectId)) {
      const r = await this.reset(projectId, w.worktree);
      if (r === 'reset') out.reset++;
      else if (r === 'busy') out.busy.push(w.worktree);
      else if (r === 'failed') out.failed.push(w.worktree);
    }
    return out;
  }

  /**
   * Removes warm scratch trees not used for `SENTINEL_WARM_IDLE_MS` (made again when needed), and
   * forgets checkouts that no longer exist (a finished split part) with their trees. Trees in use
   * are left alone.
   */
  async pruneWarm(): Promise<number> {
    const before = this.k.clock.now() - SENTINEL_WARM_IDLE_MS;
    let n = 0;
    for (const p of this.k.store.projects.list().slice(0, 200)) {
      for (const w of this.k.store.sentinel.list(p.id)) {
        if (!existsSync(w.worktree)) {
          if ((await this.reset(p.id, w.worktree)) === 'reset') n++;
          continue;
        }
        const path = this.warmPath(p.id, w.worktree);
        if (w.updatedAt >= before || !existsSync(path)) continue;
        const lock = this.lock(p.id, w.worktree);
        if (!lock) continue;
        try {
          if (await this.removeWarm(p.id, w.worktree)) {
            n++;
            this.k.store.sentinel.clearSetup(p.id, w.worktree);
          }
        } finally {
          lock.release();
        }
      }
    }
    return n;
  }

  private async removeWarm(projectId: string, worktree: string): Promise<boolean> {
    const steps = this.steps;
    if (!steps) return false;
    const path = this.warmPath(projectId, worktree);
    try {
      await steps.removeWarm(worktree, path);
      return !existsSync(path);
    } catch (err) {
      this.k.logger.warn('sentinel: scratch tree not removed', { error: describeError(err) });
      return false;
    }
  }
}

/** True when `path` is `root` or inside it. */
function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The most specific of `trees` (canonical checkouts) holding `cwd`, resolved through symlinks. */
function checkoutOf(cwd: string, trees: readonly string[]): string | null {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // gone or unreadable: compare the path as given
  }
  let best: string | null = null;
  for (const t of trees) {
    if ((isInside(real, t) || isInside(cwd, t)) && (best === null || t.length > best.length)) {
      best = t;
    }
  }
  return best;
}

/** Stable hash of a check's command, so editing it starts its state over. */
function commandHash(check: CommandSpec): string {
  return sha256(JSON.stringify([...check.argv])).slice(0, 32);
}

function skipNote(reason: NonNullable<StepCheck['skipReason']>): string {
  switch (reason) {
    case 'exit_125':
      return 'could not run here (exit 125)';
    case 'timeout':
      return 'timed out';
    case 'setup_failed':
      return 'the setup command failed';
    case 'error':
      return 'could not be started';
  }
}
