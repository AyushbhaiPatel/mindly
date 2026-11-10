import { describeError } from '@mindly/core';
import { needsYouCount, savesOf, selfHealingOf, standupService, trackOf } from '@mindly/engine';
import type { JobContext } from './context.js';

const DAY_MS = 86_400_000;
/** Sessions not seen for this long are marked ended. */
export const STALE_SESSION_MS = 6 * 60 * 60_000;
/** Context packets (X-Ray) are kept this long. */
export const CONTEXT_PACKET_RETENTION_MS = 30 * DAY_MS;
const MAX_PROJECTS = 200;

/** Re-checks memory evidence of every project (self-healing sweep). */
export function selfHealingTick(ctx: JobContext): void {
  const svc = selfHealingOf(ctx.mindly);
  for (const p of ctx.mindly.store.projects.list().slice(0, MAX_PROJECTS)) {
    try {
      const r = svc.sweep(p.id);
      if (r.markedStale > 0 || r.restored > 0) {
        ctx.logger.info('self-healing sweep', { projectId: p.id, ...r });
      }
    } catch (err) {
      ctx.logger.error('self-healing sweep failed', { projectId: p.id, error: describeError(err) });
    }
  }
}

/** What one housekeeping pass removed or changed. */
export interface HousekeepingResult {
  intentsExpired: number;
  deliveriesExpired: number;
  sessionsEnded: number;
  promptsCompacted: number;
  eventsDeleted: number;
  packetsDeleted: number;
  /** Caught saves settled because their window passed (or their conflict was dismissed). */
  saves: { confirmed: number; expired: number; rejected: number };
}

/**
 * Expires intents and deliveries, ends stale sessions, settles saves whose window passed and
 * applies retention: prompt text after `retention.promptsDays`, events after
 * `retention.eventsDays`, context packets after 30 days.
 */
export function housekeepingTick(ctx: JobContext): HousekeepingResult {
  const { store, config } = ctx.mindly;
  const now = ctx.mindly.kernel.clock.now();
  const result: HousekeepingResult = {
    intentsExpired: store.intents.expire(),
    deliveriesExpired: store.deliveries.expire(),
    sessionsEnded: 0,
    promptsCompacted: store.events.compactPrompts(now - config.retention.promptsDays * DAY_MS),
    eventsDeleted: store.events.deleteOlderThan(now - config.retention.eventsDays * DAY_MS),
    packetsDeleted: store.contextPackets.deleteOlderThan(now - CONTEXT_PACKET_RETENTION_MS),
    saves: { confirmed: 0, expired: 0, rejected: 0 },
  };
  for (const p of store.projects.list().slice(0, MAX_PROJECTS)) {
    const ended = store.sessions.endStale(p.id, STALE_SESSION_MS);
    // They never had their end hook: their notes of writes in flight go with them.
    for (const id of ended) ctx.mindly.checkpoints.forgetWrites(id);
    result.sessionsEnded += ended.length;
  }
  result.saves = savesOf(ctx.mindly).sweep();
  ctx.logger.info('housekeeping', { ...result });
  return result;
}

/** Deletes checkpoints past `checkpoints.keepDays` or `checkpoints.maxPerWorktree` in every project. */
export async function checkpointPruneTick(ctx: JobContext): Promise<void> {
  const r = await ctx.mindly.checkpoints.pruneAll();
  if (r.refsDeleted > 0 || r.rowsDeleted > 0) ctx.logger.info('checkpoint prune', { ...r });
}

/** Edits whose line survival one tick computes, across all projects. */
export const SURVIVAL_PER_TICK = 500;

/** Wall-clock time one survival tick may spend reading files. */
export const SURVIVAL_TICK_BUDGET_MS = 20_000;

/** Computes line survival (`mindly track`) for up to 500 edits that turned 7 days old. */
export async function trackSurvivalTick(ctx: JobContext): Promise<number> {
  const r = await trackOf(ctx.mindly).computeSurvival({
    projectId: null,
    max: SURVIVAL_PER_TICK,
    budgetMs: SURVIVAL_TICK_BUDGET_MS,
  });
  if (r.checked > 0) ctx.logger.info('track survival', { checked: r.checked });
  return r.checked;
}

/**
 * Sends the scheduled standup (when `config.standup.time` is set) for each project that is due,
 * then marks it delivered. Projects with nothing to report are marked without a notification.
 */
export async function standupTick(ctx: JobContext): Promise<void> {
  if (!ctx.mindly.config.standup.time) return;
  const svc = standupService(ctx.mindly);
  for (const p of ctx.mindly.store.projects.list().slice(0, MAX_PROJECTS)) {
    if (!svc.isDue(p.id)) continue;
    const digest = svc.build(p.id);
    if (digest.agents.length > 0 || needsYouCount(digest) > 0) await svc.notify(p.id, digest);
    svc.markDelivered(p.id);
  }
}
