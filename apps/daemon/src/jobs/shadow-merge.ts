import { fingerprint, sanitizeLine, shortId, type Run, type Session } from '@mindly/core';
import {
  LIVE_WINDOW_MS,
  savesOf,
  SENTINEL_FINGERPRINT_PREFIX,
  sessionLabel,
  SPLIT_FINGERPRINT_PREFIX,
  splitOf,
} from '@mindly/engine';
import { materializeTree, runChecks, shadowMerge, type CheckResult } from '@mindly/git';
import { captureSession, type SessionCapture } from './git-helpers.js';
import {
  failRun,
  finishRun,
  notify,
  outputTail,
  reportConflict,
  startRun,
  type JobContext,
} from './context.js';

const MAX_SIDES = 8;

/** Worktrees of the parts of the project's active split, if any. */
function activePartWorktrees(ctx: JobContext, projectId: string): string[] {
  const split = ctx.mindly.store.splits.active(projectId);
  return split ? ctx.mindly.store.splits.parts(split.id).map((p) => p.worktree) : [];
}

const inAny = (worktree: string, roots: readonly string[]): boolean =>
  roots.some((r) => worktree === r || worktree.startsWith(`${r}/`));

/**
 * Live sessions of a project with distinct, existing worktrees (most recently seen first).
 * Sessions working in the parts of an active split are left out: the split's merge check merges
 * those as one set (see `shadowMergeTick`).
 */
export function mergeCandidates(ctx: JobContext, projectId: string): Session[] {
  const seen = new Set<string>();
  const out: Session[] = [];
  const parts = activePartWorktrees(ctx, projectId);
  for (const s of ctx.mindly.store.sessions.listLive(projectId, LIVE_WINDOW_MS)) {
    if (s.status === 'ended' || seen.has(s.worktree) || inAny(s.worktree, parts)) continue;
    seen.add(s.worktree);
    out.push(s);
    if (out.length >= MAX_SIDES) break;
  }
  return out;
}

/** Creates a queued shadow-merge run. */
export function createShadowMergeRun(
  ctx: JobContext,
  projectId: string,
  trigger: 'schedule' | 'user',
): Run {
  return ctx.mindly.store.runs.create({
    projectId,
    kind: 'shadow_merge',
    title: 'Shadow merge',
    input: { trigger },
  });
}

/** Result shape of a shadow-merge run (see docs/api.md). */
export interface ShadowMergeRunResult {
  [key: string]: unknown;
  clean: boolean;
  conflictedPaths: string[];
  conflicts: { sessionIds: string[]; paths: string[] }[];
  checks: {
    name: string;
    ok: boolean;
    status: CheckResult['status'];
    exitCode: number | null;
    durationMs: number;
    outputTail: string;
  }[];
  checksSkipped: 'untrusted' | 'none_configured' | 'conflicts' | null;
  sessionIds: string[];
  merged: string[];
  skipped: string[];
  mergedTree: string | null;
  note?: string;
}

/**
 * Captures every live session's worktree, merges them in memory, reports `merge_conflict`
 * conflicts (resolving ones that disappeared) and, when the merge is clean and the project config
 * is trusted, runs the configured checks in a temporary tree and reports `check_failed`.
 */
export async function executeShadowMerge(ctx: JobContext, run: Run): Promise<Run> {
  const { mindly, logger } = ctx;
  const projectId = run.projectId;
  startRun(ctx, run);
  try {
    const project = mindly.projects.byId(projectId);
    const root = project.root;
    const deny = [...mindly.config.redaction.denyPaths, ...project.config.ignore];
    const captures: SessionCapture[] = [];
    // Sessions started in subdirectories of one working tree share it: capture each tree once.
    const tops = new Set<string>();
    for (const s of mergeCandidates(ctx, projectId)) {
      const c = await captureSession(root, s, deny, logger);
      if (!c || tops.has(c.top)) continue;
      tops.add(c.top);
      captures.push(c);
    }
    const base: ShadowMergeRunResult = {
      clean: true,
      conflictedPaths: [],
      conflicts: [],
      checks: [],
      checksSkipped: null,
      sessionIds: captures.map((c) => c.session.id),
      merged: [],
      skipped: [],
      mergedTree: null,
    };
    if (captures.length < 2) {
      return finishRun(ctx, run, 'cancelled', {
        ...base,
        note: 'needs at least two live sessions with distinct worktrees',
      });
    }

    const merge = await shadowMerge({
      repoRoot: root,
      sides: captures.map((c) => ({ label: c.session.id, commit: c.capture.commit })),
    });
    if (!merge.supported) {
      return finishRun(ctx, run, 'error', { ...base, error: merge.reason });
    }
    const byId = new Map(captures.map((c) => [c.session.id, c]));
    const result: ShadowMergeRunResult = {
      ...base,
      clean: merge.clean,
      merged: merge.merged,
      skipped: merge.skipped,
      mergedTree: merge.tree,
    };

    // Conflicts: one per distinct path set, attributed to the conflicting side and the merged
    // sides that touched any of those paths.
    const present: string[] = [];
    let baseBranch: { name: string | null } | undefined;
    // check_failed conflicts this run finds passing again (merge-check saves are confirmed then).
    let fixed: string[] = [];
    const accumulated: string[] = [captures[0]?.session.id ?? ''];
    for (const step of merge.steps) {
      if (step.status === 'clean') {
        accumulated.push(step.label);
        continue;
      }
      const paths = [...new Set(step.conflicts)].sort().slice(0, 200);
      const others = accumulated.filter((id) =>
        (byId.get(id)?.changed ?? []).some((p) => paths.includes(p)),
      );
      const sessionIds = [...new Set([step.label, ...others])];
      result.conflicts.push({ sessionIds, paths });
      for (const p of paths)
        if (!result.conflictedPaths.includes(p)) result.conflictedPaths.push(p);
      const fp = fingerprint('merge_conflict', ...paths);
      present.push(fp);
      const labels = sessionIds
        .map((id) => byId.get(id)?.session)
        .filter((s): s is Session => s !== undefined)
        .map(sessionLabel);
      const { conflict, isNew, eventId } = reportConflict(ctx, {
        projectId,
        kind: 'merge_conflict',
        severity: 'critical',
        title: sanitizeLine(
          `Work of ${labels.join(' and ')} conflicts in ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
          200,
        ),
        detail: sanitizeLine(
          `Merging the current worktrees of these sessions conflicts in: ${paths.slice(0, 20).join(', ')}`,
          1000,
        ),
        sessionIds,
        paths,
        fingerprint: fp,
      });
      if (eventId) {
        const git = mindly.kernel.ports.git;
        baseBranch ??= { name: await git.currentBranch(root) };
        const sides: { session: Session; changed: string[]; branch: string | null }[] = [];
        for (const id of sessionIds) {
          const c = byId.get(id);
          if (c)
            sides.push({
              session: c.session,
              changed: c.changed,
              branch: await git.currentBranch(c.top),
            });
        }
        await savesOf(mindly).mergeConflictFound({
          conflict,
          eventId,
          sides,
          repoRoot: root,
          baseBranch: baseBranch.name,
        });
      }
      if (isNew) {
        await notify(ctx, {
          trigger: 'conflict_critical',
          title: 'Agents are about to conflict',
          body: `Shadow merge found conflicts in ${paths.length} file${paths.length === 1 ? '' : 's'} in ${sanitizeLine(project.project.name, 80)}.`,
          projectName: sanitizeLine(project.project.name, 80),
          priority: 'high',
          dedupeKey: `merge_conflict:${fp}`,
        });
      }
    }
    mindly.store.conflicts.resolveMissing(projectId, 'merge_conflict', present, {
      exceptPrefix: SPLIT_FINGERPRINT_PREFIX,
    });

    let failed = !merge.clean;
    if (!merge.clean) result.checksSkipped = 'conflicts';
    else if (project.config.checks.length === 0) result.checksSkipped = 'none_configured';
    else if (!project.trusted) result.checksSkipped = 'untrusted';
    else {
      const tree = await materializeTree(root, merge.commit);
      let checks: CheckResult[];
      try {
        checks = await runChecks(
          tree.path,
          project.config.checks.map((c) => ({
            name: c.name,
            argv: c.argv,
            timeoutSec: c.timeoutSec,
          })),
        );
      } finally {
        await tree.dispose();
      }
      const failing: string[] = [];
      const changedBy = captures.filter((c) => c.changed.length > 0);
      for (const c of checks) {
        const tail = outputTail(c.output);
        result.checks.push({
          name: c.name,
          ok: c.status === 'pass',
          status: c.status,
          exitCode: c.exitCode,
          durationMs: c.durationMs,
          outputTail: tail,
        });
        if (c.status === 'pass') continue;
        failed = true;
        const fp = fingerprint('check_failed', c.name);
        failing.push(fp);
        // Attribute to sessions whose changed files appear in the output; otherwise to every
        // session that changed something.
        const mentioned = changedBy.filter((x) => x.changed.some((p) => tail.includes(p)));
        const involved = mentioned.length > 0 ? mentioned : changedBy;
        const paths = [...new Set(involved.flatMap((x) => x.changed))].sort().slice(0, 200);
        const { conflict, isNew, eventId } = reportConflict(ctx, {
          projectId,
          kind: 'check_failed',
          severity: 'critical',
          title: sanitizeLine(`Check "${c.name}" fails on the merged work of live agents`, 200),
          detail: sanitizeLine(
            `${c.status}${c.exitCode === null ? '' : ` (exit ${c.exitCode})`} in shadow merge run ${shortId(run.id)}`,
            1000,
          ),
          sessionIds: involved.map((x) => x.session.id),
          paths,
          fingerprint: fp,
        });
        if (eventId) savesOf(mindly).mergeCheckFailed(conflict, eventId);
        if (isNew) {
          await notify(ctx, {
            trigger: 'check_failed',
            title: 'A check fails on merged agent work',
            body: `Check "${sanitizeLine(c.name, 64)}" ${c.status} on the shadow merge of ${captures.length} sessions.`,
            projectName: sanitizeLine(project.project.name, 80),
            priority: 'high',
            dedupeKey: `check_failed:${projectId}:${fp}`,
          });
        }
      }
      fixed = mindly.store.conflicts
        .list(projectId, { statuses: ['open', 'acknowledged'], limit: 500 })
        .filter(
          (c) =>
            c.kind === 'check_failed' &&
            !failing.includes(c.fingerprint) &&
            // The sentinel's breaks are about one checkout's steps; it closes them itself.
            !c.fingerprint.startsWith(SENTINEL_FINGERPRINT_PREFIX),
        )
        .map((c) => c.id);
      mindly.store.conflicts.resolveMissing(projectId, 'check_failed', failing, {
        exceptPrefix: SENTINEL_FINGERPRINT_PREFIX,
      });
    }
    const finished = finishRun(ctx, run, failed ? 'failed' : 'passed', result);
    if (fixed.length > 0) {
      const evidence = mindly.store.events
        .query(projectId, { types: ['run.finished'], order: 'desc', limit: 20 })
        .find((e) => e.payload.runId === run.id);
      if (evidence) savesOf(mindly).mergeChecksPassed(projectId, fixed, evidence.id);
    }
    return finished;
  } catch (err) {
    return failRun(ctx, run, err);
  }
}

/**
 * Scheduler entry: runs a shadow merge for every project with two or more live worktrees, and
 * the merge check of an active split (every part's worktree as one set) while an agent works in
 * one of its parts.
 */
export async function shadowMergeTick(ctx: JobContext): Promise<void> {
  if (!ctx.mindly.config.shadowMerge.enabled) return;
  for (const p of ctx.mindly.store.projects.list().slice(0, 200)) {
    const split = ctx.mindly.store.splits.active(p.id);
    if (split) {
      const parts = activePartWorktrees(ctx, p.id);
      const live = ctx.mindly.store.sessions
        .listLive(p.id, LIVE_WINDOW_MS)
        .some((s) => s.status !== 'ended' && inAny(s.worktree, parts));
      const key = `split-check:${p.id}`;
      if (live && !ctx.scheduler.busy(key)) {
        await ctx.scheduler.enqueue(key, async () => {
          await splitOf(ctx.mindly).mergeCheck(split.id, 'schedule');
        });
      }
    }
    if (mergeCandidates(ctx, p.id).length < 2) continue;
    const key = `shadow:${p.id}`;
    if (ctx.scheduler.busy(key)) continue;
    await ctx.scheduler.enqueue(key, async () => {
      await executeShadowMerge(ctx, createShadowMergeRun(ctx, p.id, 'schedule'));
    });
  }
}
