import { describeError, loadUserConfig } from '@mindly/core';
import { sentinelOf } from '@mindly/engine';
import type { JobContext } from './context.js';

const MAX_PROJECTS = 200;

/**
 * Re-reads the `sentinel` settings from the config file, so `mindly config set sentinel.enabled`
 * takes effect without restarting the daemon. Other settings keep the values read at start; an
 * unreadable file keeps the current ones.
 */
function refreshSentinelConfig(ctx: JobContext): void {
  const file = ctx.mindly.paths?.config;
  if (!file) return;
  try {
    Object.assign(ctx.mindly.config.sentinel, loadUserConfig(file).sentinel);
  } catch (err) {
    ctx.logger.warn('sentinel: config not re-read', { error: describeError(err) });
  }
}

/**
 * Runs the sentinel over every working tree that is due (enough new steps, or the agents paused),
 * one pass at a time across all projects so checks never compete for the machine. Passes stop
 * when the daemon stops: their commands are killed and the run is recorded as cancelled.
 */
export async function sentinelTick(ctx: JobContext): Promise<number> {
  refreshSentinelConfig(ctx);
  if (!ctx.mindly.config.sentinel.enabled) return 0;
  const svc = sentinelOf(ctx.mindly);
  let passes = 0;
  for (const p of ctx.mindly.store.projects.list().slice(0, MAX_PROJECTS)) {
    let due: string[];
    try {
      if (!svc.readiness(ctx.mindly.projects.byId(p.id)).ready) continue;
      due = svc.dueWorktrees(p.id);
    } catch (err) {
      ctx.logger.error('sentinel: project skipped', { projectId: p.id, error: describeError(err) });
      continue;
    }
    for (const worktree of due) {
      if (ctx.scheduler.signal.aborted) return passes;
      const r = await svc.pass(p.id, worktree, {
        trigger: 'schedule',
        signal: ctx.scheduler.signal,
      });
      if (r.status === 'checked') passes++;
      const broke = r.checks.filter((c) => c.transition === 'broke').map((c) => c.name);
      if (r.status === 'checked' || r.status === 'error') {
        ctx.logger.info('sentinel pass', {
          projectId: p.id,
          status: r.status,
          step: r.step,
          ...(broke.length ? { broke } : {}),
        });
      }
    }
  }
  return passes;
}

/** Removes warm scratch trees of the sentinel that were not used for a few days. */
export async function sentinelPruneTick(ctx: JobContext): Promise<void> {
  const n = await sentinelOf(ctx.mindly).pruneWarm();
  if (n > 0) ctx.logger.info('sentinel prune', { removed: n });
}
