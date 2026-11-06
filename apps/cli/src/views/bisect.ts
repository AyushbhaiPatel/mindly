import type { BisectStatus, StepInfo } from '@mindly/engine';
import {
  absoluteTime,
  count,
  spanWords,
  type Row,
  type Screen,
  type Step,
} from '../present/index.js';
import { clean } from '../util.js';

/** Who made a step: `codex #dd7a9a10`, or words for steps nobody made. */
export function stepWho(step: StepInfo): string {
  if (step.kind === 'outside') return 'outside any agent';
  if (step.kind === 'baseline') return 'before any agent edit';
  return step.sessionLabel ? clean(step.sessionLabel, 80) : 'an agent';
}

/** What a step changed: `Edit src/auth.ts, src/b.ts, src/c.ts (+2)`. */
export function stepWhat(step: StepInfo, maxPaths = 3): string {
  const paths = step.paths.slice(0, maxPaths).map((p) => clean(p, 120));
  const more = step.paths.length - paths.length;
  const files = paths.length ? `${paths.join(', ')}${more > 0 ? ` (+${more})` : ''}` : 'no files';
  return step.tool ? `${clean(step.tool, 40)} ${files}` : files;
}

/** `14:32` for a step made today, else the date and time. */
export function stepTime(at: number, now: number): string {
  const full = absoluteTime(at);
  return absoluteTime(now).slice(0, 10) === full.slice(0, 10) ? full.slice(11) : full;
}

/** `41s` under a minute, then `spanWords`. */
export function secondsWords(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : spanWords(ms);
}

/** The lines that explain one step (who, prompt, rules in effect), indented by `indent`. */
export function stepLines(sc: Screen, step: StepInfo, indent: number): void {
  sc.text(
    `${stepWho(step)} ${sc.sym.dot} ${stepWhat(step)} ${sc.sym.dot} ${stepTime(step.at, sc.now)}`,
    indent,
  );
  if (step.kind === 'outside') {
    sc.text('not matched to an agent edit', indent);
  }
  if (step.gap) {
    sc.text('this step may hold more than one edit: a checkpoint before it was skipped', indent);
  }
  if (step.prompt) sc.text(`prompt: ${clean(step.prompt, 200)}`, indent);
  else if (step.promptState === 'gone') sc.text('prompt no longer kept', indent);
  if (step.rules.length) {
    const where = step.paths
      .slice(0, 2)
      .map((p) => clean(p, 80))
      .join(', ');
    const rules = step.rules
      .map((r) => `${clean(r.title, 100)} (${r.told ? 'it was told' : 'in effect'})`)
      .join('; ');
    sc.text(`rules in effect for ${where} then: ${rules}`, indent);
  }
}

/** What `mindly bisect -- <command>` found (the human shape of the `--json` report). */
export interface BisectReport {
  status: BisectStatus | 'cancelled';
  command: string[];
  worktree: string;
  range: { good: number; bad: number; since: string | null };
  runs: number;
  durationMs: number;
  firstBad: StepInfo | null;
  lastGood: StepInfo | null;
  flaky: boolean;
  skipped: number[];
  /** Tail of the command's output at the first bad step, sanitized. */
  output: string | null;
  mistakeId: string | null;
}

const RETRY: Step = { cmd: 'mindly bisect -- <command>', why: 'run it again' };

/** Renders the result of a bisect. */
export function renderBisect(sc: Screen, r: BisectReport): void {
  const meta = `${count(r.runs, 'run')} ${sc.sym.dot} ${secondsWords(r.durationMs)}`;
  const bad = r.firstBad;
  const good = r.lastGood;
  switch (r.status) {
    case 'found': {
      if (!bad) return;
      sc.summary(`Broke at step ${bad.seq} of ${r.range.bad} ${sc.sym.dot} ${meta}`);
      stepLines(sc, bad, 2);
      if (good)
        sc.text(
          `last good: step ${good.seq} (${stepWho(good)} ${sc.sym.dot} ${stepWhat(good, 1)})`,
          2,
        );
      if (r.output) {
        sc.text('failing output (tail):', 2);
        for (const line of r.output.split('\n').slice(-12)) sc.text(line, 4);
      }
      if (bad.kind === 'agent' && bad.gap) {
        sc.note('No mistake memory was recorded: the step may hold edits other than this one.', 2);
      }
      const steps: Step[] = [
        { cmd: `mindly bisect show ${bad.seq} --patch`, why: 'see exactly what changed' },
      ];
      if (bad.kind === 'agent') {
        steps.push({
          cmd: `mindly bisect revert ${bad.seq}`,
          why: 'undo only that edit in your checkout',
        });
      }
      sc.next(steps);
      return;
    }
    case 'unreliable':
      sc.summary(
        `${sc.mark('warn')} Unreliable ${sc.sym.dot} ${meta}: steps ${good?.seq ?? '?'} and ${bad?.seq ?? '?'} gave different results when run again, so the command looks flaky.`,
      );
      sc.note('Nobody is blamed. Make the command deterministic, then run the bisect again.', 2);
      sc.next([RETRY]);
      return;
    case 'inconclusive':
      sc.summary(
        `${sc.mark('warn')} Could not narrow it down ${sc.sym.dot} ${meta}: the command could not run at ${count(r.skipped.length, 'step')} between the last good (step ${good?.seq ?? '?'}) and the first bad (step ${bad?.seq ?? '?'}).`,
      );
      sc.note('A step is skipped when the command exits 125 or times out.', 2);
      if (bad) {
        sc.section('First bad step');
        stepLines(sc, bad, 2);
      }
      sc.next([
        {
          cmd: `mindly bisect show ${r.skipped[0] ?? '<step>'} --patch`,
          why: 'see a skipped step',
        },
      ]);
      return;
    case 'good_fails':
      sc.summary(
        `${sc.mark('fail')} The command already fails at the oldest step (step ${r.range.good}), so the break is older than this range.`,
      );
      sc.next([
        { cmd: 'mindly bisect --since 7d -- <command>', why: 'search a longer window' },
        { cmd: 'mindly bisect list', why: 'pick ends with --good and --bad' },
      ]);
      return;
    case 'bad_passes':
      sc.summary(
        `${sc.mark('ok')} The command passes at the newest step (step ${r.range.bad}), so nothing in this range broke it.`,
      );
      sc.note(
        'If it fails in your checkout, the break happened after the last checkpoint or outside the agents.',
        2,
      );
      return;
    case 'good_skipped':
    case 'bad_skipped': {
      const seq = r.status === 'good_skipped' ? r.range.good : r.range.bad;
      sc.summary(
        `${sc.mark('fail')} The command could not run at step ${seq} (it exited 125 or timed out), so there is nothing to compare against.`,
      );
      if (r.output) {
        sc.text('output (tail):', 2);
        for (const line of r.output.split('\n').slice(-12)) sc.text(line, 4);
      }
      sc.next([
        {
          cmd: 'mindly bisect --setup "<install command>" -- <command>',
          why: 'install dependencies first',
        },
      ]);
      return;
    }
    case 'cancelled':
      sc.summary(`Bisect cancelled after ${meta}. The scratch worktree was removed.`);
      return;
  }
}

/** `mindly bisect list`: steps newest first. */
export function renderStepList(sc: Screen, steps: readonly StepInfo[], since: string): void {
  if (steps.length === 0) {
    sc.summary(`No checkpoints in the last ${since}.`);
    sc.note('Mindly saves a checkpoint after every agent edit in this checkout.', 2);
    sc.next([{ cmd: 'mindly bisect list --since 7d', why: 'look further back' }]);
    return;
  }
  sc.summary(`${count(steps.length, 'step')} in the last ${since} ${sc.sym.dot} newest first`);
  sc.rows(
    steps.map((s): Row => {
      const prompt = s.prompt
        ? ` ${sc.sym.dot} prompt: ${clean(s.prompt, 80)}`
        : s.promptState === 'gone'
          ? ` ${sc.sym.dot} prompt no longer kept`
          : '';
      return {
        marker: s.kind === 'agent' ? 'agent' : 'item',
        text: `step ${s.seq} ${sc.sym.dot} ${stepTime(s.at, sc.now)} ${sc.sym.dot} ${stepWho(s)} ${sc.sym.dot} ${stepWhat(s)}${s.gap ? ' (gap)' : ''}${prompt}`,
      };
    }),
  );
  sc.next([
    { cmd: 'mindly bisect show <step>', why: 'see one step' },
    { cmd: 'mindly bisect -- <command>', why: 'find the step that broke a command' },
  ]);
}

/** `mindly bisect show <step>`: the step's details (the diff follows, unwrapped). */
export function renderStepShow(sc: Screen, step: StepInfo, patch: boolean): void {
  sc.summary(
    `Step ${step.seq} ${sc.sym.dot} ${stepWho(step)} ${sc.sym.dot} ${stepTime(step.at, sc.now)}`,
  );
  stepLines(sc, step, 2);
  sc.note(`commit ${step.commit}${step.parentCommit ? ` (parent ${step.parentCommit})` : ''}`, 2);
  sc.section(patch ? 'Patch' : 'Changes');
}
