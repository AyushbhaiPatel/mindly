import {
  describeError,
  isMindlyError,
  redactText,
  sanitizeLine,
  type Conflict,
  type Logger,
  type Run,
  type RunStatus,
} from '@mindly/core';
import type { Mindly, NotifyTrigger } from '@mindly/engine';
import type { ConflictReport } from '@mindly/store';
import type { RunnerPort } from '@mindly/runners';
import type { Scheduler } from './scheduler.js';

/** Everything a background job needs. */
export interface JobContext {
  mindly: Mindly;
  logger: Logger;
  scheduler: Scheduler;
  runners: RunnerPort;
}

/** Marks a run as running and records `run.started`. */
export function startRun(ctx: JobContext, run: Run): void {
  ctx.mindly.store.runs.start(run.id);
  ctx.mindly.store.events.append({
    projectId: run.projectId,
    sessionId: null,
    type: 'run.started',
    payload: { runId: run.id, kind: run.kind, title: run.title },
  });
}

/** Finishes a run, records `run.finished` and returns the stored run. */
export function finishRun(
  ctx: JobContext,
  run: Run,
  status: Exclude<RunStatus, 'queued' | 'running'>,
  result: Record<string, unknown>,
): Run {
  const saved = ctx.mindly.store.runs.finish(run.id, status, result);
  ctx.mindly.store.events.append({
    projectId: run.projectId,
    sessionId: null,
    type: 'run.finished',
    payload: { runId: run.id, kind: run.kind, status },
  });
  return saved;
}

/** Records a run that failed unexpectedly: generic message in the result, details in the log. */
export function failRun(ctx: JobContext, run: Run, err: unknown): Run {
  ctx.logger.error('run failed', { runId: run.id, kind: run.kind, error: describeError(err) });
  return finishRun(ctx, run, 'error', { error: safeMessage(err) });
}

/** A short message that is safe to store and show (Mindly error messages are; others are not). */
export function safeMessage(err: unknown): string {
  if (isMindlyError(err)) return sanitizeLine(redactText(err.message), 300);
  return 'internal error (see the daemon log)';
}

/**
 * Reports a conflict and records `conflict.opened` when it is new. Returns the conflict, whether
 * it is new and the id of the `conflict.opened` event (null when it is not new).
 */
export function reportConflict(
  ctx: JobContext,
  report: ConflictReport,
): { conflict: Conflict; isNew: boolean; eventId: string | null } {
  const res = ctx.mindly.store.conflicts.report(report);
  if (!res.isNew) return { ...res, eventId: null };
  const event = ctx.mindly.store.events.append({
    projectId: report.projectId,
    sessionId: null,
    type: 'conflict.opened',
    payload: {
      conflictId: res.conflict.id,
      kind: res.conflict.kind,
      severity: res.conflict.severity,
      title: res.conflict.title,
    },
  });
  return { ...res, eventId: event.id };
}

/** Sends a pager notification (titles and counts only). Never throws. */
export async function notify(
  ctx: JobContext,
  n: {
    trigger: NotifyTrigger;
    title: string;
    body: string;
    projectName?: string;
    priority?: 'low' | 'default' | 'high';
    dedupeKey?: string;
  },
): Promise<void> {
  try {
    await ctx.mindly.kernel.ports.notifier.send(n);
  } catch (err) {
    ctx.logger.warn('notification failed', { trigger: n.trigger, error: describeError(err) });
  }
}

/** Keeps the last `max` characters of process output, redacted. */
export function outputTail(text: string, max = 4000): string {
  const redacted = redactText(text);
  return redacted.length > max ? redacted.slice(-max) : redacted;
}
