import type { Run, SplitPlan } from '@mindly/core';
import type {
  TrackSuggestion,
  SplitAbortResult,
  SplitMergeCheckResult,
  SplitMergeResult,
  SplitPartState,
  SplitStatusReport,
  SplitUnmergedWork,
} from '@mindly/engine';
import {
  agentName,
  count,
  relativeTime,
  sessionName,
  type Marker,
  type Row,
  type Screen,
  type Step,
} from '../present/index.js';
import { clean } from '../util.js';

/** Plain words for a part's state. */
export function partStateWord(state: SplitPartState): string {
  switch (state) {
    case 'waiting':
      return 'waiting for its agent';
    case 'working':
      return 'working';
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
  }
}

function partMarker(state: SplitPartState): Marker {
  switch (state) {
    case 'done':
      return 'ok';
    case 'blocked':
      return 'fail';
    case 'working':
      return 'agent';
    case 'waiting':
      return 'idle';
  }
}

/**
 * `suggested: codex (broke 1 of 212 edits in src/api vs 7 of 188)`: the agent the track record
 * favours for a part. The other agent is named unless it is the part's own.
 */
export function suggestionLine(s: TrackSuggestion, partAgent: string): string {
  const vs = s.versus.agent === partAgent ? '' : `${clean(s.versus.agent, 40)} `;
  return `suggested: ${clean(s.agent, 40)} (broke ${s.count} of ${s.of} edits in ${clean(s.area, 120)} vs ${vs}${s.versus.count} of ${s.versus.of})`;
}

/**
 * The plan as a table: part, agent, owns, depends on; then the contract. `suggestions` (by part
 * key) come from the track record and are shown only; the plan is not changed.
 */
export function renderPlan(
  sc: Screen,
  plan: SplitPlan,
  plannedBy: string,
  suggestions: ReadonlyMap<string, TrackSuggestion> = new Map(),
): void {
  const by =
    plannedBy === 'plan-file'
      ? 'from your plan file'
      : `planned by ${agentName(plannedBy)}, read-only`;
  sc.summary(`Plan ${sc.sym.dot} ${clean(plan.goal, 120)}  (${by})`);
  sc.blank();
  sc.rows(
    plan.parts.map((p, i): Row => {
      const deps = p.dependsOn.length ? `depends on ${p.dependsOn.join(', ')}` : 'no dependencies';
      return {
        marker: 'item',
        text: `${i + 1} ${clean(p.title, 60)} ${sc.sym.dot} ${agentName(p.agent)} ${sc.sym.dot} owns ${p.owns.map((g) => clean(g, 100)).join(', ')} ${sc.sym.dot} ${deps}`,
        details: [
          clean(p.brief, 240),
          ...(suggestions.has(p.key)
            ? [suggestionLine(suggestions.get(p.key) as TrackSuggestion, p.agent)]
            : []),
        ],
      };
    }),
  );
  if (plan.contract.length) {
    sc.section('Shared contract');
    sc.rows(
      plan.contract.map((c): Row => ({
        marker: 'item',
        text: `${clean(c.name, 80)} ${sc.sym.dot} ${clean(c.definition, 160)} (owned by part ${c.owner})`,
      })),
    );
  }
}

/** What `mindly split status` shows. */
export function renderSplitStatus(sc: Screen, r: SplitStatusReport): void {
  const { split, parts } = r;
  const done = parts.filter((p) => p.state === 'done').length;
  const blocked = parts.filter((p) => p.state === 'blocked').length;
  const check = r.mergeCheck;
  const checkWord = mergeCheckWord(check);
  const state =
    split.status === 'merged'
      ? `merged into ${split.integrationBranch ?? 'the integration branch'}`
      : split.status === 'aborted'
        ? 'aborted'
        : `${done}/${parts.length} parts done${blocked ? ` ${sc.sym.dot} ${count(blocked, 'part')} blocked` : ''}`;
  sc.summary(
    `Split ${sc.sym.dot} ${clean(split.goal, 100)} ${sc.sym.dot} ${state} ${sc.sym.dot} merge check: ${checkWord}  ${sc.ref(split.id)}`,
  );
  sc.section('Parts');
  sc.rows(
    parts.map((p): Row => {
      const who = p.session ? sessionName(p.session) : agentName(p.part.agentKind);
      const facts = [partStateWord(p.state)];
      if (p.filesChanged.length) facts.push(`${count(p.filesChanged.length, 'file')} changed`);
      if (p.uncommitted.length) facts.push(`${p.uncommitted.length} not committed`);
      if (p.unmergedCommits.length)
        facts.push(`${count(p.unmergedCommits.length, 'commit')} not merged`);
      if (p.lastActivityAt) facts.push(`active ${relativeTime(p.lastActivityAt, sc.now)}`);
      if (p.conflicts.length) facts.push(`${count(p.conflicts.length, 'conflict')}`);
      const details = [
        `${clean(p.part.worktree, 200)} ${sc.sym.dot} branch ${clean(p.part.branch, 100)}`,
      ];
      if (p.task.blockers.length)
        details.push(`Blocked: ${p.task.blockers.map((b) => clean(b, 100)).join('; ')}`);
      return {
        marker: partMarker(p.state),
        text: `${p.part.position + 1} ${clean(p.part.title, 60)} ${sc.sym.dot} ${who} ${sc.sym.dot} ${facts.join(` ${sc.sym.dot} `)}`,
        id: p.task.id,
        details,
      };
    }),
  );
  if (r.contract.length) {
    sc.section('Shared contract');
    sc.rows(
      r.contract.map((c): Row => ({
        marker: 'item',
        text: `${clean(c.name, 80)} ${sc.sym.dot} ${clean(c.definition, 160)} (owned by part ${c.owner})`,
        ...(c.memoryId ? { id: c.memoryId } : {}),
      })),
    );
  }
  if (check) renderMergeCheck(sc, check);
  if (r.abortPending) {
    sc.blank();
    sc.text(
      `${sc.mark('warn')} An abort of this split did not remove everything. Run mindly split abort again to finish it.`,
    );
  }
  sc.next(nextSteps(r));
}

function mergeCheckWord(run: Run | null): string {
  if (!run) return 'not run yet';
  const r = run.result as SplitMergeCheckResult | null;
  switch (run.status) {
    case 'passed':
      return 'clean';
    case 'failed':
      return r && !r.clean ? 'conflicts' : 'checks failing';
    case 'error':
      return 'could not run';
    default:
      return 'running';
  }
}

/** The latest merge check of the split. */
export function renderMergeCheck(sc: Screen, run: Run): void {
  const r = run.result as SplitMergeCheckResult | null;
  sc.section(
    `Merge check ${sc.sym.dot} ${mergeCheckWord(run)} ${sc.sym.dot} ${relativeTime(run.finishedAt ?? run.createdAt, sc.now)}`,
  );
  if (!r) return;
  if (r.error) sc.text(`${sc.mark('fail')} ${clean(r.error, 200)}`, 2);
  for (const c of r.conflicts) {
    sc.text(
      `${sc.mark('fail')} Part "${clean(c.part, 40)}" conflicts in ${c.paths.map((p) => clean(p, 120)).join(', ')}`,
      2,
    );
  }
  for (const c of r.checks) {
    sc.text(
      `${sc.mark(c.ok ? 'ok' : 'fail')} Check "${clean(c.name, 40)}": ${c.ok ? 'passing' : c.status}`,
      2,
    );
  }
  for (const key of r.missing ?? []) {
    sc.text(
      `${sc.mark('warn')} Part "${clean(key, 40)}" was not checked: its worktree folder is gone.`,
      2,
    );
  }
  if (r.checksSkipped === 'untrusted')
    sc.note('Checks skipped: the project config is not trusted (mindly trust).', 2);
  else if (r.checksSkipped === 'none_configured')
    sc.note('No checks configured in .mindly/config.json.', 2);
}

/** `Part "API": src/api/a.ts, src/api/b.ts and 3 more; 2 commits only on its branch: …`. */
export function unmergedLine(w: SplitUnmergedWork): string {
  const list = (items: readonly string[]): string => {
    const shown = items.slice(0, 3).map((p) => clean(p, 120));
    const more = items.length - shown.length;
    return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  };
  const what: string[] = [];
  if (w.paths.length > 0) what.push(list(w.paths));
  if (w.held?.length) {
    what.push(`git data abort never deletes, so its worktree stays: ${list(w.held)}`);
  }
  const commits = w.commits ?? [];
  if (commits.length > 0) {
    what.push(`${count(commits.length, 'commit')} only on its branch: ${list(commits)}`);
  }
  if (w.opaque?.length) {
    what.push(`folders whose content cannot be checked: ${list(w.opaque)}`);
  }
  if (w.more) what.push('and more than can be listed');
  return `Part "${clean(w.title, 60)}": ${what.join('; ')}`;
}

const COMMIT_WHY = 'commit the work there on the part branch: the merge only takes committed work';

function nextSteps(r: SplitStatusReport): Step[] {
  const { split, parts } = r;
  const uncommitted = parts.filter((p) => p.uncommitted.length > 0);
  if (r.abortPending) {
    return [{ cmd: 'mindly split abort', why: 'finish the abort: it lists what is left' }];
  }
  if (split.status === 'merged') {
    const withCommits = parts.some((p) => p.unmergedCommits.length > 0);
    return [
      {
        cmd: `git log --oneline ${split.integrationBranch ?? ''}`.trim(),
        why: 'review the merged branch and open a PR from it',
      },
      // Removing the worktrees would delete work the merged branch does not have.
      ...uncommitted.slice(0, 3).map((p) => ({
        cmd: `cd ${p.part.worktree}`,
        why: 'this part has work that is not committed; commit or copy it before removing the worktrees',
      })),
      ...(uncommitted.length > 0
        ? []
        : withCommits
          ? [
              {
                cmd: 'mindly split abort --keep-branches',
                why: 'remove the worktrees and keep the part branches: they have commits no other branch has (expected after a squash or rebase merge)',
              },
            ]
          : [
              {
                cmd: 'mindly split abort',
                why: 'remove the part worktrees (the merged branch stays)',
              },
            ]),
    ];
  }
  if (split.status === 'aborted') return [];
  const steps: Step[] = [];
  const waiting = parts.filter((p) => p.state === 'waiting');
  for (const p of waiting.slice(0, 3)) {
    steps.push({
      cmd: `cd ${p.part.worktree}`,
      why: `start ${agentName(p.part.agentKind)} there for part "${clean(p.part.title, 40)}"`,
    });
  }
  const check = r.mergeCheck;
  const allDone = parts.length > 0 && parts.every((p) => p.state === 'done');
  for (const p of allDone ? uncommitted.slice(0, 3) : []) {
    steps.push({ cmd: `cd ${p.part.worktree}`, why: COMMIT_WHY });
  }
  if (allDone && uncommitted.length > 0) {
    // Nothing to merge yet: the finished work is not on the part branches.
  } else if (allDone && check?.status === 'passed') {
    steps.push({ cmd: 'mindly split merge', why: 'merge every part into one integration branch' });
  } else if (!check || check.status !== 'passed') {
    steps.push({ cmd: 'mindly split check', why: 'merge every part in memory and run the checks' });
  }
  steps.push({ cmd: 'mindly split abort', why: 'remove the worktrees and branches' });
  return steps;
}

export function renderMerged(sc: Screen, m: SplitMergeResult): void {
  sc.summary(
    `${sc.mark('ok')} Merged ${count(m.merged.length, 'part')} into ${m.branch} at ${m.commit.slice(0, 12)}.`,
  );
  if (m.checks) {
    sc.blank();
    for (const c of m.checks) {
      sc.text(
        `${sc.mark(c.ok ? 'ok' : 'fail')} Check "${clean(c.name, 40)}": ${c.ok ? 'passing' : c.status}`,
        2,
      );
    }
  } else if (m.checksSkipped === 'untrusted') {
    sc.note('Checks skipped: the project config is not trusted (mindly trust).', 2);
  } else if (m.checksSkipped === 'error') {
    sc.text(`${sc.mark('warn')} The checks could not run on the merged branch (see the log).`, 2);
  }
  if (m.leftBehind.length > 0) {
    sc.blank();
    sc.text(
      `${sc.mark('warn')} Not merged: work that is not committed on ${m.leftBehind.length === 1 ? "its part's branch" : "the parts' branches"} is still only in the worktrees.`,
    );
    for (const w of m.leftBehind) sc.text(unmergedLine(w), 2);
  }
  sc.next([
    { cmd: `git log --oneline ${m.branch}`, why: 'review the merged work' },
    { cmd: `git push -u origin ${m.branch}`, why: 'push it and open a pull request' },
    m.leftBehind.length > 0
      ? {
          cmd: 'mindly split status',
          why: 'see the worktrees that still hold unmerged work; removing them would delete it',
        }
      : { cmd: 'mindly split abort', why: 'remove the part worktrees (the merged branch stays)' },
  ]);
}

export function renderAborted(sc: Screen, a: SplitAbortResult): void {
  sc.summary(
    `${sc.mark(a.finished ? 'ok' : 'warn')} Split "${clean(a.split.goal, 80)}" ${a.finished ? 'closed' : 'not closed yet'}: removed ${count(a.removedWorktrees.length, 'worktree')}${
      a.keptBranches.length
        ? `, kept ${count(a.keptBranches.length, 'branch', 'branches')}`
        : `, deleted ${count(a.deletedBranches.length, 'branch', 'branches')}`
    }.`,
  );
  if (a.keptBranches.length) sc.note(`Branches kept: ${a.keptBranches.join(', ')}`, 2);
  for (const wt of a.keptWorktrees) {
    sc.text(
      `${sc.mark('warn')} Kept ${clean(wt, 200)}: ${clean(a.keptBecause[wt] ?? 'it has work the abort may not delete', 300)}`,
      2,
    );
  }
  if (!a.finished) {
    sc.text(
      `${sc.mark('warn')} Not everything was removed. Deal with what was kept and run mindly split abort again to finish, or remove it with what it holds: mindly split abort --yes --discard`,
      2,
    );
  }
  if (a.discarded.length > 0) {
    const commits = a.discarded.some((w) => (w.commits ?? []).length > 0);
    sc.text(
      `${sc.mark('warn')} ${commits ? 'Work no other branch has was removed:' : `Uncommitted work was removed with ${a.discarded.length === 1 ? 'a worktree' : 'the worktrees'}:`}`,
      2,
    );
    for (const w of a.discarded) sc.text(unmergedLine(w), 4);
  }
  if (a.split.integrationBranch)
    sc.note(`The merged branch ${a.split.integrationBranch} stays.`, 2);
}
