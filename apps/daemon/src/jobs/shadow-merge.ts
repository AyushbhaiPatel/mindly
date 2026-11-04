import { fingerprint, sanitizeLine, shortId, type Run, type Session } from '@mindly/core';
import { LIVE_WINDOW_MS, sessionLabel } from '@mindly/engine';
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

/** Live sessions of a project with distinct, existing worktrees (most recently seen first). */
export function mergeCandidates(ctx: JobContext, projectId: string): Session[] {
  const seen = new Set<string>();
  const out: Session[] = [];
  for (const s of ctx.mindly.store.sessions.listLive(projectId, LIVE_WINDOW_MS)) {
    if (s.status === 'ended' || seen.has(s.worktree)) continue;
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
      const { isNew } = reportConflict(ctx, {
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
    mindly.store.conflicts.resolveMissing(projectId, 'merge_conflict', present);

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
        const { isNew } = reportConflict(ctx, {
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
      mindly.store.conflicts.resolveMissing(projectId, 'check_failed', failing);
    }
    return finishRun(ctx, run, failed ? 'failed' : 'passed', result);
  } catch (err) {
    return failRun(ctx, run, err);
  }
}

/** Scheduler entry: runs a shadow merge for every project with two or more live worktrees. */
export async function shadowMergeTick(ctx: JobContext): Promise<void> {
  if (!ctx.mindly.config.shadowMerge.enabled) return;
  for (const p of ctx.mindly.store.projects.list().slice(0, 200)) {
    if (mergeCandidates(ctx, p.id).length < 2) continue;
    const key = `shadow:${p.id}`;
    if (ctx.scheduler.busy(key)) continue;
    await ctx.scheduler.enqueue(key, async () => {
      await executeShadowMerge(ctx, createShadowMergeRun(ctx, p.id, 'schedule'));
    });
  }
}
