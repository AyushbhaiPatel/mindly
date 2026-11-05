import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AGENT_KIND_RE,
  isMindlyError,
  SPLIT_MAX_PARTS,
  SPLIT_MIN_PARTS,
  type SplitPlan,
} from '@mindly/core';
import { HOOK_AGENT_KINDS } from '@mindly/adapters';
import { parsePlan, splitOf, validatePlan, type SplitMergeResult } from '@mindly/engine';
import { z } from 'zod';
import { withProject, type ProjectScope } from '../context.js';
import { confirm, type CliIo } from '../io.js';
import { agentName, count } from '../present/index.js';
import { clean, HintedError, UsageError, splitList, type Out } from '../util.js';
import {
  renderAborted,
  renderMergeCheck,
  renderMerged,
  renderPlan,
  renderSplitStatus,
} from '../views/split.js';
import { parseOptions } from './memory.js';
import { adapterOf, adaptersFor, installCommand, userHome } from './setup.js';

const MAX_PLAN_FILE_BYTES = 1024 * 1024;
/** Time limit for a planning agent. */
export const PLAN_TIMEOUT_SEC = 600;
const PLANNERS = ['claude-code', 'codex'] as const;

const SplitOptions = z.object({
  parts: z.number().int().min(SPLIT_MIN_PARTS).max(SPLIT_MAX_PARTS).optional(),
  agents: z.string().optional(),
  plan: z.string().min(1).optional(),
  planner: z.enum(PLANNERS).optional(),
  strict: z.boolean().optional(),
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'must be a short lowercase slug (a-z, 0-9, -)')
    .optional(),
  yes: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  json: z.boolean().optional(),
});

/** Hook agents (session_start briefs need hooks) with Mindly installed user-wide or for this project. */
export async function connectedHookAgents(io: CliIo, projectRoot: string): Promise<Set<string>> {
  const all = adaptersFor(io.env, { statusLine: false });
  const command = await installCommand(io.env);
  const out = new Set<string>();
  for (const kind of HOOK_AGENT_KINDS) {
    const adapter = adapterOf(all, kind);
    try {
      const plan = (root: string | null) =>
        adapter.planInstall({ command, projectRoot: root, homeDir: userHome(io.env) });
      if ((await plan(null)).length === 0 || (await plan(projectRoot)).length === 0) out.add(kind);
    } catch {
      // Unreadable settings: not connected.
    }
  }
  return out;
}

function readPlanFile(cwd: string, file: string): unknown {
  const path = resolve(cwd, file);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new HintedError(
      'not_found',
      `plan file not found: ${file}`,
      'Give the path of a JSON plan file.',
    );
  }
  if (size > MAX_PLAN_FILE_BYTES) throw new UsageError('the plan file is larger than 1 MB');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new HintedError(
      'invalid_input',
      `the plan file is not valid JSON (${err instanceof Error ? err.message : 'parse error'})`,
      'A plan is JSON: { goal, parts: [{ key, title, agent, owns, reads, dependsOn, brief }], contract: [{ name, owner, definition }] }.',
    );
  }
}

/** Opens the plan in `$VISUAL`/`$EDITOR` and returns the edited JSON text, or null without an editor. */
function editInEditor(io: CliIo, text: string): string | null {
  const editor = (io.env['VISUAL'] ?? io.env['EDITOR'] ?? '').trim();
  if (!editor) return null;
  const dir = mkdtempSync(join(tmpdir(), 'mindly-plan-'));
  const file = join(dir, 'plan.json');
  try {
    writeFileSync(file, text, { mode: 0o600 });
    // Like git: the editor setting is a shell fragment (it may carry flags or a quoted path).
    const r = spawnSync('sh', ['-c', `${editor} "$@"`, 'mindly', file], {
      stdio: 'inherit',
      env: io.env,
    });
    if (r.error || r.status !== 0) {
      io.stderr.write(
        `The editor exited with ${r.error ? r.error.message : `code ${r.status}`}; the plan is unchanged.\n`,
      );
      return text;
    }
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function planWithAgent(
  out: Out,
  scope: ProjectScope,
  o: { goal: string; planner?: 'claude-code' | 'codex'; parts?: number; agents: string[] | null },
  connected: ReadonlySet<string>,
  files: readonly string[],
): Promise<{ plan: SplitPlan; plannedBy: string }> {
  const { detectAgent, runPlanner } = await import('@mindly/runners');
  const planner = o.planner ?? PLANNERS.find((k) => detectAgent(k, out.io.env) !== null) ?? null;
  if (!planner || detectAgent(planner, out.io.env) === null) {
    throw new HintedError(
      'unavailable',
      planner
        ? `${agentName(planner)} is not installed or not on PATH, so it cannot plan the split`
        : 'no agent is available to plan the split (Claude Code or Codex must be on PATH)',
      'Write the plan yourself and pass it with: mindly split --plan plan.json',
    );
  }
  const pid = scope.project.project.id;
  const rules = scope.mindly.memory
    .list(pid, { kinds: ['rule'], trust: ['approved', 'verified'], limit: 40 })
    .map((m) => m.title);
  const decisions = scope.mindly.memory
    .search(pid, o.goal, {
      kinds: ['decision', 'fact'],
      trust: ['approved', 'verified'],
      limit: 20,
    })
    .map((h) => h.memory.title);
  const agents = (o.agents ?? [...connected]).filter((a) => connected.has(a));
  if (agents.length === 0) {
    throw new HintedError(
      'invalid_input',
      'no connected agent can take a part',
      'Connect the agents that should work on the parts with: mindly init',
    );
  }
  if (!out.io.env['MINDLY_QUIET']) {
    out.warn(`Planning with ${agentName(planner)} (read-only)${sym(out)}`);
  }
  const r = await runPlanner(
    {
      repoRoot: scope.project.root,
      planner,
      goal: o.goal,
      files,
      rules,
      decisions,
      agents,
      ...(o.parts !== undefined ? { parts: o.parts } : {}),
      timeoutSec: PLAN_TIMEOUT_SEC,
    },
    { env: out.io.env },
  );
  if (r.status !== 'completed') {
    throw new HintedError(
      'unavailable',
      `${agentName(planner)} could not plan the split: ${r.error ?? r.status}`,
      'Try again, or write the plan yourself: mindly split --plan plan.json',
    );
  }
  if (r.plan === null) {
    throw new HintedError(
      'invalid_input',
      `${agentName(planner)} did not return a JSON plan (it said: "${r.text.replace(/\s+/g, ' ').slice(0, 200)}")`,
      'Try again, or write the plan yourself: mindly split --plan plan.json',
    );
  }
  try {
    return { plan: parsePlan(r.plan), plannedBy: planner };
  } catch (err) {
    throw new HintedError(
      'invalid_input',
      `${agentName(planner)} returned an invalid plan: ${err instanceof Error ? err.message : 'invalid'}`,
      'Try again, or write the plan yourself: mindly split --plan plan.json',
    );
  }
}

function sym(out: Out): string {
  return out.screen().sym.ellipsis;
}

/** `mindly split "<goal>" [--plan file] [--strict] [--yes] [--dry-run]`: plan, review, create. */
export async function split(out: Out, goalWords: string[], raw: unknown): Promise<number> {
  const o = parseOptions(SplitOptions, raw);
  const goal = goalWords.join(' ').trim();
  if (!goal && !o.plan) {
    throw new UsageError(
      'give the goal to split, e.g. mindly split "add billing: API, webhook, page"',
    );
  }
  const agents = o.agents === undefined ? null : splitList(o.agents);
  for (const a of agents ?? []) {
    if (!AGENT_KIND_RE.test(a)) throw new UsageError(`invalid agent kind in --agents: ${a}`);
  }
  return withProject(out.io, async (scope) => {
    const svc = splitOf(scope.mindly);
    const connected = await connectedHookAgents(out.io, scope.project.root);
    const files = await svc.projectFiles(scope.project.project.id);
    let plan: SplitPlan;
    let plannedBy: string;
    if (o.plan) {
      plan = parsePlan(readPlanFile(out.io.cwd, o.plan));
      if (goal) plan = parsePlan({ ...plan, goal });
      plannedBy = 'plan-file';
    } else {
      ({ plan, plannedBy } = await planWithAgent(
        out,
        scope,
        {
          goal,
          agents,
          ...(o.planner !== undefined ? { planner: o.planner } : {}),
          ...(o.parts !== undefined ? { parts: o.parts } : {}),
        },
        connected,
        files,
      ));
    }
    validatePlan(plan, files, connected);

    if (o.dryRun) {
      if (o.json) out.json({ plan, plannedBy, created: false });
      else {
        renderPlan(out.screen(), plan, plannedBy);
        out.screen().next([
          {
            cmd: 'mindly split --plan plan.json --yes',
            why: 'create the worktrees from a plan file',
          },
        ]);
      }
      return 0;
    }
    if (!o.yes) {
      if (!out.io.prompt) {
        if (!o.json) renderPlan(out.screen(), plan, plannedBy);
        out.warn(
          'Not created: no terminal to review the plan on. Re-run with --yes to create it, or --dry-run to only show it.',
        );
        return 1;
      }
      // Review loop: Enter creates, "e" edits the JSON in $EDITOR, "n" stops.
      for (;;) {
        renderPlan(out.screen(), plan, plannedBy);
        out.line();
        const answer = (
          await out.io.prompt(
            `Create ${count(plan.parts.length, 'worktree')} and briefs? [Y/n/e(dit)] `,
          )
        )
          .trim()
          .toLowerCase();
        if (answer === 'n' || answer === 'no') {
          out.line('Nothing created.');
          return 0;
        }
        if (answer === 'e' || answer === 'edit') {
          const edited = editInEditor(out.io, `${JSON.stringify(plan, null, 2)}\n`);
          if (edited === null) {
            out.warn(
              'No editor configured (set $EDITOR), or write the plan to a file and use --plan.',
            );
            continue;
          }
          try {
            plan = parsePlan(JSON.parse(edited) as unknown);
            validatePlan(plan, files, connected);
          } catch (err) {
            out.warn(
              `The edited plan is not valid: ${err instanceof Error ? err.message : 'invalid'}`,
            );
          }
          continue;
        }
        break;
      }
    }
    const created = await svc.create({
      projectId: scope.project.project.id,
      plan,
      strict: o.strict === true,
      ...(o.name !== undefined ? { slug: o.name } : {}),
      plannedBy,
      connectedAgents: connected,
    });
    if (o.json) {
      out.json({ plan, plannedBy, created: true, ...created });
      return 0;
    }
    const sc = out.screen();
    sc.summary(
      `${sc.mark('ok')} Created ${count(created.parts.length, 'worktree')} next to the repo (${created.split.worktreeRoot}) and briefed each part.`,
    );
    sc.rows(
      created.parts.map((p) => ({
        marker: 'item' as const,
        text: `${p.position + 1} ${clean(p.title, 60)} ${sc.sym.dot} ${agentName(p.agentKind)} ${sc.sym.dot} ${p.worktree}`,
      })),
    );
    if (created.split.strict)
      sc.note('Strict mode: writes to files owned by another part are blocked.', 2);
    sc.next([
      ...created.parts.slice(0, 3).map((p) => ({
        cmd: `cd ${p.worktree}`,
        why: `start ${agentName(p.agentKind)} there; Mindly briefs it on part "${clean(p.title, 60)}" when the session starts`,
      })),
      { cmd: 'mindly split status', why: 'see progress, conflicts and the merge check' },
    ]);
    return 0;
  });
}

function currentSplit(scope: ProjectScope): string {
  const s = splitOf(scope.mindly).current(scope.project.project.id);
  if (!s) {
    throw new HintedError(
      'not_found',
      'no split in this project',
      'Start one with: mindly split "<goal>"',
    );
  }
  return s.id;
}

/** `mindly split status`. */
export async function splitStatus(out: Out, o: { json?: boolean }): Promise<number> {
  return withProject(out.io, async (scope) => {
    const r = await splitOf(scope.mindly).status(currentSplit(scope));
    if (o.json) out.json(r);
    else renderSplitStatus(out.screen(), r);
    return 0;
  });
}

/** `mindly split check`: merge every part in memory and run the trusted checks now. */
export async function splitCheck(out: Out, o: { json?: boolean }): Promise<number> {
  return withProject(out.io, async (scope) => {
    const run = await splitOf(scope.mindly).mergeCheck(currentSplit(scope), 'user');
    if (o.json) {
      out.json(run);
      return run.status === 'passed' ? 0 : 1;
    }
    const sc = out.screen();
    sc.summary(
      run.status === 'passed'
        ? `${sc.mark('ok')} Merge check clean: every part merges and the checks pass.`
        : run.status === 'failed'
          ? `${sc.mark('fail')} Merge check failed.`
          : `${sc.mark('fail')} Merge check could not run.`,
    );
    renderMergeCheck(sc, run);
    sc.next([{ cmd: 'mindly split status', why: 'see every part' }]);
    return run.status === 'passed' ? 0 : 1;
  });
}

/** `mindly split merge [--force]`. */
export async function splitMerge(
  out: Out,
  o: { force?: boolean; json?: boolean },
): Promise<number> {
  return withProject(out.io, async (scope) => {
    let m: SplitMergeResult;
    try {
      m = await splitOf(scope.mindly).merge(currentSplit(scope), { force: o.force === true });
    } catch (err) {
      if (isMindlyError(err, 'conflict') && Array.isArray(err.details?.['parts'])) {
        throw new HintedError(
          'conflict',
          err.message,
          'Merge anyway with: mindly split merge --force',
        );
      }
      throw err;
    }
    if (o.json) out.json(m);
    else renderMerged(out.screen(), m);
    return m.checks && m.checks.some((c) => !c.ok) ? 1 : 0;
  });
}

/** `mindly split abort [--keep-branches] [-y]`. */
export async function splitAbort(
  out: Out,
  o: { keepBranches?: boolean; yes?: boolean; json?: boolean },
): Promise<number> {
  return withProject(out.io, async (scope) => {
    const id = currentSplit(scope);
    const svc = splitOf(scope.mindly);
    const split = scope.mindly.store.splits.get(id);
    if (!o.json || !o.yes) {
      const ok = await confirm(
        out.io,
        `Remove the worktrees${o.keepBranches ? '' : ' and branches'} of the split "${split.goal.slice(0, 60)}"? Uncommitted work in them is lost.`,
        o.yes === true,
      );
      if (!ok) return 1;
    }
    const a = await svc.abort(id, { keepBranches: o.keepBranches === true });
    if (o.json) out.json(a);
    else renderAborted(out.screen(), a);
    return 0;
  });
}
