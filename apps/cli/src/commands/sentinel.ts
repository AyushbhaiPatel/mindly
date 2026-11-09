import { resolve } from 'node:path';
import { sentinelOf, type SentinelProgress } from '@mindly/engine';
import { z } from 'zod';
import { withProject, type ProjectScope } from '../context.js';
import { confirm } from '../io.js';
import { HintedError, type Out } from '../util.js';
import { notReadyWords, renderSentinelPass, renderSentinelStatus } from '../views/sentinel.js';
import { daemonAlive } from './daemon.js';
import { parseOptions } from './memory.js';

/*
 * `mindly sentinel`: the background checks after agent edits. The daemon runs them on its own
 * schedule; `sentinel run` does one pass now, in the foreground, the same way.
 */

const Options = z.object({
  worktree: z.string().min(1).optional(),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
});

/** The checkout a subcommand is about: `--worktree`, else the current folder's. */
async function worktreeOf(scope: ProjectScope, cwd: string, override?: string): Promise<string> {
  const dir = override !== undefined ? resolve(cwd, override) : cwd;
  const worktree = await scope.mindly.checkpoints.worktreeOf(dir);
  if (!worktree) {
    throw new HintedError(
      'unavailable',
      `${override === undefined ? 'this folder' : override} is not inside a git repository, so there are no checkpoints to check`,
      'The sentinel checks the copies Mindly keeps after each agent edit, which need git',
    );
  }
  return worktree;
}

/** The sentinel holds a checkout's lock: a pass (or a cleanup) is running there now. */
export function busyError(): HintedError {
  return new HintedError(
    'conflict',
    'the sentinel is checking this checkout right now',
    'Wait for it to finish (mindly sentinel shows when it last checked), or stop the daemon: mindly daemon stop',
  );
}

/** `mindly sentinel [--json]`. */
export async function sentinelStatus(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(Options.pick({ json: true }), raw);
  return withProject(out.io, async (scope) => {
    const status = sentinelOf(scope.mindly).status(scope.project.project.id);
    const daemon = daemonAlive(out.io.env);
    if (o.json) {
      out.json({ ...status, daemon });
      return 0;
    }
    const current = (await scope.mindly.checkpoints.worktreeOf(out.io.cwd)) ?? scope.project.root;
    renderSentinelStatus(out.screen(), status, { root: current, daemon });
    return 0;
  });
}

/** Test hook: an abort signal besides Ctrl-C. */
export interface SentinelRunDeps {
  signal?: AbortSignal;
}

/** `mindly sentinel run [--worktree <path>] [--json]`: one pass now, even when the sentinel is off. */
export async function sentinelRun(
  out: Out,
  raw: unknown,
  deps: SentinelRunDeps = {},
): Promise<number> {
  const o = parseOptions(Options.pick({ worktree: true, json: true }), raw);
  return withProject(out.io, async (scope) => {
    const { mindly, project } = scope;
    const svc = sentinelOf(mindly);
    const ready = svc.readiness(project);
    if (!ready.ready) {
      const w = notReadyWords(ready.reason ?? 'no_checks');
      throw new HintedError(
        'unavailable',
        `the sentinel cannot run: ${w.why}`,
        w.step.cmd
          ? `${w.step.why[0]?.toUpperCase() ?? ''}${w.step.why.slice(1)}: ${w.step.cmd}`
          : w.step.why,
      );
    }
    const worktree = await worktreeOf(scope, out.io.cwd, o.worktree);
    const ac = new AbortController();
    const cancel = (): void => ac.abort();
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals) process.on(s, cancel);
    deps.signal?.addEventListener('abort', cancel, { once: true });
    if (deps.signal?.aborted) ac.abort();
    let last = '';
    const progress = (p: SentinelProgress): void => {
      const line =
        p.phase === 'bisect'
          ? `finding the edit that broke ${p.check ?? 'a check'}: step ${p.step} (${p.run ?? '?'} of ~${p.estimatedRuns ?? '?'} runs)`
          : `running ${p.check ?? 'checks'} at step ${p.step}`;
      if (line !== last) out.warn(line);
      last = line;
    };
    try {
      const r = await svc.pass(project.project.id, worktree, {
        trigger: 'user',
        force: true,
        signal: ac.signal,
        onProgress: progress,
      });
      if (r.status === 'no_steps') {
        throw new HintedError(
          'not_found',
          'no checkpoints in this checkout yet',
          'Mindly saves one after every agent edit: let Claude Code, Codex or Cursor edit something here first (connect them with: mindly init)',
        );
      }
      if (o.json) out.json(r);
      else renderSentinelPass(out.screen(), r, worktree);
      if (r.status !== 'checked') return 1;
      return r.checks.some((c) => c.outcome !== 'pass') ? 1 : 0;
    } finally {
      for (const s of signals) process.off(s, cancel);
      deps.signal?.removeEventListener('abort', cancel);
    }
  });
}

/** `mindly sentinel reset [--worktree <path>] [-y]`: forgets a checkout's state and scratch tree. */
export async function sentinelReset(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(Options, raw);
  return withProject(out.io, async (scope) => {
    const worktree = await worktreeOf(scope, out.io.cwd, o.worktree);
    const ok = await confirm(
      out.io,
      'Forget what the sentinel knows about this checkout and delete its scratch copy? The next run starts over; conflicts it opened stay.',
      o.yes === true,
    );
    if (!ok) {
      out.line('Nothing changed.');
      return 1;
    }
    const r = await sentinelOf(scope.mindly).reset(scope.project.project.id, worktree);
    if (r === 'busy') throw busyError();
    if (r === 'failed') {
      throw new HintedError(
        'internal',
        "the sentinel's scratch copy of this checkout could not be removed",
        'See the log in ~/.mindly/logs, then try again',
      );
    }
    if (o.json) out.json({ worktree, reset: r === 'reset' });
    else {
      out.line(
        r === 'reset'
          ? 'Reset: the next run checks this checkout from scratch.'
          : 'There was nothing to reset.',
      );
    }
    return 0;
  });
}
