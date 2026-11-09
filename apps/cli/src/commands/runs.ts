import { MindlyError, type Run } from '@mindly/core';
import { z } from 'zod';
import { pickSession, withProject, type ProjectScope } from '../context.js';
import {
  agentName,
  capitalise,
  humanizeText,
  runKindWord,
  runStatusWord,
} from '../present/index.js';
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

const SEVERITY_WORDS: Record<string, string> = {
  info: 'FYI',
  warning: 'check this',
  critical: 'urgent',
};

function printRun(out: Out, run: Run, json: boolean | undefined): void {
  if (json) {
    out.json(run);
    return;
  }
  const sc = out.screen();
  const ok = run.status === 'passed';
  const marker = ok ? 'ok' : run.status === 'failed' || run.status === 'error' ? 'fail' : 'item';
  sc.summary(
    `${sc.mark(marker)} ${capitalise(runKindWord(run.kind))}: ${humanizeText(clean(run.title, 120))} ${sc.sym.dot} ${runStatusWord(run.status)}  ${sc.ref(run.id)}`,
  );
  const r = run.result;
  if (!r) return;
  if (typeof r['summary'] === 'string') sc.text(clean(r['summary'], 300), 2);
  if (Array.isArray(r['findings'])) {
    const findings = r['findings'] as {
      severity?: string;
      file?: string | null;
      line?: number | null;
      message?: string;
    }[];
    if (findings.length) sc.section('Findings');
    sc.rows(
      findings.map((f) => {
        const where = f.file ? `${clean(f.file, 120)}${f.line ? `:${f.line}` : ''}: ` : '';
        const sev = f.severity ?? 'info';
        return {
          marker: sev === 'critical' ? 'fail' : sev === 'warning' ? 'warn' : 'item',
          text: `${SEVERITY_WORDS[sev] ?? 'FYI'}: ${where}${clean(f.message ?? '', 200)}`,
        };
      }),
    );
  }
  if (Array.isArray(r['agents'])) {
    const agents = r['agents'] as {
      agent?: string;
      status?: string;
      filesChanged?: number;
      addedLines?: number;
      removedLines?: number;
      summary?: string;
    }[];
    if (agents.length) sc.section('Agents');
    sc.rows(
      agents.map((a) => ({
        marker:
          a.status === 'completed'
            ? 'ok'
            : a.status === 'failed' || a.status === 'error' || a.status === 'timeout'
              ? 'fail'
              : 'item',
        text: `${agentName(clean(a.agent ?? 'agent', 32))}: ${agentRunWord(a.status)}, changed ${a.filesChanged ?? 0} files (+${a.addedLines ?? 0} -${a.removedLines ?? 0} lines)${a.summary ? `. ${clean(a.summary, 120)}` : ''}`,
      })),
    );
  }
  if (typeof r['error'] === 'string' && r['error']) {
    sc.text(`${sc.mark('fail')} What went wrong: ${clean(r['error'], 300)}`);
  }
}

/** Plain words for how one agent's run ended (the statuses of `@mindly/runners`). */
const AGENT_RUN_WORDS: Readonly<Record<string, string>> = {
  completed: 'finished',
  failed: 'failed',
  timeout: 'ran out of time',
  aborted: 'cancelled',
  error: 'could not run',
  unavailable: 'not installed',
};

export function agentRunWord(status: string | undefined): string {
  return (status !== undefined ? AGENT_RUN_WORDS[status] : undefined) ?? 'unknown';
}

/** Runs a review/replay in this process with the real agent runners (no daemon). */
async function runDirect(scope: ProjectScope, run: Run, env: NodeJS.ProcessEnv): Promise<Run> {
  const [{ executeReplay, executeReview, Scheduler }, { createRunners }] = await Promise.all([
    import('@mindly/daemon'),
    import('@mindly/runners'),
  ]);
  const logger = scope.mindly.kernel.logger.child({ component: 'cli' });
  const ctx = {
    mindly: scope.mindly,
    logger,
    scheduler: new Scheduler(logger),
    // The command's environment, not the process's: it decides which agent programs are found.
    runners: createRunners({ env }),
  };
  return run.kind === 'review' ? executeReview(ctx, run) : executeReplay(ctx, run);
}

const DIRECT_WARNING =
  "Mindly's background service is not running, so this runs here instead. It starts the agents without a window in separate copies of the code and may take several minutes.";

/** `mindly review --session <id> --reviewer <agent>`: cross-agent review of a session's changes. */
export async function review(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(ReviewOptions, raw);
  return withProject(out.io, async (scope) => {
    const session = pickSession(scope, o.session);
    if (session.agentKind === o.reviewer) {
      throw new MindlyError(
        'invalid_input',
        `${agentName(session.agentKind)} cannot review its own work: choose another agent with --reviewer`,
      );
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
      else {
        const sc = out.screen();
        sc.text(`${sc.mark('ok')} Review started in the background ${sc.ref(run.id)}.`);
        sc.next([{ cmd: 'mindly dashboard', why: 'follow it in Mission Control' }]);
      }
      return 0;
    }
    out.warn(DIRECT_WARNING);
    const run = scope.mindly.store.runs.create({
      projectId: pid,
      kind: 'review',
      title: `Review of ${session.agentKind} by ${o.reviewer}`,
      input: { sessionId: session.id, reviewer: o.reviewer },
    });
    const done = await runDirect(scope, run, out.io.env);
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
      else {
        const sc = out.screen();
        sc.text(`${sc.mark('ok')} Replay started in the background ${sc.ref(run.id)}.`);
        sc.next([{ cmd: 'mindly dashboard', why: 'follow it in Mission Control' }]);
      }
      return 0;
    }
    out.warn(DIRECT_WARNING);
    const run = scope.mindly.store.runs.create({
      projectId: pid,
      kind: 'replay',
      title: `Replay with ${o.agents.join(', ')}`,
      input: { prompt: o.prompt, baseCommit: o.base ?? 'HEAD', agents: o.agents },
    });
    const done = await runDirect(scope, run, out.io.env);
    printRun(out, done, o.json);
    return done.status === 'passed' ? 0 : 1;
  });
}
