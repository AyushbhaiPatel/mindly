import { existsSync, realpathSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  fingerprint,
  globsMayOverlap,
  invalidInput,
  matchesAnyGlob,
  MindlyError,
  sanitizeForContext,
  sanitizeLine,
  SplitPlanSchema,
  type Conflict,
  type HandoffSplitBrief,
  type Run,
  type Session,
  type Split,
  type SplitContractItem,
  type SplitPart,
  type SplitPlan,
  type Task,
} from '@mindly/core';
import type { z } from 'zod';
import type { TelepathyService } from '../coordination/telepathy.js';
import type { TaskService } from '../coordination/work.js';
import type { WriteGuardResult } from '../hooks/handler.js';
import type { Kernel } from '../kernel.js';
import { cleanScopePaths, USER, type MemoryService } from '../memory/service.js';
import type { Mindly, MindlyModule } from '../mindly.js';
import type { SplitCheckResult, SplitGitPort } from '../ports.js';
import type { ProjectService } from '../projects.js';
import {
  contractLines,
  contractTitle,
  liveContract,
  SPLIT_FINGERPRINT_PREFIX,
} from './split-contract.js';
import { ImpactService } from './impact.js';
import { liveSessions, serviceOf } from './shared.js';
import { isValidBranchName } from './snapshots.js';

/*
 * `mindly split`: one goal divided into non-overlapping parts, each worked on by one agent in its
 * own worktree, briefed at session start, kept inside its files, told about contract changes,
 * merge-checked as one set and merged into one integration branch.
 */

/** Branch names of a split: `mindly/<slug>/<key>` and `mindly/<slug>/integration`. */
export const SPLIT_BRANCH_PREFIX = 'mindly';
export const SPLIT_INTEGRATION_KEY = 'integration';
const MAX_SLUG = 40;
const MAX_FILES_FOR_OVERLAP = 20_000;
/** Ownership ignores letter case: src/API and src/api are one folder on macOS and Windows. */
const NOCASE = { nocase: true } as const;

// ---------------------------------------------------------------------------------------------
// Plan parsing and validation (pure)
// ---------------------------------------------------------------------------------------------

function zodProblems(err: z.ZodError): string[] {
  return err.issues
    .slice(0, 12)
    .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
}

/** Parses a plan object (from a file or a planning agent). Throws `invalid_input` listing problems. */
export function parsePlan(raw: unknown): SplitPlan {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidInput('the plan must be a JSON object with goal, parts and contract');
  }
  const r = SplitPlanSchema.safeParse(raw);
  if (!r.success) throw problems(zodProblems(r.error));
  return r.data;
}

function problems(list: readonly string[]): MindlyError {
  const n = list.length;
  return invalidInput(
    `the plan has ${n} problem${n === 1 ? '' : 's'}:\n${list.map((p) => `- ${p}`).join('\n')}`,
    { problems: [...list] },
  );
}

/** Orders part keys so every part comes after the parts it depends on (stable by position). */
export function orderParts(
  parts: readonly { key: string; dependsOn: readonly string[] }[],
): string[] {
  const remaining = parts.map((p) => p.key);
  const done = new Set<string>();
  const out: string[] = [];
  while (remaining.length > 0) {
    const i = remaining.findIndex((key) => {
      const p = parts.find((x) => x.key === key);
      return (p?.dependsOn ?? []).every((d) => done.has(d) || !remaining.includes(d));
    });
    if (i === -1) break;
    const key = remaining.splice(i, 1)[0] as string;
    done.add(key);
    out.push(key);
  }
  return [...out, ...remaining];
}

/** Finds a dependency cycle, returned as the keys along it, or null. */
function findCycle(
  parts: readonly { key: string; dependsOn: readonly string[] }[],
): string[] | null {
  const deps = new Map(parts.map((p) => [p.key, p.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    const s = state.get(key);
    if (s === 'done') return null;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting');
    stack.push(key);
    for (const d of deps.get(key) ?? []) {
      if (!deps.has(d)) continue;
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };
  for (const p of parts) {
    const found = visit(p.key);
    if (found) return found;
  }
  return null;
}

/**
 * Checks a parsed plan against the project before anything is created: unique keys, known
 * dependencies without cycles, valid and pairwise disjoint `owns` globs (against the current
 * file list and the patterns themselves), contract owners that exist, and agents that are
 * connected (when `connectedAgents` is given). Throws `invalid_input` listing every problem.
 */
export function validatePlan(
  plan: SplitPlan,
  files: readonly string[],
  connectedAgents: ReadonlySet<string> | null,
): void {
  const out: string[] = [];
  const keys = plan.parts.map((p) => p.key);
  for (const key of new Set(keys)) {
    if (keys.filter((k) => k === key).length > 1)
      out.push(`part key "${key}" is used more than once`);
  }
  if (keys.includes(SPLIT_INTEGRATION_KEY)) {
    out.push(`"${SPLIT_INTEGRATION_KEY}" is reserved for the merged branch; use another part key`);
  }
  const owns = new Map<string, string[]>();
  for (const p of plan.parts) {
    for (const d of p.dependsOn) {
      if (d === p.key) out.push(`part "${p.key}" depends on itself`);
      else if (!keys.includes(d)) out.push(`part "${p.key}" depends on unknown part "${d}"`);
    }
    try {
      owns.set(p.key, cleanScopePaths(p.owns));
      cleanScopePaths(p.reads);
    } catch (err) {
      out.push(`part "${p.key}": ${err instanceof Error ? err.message : 'invalid globs'}`);
    }
    if (connectedAgents !== null && !connectedAgents.has(p.agent)) {
      out.push(
        `part "${p.key}" is for agent "${p.agent}", which is not connected to Mindly (connect it with: mindly init --agents ${p.agent})`,
      );
    }
  }
  const cycle = findCycle(plan.parts);
  if (cycle) out.push(`parts depend on each other in a cycle: ${cycle.join(' \u2192 ')}`);
  // Pairwise disjoint ownership: no current file and no owns pattern may match two parts. Case
  // is ignored on every OS: on a case-insensitive file system src/API and src/api are one folder,
  // and a plan that tells them apart is confusing anywhere.
  const candidates = [
    ...new Set([...files.slice(0, MAX_FILES_FOR_OVERLAP), ...[...owns.values()].flat()]),
  ];
  const parts = [...owns.entries()];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const [a, aGlobs] = parts[i] as [string, string[]];
      const [b, bGlobs] = parts[j] as [string, string[]];
      // Parts mostly create files, so the patterns themselves must be disjoint, not just their
      // matches today: a pair that cannot be proven disjoint is refused, naming a current file
      // both match when there is one.
      const hit = candidates.find(
        (c) => matchesAnyGlob(c, aGlobs, NOCASE) && matchesAnyGlob(c, bGlobs, NOCASE),
      );
      let pair: [string, string] | null = null;
      for (const ga of aGlobs) {
        const gb = bGlobs.find((g) => globsMayOverlap(ga, g, NOCASE));
        if (gb !== undefined) {
          pair = [ga, gb];
          break;
        }
      }
      if (hit === undefined && pair === null) continue;
      const today = hit === undefined ? '' : `both own ${sanitizeLine(hit, 160)} and `;
      out.push(
        pair
          ? `parts "${a}" and "${b}" ${today}could both own the same new files: ${sanitizeLine(pair[0], 160)} and ${sanitizeLine(pair[1], 160)} are not clearly disjoint; use patterns that cannot match the same path`
          : `parts "${a}" and "${b}" both own ${sanitizeLine(hit as string, 160)}; owns globs must not overlap`,
      );
    }
  }
  const names = new Set<string>();
  for (const c of plan.contract) {
    const name = sanitizeLine(c.name, 120).trim();
    if (!name || !sanitizeLine(c.definition, 2000).trim()) {
      out.push(`contract item "${sanitizeLine(c.name, 80)}" needs a readable name and definition`);
    }
    const norm = name.toLowerCase().replace(/\s+/g, ' ');
    if (names.has(norm)) out.push(`contract item "${name}" appears more than once`);
    names.add(norm);
    if (!keys.includes(c.owner)) {
      out.push(`contract item "${sanitizeLine(c.name, 80)}" is owned by unknown part "${c.owner}"`);
    }
  }
  if (out.length > 0) throw problems(out);
}

/** A short slug for branch and folder names, derived from the goal. */
export function slugFor(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug || 'split';
}

/** Branch of a part (or of the integration branch) of a split. */
export function splitBranch(slug: string, key: string): string {
  return `${SPLIT_BRANCH_PREFIX}/${slug}/${key}`;
}

function insideDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** Canonical path (symlinks and, on case-insensitive file systems, letter case resolved). */
function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export type SplitPartState = 'waiting' | 'working' | 'done' | 'blocked';

export interface SplitPartStatus {
  part: SplitPart;
  task: Task;
  /** The agent working on the part (its task owner, else the newest session in the worktree). */
  session: Session | null;
  state: SplitPartState;
  /** Paths changed in the worktree since the split's base commit (committed or not). */
  filesChanged: string[];
  lastActivityAt: number | null;
  /** Open conflicts involving the part's session. */
  conflicts: Conflict[];
}

/** Everything `split status`, the daemon and Mission Control show about a split. */
export interface SplitStatusReport {
  split: Split;
  parts: SplitPartStatus[];
  contract: SplitContractItem[];
  /** The latest merge check of this split, or null. */
  mergeCheck: Run | null;
}

export interface CreateSplitInput {
  projectId: string;
  plan: SplitPlan;
  strict?: boolean;
  /** Overrides the slug derived from the goal. */
  slug?: string;
  /** Agent kind that produced the plan, or `plan-file`. */
  plannedBy: string;
  /** Agents with Mindly hooks installed; null skips the check (tests only). */
  connectedAgents: ReadonlySet<string> | null;
}

export interface CreatedSplit {
  split: Split;
  parts: SplitPart[];
  task: Task;
}

/** Result shape of a split merge-check run (`runs.kind = shadow_merge`, `input.splitId` set). */
export interface SplitMergeCheckResult {
  [key: string]: unknown;
  splitId: string;
  clean: boolean;
  parts: string[];
  merged: string[];
  conflicts: { part: string; sessionIds: string[]; paths: string[] }[];
  conflictedPaths: string[];
  checks: {
    name: string;
    ok: boolean;
    status: SplitCheckResult['status'];
    exitCode: number | null;
    durationMs: number;
    outputTail: string;
  }[];
  checksSkipped: 'untrusted' | 'none_configured' | 'conflicts' | null;
  sessionIds: string[];
  skipped: string[];
  mergedTree: string | null;
  error?: string;
}

export interface SplitMergeResult {
  split: Split;
  branch: string;
  commit: string;
  /** Parts merged, in dependency order. */
  merged: string[];
  checks: SplitMergeCheckResult['checks'] | null;
  checksSkipped: 'untrusted' | 'none_configured' | null;
}

export interface SplitAbortResult {
  split: Split;
  removedWorktrees: string[];
  deletedBranches: string[];
  keptBranches: string[];
}

export class SplitService {
  constructor(
    private readonly k: Kernel,
    private readonly memory: MemoryService,
    private readonly tasks: TaskService,
    private readonly telepathy: TelepathyService,
    private readonly projects: ProjectService,
  ) {}

  private git(): SplitGitPort {
    const port = this.k.ports.git.split;
    if (!port) throw new MindlyError('unavailable', 'git is required for mindly split');
    return port;
  }

  /** The current file list of the project (for plan validation). */
  async projectFiles(projectId: string): Promise<string[]> {
    return this.git().listFiles(this.projects.byId(projectId).root);
  }

  /**
   * Creates the worktrees, branches, tasks, contract decisions and briefs of a validated plan.
   * Everything is checked first; on a git failure half-way, what was created is removed again.
   */
  async create(input: CreateSplitInput): Promise<CreatedSplit> {
    const project = this.projects.byId(input.projectId);
    const root = project.root;
    const git = this.git();
    const plan = input.plan;
    validatePlan(plan, await git.listFiles(root), input.connectedAgents);
    const active = this.k.store.splits.active(input.projectId);
    if (active) {
      throw new MindlyError(
        'conflict',
        `a split is already active ("${sanitizeLine(active.goal, 80)}"); merge or abort it first`,
      );
    }
    const slug = input.slug ?? slugFor(plan.goal);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug) || !isValidBranchName(splitBranch(slug, 'x'))) {
      throw invalidInput('the split name must be a short lowercase slug (a-z, 0-9, -)');
    }
    const baseCommit = await this.k.ports.git.headCommit(root);
    if (!baseCommit) throw new MindlyError('invalid_input', 'the repository has no commits yet');
    const baseBranch = await this.k.ports.git.currentBranch(root);
    const worktreeRoot = resolve(dirname(root), `${basename(root)}.mindly`);
    if (insideDir(worktreeRoot, root)) {
      throw new MindlyError('invalid_input', 'cannot place worktrees next to the repository');
    }
    for (const c of plan.contract) {
      const title = contractTitle(slug, c.name);
      if (this.memory.findSameTitle(input.projectId, 'decision', title, null)) {
        throw new MindlyError(
          'conflict',
          `a decision titled "${sanitizeLine(title, 120)}" already exists (from an earlier split with this name?); choose another name with --name`,
        );
      }
    }
    const branches = [
      ...plan.parts.map((p) => splitBranch(slug, p.key)),
      splitBranch(slug, SPLIT_INTEGRATION_KEY),
    ];
    for (const b of branches) {
      if (await git.branchExists(root, b)) {
        throw new MindlyError(
          'conflict',
          `branch ${b} already exists; choose another name with --name`,
        );
      }
    }
    const folders = plan.parts.map((p) => join(worktreeRoot, `${slug}-${p.key}`));
    for (const f of folders) {
      if (existsSync(f)) {
        throw new MindlyError(
          'conflict',
          `folder ${f} already exists; choose another name with --name`,
        );
      }
    }

    // Anything created before a failure (a worktree, a branch, or the database rows when the
    // transaction fails after the worktrees exist) is removed again.
    const created: { key: string; worktree: string; branch: string }[] = [];
    try {
      for (const [i, p] of plan.parts.entries()) {
        const branch = splitBranch(slug, p.key);
        const worktree = await git.addWorktree(root, folders[i] as string, branch, baseCommit);
        created.push({ key: p.key, worktree, branch });
      }
      return this.record(input, plan, slug, baseCommit, baseBranch, worktreeRoot, created);
    } catch (err) {
      for (const c of created) {
        await git.removeWorktree(root, c.worktree).catch(() => undefined);
        await git.deleteBranch(root, c.branch).catch(() => undefined);
      }
      throw err;
    }
  }

  private record(
    input: CreateSplitInput,
    plan: SplitPlan,
    slug: string,
    baseCommit: string,
    baseBranch: string | null,
    worktreeRoot: string,
    created: readonly { key: string; worktree: string; branch: string }[],
  ): CreatedSplit {
    const root = this.projects.byId(input.projectId).root;
    const owner = (key: string): string => plan.parts.find((p) => p.key === key)?.title ?? key;
    return this.k.store.transaction(() => {
      if (this.k.store.splits.active(input.projectId)) {
        throw new MindlyError('conflict', 'a split is already active; merge or abort it first');
      }
      const task = this.tasks.create({
        projectId: input.projectId,
        title: plan.goal,
        description: `Split "${slug}": ${plan.parts.map((p) => p.title).join(', ')}`,
        plan: plan.parts.map((p) => p.title),
      });
      const contract: SplitContractItem[] = plan.contract.map((c) => {
        // A new decision per item (the title prefix keeps it apart from every other decision).
        const m = this.memory.remember({
          projectId: input.projectId,
          projectRoot: root,
          kind: 'decision',
          title: contractTitle(slug, c.name),
          body: c.definition,
          tags: ['split', `split-${slug}`],
          source: USER,
          trust: 'approved',
          reason: `contract of the split "${sanitizeLine(plan.goal, 80)}" (${slug}), owned by part "${owner(c.owner)}" (${c.owner})`,
        });
        return { ...c, memoryId: m.id };
      });
      const lines = contractLines(contract);
      const parts = plan.parts.map((p, i) => {
        const c = created[i] as { worktree: string; branch: string };
        const child = this.tasks.create({
          projectId: input.projectId,
          title: p.title,
          description: p.brief,
          parentId: task.id,
        });
        return {
          key: p.key,
          position: i,
          title: p.title,
          agentKind: p.agent,
          owns: cleanScopePaths(p.owns),
          reads: cleanScopePaths(p.reads),
          dependsOn: [...p.dependsOn],
          brief: p.brief,
          worktree: c.worktree,
          branch: c.branch,
          taskId: child.id,
          handoffId: null,
        };
      });
      const made = this.k.store.splits.create({
        projectId: input.projectId,
        slug,
        goal: plan.goal,
        taskId: task.id,
        baseCommit,
        baseBranch,
        strict: input.strict === true,
        worktreeRoot,
        contract,
        plannedBy: input.plannedBy,
        parts,
      });
      for (const part of made.parts) {
        const brief: HandoffSplitBrief = {
          splitId: made.split.id,
          goal: plan.goal,
          partKey: part.key,
          title: part.title,
          owns: part.owns,
          reads: part.reads,
          dependsOn: part.dependsOn,
          contract: lines,
          strict: made.split.strict,
        };
        const h = this.k.store.handoffs.create({
          projectId: input.projectId,
          fromSessionId: made.split.id,
          toAgentKind: part.agentKind,
          taskId: part.taskId,
          reason: 'manual',
          summary: sanitizeLine(`Part "${part.title}" of the split "${plan.goal}"`, 300),
          packet: {
            goal: part.brief,
            plan: [],
            filesChanged: [],
            recentPrompts: [],
            decisions: lines,
            blockers: [],
            nextSteps: [],
            branch: part.branch,
            headCommit: baseCommit,
            split: brief,
          },
          worktree: part.worktree,
        });
        this.k.store.splits.setPartHandoff(part.id, h.id);
        this.k.store.events.append({
          projectId: input.projectId,
          sessionId: null,
          type: 'handoff.created',
          payload: {
            handoffId: h.id,
            reason: 'split',
            toAgentKind: part.agentKind,
            splitId: made.split.id,
          },
        });
      }
      this.k.store.events.append({
        projectId: input.projectId,
        sessionId: null,
        type: 'split.created',
        payload: { splitId: made.split.id, slug, parts: made.parts.map((p) => p.key) },
      });
      return { split: made.split, parts: this.k.store.splits.parts(made.split.id), task };
    });
  }

  // ------------------------------------------------------------------ lookups

  /** The project's active split, else its most recent one. */
  current(projectId: string): Split | null {
    return (
      this.k.store.splits.active(projectId) ??
      this.k.store.splits.list(projectId, { limit: 1 })[0] ??
      null
    );
  }

  /** The part of an active split whose worktree the session runs in, if any. */
  partForSession(session: Session): SplitPart | null {
    return this.k.store.splits.partForWorktree(session.projectId, safeRealpath(session.worktree));
  }

  /** Live sessions running inside `worktree`. */
  private sessionsIn(projectId: string, worktree: string): Session[] {
    return liveSessions(this.k, projectId).filter((s) =>
      insideDir(safeRealpath(s.worktree), worktree),
    );
  }

  private partSession(part: SplitPart, task: Task): Session | null {
    const owner = task.ownerSessionId ? this.k.store.sessions.find(task.ownerSessionId) : null;
    if (owner) return owner;
    return (
      this.k.store.sessions
        .list(part.projectId, 200)
        .filter((s) => insideDir(safeRealpath(s.worktree), part.worktree))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0] ?? null
    );
  }

  /** The latest merge check of a split. */
  latestMergeCheck(split: Split): Run | null {
    return this.k.store.runs.latestWithInput(split.projectId, 'shadow_merge', 'splitId', split.id);
  }

  /** The contract items that are still approved decisions, with their current text. */
  contract(split: Split): SplitContractItem[] {
    return liveContract(this.k.store, split);
  }

  /** Full status of a split (asks git for the files each part changed). */
  async status(splitId: string): Promise<SplitStatusReport> {
    const split = this.k.store.splits.get(splitId);
    const root = this.projects.byId(split.projectId).root;
    const git = this.k.ports.git.split;
    const parts: SplitPartStatus[] = [];
    for (const part of this.k.store.splits.parts(split.id)) {
      const task = this.k.store.tasks.get(part.taskId);
      const session = this.partSession(part, task);
      let filesChanged: string[] = [];
      if (git && split.status !== 'aborted' && existsSync(part.worktree)) {
        try {
          filesChanged = await git.changedSince(root, part.worktree, split.baseCommit);
        } catch (err) {
          this.k.logger.warn('split status: could not diff a worktree', {
            part: part.key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const state: SplitPartState =
        task.status === 'done'
          ? 'done'
          : task.status === 'blocked'
            ? 'blocked'
            : task.status === 'in_progress' || session
              ? 'working'
              : 'waiting';
      parts.push({
        part,
        task,
        session,
        state,
        filesChanged,
        lastActivityAt: session?.lastSeenAt ?? null,
        conflicts: session
          ? this.k.store.conflicts.list(split.projectId, { sessionId: session.id })
          : [],
      });
    }
    return {
      split,
      parts,
      contract: this.contract(split),
      mergeCheck: this.latestMergeCheck(split),
    };
  }

  // ------------------------------------------------------------------ merge check

  /**
   * Shadow-merges every part's worktree (uncommitted work included) on the split's base and, when
   * the merge is clean and the project config is trusted, runs the configured checks on the
   * combined tree. Stored as a `shadow_merge` run with `input.splitId`; conflicts are reported as
   * `merge_conflict` conflicts on the parts' sessions.
   */
  async mergeCheck(splitId: string, trigger: 'user' | 'schedule' | 'merge'): Promise<Run> {
    const split = this.k.store.splits.get(splitId);
    const project = this.projects.byId(split.projectId);
    const parts = this.k.store.splits.parts(split.id);
    const run = this.k.store.runs.create({
      projectId: split.projectId,
      kind: 'shadow_merge',
      title: `Merge check of split "${sanitizeLine(split.goal, 80)}"`,
      input: { trigger, splitId: split.id },
    });
    this.k.store.runs.start(run.id);
    this.k.store.events.append({
      projectId: split.projectId,
      sessionId: null,
      type: 'run.started',
      payload: { runId: run.id, kind: run.kind, title: run.title },
    });
    const sessionOf = (part: SplitPart): Session | null =>
      this.partSession(part, this.k.store.tasks.get(part.taskId));
    const sessionIds = parts
      .map(sessionOf)
      .filter((s): s is Session => s !== null)
      .map((s) => s.id);
    const result: SplitMergeCheckResult = {
      splitId: split.id,
      clean: true,
      parts: parts.map((p) => p.key),
      merged: [],
      conflicts: [],
      conflictedPaths: [],
      checks: [],
      checksSkipped: null,
      sessionIds,
      skipped: [],
      mergedTree: null,
    };
    const finish = (status: 'passed' | 'failed' | 'error', r: SplitMergeCheckResult): Run => {
      const saved = this.k.store.runs.finish(run.id, status, r);
      this.k.store.events.append({
        projectId: split.projectId,
        sessionId: null,
        type: 'run.finished',
        payload: { runId: run.id, kind: run.kind, status },
      });
      return saved;
    };
    try {
      const git = this.git();
      const sides = parts
        .filter((p) => existsSync(p.worktree))
        .map((p) => ({ label: p.key, worktree: p.worktree }));
      const merge = await git.mergeCheck(project.root, split.baseCommit, sides);
      if (!merge.supported) {
        return finish('error', {
          ...result,
          clean: false,
          error: merge.reason ?? 'unsupported git',
        });
      }
      result.clean = merge.clean;
      result.merged = merge.merged;
      result.skipped = merge.conflicts.map((c) => c.label);
      result.mergedTree = merge.commit;
      const present: string[] = [];
      for (const c of merge.conflicts) {
        const part = parts.find((p) => p.key === c.label);
        const paths = [...new Set(c.paths)].sort().slice(0, 200);
        const involved = parts.filter(
          (p) => p.key === c.label || (p.key !== c.label && merge.merged.includes(p.key)),
        );
        const ids = involved
          .map(sessionOf)
          .filter((s): s is Session => s !== null)
          .map((s) => s.id);
        result.conflicts.push({ part: c.label, sessionIds: ids, paths });
        for (const p of paths)
          if (!result.conflictedPaths.includes(p)) result.conflictedPaths.push(p);
        const fp =
          SPLIT_FINGERPRINT_PREFIX + fingerprint('split_merge', split.id, c.label, ...paths);
        present.push(fp);
        this.reportConflict({
          projectId: split.projectId,
          kind: 'merge_conflict',
          severity: 'critical',
          title: sanitizeLine(
            `Part "${part?.title ?? c.label}" of the split conflicts with the other parts in ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
            200,
          ),
          detail: sanitizeLine(
            `Merging the parts' worktrees conflicts in: ${paths.slice(0, 20).join(', ')}`,
            1000,
          ),
          sessionIds: ids,
          paths,
          fingerprint: fp,
        });
      }
      this.resolveStaleConflicts(split, present);
      let failed = !merge.clean;
      if (!merge.clean) result.checksSkipped = 'conflicts';
      else if (project.config.checks.length === 0) result.checksSkipped = 'none_configured';
      else if (!project.trusted) result.checksSkipped = 'untrusted';
      else if (merge.commit) {
        const checks = await git.runChecks(project.root, merge.commit, project.config.checks);
        result.checks = checks.map((c) => ({
          name: c.name,
          ok: c.status === 'pass',
          status: c.status,
          exitCode: c.exitCode,
          durationMs: c.durationMs,
          outputTail: outputTail(c.output),
        }));
        if (result.checks.some((c) => !c.ok)) failed = true;
      }
      return finish(failed ? 'failed' : 'passed', result);
    } catch (err) {
      this.k.logger.error('split merge check failed', {
        splitId: split.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return finish('error', {
        ...result,
        clean: false,
        error:
          err instanceof MindlyError
            ? sanitizeLine(err.message, 300)
            : 'internal error (see the log)',
      });
    }
  }

  private reportConflict(report: Parameters<Kernel['store']['conflicts']['report']>[0]): void {
    const { conflict, isNew } = this.k.store.conflicts.report(report);
    if (!isNew) return;
    this.k.store.events.append({
      projectId: report.projectId,
      sessionId: null,
      type: 'conflict.opened',
      payload: {
        conflictId: conflict.id,
        kind: conflict.kind,
        severity: conflict.severity,
        title: conflict.title,
        sessionIds: report.sessionIds,
        paths: report.paths.slice(0, 200),
      },
    });
  }

  /** Resolves this split's merge conflicts that the latest check no longer reports. */
  private resolveStaleConflicts(split: Split, present: readonly string[]): void {
    const key = `split.conflicts:${split.id}`;
    const previous = this.k.store.kv.get<string[]>(key) ?? [];
    for (const fp of previous) {
      if (present.includes(fp)) continue;
      const c = this.k.store.conflicts
        .list(split.projectId, { statuses: ['open', 'acknowledged'], limit: 500 })
        .find((x) => x.fingerprint === fp);
      if (c) this.k.store.conflicts.setStatus(c.id, 'resolved');
    }
    this.k.store.kv.set(key, [...present]);
  }

  // ------------------------------------------------------------------ merge and abort

  /**
   * Merges the part branches in dependency order into the new branch `mindly/<slug>/integration`
   * (merge commits, no fast-forward, no push, nothing checked out) after a clean merge check, then
   * runs the trusted checks once more on the result. Stops at the first conflict without creating
   * the branch. Parts must be done unless `force` is set.
   */
  async merge(splitId: string, options: { force?: boolean } = {}): Promise<SplitMergeResult> {
    const split = this.k.store.splits.get(splitId);
    if (split.status !== 'active') {
      throw new MindlyError('conflict', `the split is ${split.status}, not active`);
    }
    const project = this.projects.byId(split.projectId);
    const parts = this.k.store.splits.parts(split.id);
    const notDone = parts.filter((p) => this.k.store.tasks.get(p.taskId).status !== 'done');
    if (notDone.length > 0 && !options.force) {
      throw new MindlyError(
        'conflict',
        `${notDone.length === 1 ? 'a part is' : `${notDone.length} parts are`} not done yet: ${notDone.map((p) => `"${p.title}"`).join(', ')}`,
        { details: { parts: notDone.map((p) => p.key) } },
      );
    }
    const into = splitBranch(split.slug, SPLIT_INTEGRATION_KEY);
    const git = this.git();
    if (await git.branchExists(project.root, into)) {
      throw new MindlyError('conflict', `branch ${into} already exists`);
    }
    const check = await this.mergeCheck(split.id, 'merge');
    const checkResult = check.result as SplitMergeCheckResult | null;
    if (!checkResult || !checkResult.clean) {
      const where = checkResult?.conflictedPaths.slice(0, 10).join(', ') ?? '';
      throw new MindlyError(
        'conflict',
        checkResult
          ? `the merge check found conflicts${where ? ` in ${where}` : ''}`
          : `the merge check could not run (${sanitizeLine(String(check.result?.['error'] ?? 'error'), 200)})`,
        { details: { runId: check.id } },
      );
    }
    const order = orderParts(parts);
    const sources = order.map((key) => {
      const p = parts.find((x) => x.key === key) as SplitPart;
      return { label: p.key, branch: p.branch };
    });
    const merged = await git.mergeBranches(project.root, into, split.baseCommit, sources);
    if (merged.status === 'unsupported') throw new MindlyError('unavailable', merged.reason);
    if (merged.status === 'conflicted') {
      const part = parts.find((p) => p.key === merged.label);
      throw new MindlyError(
        'conflict',
        `merging part "${part?.title ?? merged.label}" conflicts in: ${merged.paths.slice(0, 20).join(', ')}; nothing was merged`,
        { details: { part: merged.label, paths: merged.paths } },
      );
    }
    let checks: SplitMergeResult['checks'] = null;
    let checksSkipped: SplitMergeResult['checksSkipped'] = null;
    if (project.config.checks.length === 0) checksSkipped = 'none_configured';
    else if (!project.trusted) checksSkipped = 'untrusted';
    else {
      checks = (await git.runChecks(project.root, merged.commit, project.config.checks)).map(
        (c) => ({
          name: c.name,
          ok: c.status === 'pass',
          status: c.status,
          exitCode: c.exitCode,
          durationMs: c.durationMs,
          outputTail: outputTail(c.output),
        }),
      );
    }
    const updated = this.k.store.splits.update(split.id, {
      status: 'merged',
      integrationBranch: into,
      finishedAt: this.k.clock.now(),
    });
    for (const p of parts) this.k.store.handoffs.cancelForWorktree(split.projectId, p.worktree);
    this.tasks.update(split.taskId, { status: 'done' }, null);
    this.k.store.events.append({
      projectId: split.projectId,
      sessionId: null,
      type: 'split.merged',
      payload: { splitId: split.id, branch: into, commit: merged.commit },
    });
    return {
      split: updated,
      branch: into,
      commit: merged.commit,
      merged: order,
      checks,
      checksSkipped,
    };
  }

  /**
   * Removes the worktrees the split created (and their branches unless kept), cancels unclaimed
   * briefs, closes the parts' intents and tasks and marks the split aborted; the contract
   * decisions of an aborted split are archived. A branch the user has checked out somewhere is
   * kept and reported. A merged split only loses its worktrees and part branches: it stays merged
   * and keeps its integration branch.
   */
  async abort(
    splitId: string,
    options: { keepBranches?: boolean } = {},
  ): Promise<SplitAbortResult> {
    const split = this.k.store.splits.get(splitId);
    if (split.status === 'aborted')
      throw new MindlyError('conflict', 'the split is already aborted');
    const root = this.projects.byId(split.projectId).root;
    const git = this.git();
    const removedWorktrees: string[] = [];
    const deletedBranches: string[] = [];
    const keptBranches: string[] = [];
    for (const part of this.k.store.splits.parts(split.id)) {
      if (await git.removeWorktree(root, part.worktree)) removedWorktrees.push(part.worktree);
      if (options.keepBranches) keptBranches.push(part.branch);
      else {
        try {
          if (await git.deleteBranch(root, part.branch)) deletedBranches.push(part.branch);
        } catch (err) {
          if (!(err instanceof MindlyError && err.code === 'conflict')) throw err;
          keptBranches.push(part.branch);
          this.k.logger.warn('split abort: branch kept', {
            branch: part.branch,
            error: err.message,
          });
        }
      }
      this.k.store.handoffs.cancelForWorktree(split.projectId, part.worktree);
      const task = this.k.store.tasks.get(part.taskId);
      if (task.ownerSessionId)
        this.k.store.intents.closeForSession(task.ownerSessionId, 'abandoned');
      if (task.status !== 'done') this.tasks.update(task.id, { status: 'abandoned' }, null);
    }
    if (split.status === 'merged' && removedWorktrees.length + deletedBranches.length === 0) {
      throw new MindlyError('conflict', 'the split is merged and its worktrees are already gone');
    }
    try {
      rmdirSync(split.worktreeRoot);
    } catch {
      // Not empty (other splits' folders) or already gone: leave it.
    }
    const parent = this.k.store.tasks.get(split.taskId);
    if (parent.status !== 'done') {
      this.tasks.update(
        parent.id,
        { status: split.status === 'merged' ? 'done' : 'abandoned' },
        null,
      );
    }
    if (split.status !== 'merged') {
      for (const c of split.contract) {
        const m = c.memoryId ? this.k.store.memories.find(c.memoryId) : null;
        if (m && m.status === 'active') this.memory.archive(m.id);
      }
    }
    const updated =
      split.status === 'merged'
        ? split
        : this.k.store.splits.update(split.id, {
            status: 'aborted',
            finishedAt: this.k.clock.now(),
          });
    this.k.store.events.append({
      projectId: split.projectId,
      sessionId: null,
      type: 'split.aborted',
      payload: { splitId: split.id, removedWorktrees: removedWorktrees.length, keptBranches },
    });
    return { split: updated, removedWorktrees, deletedBranches, keptBranches };
  }

  // ------------------------------------------------------------------ hooks into the engine

  /** Write guard: warns (or, in strict mode, denies) writes to files owned by another part. */
  guard(
    session: Session,
    paths: readonly string[],
    whole: readonly string[] = [],
  ): WriteGuardResult {
    const none: WriteGuardResult = { warnings: [], deny: null };
    const part = this.partForSession(session);
    if (!part) return none;
    const split = this.k.store.splits.find(part.splitId);
    if (!split || split.status !== 'active') return none;
    const others = this.k.store.splits.parts(split.id).filter((p) => p.id !== part.id);
    const warnings: string[] = [];
    const denied: string[] = [];
    for (const path of paths) {
      if (matchesAnyGlob(path, part.owns, NOCASE)) continue;
      // Ignoring case can only add a warning, never miss one on a case-insensitive file system.
      const owner = others.find((o) => matchesAnyGlob(path, o.owns, NOCASE));
      if (!owner) continue;
      denied.push(`${path} (part "${owner.title}", ${owner.agentKind})`);
      warnings.push(
        `${path} is owned by part "${owner.title}" (${owner.agentKind}) of this split; your part "${part.title}" owns ${part.owns.join(', ')}. Coordinate with the user before changing another part's files.`,
      );
    }
    // A directory or wildcard written as a whole (`rm -r dir`): decided by what it can match.
    for (const pattern of whole) {
      const owner = others.find((o) => o.owns.some((g) => globsMayOverlap(pattern, g, NOCASE)));
      if (!owner) continue;
      denied.push(`${pattern} (part "${owner.title}", ${owner.agentKind})`);
      warnings.push(
        `${pattern} reaches files owned by part "${owner.title}" (${owner.agentKind}) of this split; your part "${part.title}" owns ${part.owns.join(', ')}. Coordinate with the user before changing another part's files.`,
      );
    }
    const deny =
      split.strict && denied.length > 0
        ? `Blocked by the split's ownership rules (strict mode): ${denied.map((d) => sanitizeLine(d, 200)).join('; ')} belong to another part. Ask the user before changing files owned by another part.`
        : null;
    return { warnings, deny };
  }

  /** Dependants of the part that owns `path`: sessions working on parts that depend on it. */
  dependantSessions(
    projectId: string,
    actor: Session,
    path: string,
  ): { session: Session; note: string }[] {
    const part = this.partForSession(actor);
    if (!part || !matchesAnyGlob(path, part.owns)) return [];
    const out: { session: Session; note: string }[] = [];
    for (const q of this.k.store.splits.parts(part.splitId)) {
      if (!q.dependsOn.includes(part.key)) continue;
      for (const s of this.sessionsIn(projectId, q.worktree)) {
        out.push({
          session: s,
          note: `Your part "${q.title}" depends on part "${part.title}", which owns ${path}.`,
        });
      }
    }
    return out;
  }

  /** A contract decision changed: tell the sessions of the parts that depend on its owner. */
  onContractChanged(memoryId: string, title: string, body: string, version: number): void {
    const split = this.k.store.splits.findByContractMemory(memoryId);
    if (!split || split.status !== 'active') return;
    const item = split.contract.find((c) => c.memoryId === memoryId);
    if (!item) return;
    const parts = this.k.store.splits.parts(split.id);
    const owner = parts.find((p) => p.key === item.owner);
    const ids = parts
      .filter((q) => q.dependsOn.includes(item.owner))
      .flatMap((q) => this.sessionsIn(split.projectId, q.worktree).map((s) => s.id));
    if (ids.length === 0) return;
    this.telepathy.send({
      projectId: split.projectId,
      from: null,
      to: { sessionIds: ids },
      kind: 'impact',
      priority: 7,
      title: `Contract item "${sanitizeLine(item.name, 100)}" of the split changed`,
      body: `${sanitizeLine(title, 160)}: ${sanitizeForContext(body, 600).replace(/\n/g, ' ')} It is owned by part "${owner?.title ?? item.owner}"; your part depends on it. Re-check how you use it.`,
      dedupeKey: `split-contract:${memoryId}:${version}`,
    });
  }

  /** A session started in a part's worktree: it plans to edit the files the part owns. */
  onSessionStarted(session: Session): void {
    const part = this.partForSession(session);
    if (!part) return;
    const summary = `Part "${sanitizeLine(part.title, 80)}" of the split: owns ${part.owns.join(', ')}`;
    if (this.k.store.intents.activeForSession(session.id).some((i) => i.summary === summary))
      return;
    this.k.store.intents.declare({
      projectId: session.projectId,
      sessionId: session.id,
      taskId: part.taskId,
      summary: sanitizeLine(summary, 300),
      targets: { files: part.owns, symbols: [] },
      ttlMs: 24 * 60 * 60_000,
    });
  }
}

function outputTail(text: string, max = 4000): string {
  return text.length > max ? text.slice(-max) : text;
}

/** The split service of `mindly` (created on first use). */
export function splitOf(mindly: Mindly): SplitService {
  return serviceOf(
    mindly,
    'split',
    () =>
      new SplitService(
        mindly.kernel,
        mindly.memory,
        mindly.tasks,
        mindly.telepathy,
        mindly.projects,
      ),
  );
}

const registered = new WeakSet<Mindly>();

/** Split module: ownership guard, dependant impact routing, contract-change updates, intents. */
export const splitModule: MindlyModule = (mindly) => {
  if (registered.has(mindly)) return;
  registered.add(mindly);
  const svc = splitOf(mindly);
  mindly.hooks.useWriteGuard((_project, session, paths, whole) => svc.guard(session, paths, whole));
  serviceOf(
    mindly,
    'impact',
    () => new ImpactService(mindly.kernel, mindly.telepathy),
  ).addRecipientResolver((projectId, actor, path) => svc.dependantSessions(projectId, actor, path));
  mindly.memory.onUpdated((m) => {
    if (m.kind === 'decision') svc.onContractChanged(m.id, m.title, m.body, m.version);
  });
  mindly.bus.on('session.started', 'split.intent', (p) => {
    svc.onSessionStarted(p.session);
  });
};
