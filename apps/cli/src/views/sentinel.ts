import type {
  SentinelCheckReport,
  SentinelCheckStatus,
  SentinelNotReady,
  SentinelPassResult,
  SentinelStatus,
  SentinelWatchStatus,
} from '@mindly/engine';
import {
  count,
  relativeTime,
  spanWords,
  type Row,
  type Screen,
  type Step,
} from '../present/index.js';
import { clean } from '../util.js';
import { stepWhat, stepWho } from './bisect.js';

/** Why the sentinel cannot run, and what to do about it. */
export function notReadyWords(reason: SentinelNotReady): { why: string; step: Step } {
  switch (reason) {
    case 'no_git':
      return {
        why: 'git is not available, so there are no checkpoints to check',
        step: { why: 'Install git, then let an agent make some edits here' },
      };
    case 'checkpoints_off':
      return {
        why: 'checkpoints are off, so there are no steps to check',
        step: { cmd: 'mindly config set checkpoints.enabled true', why: 'turn them on' },
      };
    case 'config_error':
      return {
        why: "this project's .mindly/config.json is invalid",
        step: { cmd: 'mindly trust --show', why: 'see the problem' },
      };
    case 'no_checks':
      return {
        why: 'this project lists no checks for it to run',
        step: {
          why: 'Add your test command to .mindly/config.json, e.g. {"checks": [{"name": "unit", "argv": ["pnpm", "test"]}]}, then run mindly trust',
        },
      };
    case 'unknown_checks':
      return {
        why: 'sentinel.checks in .mindly/config.json names no check of this project',
        step: { cmd: 'mindly trust --show', why: 'see the checks it has' },
      };
    case 'untrusted':
      return {
        why: "this project's checks are not trusted yet, so nothing runs",
        step: { cmd: 'mindly trust', why: 'review the commands and allow them' },
      };
    case 'scratch_inside_repo':
      return {
        why: "Mindly's home (MINDLY_HOME) is inside this repository, so the sentinel's scratch copies would be too",
        step: {
          why: 'Point MINDLY_HOME outside the repository (for development, e.g. a folder in /tmp)',
        },
      };
  }
}

/**
 * ` --worktree <path>` when a step is in another checkout than the current one, `''` when it is
 * not, and null when the path is not safe to paste into a shell.
 */
export function worktreeFlag(worktree: string, current: string): string | null {
  if (worktree === current) return '';
  return /^[\w./@+-]+$/.test(worktree) ? ` --worktree ${worktree}` : null;
}

/** `step 87 · codex #dd7a9a10` for a check that broke, or what is known about it. */
function checkLine(sc: Screen, c: SentinelCheckStatus): Row {
  const name = clean(c.name, 64);
  if (c.state === 'passing') {
    return {
      marker: 'ok',
      text: `${name} ${sc.sym.dot} passing${c.goodSeq !== null ? ` at step ${c.goodSeq}` : ''}`,
    };
  }
  if (c.brokeAt !== null) {
    const who = c.culprit ? clean(c.culprit.label, 80) : 'not pinned to one agent';
    return {
      marker: 'fail',
      text: `${name} ${sc.sym.dot} broke at step ${c.brokeAt} ${sc.sym.dot} ${who}`,
      details: [
        `passed at step ${c.goodSeq ?? '?'}, failing since ${relativeTime(c.since, sc.now)}`,
        ...(c.conflictId ? [`conflict ${sc.ref(c.conflictId)}`] : []),
        ...(c.note ? [clean(c.note, 200)] : []),
      ],
    };
  }
  return {
    marker: 'fail',
    text: `${name} ${sc.sym.dot} failing since step ${c.failingSeq ?? '?'}`,
    details: c.note ? [clean(c.note, 200)] : [],
  };
}

function watchHeader(sc: Screen, w: SentinelWatchStatus, root: string): string {
  const where = w.worktree === root ? 'this checkout' : clean(w.worktree, 200);
  // Nothing could run at the newest step (setup failed, checks timed out): when it is retried.
  const retry =
    w.retryAt !== null
      ? ` ${sc.sym.dot} nothing could run at step ${w.latestSeq ?? '?'}; ${w.retryAt > sc.now ? `tried again in ${spanWords(w.retryAt - sc.now)} or at a new step` : 'tried again soon'}`
      : '';
  if (w.checkedSeq === null) {
    return `${where} ${sc.sym.dot} not checked yet${w.latestSeq !== null ? ` (${count(w.latestSeq, 'step')})` : ''}${retry}`;
  }
  const behind = w.pending > 0 ? ` ${sc.sym.dot} ${count(w.pending, 'new step')} since` : '';
  return `${where} ${sc.sym.dot} checked step ${w.checkedSeq} ${relativeTime(w.checkedAt, sc.now)}${behind}${retry}`;
}

/** `mindly sentinel`: whether it runs, what it watches and what broke. */
export function renderSentinelStatus(
  sc: Screen,
  s: SentinelStatus,
  ctx: { root: string; daemon: boolean },
): void {
  const names = s.readiness.checks.map((c) => clean(c.name, 64));
  if (!s.enabled) {
    sc.summary(
      'The sentinel is off. When on, it runs your checks in the background as agents edit and finds the edit that broke one.',
    );
  } else if (!s.readiness.ready) {
    const w = notReadyWords(s.readiness.reason ?? 'no_checks');
    sc.summary(`${sc.mark('warn')} The sentinel is on, but ${w.why}.`);
  } else {
    sc.summary(
      `${sc.mark('ok')} The sentinel is on ${sc.sym.dot} runs ${names.join(', ')} after agent edits${ctx.daemon ? '' : ' (needs the daemon, which is not running)'}`,
    );
  }
  if (s.readiness.unknown.length) {
    sc.note(
      `sentinel.checks names checks this project does not have: ${s.readiness.unknown.map((n) => clean(n, 64)).join(', ')}`,
      2,
    );
  }

  for (const w of s.watches) {
    sc.section(watchHeader(sc, w, ctx.root));
    if (w.checks.length === 0) {
      sc.note('nothing known yet', 2);
      continue;
    }
    sc.rows(w.checks.map((c) => checkLine(sc, c)));
  }

  const steps: Step[] = [];
  const broken = s.watches.flatMap((w) =>
    w.checks
      .filter((c) => c.state === 'failing' && c.brokeAt !== null)
      .map((c) => ({ c, flag: worktreeFlag(w.worktree, ctx.root) })),
  );
  const first = broken[0];
  if (first?.c.brokeAt && first.flag !== null) {
    const at = `${first.c.brokeAt}${first.flag}`;
    steps.push({ cmd: `mindly bisect show ${at} --patch`, why: 'see the edit that broke it' });
    if (first.c.culprit) {
      steps.push({ cmd: `mindly bisect revert ${at}`, why: 'undo only that edit' });
    }
  }
  if (!s.enabled) {
    steps.push({ cmd: 'mindly config set sentinel.enabled true', why: 'turn it on' });
  }
  if (!s.readiness.ready) steps.push(notReadyWords(s.readiness.reason ?? 'no_checks').step);
  else if (s.enabled && !ctx.daemon) {
    steps.push({ cmd: 'mindly daemon start', why: 'let it run in the background' });
  }
  if (s.readiness.ready)
    steps.push({ cmd: 'mindly sentinel run', why: 'check the newest step now' });
  sc.next(steps);
}

/** One check's result in a pass. */
function reportRow(sc: Screen, c: SentinelCheckReport): Row {
  const name = clean(c.name, 64);
  const b = c.bisect;
  switch (c.transition) {
    case 'baseline_pass':
    case 'still_passing':
      return { marker: 'ok', text: `${name} ${sc.sym.dot} passes` };
    case 'fixed':
      return { marker: 'ok', text: `${name} ${sc.sym.dot} passes again; its conflict is closed` };
    case 'flaky':
      return {
        marker: 'warn',
        text: `${name} ${sc.sym.dot} failed once, not when run again ${sc.sym.dot} nobody blamed`,
      };
    case 'baseline_fail':
      return {
        marker: 'fail',
        text: `${name} ${sc.sym.dot} fails, and already did when the sentinel started watching`,
      };
    case 'still_failing':
      return { marker: 'fail', text: `${name} ${sc.sym.dot} still fails` };
    case 'skipped':
      return {
        marker: 'warn',
        text:
          c.outcome === 'skip'
            ? `${name} ${sc.sym.dot} did not run: ${clean(c.note, 120)}`
            : `${name} ${sc.sym.dot} ${clean(c.note, 160)}`,
      };
    case 'broke': {
      const details: string[] = [];
      if (b?.firstBad) {
        details.push(`${stepWho(b.firstBad)} ${sc.sym.dot} ${stepWhat(b.firstBad)}`);
        if (b.firstBad.prompt) details.push(`prompt: ${clean(b.firstBad.prompt, 200)}`);
        if (b.lastGood) details.push(`last good: step ${b.lastGood.seq}`);
      }
      if (c.note) details.push(clean(c.note, 200));
      if (c.told.length) details.push(`told ${count(c.told.length, 'agent')}`);
      if (b && b.runs > 0) details.push(`${count(b.runs, 'run')} to find it`);
      return {
        marker: 'fail',
        text:
          b?.status === 'found' && b.firstBad
            ? `${name} ${sc.sym.dot} broke at step ${b.firstBad.seq}`
            : `${name} ${sc.sym.dot} broke`,
        details,
      };
    }
  }
}

/** `mindly sentinel run`: what one pass found. */
export function renderSentinelPass(sc: Screen, r: SentinelPassResult, current: string): void {
  switch (r.status) {
    case 'no_steps':
      sc.summary('No checkpoints in this checkout yet: let an agent make some edits here first.');
      return;
    case 'busy':
      sc.summary(
        'The sentinel is already checking this checkout (in the daemon). Try again shortly.',
      );
      return;
    case 'cancelled':
      if (r.reason === 'lock_lost') {
        sc.summary(
          `${sc.mark('warn')} Stopped: another process took over this checkout while this one was paused. Nothing was saved; run it again.`,
        );
        return;
      }
      sc.summary(
        'Cancelled. The scratch tree stays for the next run; your checkout was not touched.',
      );
      return;
    case 'error':
      sc.summary(`${sc.mark('fail')} The sentinel could not finish: ${clean(r.reason, 300)}`);
      return;
    case 'not_ready':
    case 'up_to_date':
    case 'not_due':
      sc.summary(`Nothing to do at step ${r.step ?? '?'}.`);
      return;
    case 'checked':
      break;
  }
  const failing = r.checks.filter((c) => c.outcome === 'fail').length;
  // A check that did not run (setup failed, timeout, exit 125) says nothing: it is not passing.
  const skipped = r.checks.filter((c) => c.outcome === 'skip').length;
  const mark = failing ? sc.mark('fail') : skipped ? sc.mark('warn') : sc.mark('ok');
  const parts = [
    ...(failing ? [`${failing} failing`] : []),
    ...(skipped ? [skipped === r.checks.length ? 'none could run' : `${skipped} did not run`] : []),
  ];
  sc.summary(
    `${mark} Step ${r.step} ${sc.sym.dot} ${count(r.checks.length, 'check')}${parts.length ? ` ${sc.sym.dot} ${parts.join(` ${sc.sym.dot} `)}` : ', all passing'}`,
  );
  if (r.setupFailed) sc.note('The setup command failed, so the checks could not run.', 2);
  sc.rows(r.checks.map((c) => reportRow(sc, c)));
  const broke = r.checks.find((c) => c.transition === 'broke' && c.bisect?.firstBad);
  const output = r.checks.find((c) => c.outcome === 'fail' && c.output)?.output;
  if (output) {
    sc.text('failing output (tail):', 2);
    for (const line of output.split('\n').slice(-12)) sc.text(line, 4);
  }
  const bad = broke?.bisect?.firstBad;
  const flag = worktreeFlag(r.worktree, current);
  if (bad && flag !== null) {
    const steps: Step[] = [
      { cmd: `mindly bisect show ${bad.seq}${flag} --patch`, why: 'see exactly what changed' },
    ];
    if (bad.kind === 'agent') {
      steps.push({ cmd: `mindly bisect revert ${bad.seq}${flag}`, why: 'undo only that edit' });
    }
    sc.next(steps);
  }
}
