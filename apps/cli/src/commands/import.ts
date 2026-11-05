import { existsSync, realpathSync } from 'node:fs';
import { defaultUserConfig, homePaths, mindlyHome } from '@mindly/core';
import {
  dedupeRules,
  hasInstructionFiles,
  scanInstructionFiles,
  type InstructionFile,
  type InstructionImportPlan,
} from '@mindly/engine';
import { findRepoRoot } from '@mindly/git';
import { openMindly } from '@mindly/runtime';
import { withProject } from '../context.js';
import { confirm } from '../io.js';
import { count, listWords } from '../present/index.js';
import { clean, type Out } from '../util.js';

/** Options shared by `mindly init` and `mindly rules import`. */
export interface RuleImportOptions {
  yes?: boolean;
  dryRun?: boolean;
}

type Importer = (trust: 'approved' | 'proposed') => readonly unknown[];

/**
 * Finds rules in the project's agent instruction files (CLAUDE.md, AGENTS.md, .cursorrules, …) and
 * imports the new ones. They are approved only when the user confirms the list on a terminal; with
 * `--yes` or without a terminal they are added as suggestions waiting for approval. `from` decides
 * the wording: inside `mindly init` the step stays silent when there is nothing new, and is skipped
 * outside a git repository. Returns the exit code.
 */
export async function offerRuleImport(
  out: Out,
  o: RuleImportOptions,
  from: 'init' | 'rules',
): Promise<number> {
  let root: string;
  try {
    root = realpathSync(await findRepoRoot(out.io.cwd));
  } catch {
    if (from === 'init') return 0;
    root = realpathSync(out.io.cwd);
  }
  // Most repositories have none of these files: do not open storage or register anything for them.
  // Only checks that the paths exist; the files are read and parsed once, for the plan below.
  if (from === 'init' && !hasInstructionFiles(root)) return 0;
  if (o.dryRun) return present(out, dryRunPlan(out, root), o, from, null);
  return withProject(out.io, ({ mindly, project }) => {
    const pid = project.project.id;
    const plan = mindly.rules.planImport(pid, project.root, project.config.ignore);
    return present(out, plan, o, from, (trust) =>
      mindly.rules.importRules(pid, project.root, plan.fresh, trust),
    );
  });
}

/** The plan for a dry run, read without creating the database or registering the project. */
function dryRunPlan(out: Out, root: string): InstructionImportPlan {
  if (!existsSync(homePaths(mindlyHome(out.io.env)).db)) {
    const files = scanInstructionFiles(root, defaultUserConfig().redaction.denyPaths);
    return {
      files,
      ...dedupeRules(
        files.flatMap((f) => f.rules),
        [],
      ),
    };
  }
  const mindly = openMindly({ env: out.io.env, disableNotify: true, disableLlm: true });
  try {
    const project = mindly.store.projects.findByRoot(root);
    const ignore = project ? mindly.projects.byId(project.id).config.ignore : [];
    return mindly.rules.planImport(project?.id ?? null, root, ignore);
  } finally {
    mindly.close();
  }
}

async function present(
  out: Out,
  plan: InstructionImportPlan,
  o: RuleImportOptions,
  from: 'init' | 'rules',
  apply: Importer | null,
): Promise<number> {
  const sc = out.screen();
  if (plan.files.length === 0) {
    sc.summary('No agent instruction files in this project.');
    sc.note(
      'Mindly imports rules from CLAUDE.md, AGENTS.md, GEMINI.md, .cursorrules, .cursor/rules and similar files at the project root.',
    );
    return 0;
  }
  // Re-running init on a project whose rules are already imported says nothing about them.
  if (from === 'init' && plan.fresh.length === 0) return 0;
  const total = plan.fresh.length + plan.known.length;
  const names = plan.files.map((f) => f.path);
  if (from === 'init') sc.section('Rules from your agent instruction files');
  else sc.summary(`Found ${count(total, 'rule')} in ${listWords(names)}`);
  sc.pairs(
    plan.files.map((f) => [f.path, fileWords(f)]),
    2,
  );
  if (plan.fresh.length > 0) {
    sc.blank();
    for (const r of plan.fresh) {
      sc.text(
        `${sc.mark('item')} ${clean(r.title, 160)} ${sc.style.dim(`${r.file}:${r.line}`)}`,
        2,
      );
    }
  }
  if (plan.known.length > 0) {
    sc.note(
      `Skipping ${count(plan.known.length, 'rule')} that Mindly already has or that another file repeats.`,
      2,
    );
  }
  if (plan.fresh.length === 0) {
    sc.text(`${sc.mark('ok')} Nothing new to import.`);
    return 0;
  }
  if (apply === null) {
    if (from === 'rules') {
      sc.blank();
      sc.text('Dry run: no rules were imported.');
    }
    return 0;
  }
  sc.blank();
  const n = count(plan.fresh.length, 'rule');
  if (o.yes === true || out.io.prompt === null) {
    // Nobody read the list: the rules are suggestions until the user approves them.
    const stored = apply('proposed');
    sc.text(`${sc.mark('ok')} Added ${count(stored.length, 'suggested rule')}, waiting for you.`);
    sc.note('Agents do not follow them as project rules until you approve them.', 2);
    sc.next([{ cmd: 'mindly rules', why: 'review and approve them' }]);
    return 0;
  }
  if (!(await confirm(out.io, `Import ${n} as approved project rules?`, false))) {
    sc.text('No rules were imported.');
    sc.next([{ cmd: 'mindly rules import', why: 'import them later' }]);
    return from === 'rules' ? 1 : 0;
  }
  const stored = apply('approved');
  sc.text(`${sc.mark('ok')} Imported ${count(stored.length, 'rule')}.`);
  sc.note(
    'Every agent in this project follows them from now on. A rule is marked as possibly outdated when its line is removed from the file.',
    2,
  );
  if (from === 'rules') sc.next([{ cmd: 'mindly rules', why: 'see every rule' }]);
  return 0;
}

function fileWords(f: InstructionFile): string {
  const scope = f.rules[0]?.scopePaths ?? [];
  switch (f.skipped) {
    case 'manual':
      return `${f.agents} · skipped: only used when you ask for it`;
    case 'too_large':
      return `${f.agents} · skipped: file is too large`;
    case 'unreadable':
      return `${f.agents} · skipped: not readable as text`;
    case 'invalid_scope':
      return `${f.agents} · skipped: none of the paths it applies to is a valid project path`;
    case null:
      return `${f.agents} · ${count(f.rules.length, 'rule')}${scope.length ? ` for ${scope.join(', ')}` : ''}`;
  }
}
