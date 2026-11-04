import { MindlyError, type Run } from '@mindly/core';
import { z } from 'zod';
import { pickSession, withProject, type ProjectScope } from '../context.js';
import { clean, splitList, type Out } from '../util.js';
import { daemonRequest, runningDaemon } from './daemon.js';
import { parseOptions } from './memory.js';

const RUNNER_AGENTS = ['claude-code', 'codex'] as const;
const RunnerAgent = z.enum(RUNNER_AGENTS);

const ReviewOptions = z.object({
  session: z.string().min(1),
  reviewer: RunnerAgent,
  json: z.boolean().optional(),
});

const ReplayOptions = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  agents: z
    .array(RunnerAgent)
    .min(1)
    .max(4)
    .refine((a) => new Set(a).size === a.length, 'agents must be distinct'),
  base: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/^~-]{0,199}$/, 'invalid revision')
    .refine((s) => !s.includes('..'), 'invalid revision')
    .optional(),
  json: z.boolean().optional(),
});

function printRun(out: Out, run: Run, json: boolean | undefined): void {
  if (json) {
    out.json(run);
    return;
  }
  out.line(`${clean(run.title, 120)}: ${run.status} (run ${run.id})`);
  const r = run.result;
  if (!r) return;
  if (typeof r['summary'] === 'string') out.line(clean(r['summary'], 300));
  if (Array.isArray(r['findings'])) {
    for (const f of r['findings'] as {
      severity?: string;
      file?: string | null;
      line?: number | null;
      message?: string;
    }[]) {
      const where = f.file ? `${clean(f.file, 120)}${f.line ? `:${f.line}` : ''} ` : '';
      out.line(`  ${f.severity ?? 'info'}  ${where}${clean(f.message ?? '', 200)}`);
    }
  }
  if (Array.isArray(r['agents'])) {
    for (const a of r['agents'] as {
      agent?: string;
      status?: string;
      filesChanged?: number;
      addedLines?: number;
      removedLines?: number;
      summary?: string;
    }[]) {
      out.line(
        `  ${clean(a.agent ?? '?', 20)}  ${a.status ?? '?'}  ${a.filesChanged ?? 0} files +${a.addedLines ?? 0}/-${a.removedLines ?? 0}  ${clean(a.summary ?? '', 120)}`,
      );
    }
  }
  if (typeof r['error'] === 'string' && r['error']) out.line(`error: ${clean(r['error'], 300)}`);
}

/** Runs a review/replay in this process with the real agent runners (no daemon). */
async function runDirect(scope: ProjectScope, run: Run): Promise<Run> {
  const [{ executeReplay, executeReview, Scheduler }, { createRunners }] = await Promise.all([
    import('@mindly/daemon'),
    import('@mindly/runners'),
  ]);
  const logger = scope.mindly.kernel.logger.child({ component: 'cli' });
  const ctx = {
    mindly: scope.mindly,
    logger,
    scheduler: new Scheduler(logger),
    runners: createRunners(),
  };
  return run.kind === 'review' ? executeReview(ctx, run) : executeReplay(ctx, run);
}

const DIRECT_WARNING =
  'The Mindly daemon is not running: running here instead. This launches the agent CLIs headlessly in isolated worktrees and may take several minutes.';

/** `mindly review --session <id> --reviewer <agent>`: cross-agent review of a session's changes. */
export async function review(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(ReviewOptions, raw);
  return withProject(out.io, async (scope) => {
    const session = pickSession(scope, o.session);
    if (session.agentKind === o.reviewer) {
      throw new MindlyError('invalid_input', 'the reviewer must be a different agent');
    }
    const pid = scope.project.project.id;
    const daemon = await runningDaemon(out.io.env);
    if (daemon) {
      const run = await daemonRequest<Run>(
        out.io.env,
        daemon,
        'POST',
        `/api/projects/${pid}/review`,
        {
          sessionId: session.id,
          reviewer: o.reviewer,
        },
      );
      if (o.json) out.json(run);
      else out.line(`Review queued in the daemon (run ${run.id}). Follow it in mindly dashboard.`);
      return 0;
    }
    out.warn(DIRECT_WARNING);
    const run = scope.mindly.store.runs.create({
      projectId: pid,
      kind: 'review',
      title: `Review of ${session.agentKind} by ${o.reviewer}`,
      input: { sessionId: session.id, reviewer: o.reviewer },
    });
    const done = await runDirect(scope, run);
    printRun(out, done, o.json);
    return done.status === 'error' ? 1 : 0;
  });
}

/** `mindly replay --prompt <p> --agents a,b`: A/B replay of a prompt from the same commit. */
export async function replay(
  out: Out,
  raw: { prompt?: string; agents?: string; base?: string; json?: boolean },
): Promise<number> {
  const o = parseOptions(ReplayOptions, {
    ...raw,
    agents: raw.agents !== undefined ? splitList(raw.agents) : undefined,
  });
  return withProject(out.io, async (scope) => {
    const pid = scope.project.project.id;
    const daemon = await runningDaemon(out.io.env);
    if (daemon) {
      const run = await daemonRequest<Run>(
        out.io.env,
        daemon,
        'POST',
        `/api/projects/${pid}/replay`,
        {
          prompt: o.prompt,
          agents: o.agents,
          ...(o.base ? { baseCommit: o.base } : {}),
        },
      );
      if (o.json) out.json(run);
      else out.line(`Replay queued in the daemon (run ${run.id}). Follow it in mindly dashboard.`);
      return 0;
    }
    out.warn(DIRECT_WARNING);
    const run = scope.mindly.store.runs.create({
      projectId: pid,
      kind: 'replay',
      title: `Replay with ${o.agents.join(', ')}`,
      input: { prompt: o.prompt, baseCommit: o.base ?? 'HEAD', agents: o.agents },
    });
    const done = await runDirect(scope, run);
    printRun(out, done, o.json);
    return done.status === 'passed' ? 0 : 1;
  });
}
