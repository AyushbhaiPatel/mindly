import { AGENT_KIND_RE, isMindlyError, type Clock } from '@mindly/core';
import {
  parseAreaPrefix,
  SURVIVAL_AGE_MS,
  TRACK_DEFAULT_WINDOW_MS,
  trackOf,
  type TrackReport,
} from '@mindly/engine';
import { z } from 'zod';
import { withProject } from '../context.js';
import { parseDuration, UsageError, type Out } from '../util.js';
import { renderTrack } from '../views/track.js';
import { parseOptions } from './memory.js';

/*
 * `mindly track`: what each agent did in each part of this repository and what went wrong
 * afterwards, as counts. Survival of old edits is computed on demand within a small budget; the
 * daemon does the rest.
 */

/** Survival checks `mindly track` does before answering, and the time it may spend on them. */
export const ON_DEMAND_SURVIVAL = { max: 200, budgetMs: 3000 } as const;

const MAX_WINDOW_MS = 3650 * 86_400_000;

const TrackOptions = z.object({
  since: z.string().trim().min(1).optional(),
  area: z.string().min(1).max(512).optional(),
  agent: z.string().regex(AGENT_KIND_RE, 'not an agent kind (e.g. claude-code)').optional(),
  minEdits: z.number().int().min(1).max(100_000).optional(),
  explain: z.boolean().optional(),
  json: z.boolean().optional(),
});

/** Test hooks: a fixed clock (survival needs edits at least 7 days old). */
export interface TrackDeps {
  clock?: Clock;
}

/** `mindly track [--since 30d] [--area <prefix>] [--agent <kind>] [--min-edits 20] [--explain] [--json]`. */
export async function track(out: Out, raw: unknown, deps: TrackDeps = {}): Promise<number> {
  const o = parseOptions(TrackOptions, raw);
  const windowMs = o.since !== undefined ? parseDuration(o.since) : TRACK_DEFAULT_WINDOW_MS;
  if (windowMs <= 0 || windowMs > MAX_WINDOW_MS) {
    throw new UsageError('--since must be between 1s and 3650d');
  }
  let area: string | null = null;
  if (o.area !== undefined) {
    try {
      area = parseAreaPrefix(o.area);
    } catch (err) {
      if (isMindlyError(err)) throw new UsageError(`--area: ${err.message}`);
      throw err;
    }
  }
  return withProject(
    out.io,
    async ({ mindly, project }) => {
      const pid = project.project.id;
      const svc = trackOf(mindly);
      const now = mindly.kernel.clock.now();
      const from = now - windowMs;
      // Lines of edits that just turned 7 days old: checked here, a bounded amount at a time.
      const survival =
        now - SURVIVAL_AGE_MS >= from
          ? await svc.computeSurvival({ projectId: pid, from, ...ON_DEMAND_SURVIVAL })
          : { checked: 0, pending: 0 };
      const report: TrackReport = svc.report(pid, {
        windowMs,
        since: o.since ?? '30d',
        area,
        agent: o.agent ?? null,
        ...(o.minEdits !== undefined ? { minEdits: o.minEdits } : {}),
        checkedNow: survival.checked,
      });
      if (o.json) out.json(report);
      else renderTrack(out.screen(), report, { explain: o.explain === true, windowMs });
      return 0;
    },
    deps.clock ? { clock: deps.clock } : {},
  );
}
