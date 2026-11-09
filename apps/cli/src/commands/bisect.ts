import { resolve } from 'node:path';
import { describeError, redactText, type Checkpoint, type Run } from '@mindly/core';
import {
  BisectAborted,
  bisectOf,
  bisectSearch,
  outputTail,
  StepCommandRunner,
  type BisectSearchResult,
  type StepCheck,
  type StepGitPort,
  type StepInfo,
  type StepWorkspace,
} from '@mindly/engine';
import { lockfileIn, revertStep, stepDiff } from '@mindly/git';
import { z } from 'zod';
import { withProject, type ProjectScope } from '../context.js';
import { confirm } from '../io.js';
import { argvWords, count } from '../present/index.js';
import {
  HintedError,
  LITERAL_MARK,
  parseDuration,
  stripControl,
  UsageError,
  type Out,
} from '../util.js';
import {
  renderBisect,
  renderStepList,
  renderStepShow,
  stepWhat,
  type BisectReport,
} from '../views/bisect.js';
import { parseOptions } from './memory.js';

/*
 * `mindly bisect`: which agent edit broke a command. The search runs in a scratch worktree in a
 * temp dir, never in the user's checkout; the command is the user's own argv, run without a shell.
 */

const DEFAULT_SINCE = '24h';
/** Time limit per run of the command (and of the setup command). */
export const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 3600;
const MAX_STEP = 1_000_000_000;
const MAX_LIST = 500;

const RunOptions = z.object({
  since: z.string().trim().min(1).optional(),
  good: z.number().int().min(1).max(MAX_STEP).optional(),
  bad: z.number().int().min(1).max(MAX_STEP).optional(),
  worktree: z.string().min(1).optional(),
  setup: z.string().trim().min(1).optional(),
  timeout: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional(),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
});

/** Test hooks: an abort signal besides Ctrl-C, and where the scratch worktree was created. */
export interface BisectDeps {
  signal?: AbortSignal;
  onWorkspace?: (path: string) => void;
}

/** Splits `--setup "pnpm install --frozen-lockfile"` into argv (quotes and backslashes as in a shell, no expansion). */
export function splitCommandLine(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new UsageError('the command has an unclosed quote');
  if (has) out.push(cur);
  return out;
}

/** The canonical working tree to search: `--worktree`, else the current folder's. */
async function worktreeFor(scope: ProjectScope, cwd: string, override?: string): Promise<string> {
  const { mindly } = scope;
  if (!mindly.kernel.ports.git.checkpoints || !mindly.kernel.ports.git.steps) {
    throw new HintedError(
      'unavailable',
      'git is not available, so Mindly has no checkpoints to search',
      'Install git, then let an agent make some edits here',
    );
  }
  if (!mindly.config.checkpoints.enabled) {
    throw new HintedError(
      'unavailable',
      'checkpoints are turned off, so there are no steps to search',
      'Turn them on with: mindly config set checkpoints.enabled true',
    );
  }
  const dir = override !== undefined ? resolve(cwd, override) : cwd;
  const worktree = await mindly.checkpoints.worktreeOf(dir);
  if (!worktree) {
    throw new HintedError(
      'unavailable',
      `${override === undefined ? 'this folder' : override} is not inside a git repository, so Mindly keeps no checkpoints for it`,
      'Checkpoints need git: run git init here, then let an agent make some edits',
    );
  }
  return worktree;
}

function stepNumber(value: string): number {
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) {
    throw new UsageError('a step is a positive number, as mindly bisect list shows it');
  }
  return Number(value);
}

function noSuchStep(seq: number): HintedError {
  return new HintedError(
    'not_found',
    `step ${seq} does not exist in this checkout`,
    'See the steps with: mindly bisect list',
  );
}

/** A step of the worktree, or a clear error. */
function stepOf(scope: ProjectScope, worktree: string, seq: number): Checkpoint {
  const step = scope.mindly.checkpoints.step(scope.project.project.id, worktree, seq);
  if (!step) throw noSuchStep(seq);
  return step;
}

/** The consecutive steps to search, oldest first (at least two). */
function stepsFor(
  scope: ProjectScope,
  worktree: string,
  o: { since?: string | undefined; good?: number | undefined; bad?: number | undefined },
  now: number,
): { steps: Checkpoint[]; since: string | null } {
  const svc = scope.mindly.checkpoints;
  const pid = scope.project.project.id;
  if (o.good !== undefined && o.since !== undefined) {
    throw new UsageError('use either --since or --good, not both');
  }
  if (o.good !== undefined && o.bad !== undefined && o.bad <= o.good) {
    throw new UsageError('--bad must be a later step than --good');
  }
  if (o.good !== undefined) stepOf(scope, worktree, o.good);
  if (o.bad !== undefined) stepOf(scope, worktree, o.bad);
  const since = o.good === undefined ? (o.since ?? DEFAULT_SINCE) : null;
  const steps = svc.list(pid, worktree, {
    ...(since !== null ? { since: now - parseDuration(since) } : {}),
    ...(o.good !== undefined ? { fromSeq: o.good } : {}),
    ...(o.bad !== undefined ? { toSeq: o.bad } : {}),
    limit: 100_000,
  });
  if (steps.length === 0) {
    if (!svc.latest(pid, worktree)) {
      throw new HintedError(
        'not_found',
        'no checkpoints in this checkout yet',
        'Mindly saves one after every agent edit: let Claude Code, Codex or Cursor edit something here first (connect them with: mindly init)',
      );
    }
    throw new HintedError(
      'not_found',
      `no checkpoints in the last ${since ?? 'range'}`,
      'Try a longer window (mindly bisect --since 7d -- <command>) or pick the ends with --good and --bad (see mindly bisect list)',
    );
  }
  if (steps.length < 2) {
    throw new HintedError(
      'invalid_input',
      'only one step in that range; a bisect needs a step that passes and a later one that fails',
      'Widen the range with --since or --good (see mindly bisect list)',
    );
  }
  return { steps, since };
}

function sanitizeCheck(c: StepCheck): StepCheck {
  return { ...c, output: outputTail(c.output) };
}

/** `mindly bisect [options] -- <command> [args...]`. */
export async function bisectRun(
  out: Out,
  command: readonly string[],
  raw: unknown,
  deps: BisectDeps = {},
): Promise<number> {
  const o = parseOptions(RunOptions, raw);
  const argv = (command[0] === LITERAL_MARK ? command.slice(1) : command).map((a) =>
    stripControl(a),
  );
  if (argv.length === 0 || argv[0] === '') {
    throw new UsageError('give the command to run after --, e.g. mindly bisect -- pnpm test');
  }
  const setup = o.setup !== undefined ? splitCommandLine(o.setup) : null;
  if (setup !== null && setup.length === 0) throw new UsageError('--setup is empty');
  const timeoutSec = o.timeout ?? DEFAULT_TIMEOUT_SEC;

  return withProject(out.io, async (scope) => {
    const { mindly, project } = scope;
    const pid = project.project.id;
    const now = mindly.kernel.clock.now();
    const worktree = await worktreeFor(scope, out.io.cwd, o.worktree);
    const { steps, since } = stepsFor(scope, worktree, o, now);
    const good = steps[0] as Checkpoint;
    const bad = steps[steps.length - 1] as Checkpoint;
    const svc = bisectOf(mindly);
    const lockfile = setup === null ? lockfileIn(worktree) : null;
    if (lockfile !== null) {
      out.warn(
        `Hint: ${lockfile} found. Add --setup "<install command>" if the command needs dependencies installed in the scratch tree.`,
      );
    }

    // The run record is exported and kept: nothing typed on the command line goes in unredacted.
    const redacted = {
      command: argv.map((a) => redactText(a)),
      setup: setup?.map((a) => redactText(a)) ?? null,
      worktree: redactText(worktree),
    };
    const run = svc.startRun(pid, redactText(`Bisect ${argvWords(argv)}`), {
      command: redacted.command,
      range: { good: good.seq, bad: bad.seq, worktree: redacted.worktree, since },
      setup: redacted.setup,
      timeoutSec,
    });
    const ac = new AbortController();
    const cancel = (): void => ac.abort();
    // Any of these ends the search; the handlers stay on so a second Ctrl-C cannot skip cleanup.
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals) process.on(s, cancel);
    deps.signal?.addEventListener('abort', cancel, { once: true });
    if (deps.signal?.aborted) ac.abort();
    const started = Date.now();
    let result: BisectSearchResult | null = null;
    let status: BisectReport['status'] = 'cancelled';
    let ws: StepWorkspace | null = null;
    try {
      const git = mindly.kernel.ports.git.steps as StepGitPort;
      ws = await git.scratch(worktree, good.commit);
      deps.onWorkspace?.(ws.path);
      const runner = new StepCommandRunner(git, ws, {
        command: { name: 'command', argv, timeoutSec },
        setup: setup ? { name: 'setup', argv: setup, timeoutSec } : null,
        signal: ac.signal,
      });
      result = await bisectSearch(steps, runner, {
        signal: ac.signal,
        onProgress: (p) => {
          const verb = p.phase === 'confirm' ? 're-checking' : 'checking';
          out.warn(
            `${verb} step ${p.step.seq} of ${bad.seq} (${p.run} of ~${p.estimatedRuns} runs)`,
          );
        },
      });
      status = result.status;
    } catch (err) {
      if (!(err instanceof BisectAborted) && !ac.signal.aborted) {
        svc.finishRun(run, 'error', { error: outputTail(describeError(err)) });
        throw err;
      }
    } finally {
      for (const s of signals) process.off(s, cancel);
      deps.signal?.removeEventListener('abort', cancel);
      if (ws) await ws.dispose();
    }
    const durationMs = Date.now() - started;

    const firstBad = result?.firstBad ? svc.describe(result.firstBad) : null;
    const lastGood = result?.lastGood ? svc.describe(result.lastGood) : null;
    const checks = (result?.checks ?? []).map(sanitizeCheck);
    const failing =
      status === 'found' && firstBad
        ? [...checks].reverse().find((c) => c.seq === firstBad.seq && c.outcome === 'bad')
        : status === 'good_skipped' || status === 'bad_skipped'
          ? checks[checks.length - 1]
          : null;
    const report: BisectReport = {
      status,
      command: redacted.command,
      worktree: redacted.worktree,
      range: { good: good.seq, bad: bad.seq, since },
      runs: checks.length,
      durationMs,
      firstBad,
      lastGood,
      flaky: result?.flaky ?? false,
      skipped: (result?.skipped ?? []).map((s) => s.seq),
      output: failing?.output ? failing.output : null,
      mistakeId: null,
    };
    if (status === 'found' && firstBad) {
      const mistake = svc.recordMistake({
        projectId: pid,
        projectRoot: project.root,
        step: firstBad,
        command: argvWords(redacted.command),
      });
      report.mistakeId = mistake?.id ?? null;
    }
    const runStatus: Exclude<Run['status'], 'queued' | 'running'> =
      status === 'found' ? 'passed' : status === 'cancelled' ? 'cancelled' : 'failed';
    const saved = svc.finishRun(
      run,
      runStatus,
      svc.resultRecord({
        status,
        search: result,
        checks,
        firstBad,
        lastGood,
        output: report.output,
        durationMs,
        mistakeId: report.mistakeId,
      }),
    );
    if (o.json) out.json({ ...report, run: { id: saved.id, status: saved.status } });
    else renderBisect(out.screen(), report);
    return status === 'found' ? 0 : 1;
  });
}

/** `mindly bisect list [--since 24h]`. */
export async function bisectList(
  out: Out,
  raw: { since?: string; worktree?: string; json?: boolean },
): Promise<number> {
  const o = parseOptions(RunOptions.pick({ since: true, worktree: true, json: true }), raw);
  const since = o.since ?? DEFAULT_SINCE;
  const sinceMs = parseDuration(since);
  return withProject(out.io, async (scope) => {
    const worktree = await worktreeFor(scope, out.io.cwd, o.worktree);
    const now = scope.mindly.kernel.clock.now();
    const svc = bisectOf(scope.mindly);
    const steps = scope.mindly.checkpoints
      .list(scope.project.project.id, worktree, {
        since: now - sinceMs,
        order: 'desc',
        limit: MAX_LIST,
      })
      .map((s) => svc.describe(s));
    if (o.json) out.json({ worktree, since, steps });
    else renderStepList(out.screen(), steps, since);
    return 0;
  });
}

/** `mindly bisect show <step> [--patch]`. */
export async function bisectShow(
  out: Out,
  stepArg: string,
  raw: { patch?: boolean; worktree?: string; json?: boolean },
): Promise<number> {
  const seq = stepNumber(stepArg);
  const o = parseOptions(
    RunOptions.pick({ worktree: true, json: true }).extend({ patch: z.boolean().optional() }),
    raw,
  );
  return withProject(out.io, async (scope) => {
    const worktree = await worktreeFor(scope, out.io.cwd, o.worktree);
    const step = stepOf(scope, worktree, seq);
    const info: StepInfo = bisectOf(scope.mindly).describe(step);
    const diff = await stepDiff(worktree, step.parentCommit, step.commit, {
      patch: o.patch === true,
    });
    if (o.json) {
      out.json({ step: info, diff: stripControl(diff) });
      return 0;
    }
    renderStepShow(out.screen(), info, o.patch === true);
    for (const line of stripControl(diff).trimEnd().split('\n'))
      out.line(line === '' ? '' : `  ${line}`);
    return 0;
  });
}

/** `mindly bisect revert <step> [-y]`: undoes one step in the user's checkout, asking first. */
export async function bisectRevert(
  out: Out,
  stepArg: string,
  raw: { yes?: boolean; worktree?: string; json?: boolean },
): Promise<number> {
  const seq = stepNumber(stepArg);
  const o = parseOptions(RunOptions.pick({ yes: true, worktree: true, json: true }), raw);
  return withProject(out.io, async (scope) => {
    const worktree = await worktreeFor(scope, out.io.cwd, o.worktree);
    const step = stepOf(scope, worktree, seq);
    const info = bisectOf(scope.mindly).describe(step);
    const extraDeny = [...scope.mindly.config.redaction.denyPaths, ...scope.project.config.ignore];
    const check = await revertStep(worktree, step.parentCommit, step.commit, {
      apply: false,
      extraDeny,
    });
    if (!check.applied) {
      throw new HintedError(
        'conflict',
        `cannot undo step ${seq}: ${check.reason ?? 'it no longer applies'}${check.conflicts.length ? ` (${check.conflicts.map((p) => stripControl(p)).join(', ')})` : ''}`,
        `See what that step changed with: mindly bisect show ${seq} --patch`,
      );
    }
    if (!o.json) {
      const diff = await stepDiff(worktree, step.parentCommit, step.commit, { patch: true });
      out.line(`Step ${seq} (${stepWhat(info)}) will be undone in ${worktree}:`);
      for (const line of stripControl(diff).trimEnd().split('\n'))
        out.line(line === '' ? '' : `  ${line}`);
      out.line();
    }
    const ok = await confirm(
      out.io,
      `Undo step ${seq} in your checkout? ${count(check.paths.length, 'file')} will change; nothing is committed.`,
      o.yes === true,
    );
    if (!ok) {
      out.line('Nothing changed.');
      return 1;
    }
    const applied = await revertStep(worktree, step.parentCommit, step.commit, {
      apply: true,
      extraDeny,
    });
    if (!applied.applied) {
      throw new HintedError(
        'conflict',
        `cannot undo step ${seq}: ${applied.reason ?? 'the files changed meanwhile'}`,
        `See what that step changed with: mindly bisect show ${seq} --patch`,
      );
    }
    if (o.json) {
      out.json({ step: info, paths: applied.paths, applied: true });
      return 0;
    }
    const sc = out.screen();
    sc.text(
      `${sc.mark('ok')} Undid step ${seq}: ${count(applied.paths.length, 'file')} changed in your checkout, nothing committed.`,
    );
    sc.rows(applied.paths.map((p) => ({ marker: 'item' as const, text: stripControl(p) })));
    sc.next([{ cmd: 'git diff', why: 'review the change before committing' }]);
    return 0;
  });
}
