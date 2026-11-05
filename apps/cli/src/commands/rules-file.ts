import { existsSync, realpathSync } from 'node:fs';
import { homePaths, mindlyHome } from '@mindly/core';
import type { Mindly, RulesFileChange, RulesFileCheckout, RulesFileSkip } from '@mindly/engine';
import { findRepoRoot } from '@mindly/git';
import { openMindly } from '@mindly/runtime';
import { withProject } from '../context.js';
import { diffSummary } from '../diff.js';
import { confirm, type CliIo } from '../io.js';
import { count, listWords } from '../present/index.js';
import { type Out } from '../util.js';

/*
 * `mindly rules sync`: keeps the approved rules in a marked section of AGENTS.md, CLAUDE.md and
 * GEMINI.md. The engine rewrites the section whenever a rule changes once sync is on; these
 * commands turn it on and off and show what changes.
 */

const SKIP_WORDS: Record<RulesFileSkip, string> = {
  outside_project: 'skipped: it links to a file outside the project',
  not_markdown: 'skipped: not a Markdown file',
  denied: 'skipped: Mindly never writes this path',
  broken_link: 'skipped: it is a broken link',
  unreadable: 'skipped: not readable as UTF-8 text',
  damaged:
    'skipped, needs attention: its Mindly markers are incomplete, repeated or inside a code block, or the file ends inside an unclosed code block (```); fix it, then sync again',
  changed: 'skipped: it changed while Mindly was writing; run the command again',
  unwritable: 'skipped: Mindly could not write it',
};

function fileName(c: RulesFileChange): string {
  const names = [c.path, ...c.aliases].join(', ');
  return c.target === c.path ? names : `${names} -> ${c.target}`;
}

/** Prints each file with a diff of what changes. Returns the number of files that change. */
export function printRulesFileChanges(out: Out, changes: readonly RulesFileChange[]): number {
  const s = out.style;
  let changed = 0;
  for (const c of changes) {
    if (c.skipped) {
      out.line(`  ${s.cyan(fileName(c))} ${s.dim(SKIP_WORDS[c.skipped])}`);
      continue;
    }
    if (c.next === c.previous) {
      out.line(`  ${s.cyan(fileName(c))} ${s.dim('(up to date)')}`);
      continue;
    }
    changed++;
    const d = diffSummary(c.previous, c.next ?? '');
    const what = c.previous === null ? 'new file' : c.next === null ? 'deleted' : 'modified';
    out.line(`  ${s.cyan(fileName(c))} ${s.dim(`(${what}, +${d.added} -${d.removed} lines)`)}`);
    for (const l of d.lines) {
      out.line(`    ${l.startsWith('+') ? s.green(l) : l.startsWith('-') ? s.red(l) : s.dim(l)}`);
    }
    if (c.edited) {
      out.line(
        `    ${s.yellow('The Mindly section was edited by hand; those edits are replaced.')}`,
      );
    }
  }
  return changed;
}

function warnEdited(out: Out, changes: readonly RulesFileChange[]): void {
  const edited = changes.filter((c) => c.edited && c.next !== c.previous).map(fileName);
  if (edited.length === 0) return;
  const sc = out.screen();
  sc.text(`${sc.mark('warn')} Replaced hand edits in the Mindly section of ${listWords(edited)}.`);
  sc.note('Mindly owns that section. Change rules with mindly rules or in Mission Control.', 2);
}

/** `mindly rules sync [--dry-run] [--off] [--yes]`. */
export async function rulesSync(
  out: Out,
  o: { dryRun?: boolean; off?: boolean; yes?: boolean },
): Promise<number> {
  const checkout = await repoRoot(out.io.cwd);
  return withProject(out.io, async ({ mindly, project }) => {
    const pid = project.project.id;
    const root = checkout ?? project.root;
    const svc = mindly.rulesFile;
    const enabled = svc.enabledFiles(pid, root) !== null;
    const sc = out.screen();
    if (o.off === true) {
      const plan = svc.planRemove(pid, root);
      if (plan.length === 0) {
        if (enabled && o.dryRun !== true) svc.remove(pid, root);
        sc.summary(
          enabled
            ? 'Rules sync is now off. No file had a Mindly section.'
            : 'Rules sync is off and no file has a Mindly section.',
        );
        return 0;
      }
      sc.summary('Removing the Mindly rules section');
      const n = printRulesFileChanges(out, plan);
      if (o.dryRun === true) {
        sc.blank();
        sc.text('Dry run: nothing was written.');
        return 0;
      }
      sc.blank();
      const ask = `Remove the section from ${count(n, 'file')} and stop syncing rules?`;
      if (n > 0 && !(await confirm(out.io, ask, o.yes === true))) {
        sc.text('Nothing changed.');
        return 1;
      }
      const done = svc.remove(pid, root);
      sc.text(`${sc.mark('ok')} Rules sync is off.`);
      return done.some((c) => c.skipped !== null) ? 1 : 0;
    }

    const plan = svc.planSync(pid, root);
    const rules = svc.rules(pid).length;
    sc.summary(
      enabled
        ? `Syncing ${count(rules, 'approved rule')} into your agent instruction files`
        : `Writing ${count(rules, 'approved rule')} into your agent instruction files`,
    );
    if (root !== project.root) sc.note(`In this worktree: ${root}`);
    const awaiting = svc.awaitingApproval(pid).length;
    if (awaiting > 0) {
      sc.note(
        `${count(awaiting, 'rule')} Mindly picked up from your prompts ${awaiting === 1 ? 'is' : 'are'} not written until you approve ${awaiting === 1 ? 'it' : 'them'} with: mindly rules --approve <id>`,
      );
    }
    const n = printRulesFileChanges(out, plan);
    const writable = plan.filter((c) => c.skipped === null);
    if (o.dryRun === true) {
      sc.blank();
      sc.text('Dry run: nothing was written.');
      return 0;
    }
    if (writable.length === 0) {
      sc.blank();
      sc.text(`${sc.mark('fail')} No file could be written.`);
      return 1;
    }
    if (!enabled) {
      sc.blank();
      sc.note(
        'Mindly writes only between its <!-- mindly:rules:start --> and <!-- mindly:rules:end --> markers, and keeps the section updated when rules are approved, edited or archived.',
      );
      const files = listWords(writable.map((c) => c.path));
      if (!(await confirm(out.io, `Keep the approved rules in ${files}?`, o.yes === true))) {
        sc.text('Nothing changed.');
        return 1;
      }
    }
    const done = svc.sync(pid, root);
    sc.blank();
    warnEdited(out, done);
    sc.text(
      n === 0
        ? `${sc.mark('ok')} Everything is up to date.`
        : `${sc.mark('ok')} Updated ${count(n, 'file')}.`,
    );
    if (!enabled) {
      sc.note('Commit the files to share the rules with every agent working on the project.', 2);
      sc.next([{ cmd: 'mindly rules sync --off', why: 'remove the section and stop syncing' }]);
    }
    return done.some((c) => c.skipped !== null) ? 1 : 0;
  });
}

/**
 * The `mindly init` step: on a terminal, offers to keep the approved rules in the project's
 * instruction files. Does nothing outside a git repository, without approved rules, when sync is
 * already on, or when nobody can be asked (`--yes` and scripts never turn it on).
 */
export async function offerRulesSync(out: Out, o: { yes?: boolean }): Promise<void> {
  if (o.yes === true || out.io.prompt === null) return;
  const root = await repoRoot(out.io.cwd);
  if (root === null) return;
  await withProject(out.io, async ({ mindly, project }) => {
    const pid = project.project.id;
    const svc = mindly.rulesFile;
    const rules = svc.rules(pid).length;
    if (svc.enabledFiles(pid, root) !== null || rules === 0) return;
    const plan = svc.planSync(pid, root).filter((c) => c.skipped === null);
    if (plan.length === 0) return;
    const sc = out.screen();
    sc.section('Rules in your agent instruction files');
    sc.note(
      `Mindly can keep your ${count(rules, 'approved rule')} in a marked section of ${listWords(plan.map((c) => c.path))}, so agents that are not connected to Mindly follow them too and the rules are versioned with your code.`,
      2,
    );
    if (!(await confirm(out.io, 'Write the rules section and keep it updated?', false))) {
      sc.note('Turn it on later with: mindly rules sync', 2);
      return;
    }
    const done = svc.sync(pid, root);
    const written = done.filter((c) => c.skipped === null && c.next !== c.previous);
    warnEdited(out, done);
    sc.text(
      written.length > 0
        ? `${sc.mark('ok')} Wrote the rules section to ${listWords(written.map((c) => c.path))}.`
        : `${sc.mark('ok')} Rules sync is on. ${listWords(plan.map((c) => c.path))} already ${plan.length === 1 ? 'states' : 'state'} every approved rule, so no section was added yet.`,
    );
  });
}

async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return realpathSync(await findRepoRoot(cwd));
  } catch {
    return null;
  }
}

/** The rules section changes in one checkout. */
export interface CheckoutChanges {
  root: string;
  changes: RulesFileChange[];
}

/**
 * Runs `fn` on every checkout with rules sync on, without creating the database. Returns null
 * when there is none.
 */
function withSyncedCheckouts(
  io: CliIo,
  fn: (mindly: Mindly, checkout: RulesFileCheckout) => RulesFileChange[],
): CheckoutChanges[] | null {
  if (!existsSync(homePaths(mindlyHome(io.env)).db)) return null;
  const mindly = openMindly({ env: io.env, disableNotify: true, disableLlm: true });
  try {
    const checkouts = mindly.rulesFile.enabledCheckouts();
    if (checkouts.length === 0) return null;
    return checkouts.map((c) => ({ root: c.root, changes: fn(mindly, c) }));
  } finally {
    mindly.close();
  }
}

/**
 * What `mindly uninstall` removes: the rules section in every checkout, in every project, with
 * rules sync on. Null when sync is on nowhere.
 */
export function planRulesSyncRemoval(io: CliIo): CheckoutChanges[] | null {
  return withSyncedCheckouts(io, (m, c) => m.rulesFile.planRemove(c.projectId, c.root));
}

/** Removes the rules section and turns sync off everywhere. */
export function removeRulesSync(io: CliIo): CheckoutChanges[] {
  return withSyncedCheckouts(io, (m, c) => m.rulesFile.remove(c.projectId, c.root)) ?? [];
}
