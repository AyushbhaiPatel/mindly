import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isMindlyError, MindlyError, type SplitPlan } from '@mindly/core';
import {
  installDefaultModules,
  Mindly,
  orderParts,
  parsePlan,
  slugFor,
  splitBranch,
  splitOf,
  USER,
  validatePlan,
  type SplitGitPort,
  type SplitMergeCheck,
} from '../../src/index.js';
import { event, FakeClock, fakeGit, shellTool, writeTool } from '../helpers.js';
import { fileDigest } from '../../src/features/split.js';

const FILES = ['README.md', 'src/api/billing.ts', 'src/app/page.ts', 'src/webhooks/stripe.ts'];

function part(
  key: string,
  owns: string[],
  dependsOn: string[] = [],
  agent = 'claude-code',
): SplitPlan['parts'][number] {
  return { key, title: `Part ${key}`, agent, owns, reads: [], dependsOn, brief: `Build ${key}.` };
}

const PLAN: SplitPlan = {
  goal: 'Add billing',
  parts: [part('api', ['src/api/**']), part('page', ['src/app/**'], ['api'])],
  contract: [{ name: 'GET /billing', owner: 'api', definition: 'returns { plan }' }],
};

/** An in-memory stand-in for the git side of a split: folders are real, branches are a set. */
function fakeSplitGit(root: string) {
  const branches = new Set<string>();
  const worktrees = new Map<string, string>();
  const changed = new Map<string, string[]>();
  // Paths of a worktree that are not on its branch (asked for with a branch as the base).
  const uncommitted = new Map<string, string[]>();
  // Ignored files on the deny-list (by worktree), and which paths are deny-listed.
  const ignoredDenied = new Map<string, string[]>();
  const denied = new Set<string>();
  // Nested repositories (by worktree), moved out before a worktree goes, or the one that cannot be.
  const nestedRepos = new Map<string, string[]>();
  const cannotMove = new Map<string, { path: string; reason: string }>();
  // What appeared right before a removal (by worktree).
  const stray = new Map<string, string[]>();
  // Commits only a branch has (by branch), as `branchOnlyWork` reports them; the branch tip is
  // the newest of them.
  const onlyOn = new Map<string, { commit: string; subject: string }[]>();
  const tipOf = (b: string): string => onlyOn.get(b)?.[0]?.commit ?? `tip-${b}`;
  const calls: { mergeBranches: unknown[]; restored: { worktree: string; paths: string[] }[] } = {
    mergeBranches: [],
    restored: [],
  };
  let mergeCheck: SplitMergeCheck | null = null;
  let runChecks: SplitGitPort['runChecks'] = async () => [];
  const port: SplitGitPort = {
    listFiles: async () => FILES,
    branchExists: async (_root, b) => branches.has(b),
    addWorktree: async (_root, path, branch, startPoint) => {
      if (existsSync(path) || branches.has(branch)) throw new Error('conflict');
      expect(startPoint).toBe('base0001');
      mkdirSync(path, { recursive: true });
      branches.add(branch);
      worktrees.set(path, branch);
      return path;
    },
    removeWorktree: async (_root, path) => {
      if (!worktrees.has(path)) return false;
      rmSync(path, { recursive: true, force: true });
      worktrees.delete(path);
      return true;
    },
    restoreFromHead: async (_root, worktree, paths) => {
      calls.restored.push({ worktree, paths: [...paths] });
    },
    keepNestedRepos: async (_root, worktree, holding) => {
      const failed = cannotMove.get(worktree) ?? null;
      if (failed) return { moved: [], failed };
      const moved = (nestedRepos.get(worktree) ?? []).map((path) => ({
        path,
        to: join(root, '.git', 'mindly', 'kept', ...holding, path),
      }));
      nestedRepos.delete(worktree);
      return { moved, failed: null };
    },
    strayWork: async (_root, worktree) => stray.get(worktree) ?? [],
    deleteBranch: async (_root, b, expectedTip) => {
      if (expectedTip !== undefined && branches.has(b) && tipOf(b) !== expectedTip) {
        throw new MindlyError('conflict', `branch ${b} has commits made after it was checked`, {
          details: { branch: b, moved: true },
        });
      }
      return branches.delete(b);
    },
    branchOnlyWork: async (_root, b) =>
      branches.has(b)
        ? { tip: tipOf(b), commits: onlyOn.get(b) ?? [], more: false }
        : { tip: null, commits: [], more: false },
    uncommittedWork: async (_root, wt) => {
      const paths = uncommitted.get(wt) ?? [];
      const ignored = ignoredDenied.get(wt) ?? [];
      return {
        paths,
        ignoredDenied: ignored,
        denied: [...paths, ...ignored].filter((p) => denied.has(p)),
      };
    },
    changedSince: async (_root, wt, base) =>
      (base.startsWith('refs/heads/') ? uncommitted.get(wt) : changed.get(wt)) ?? [],
    mergeCheck: async (_root, _base, sides) =>
      mergeCheck ?? {
        supported: true,
        clean: true,
        merged: sides.map((s) => s.label),
        conflicts: [],
        commit: 'tree0001',
      },
    mergeBranches: async (_root, into, _base, sources) => {
      calls.mergeBranches.push({ into, sources });
      if (branches.has(into)) throw new Error('exists');
      branches.add(into);
      return { status: 'merged', commit: 'merge0001' };
    },
    runChecks: (...args) => runChecks(...args),
  };
  const findRepoRoot = async (cwd: string): Promise<string> => {
    for (const wt of worktrees.keys()) if (cwd === wt || cwd.startsWith(`${wt}/`)) return wt;
    return root;
  };
  return {
    port,
    branches,
    worktrees,
    changed,
    uncommitted,
    ignoredDenied,
    denied,
    nestedRepos,
    cannotMove,
    stray,
    onlyOn,
    calls,
    setRunChecks: (fn: SplitGitPort['runChecks']) => {
      runChecks = fn;
    },
    setMergeCheck: (m: SplitMergeCheck | null) => {
      mergeCheck = m;
    },
    findRepoRoot,
  };
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-split-')));
  mkdirSync(join(root, 'src', 'api'), { recursive: true });
  const fake = fakeSplitGit(root);
  const clock = new FakeClock();
  const mindly = Mindly.open({
    inMemory: true,
    clock,
    ports: {
      git: {
        ...fakeGit,
        headCommit: async () => 'base0001',
        findRepoRoot: fake.findRepoRoot,
        projectRoot: async () => root,
        split: fake.port,
      },
    },
  });
  installDefaultModules(mindly);
  const project = mindly.store.projects.upsertByRoot(root, basename(root));
  const svc = splitOf(mindly);
  const worktreeRoot = join(dirname(root), `${basename(root)}.mindly`);
  return { root, clock, mindly, project, pid: project.id, svc, fake, worktreeRoot };
}

describe('plan validation', () => {
  it('rejects bad shapes, counts, overlaps, unknown agents and cycles before anything exists', async () => {
    const { svc, pid, mindly, worktreeRoot } = await setup();
    const reject = (plan: unknown, re: RegExp) => {
      let err: unknown = null;
      try {
        validatePlan(parsePlan(plan), FILES, new Set(['claude-code', 'codex']));
      } catch (e) {
        err = e;
      }
      expect(isMindlyError(err, 'invalid_input')).toBe(true);
      expect((err as Error).message).toMatch(re);
    };
    reject([], /JSON object/);
    reject({ goal: 'g', parts: [part('a', ['src/**'])], contract: [] }, /parts/);
    reject(
      {
        goal: 'g',
        parts: Array.from({ length: 7 }, (_, i) => part(`p${i}`, [`p${i}/**`])),
        contract: [],
      },
      /parts/,
    );
    reject(
      { goal: 'g', parts: [part('a', ['src/**']), part('b', ['src/api/**'])], contract: [] },
      /"a" and "b" both own src\/api\/billing\.ts/,
    );
    reject(
      { goal: 'g', parts: [part('a', ['lib/**']), part('b', ['lib/**'])], contract: [] },
      /both own lib\/\*\*/,
    );
    reject(
      {
        goal: 'g',
        parts: [part('a', ['src/api/**'], [], 'gemini'), part('b', ['src/app/**'])],
        contract: [],
      },
      /"gemini", which is not connected/,
    );
    reject(
      {
        goal: 'g',
        parts: [part('a', ['src/api/**'], ['b']), part('b', ['src/app/**'], ['a'])],
        contract: [],
      },
      /cycle: a → b → a/,
    );
    reject(
      {
        goal: 'g',
        parts: [part('a', ['src/api/**'], ['zzz']), part('b', ['src/app/**'])],
        contract: [],
      },
      /unknown part "zzz"/,
    );
    reject(
      { goal: 'g', parts: [part('a', ['src/api/**']), part('a', ['src/app/**'])], contract: [] },
      /used more than once/,
    );
    reject(
      {
        goal: 'g',
        parts: [part('integration', ['src/api/**']), part('b', ['src/app/**'])],
        contract: [],
      },
      /reserved/,
    );
    reject(
      {
        goal: 'g',
        parts: [part('a', ['src/api/**']), part('b', ['src/app/**'])],
        contract: [{ name: 'x', owner: 'nope', definition: 'd' }],
      },
      /unknown part "nope"/,
    );
    reject(
      { goal: 'g', parts: [part('a', ['../etc/**']), part('b', ['src/app/**'])], contract: [] },
      /part "a"/,
    );
    // The service validates again and creates nothing on failure.
    await expect(
      svc.create({
        projectId: pid,
        plan: {
          goal: 'g',
          parts: [part('a', ['src/**']), part('b', ['src/api/**'])],
          contract: [],
        },
        plannedBy: 'plan-file',
        connectedAgents: null,
      }),
    ).rejects.toSatisfy((e) => isMindlyError(e, 'invalid_input'));
    expect(mindly.store.splits.list(pid)).toHaveLength(0);
    expect(mindly.store.tasks.list(pid)).toHaveLength(0);
    expect(existsSync(worktreeRoot)).toBe(false);
  });

  it('refuses owns globs that could match the same new file, and unreadable or repeated contract items', () => {
    const check = (plan: unknown): string | null => {
      try {
        validatePlan(parsePlan(plan), FILES, null);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    const two = (a: string[], b: string[]) => ({
      goal: 'g',
      parts: [part('a', a), part('b', b)],
      contract: [],
    });
    // No file matches both today, but a new file could.
    expect(check(two(['src/billing/**'], ['**/*.test.ts']))).toMatch(/not clearly disjoint/);
    expect(check(two(['src/*.ts'], ['src/new.*']))).toMatch(/not clearly disjoint/);
    expect(check(two(['web/**'], ['**/billing/**']))).toMatch(/not clearly disjoint/);
    expect(check(two(['src/api/**'], ['src/app/**', 'docs/*.md']))).toBeNull();
    // Letter case never tells two owners apart (src/API and src/api are one folder on macOS).
    expect(check(two(['src/API/**'], ['src/api/**']))).toMatch(/could both own the same new files/);
    expect(check(two(['src/API/**'], ['src/app/**']))).toBeNull();
    expect(check(two(['src/**/*.ts'], ['src/**/*.css']))).toBeNull();
    const withContract = (contract: unknown[]) => ({
      goal: 'g',
      parts: [part('a', ['a/**']), part('b', ['b/**'])],
      contract,
    });
    expect(check(withContract([{ name: '\u200b', owner: 'a', definition: 'x' }]))).toMatch(
      /readable name/,
    );
    expect(
      check(
        withContract([
          { name: 'GET /x', owner: 'a', definition: 'x' },
          { name: 'get  /x', owner: 'b', definition: 'y' },
        ]),
      ),
    ).toMatch(/more than once/);
  });

  it('orders parts by dependency and derives branch names', () => {
    expect(
      orderParts([
        { key: 'page', dependsOn: ['api', 'hooks'] },
        { key: 'hooks', dependsOn: ['api'] },
        { key: 'api', dependsOn: [] },
      ]),
    ).toEqual(['api', 'hooks', 'page']);
    expect(slugFor('Add billing: API, webhook handler & page!')).toBe(
      'add-billing-api-webhook-handler-page',
    );
    expect(slugFor('???')).toBe('split');
    expect(splitBranch('billing', 'api')).toBe('mindly/billing/api');
    expect(splitBranch('billing', 'integration')).toBe('mindly/billing/integration');
  });
});

describe('split through hook events', () => {
  it('creates worktrees, tasks, contract decisions and briefs claimed at session start', async () => {
    const { mindly, svc, pid, fake, worktreeRoot, root } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: new Set(['claude-code']),
    });
    expect(created.split.worktreeRoot).toBe(worktreeRoot);
    expect(created.parts.map((p) => p.worktree)).toEqual([
      join(worktreeRoot, 'billing-api'),
      join(worktreeRoot, 'billing-page'),
    ]);
    expect([...fake.branches].sort()).toEqual(['mindly/billing/api', 'mindly/billing/page']);
    // Parent task with one child per part; the contract is a user-approved decision.
    const tasks = mindly.store.tasks.list(pid);
    expect(tasks.find((t) => t.id === created.task.id)?.parentId).toBeNull();
    expect(
      tasks
        .filter((t) => t.parentId === created.task.id)
        .map((t) => t.title)
        .sort(),
    ).toEqual(['Part api', 'Part page']);
    const decision = mindly.store.memories.get(created.split.contract[0]!.memoryId as string);
    expect(decision).toMatchObject({
      kind: 'decision',
      trust: 'approved',
      title: '[split billing] GET /billing',
      body: 'returns { plan }',
    });
    expect(mindly.store.handoffs.list(pid).filter((h) => h.status === 'pending')).toHaveLength(2);
    // A second split cannot start while this one is active.
    await expect(
      svc.create({
        projectId: pid,
        plan: PLAN,
        slug: 'other',
        plannedBy: 'plan-file',
        connectedAgents: null,
      }),
    ).rejects.toSatisfy((e) => isMindlyError(e, 'conflict'));

    // The api agent starts in its worktree: it is briefed on its part and the contract.
    const apiWt = created.parts[0]!.worktree;
    const res = await mindly.hooks.handle(event(apiWt, 'claude-code', 'api-1', 'session_start'));
    expect(res.context).toContain('Your part of the split');
    expect(res.context).toContain('Part api');
    expect(res.context).toContain('Files you own (edit only these): src/api/**');
    expect(res.context).toContain('GET /billing');
    expect(res.context).toContain('owned by part api');
    expect(res.context).toContain('branch mindly/billing/api');
    // Only committed work on the part branch is merged: the brief says so.
    expect(res.context).toMatch(
      /Commit your work in this worktree on its branch \(mindly\/billing\/api\)/,
    );
    const session = mindly.store.sessions.findByExternal(pid, 'claude-code', 'api-1')!;
    expect(session.worktree).toBe(apiWt);
    expect(svc.partForSession(session)?.key).toBe('api');
    expect(
      mindly.store.handoffs.list(pid).find((h) => h.claimedBySessionId === session.id)?.packet.split
        ?.partKey,
    ).toBe('api');
    expect(mindly.store.intents.activeForSession(session.id)[0]?.targets.files).toEqual([
      'src/api/**',
    ]);
    // A session in the main checkout gets no brief; the page brief waits for a page session.
    const main = await mindly.hooks.handle(event(root, 'claude-code', 'main-1', 'session_start'));
    expect(main.context ?? '').not.toContain('Your part of the split');
    expect(mindly.store.handoffs.list(pid).filter((h) => h.status === 'pending')).toHaveLength(1);
    const status = await svc.status(created.split.id);
    expect(status.parts.map((p) => p.state)).toEqual(['working', 'waiting']);
    expect(status.parts[0]!.session?.id).toBe(session.id);
  });

  it('warns about writes to another part, denies them in strict mode, allows own files', async () => {
    const { mindly, svc, pid } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const apiWt = created.parts[0]!.worktree;
    await mindly.hooks.handle(event(apiWt, 'claude-code', 'api-1', 'session_start'));
    const own = await mindly.hooks.handle(
      event(apiWt, 'claude-code', 'api-1', 'pre_tool', {
        tool: writeTool('src/api/billing.ts', 'x'),
      }),
    );
    expect(own.decision ?? null).toBeNull();
    expect(own.context ?? '').not.toContain('owned by part');
    const other = await mindly.hooks.handle(
      event(apiWt, 'claude-code', 'api-1', 'pre_tool', { tool: writeTool('src/app/page.ts', 'x') }),
    );
    expect(other.decision ?? null).toBeNull();
    expect(other.context).toContain(
      'src/app/page.ts is owned by part "Part page" (claude-code) of this split',
    );
    expect(other.context).toContain('your part "Part api" owns src/api/**');
    // A path that differs from another part's owns only by case is still that part's file.
    const cased = await mindly.hooks.handle(
      event(apiWt, 'claude-code', 'api-1', 'pre_tool', { tool: writeTool('src/APP/page.ts', 'x') }),
    );
    expect(cased.context).toContain('src/APP/page.ts is owned by part "Part page"');
    // Files nobody owns are free.
    const free = await mindly.hooks.handle(
      event(apiWt, 'claude-code', 'api-1', 'pre_tool', { tool: writeTool('README.md', 'x') }),
    );
    expect(free.context ?? '').not.toContain('owned by part');

    await svc.abort(created.split.id);
    const strict = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'strict',
      strict: true,
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const pageWt = strict.parts[1]!.worktree;
    const brief = await mindly.hooks.handle(
      event(pageWt, 'claude-code', 'page-1', 'session_start'),
    );
    expect(brief.context).toContain('blocked (strict mode)');
    const denied = await mindly.hooks.handle(
      event(pageWt, 'claude-code', 'page-1', 'pre_tool', {
        tool: writeTool('src/api/billing.ts', 'x'),
      }),
    );
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('strict mode');
    expect(denied.reason).toContain('src/api/billing.ts (part "Part api", claude-code)');
    const deniedCased = await mindly.hooks.handle(
      event(pageWt, 'claude-code', 'page-1', 'pre_tool', { tool: writeTool('src/API/a.ts', 'x') }),
    );
    expect(deniedCased.decision).toBe('deny');
    expect(deniedCased.reason).toContain('src/API/a.ts (part "Part api", claude-code)');
    const ok = await mindly.hooks.handle(
      event(pageWt, 'claude-code', 'page-1', 'pre_tool', {
        tool: writeTool('src/app/page.ts', 'x'),
      }),
    );
    expect(ok.decision ?? null).toBeNull();
  });

  it("guards shell commands that may write another part's files", async () => {
    const { mindly, svc, pid } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const apiWt = created.parts[0]!.worktree;
    await mindly.hooks.handle(event(apiWt, 'claude-code', 'api-1', 'session_start'));
    const shell = (command: string) =>
      mindly.hooks.handle(
        event(apiWt, 'claude-code', 'api-1', 'pre_tool', { tool: shellTool(command) }),
      );
    const read = await shell('cat src/app/page.ts | grep page');
    expect(read.decision ?? null).toBeNull();
    expect(read.context ?? '').not.toContain('owned by part');
    for (const command of ['sed -i "" s/a/b/ src/app/page.ts', 'cat tpl > src/app/page.ts']) {
      const r = await shell(command);
      expect(r.decision ?? null).toBeNull();
      expect(r.context).toContain('src/app/page.ts is owned by part "Part page"');
    }
    const own = await shell('echo x > src/api/new.ts');
    expect(own.context ?? '').not.toContain('owned by part');
  });

  it('keeps other decisions untouched, shows the contract as it is now and archives it on abort', async () => {
    const { mindly, svc, pid, root } = await setup();
    const before = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'GET /billing',
      body: 'the old one',
      tags: [],
      source: USER,
      trust: 'approved',
      reason: 'test',
    });
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const id = created.split.contract[0]!.memoryId as string;
    expect(id).not.toBe(before.id);
    expect(mindly.store.memories.get(before.id)).toMatchObject({ body: 'the old one', version: 1 });
    expect(mindly.store.memories.get(id)).toMatchObject({
      title: '[split billing] GET /billing',
      body: 'returns { plan }',
    });
    expect(svc.contract(created.split)).toEqual([
      { name: 'GET /billing', owner: 'api', definition: 'returns { plan }', memoryId: id },
    ]);
    // The user edits the decision: status and later briefs show the new text.
    mindly.memory.update(id, { body: 'returns { plan, id }' }, USER, 'edited');
    expect((await svc.status(created.split.id)).contract[0]!.definition).toBe(
      'returns { plan, id }',
    );
    const page = await mindly.hooks.handle(
      event(created.parts[1]!.worktree, 'claude-code', 'page-1', 'session_start'),
    );
    expect(page.context).toContain('GET /billing \u2014 returns { plan, id }');
    // A rejected item is no longer part of the contract.
    mindly.memory.reject(id);
    expect((await svc.status(created.split.id)).contract).toEqual([]);
    // A second split with the same name cannot reuse the title; abort archives the decision.
    await svc.abort(created.split.id);
    expect(mindly.store.memories.get(id).status).toBe('archived');
    expect(mindly.store.memories.get(before.id)).toMatchObject({
      status: 'active',
      body: 'the old one',
    });
  });

  it('tells dependants when a contract decision changes', async () => {
    const { mindly, svc, pid } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    await mindly.hooks.handle(
      event(created.parts[0]!.worktree, 'claude-code', 'api-1', 'session_start'),
    );
    await mindly.hooks.handle(
      event(created.parts[1]!.worktree, 'claude-code', 'page-1', 'session_start'),
    );
    const memoryId = created.split.contract[0]!.memoryId as string;
    mindly.memory.update(
      memoryId,
      { body: 'returns { plan, status, renewsAt }' },
      USER,
      'contract change',
    );
    const page = mindly.store.sessions.findByExternal(pid, 'claude-code', 'page-1')!;
    const api = mindly.store.sessions.findByExternal(pid, 'claude-code', 'api-1')!;
    const deliveries = mindly.store.deliveries.list(pid).filter((d) => d.kind === 'impact');
    expect(deliveries.map((d) => d.targetSessionId)).toEqual([page.id]);
    expect(deliveries[0]!.title).toBe('Contract item "GET /billing" of the split changed');
    expect(deliveries[0]!.targetSessionId).not.toBe(api.id);
    const next = await mindly.hooks.handle(
      event(page.worktree, 'claude-code', 'page-1', 'prompt', { prompt: 'continue' }),
    );
    expect(next.context).toContain('Contract item "GET /billing" of the split changed');
    expect(next.context).toContain('renewsAt');
    expect(next.context).toContain('your part depends on it');
    // The same version is not announced twice; an unrelated decision is ignored.
    mindly.memory.update(memoryId, { tags: ['split'] }, USER, 'retag');
    mindly.memory.remember({
      projectId: pid,
      projectRoot: created.split.worktreeRoot,
      kind: 'decision',
      title: 'Other',
      body: 'b',
      source: USER,
      trust: 'approved',
    });
    expect(
      mindly.store.deliveries.list(pid).filter((d) => d.kind === 'impact').length,
    ).toBeLessThanOrEqual(2);
  });

  it('reports status, merge-checks the parts as one set, merges in order and aborts cleanly', async () => {
    const { mindly, svc, pid, fake, worktreeRoot } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    await mindly.hooks.handle(event(api.worktree, 'claude-code', 'api-1', 'session_start'));
    await mindly.hooks.handle(event(page.worktree, 'claude-code', 'page-1', 'session_start'));
    fake.changed.set(api.worktree, ['src/api/billing.ts']);
    const apiSession = mindly.store.sessions.findByExternal(pid, 'claude-code', 'api-1')!;
    const pageSession = mindly.store.sessions.findByExternal(pid, 'claude-code', 'page-1')!;

    let status = await svc.status(created.split.id);
    expect(status.parts.map((p) => p.filesChanged)).toEqual([['src/api/billing.ts'], []]);
    expect(status.mergeCheck).toBeNull();

    // Not done yet: merge refuses unless forced.
    await expect(svc.merge(created.split.id)).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict') && /2 parts are not done yet/.test((e as Error).message),
    );
    // A conflicting merge check stops the merge and opens merge conflicts on the parts' sessions.
    fake.setMergeCheck({
      supported: true,
      clean: false,
      merged: ['api'],
      conflicts: [{ label: 'page', paths: ['src/shared.ts'] }],
      commit: null,
    });
    await expect(svc.merge(created.split.id, { force: true })).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') && /conflicts in src\/shared\.ts/.test((e as Error).message),
    );
    status = await svc.status(created.split.id);
    expect(status.split.status).toBe('active');
    expect(status.mergeCheck?.status).toBe('failed');
    expect(status.mergeCheck?.input['splitId']).toBe(created.split.id);
    expect((status.mergeCheck?.result as { conflictedPaths: string[] }).conflictedPaths).toEqual([
      'src/shared.ts',
    ]);
    const open = mindly.store.conflicts.list(pid).filter((c) => c.kind === 'merge_conflict');
    expect(open).toHaveLength(1);
    expect(open[0]!.sessionIds.sort()).toEqual([apiSession.id, pageSession.id].sort());
    expect(status.parts[1]!.conflicts).toHaveLength(1);
    expect(fake.calls.mergeBranches).toHaveLength(0);

    // Clean again: the stale conflict is resolved and the merge goes through in dependency order.
    fake.setMergeCheck(null);
    mindly.tasks.update(api.taskId, { status: 'done' }, null);
    mindly.tasks.update(page.taskId, { status: 'done' }, null);
    const merged = await svc.merge(created.split.id);
    expect(merged.branch).toBe('mindly/billing/integration');
    expect(merged.commit).toBe('merge0001');
    expect(merged.merged).toEqual(['api', 'page']);
    expect(merged.checksSkipped).toBe('none_configured');
    expect(fake.calls.mergeBranches).toEqual([
      {
        into: 'mindly/billing/integration',
        sources: [
          { label: 'api', branch: 'mindly/billing/api' },
          { label: 'page', branch: 'mindly/billing/page' },
        ],
      },
    ]);
    expect(
      mindly.store.conflicts
        .list(pid, { statuses: ['open'] })
        .filter((c) => c.kind === 'merge_conflict'),
    ).toHaveLength(0);
    expect(mindly.store.splits.get(created.split.id)).toMatchObject({
      status: 'merged',
      integrationBranch: 'mindly/billing/integration',
    });
    expect(mindly.store.tasks.get(created.task.id).status).toBe('done');
    expect(mindly.store.events.query(pid, { types: ['split.merged'] })).toHaveLength(1);
    await expect(svc.merge(created.split.id)).rejects.toSatisfy((e) =>
      isMindlyError(e, 'conflict'),
    );

    // Abort removes the worktrees and branches the split created, and only those.
    fake.branches.add('keep-me');
    const aborted = await svc.abort(created.split.id);
    expect(aborted.removedWorktrees.sort()).toEqual([api.worktree, page.worktree].sort());
    expect(aborted.deletedBranches.sort()).toEqual(['mindly/billing/api', 'mindly/billing/page']);
    expect([...fake.branches].sort()).toEqual(['keep-me', 'mindly/billing/integration']);
    expect(existsSync(worktreeRoot)).toBe(false);
    // Cleaning up after a merge does not turn the split into an aborted one.
    expect(mindly.store.splits.get(created.split.id).status).toBe('merged');
    expect(mindly.store.splits.partForWorktree(pid, api.worktree)).toBeNull();
    await expect(svc.abort(created.split.id)).rejects.toSatisfy((e) =>
      isMindlyError(e, 'conflict'),
    );
  });

  it('does not merge past work that is only in a worktree, and does not delete it after a merge', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    mindly.tasks.update(api.taskId, { status: 'done' }, null);
    // The page part's work was never committed on its branch.
    fake.changed.set(page.worktree, ['src/app/billing.ts']);
    fake.uncommitted.set(page.worktree, ['src/app/billing.ts']);
    const status = await svc.status(created.split.id);
    expect(status.parts.map((p) => p.uncommitted)).toEqual([[], ['src/app/billing.ts']]);
    expect(await svc.unmergedWork(created.split.id)).toEqual([
      { part: 'page', title: 'Part page', paths: ['src/app/billing.ts'] },
    ]);

    mindly.tasks.update(page.taskId, { status: 'done' }, null);
    await expect(svc.merge(created.split.id)).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') &&
        /a part has work that is not committed on its branch and would be left out: "Part page" \(src\/app\/billing\.ts\)/.test(
          (e as Error).message,
        ) &&
        Array.isArray((e as { details?: Record<string, unknown> }).details?.['uncommitted']),
    );
    expect(fake.calls.mergeBranches).toHaveLength(0);
    expect(mindly.store.splits.get(created.split.id).status).toBe('active');

    // Forced, the merge goes through and says what it left out.
    mindly.tasks.update(page.taskId, { status: 'in_progress' }, null);
    const merged = await svc.merge(created.split.id, { force: true });
    expect(merged.leftBehind).toEqual([
      { part: 'page', title: 'Part page', paths: ['src/app/billing.ts'] },
    ]);

    // Cleaning up after the merge would delete that work: it has to be asked for.
    await expect(svc.abort(created.split.id)).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') &&
        /hold work no other branch has: "Part page" \(not committed: src\/app\/billing\.ts\)/.test(
          (e as Error).message,
        ),
    );
    expect(existsSync(page.worktree)).toBe(true);
    const aborted = await svc.abort(created.split.id, { discardUncommitted: true });
    expect(aborted.discarded.map((w) => w.part)).toEqual(['page']);
    expect(existsSync(page.worktree)).toBe(false);
    // The unfinished part was merged with the others, not abandoned.
    expect(mindly.store.tasks.get(page.taskId).status).toBe('done');
    expect(mindly.store.splits.get(created.split.id).status).toBe('merged');
  });

  it('does not delete commits a part made on its branch after the merge', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    // The page part keeps working and commits on its branch: the merged branch does not have it.
    const late = { commit: 'late0001late0001', subject: 'Add the late page' };
    fake.onlyOn.set(page.branch, [late]);
    const status = await svc.status(created.split.id);
    expect(status.parts.map((p) => p.unmergedCommits)).toEqual([
      [],
      ['late0001late Add the late page'],
    ]);
    expect(status.parts.map((p) => p.uncommitted)).toEqual([[], []]);
    expect(await svc.abortLoses(created.split.id)).toEqual([
      { part: 'page', title: 'Part page', paths: [], commits: ['late0001late Add the late page'] },
    ]);
    expect(await svc.abortLoses(created.split.id, { keepBranches: true })).toEqual([]);

    await expect(svc.abort(created.split.id)).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') &&
        /hold work no other branch has: "Part page" \(1 commit only on its branch: late0001late Add the late page\)/.test(
          (e as Error).message,
        ),
    );
    expect(fake.branches.has(page.branch)).toBe(true);
    expect(existsSync(page.worktree)).toBe(true);
    expect(existsSync(api.worktree)).toBe(true);

    // Keeping the branches keeps the commits: nothing is lost.
    const kept = await svc.abort(created.split.id, { keepBranches: true });
    expect(kept.discarded).toEqual([]);
    expect(kept.keptBranches).toEqual([api.branch, page.branch]);
    expect(fake.branches.has(page.branch)).toBe(true);
  });

  it('deletes commits after a merge only when asked to', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const page = created.parts[1]!;
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    fake.onlyOn.set(page.branch, [{ commit: 'late0001late0001', subject: 'Add the late page' }]);
    const aborted = await svc.abort(created.split.id, { discardUncommitted: true });
    expect(aborted.discarded).toEqual([
      { part: 'page', title: 'Part page', paths: [], commits: ['late0001late Add the late page'] },
    ]);
    expect(fake.branches.has(page.branch)).toBe(false);
  });

  it('removes nothing when it cannot tell what an abort would delete', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    fake.port.branchOnlyWork = async () => {
      throw new MindlyError('timeout', 'git timed out');
    };
    await expect(svc.abort(created.split.id)).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'unavailable') &&
        /nothing was removed: git timed out/.test((e as Error).message),
    );
    for (const p of created.parts) {
      expect(existsSync(p.worktree)).toBe(true);
      expect(fake.branches.has(p.branch)).toBe(true);
    }
    // Discarding is an explicit choice to delete whatever is there.
    const aborted = await svc.abort(created.split.id, { discardUncommitted: true });
    expect(aborted.removedWorktrees).toHaveLength(2);
    expect(aborted.discarded).toEqual([]);
  });

  it('deletes only the work a confirmation covered, with or without a discard', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    const first = { commit: 'late0001late0001', subject: 'First late page' };
    fake.onlyOn.set(page.branch, [first]);
    const shown = await svc.abortCheck(created.split.id);
    // Another commit lands while the question is open: the "yes" does not cover it, even with
    // a discard.
    fake.onlyOn.set(page.branch, [{ commit: 'late0002late0002', subject: 'Second' }, first]);
    for (const discardUncommitted of [false, true]) {
      await expect(
        svc.abort(created.split.id, { confirmed: shown, discardUncommitted }),
      ).rejects.toSatisfy(
        (e) =>
          isMindlyError(e, 'conflict') &&
          /not shown when the abort was confirmed, or that cannot be checked: "Part page" \(2 commits only on its branch: late0002late Second, late0001late First late page\)/.test(
            (e as Error).message,
          ) &&
          (e as { details?: Record<string, unknown> }).details?.['appeared'] === true,
      );
    }
    expect(fake.branches.has(page.branch)).toBe(true);
    expect(existsSync(api.worktree)).toBe(true);

    // A listed file that is edited after the question is not covered either.
    fake.uncommitted.set(page.worktree, ['src/app/wip.ts']);
    mkdirSync(join(page.worktree, 'src', 'app'), { recursive: true });
    writeFileSync(join(page.worktree, 'src', 'app', 'wip.ts'), 'one\n');
    const withFile = await svc.abortCheck(created.split.id);
    writeFileSync(join(page.worktree, 'src', 'app', 'wip.ts'), 'two\n');
    await expect(svc.abort(created.split.id, { confirmed: withFile })).rejects.toSatisfy((e) =>
      isMindlyError(e, 'conflict'),
    );
    fake.uncommitted.delete(page.worktree);

    // More than can be listed is never covered by a "yes"; only a discard without one goes on.
    const branchOnlyWork = fake.port.branchOnlyWork;
    fake.port.branchOnlyWork = async (root, b, o) => ({
      ...(await branchOnlyWork(root, b, o)),
      more: b === page.branch,
    });
    const tooMany = await svc.abortCheck(created.split.id);
    expect(tooMany.work[0]?.more).toBe(true);
    await expect(svc.abort(created.split.id, { confirmed: tooMany })).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') && /and more than can be listed/.test((e as Error).message),
    );
    fake.port.branchOnlyWork = branchOnlyWork;

    // Confirmed as it is now, the abort goes ahead. A commit made after the check keeps the
    // branch and its worktree, and the split stays as it was so that the abort can be run again.
    const now = await svc.abortCheck(created.split.id);
    const removeWorktree = fake.port.removeWorktree;
    fake.port.removeWorktree = async (root, path) => {
      if (path === api.worktree) {
        fake.onlyOn.set(page.branch, [
          { commit: 'late0003late0003', subject: 'Third' },
          ...(fake.onlyOn.get(page.branch) ?? []),
        ]);
      }
      return removeWorktree(root, path);
    };
    const aborted = await svc.abort(created.split.id, { confirmed: now });
    fake.port.removeWorktree = removeWorktree;
    expect(aborted.finished).toBe(false);
    expect(aborted.removedWorktrees).toEqual([api.worktree]);
    expect(aborted.keptWorktrees).toEqual([page.worktree]);
    expect(aborted.deletedBranches).toEqual([api.branch]);
    expect(aborted.keptBranches).toEqual([page.branch]);
    expect(aborted.discarded).toEqual([]);
    expect(fake.branches.has(page.branch)).toBe(true);
    expect((await svc.status(created.split.id)).abortPending).toBe(true);
    // Run again: the new commit is listed, confirmed and removed.
    const again = await svc.abortCheck(created.split.id);
    expect(again.work.map((w) => w.commits?.[0])).toEqual(['late0003late Third']);
    const done = await svc.abort(created.split.id, { confirmed: again });
    expect(done.finished).toBe(true);
    expect(done.removedWorktrees).toEqual([page.worktree]);
    expect(done.deletedBranches).toEqual([page.branch]);
    expect((await svc.status(created.split.id)).abortPending).toBe(false);
  });

  it('finishes an abort left unfinished by a commit, keeping the branch or once it is gone', async () => {
    for (const how of ['keep-branches', 'deleted-by-hand'] as const) {
      const { mindly, svc, pid, fake } = await setup();
      const created = await svc.create({
        projectId: pid,
        plan: PLAN,
        slug: 'billing',
        plannedBy: 'plan-file',
        connectedAgents: null,
      });
      const page = created.parts[1]!;
      await mindly.hooks.handle(event(page.worktree, 'claude-code', 'page-1', 'session_start'));
      for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
      await svc.merge(created.split.id);
      // The page agent commits right as its worktree is removed: the branch is kept.
      const removeWorktree = fake.port.removeWorktree;
      fake.port.removeWorktree = async (root, path) => {
        if (path === page.worktree) {
          fake.onlyOn.set(page.branch, [{ commit: 'late0001late0001', subject: 'Late' }]);
        }
        return removeWorktree(root, path);
      };
      const first = await svc.abort(created.split.id);
      fake.port.removeWorktree = removeWorktree;
      expect(first.finished).toBe(false);
      expect(first.removedWorktrees).toEqual([created.parts[0]!.worktree, page.worktree]);
      expect(first.keptBranches).toEqual([page.branch]);
      expect(fake.branches.has(page.branch)).toBe(true);
      // Plain abort refuses: the commit is only on that branch.
      await expect(svc.abort(created.split.id)).rejects.toSatisfy((e) =>
        isMindlyError(e, 'conflict'),
      );
      if (how === 'deleted-by-hand') fake.branches.delete(page.branch);
      const second = await svc.abort(created.split.id, {
        keepBranches: how === 'keep-branches',
      });
      expect(second.finished).toBe(true);
      expect(fake.branches.has(page.branch)).toBe(how === 'keep-branches');
      expect(svc.abortPending(mindly.store.splits.get(created.split.id))).toBe(false);
      // Done: nothing is left to finish.
      if (how === 'deleted-by-hand') {
        await expect(svc.abort(created.split.id)).rejects.toSatisfy(
          (e) => isMindlyError(e, 'conflict') && /already gone/.test((e as Error).message),
        );
      }
    }
  });

  it('keeps a worktree that gets new files during the abort, and lets the abort finish later', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    await mindly.hooks.handle(event(page.worktree, 'claude-code', 'page-1', 'session_start'));
    // Before a merge, confirmed on the terminal: nothing was listed.
    const shown = await svc.abortCheck(created.split.id);
    const removeWorktree = fake.port.removeWorktree;
    fake.port.removeWorktree = async (root, path) => {
      // While the api worktree is removed, the page agent writes a new file.
      if (path === api.worktree) fake.uncommitted.set(page.worktree, ['src/app/late.ts']);
      return removeWorktree(root, path);
    };
    const aborted = await svc.abort(created.split.id, { confirmed: shown });
    fake.port.removeWorktree = removeWorktree;
    expect(aborted.finished).toBe(false);
    expect(aborted.removedWorktrees).toEqual([api.worktree]);
    expect(aborted.keptWorktrees).toEqual([page.worktree]);
    expect(aborted.keptBranches).toEqual([page.branch]);
    expect(existsSync(page.worktree)).toBe(true);
    expect(fake.branches.has(page.branch)).toBe(true);
    // The split and the part that kept its work are left as they were.
    expect(mindly.store.splits.get(created.split.id).status).toBe('active');
    expect(mindly.store.tasks.get(page.taskId).status).not.toBe('abandoned');
    expect(mindly.store.tasks.get(api.taskId).status).toBe('abandoned');
    expect(mindly.store.splits.partForWorktree(pid, page.worktree)?.key).toBe('page');
    // Only finishing the abort is left: a merge is refused, status says so.
    expect((await svc.status(created.split.id)).abortPending).toBe(true);
    await expect(svc.merge(created.split.id, { force: true })).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict') && /did not finish/.test((e as Error).message),
    );

    // The abort can be run again to finish.
    fake.uncommitted.delete(page.worktree);
    const second = await svc.abort(created.split.id, { discardUncommitted: true });
    expect(second.finished).toBe(true);
    expect(existsSync(page.worktree)).toBe(false);
    expect(fake.branches.has(page.branch)).toBe(false);
    expect(mindly.store.splits.get(created.split.id).status).toBe('aborted');
    expect(mindly.store.tasks.get(page.taskId).status).toBe('abandoned');
  });

  it('keeps a worktree that gets new files while a merged split is cleaned up', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    const removeWorktree = fake.port.removeWorktree;
    fake.port.removeWorktree = async (root, path) => {
      if (path === api.worktree) fake.uncommitted.set(page.worktree, ['src/app/late.ts']);
      return removeWorktree(root, path);
    };
    const aborted = await svc.abort(created.split.id);
    fake.port.removeWorktree = removeWorktree;
    expect(aborted.finished).toBe(false);
    expect(aborted.removedWorktrees).toEqual([api.worktree]);
    expect(aborted.keptWorktrees).toEqual([page.worktree]);
    expect(aborted.keptBranches).toEqual([page.branch]);
    expect(existsSync(page.worktree)).toBe(true);
    expect(fake.branches.has(page.branch)).toBe(true);
    // Its work is listed by the next abort, which refuses until it is dealt with.
    await expect(svc.abort(created.split.id)).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict') && /src\/app\/late\.ts/.test((e as Error).message),
    );
    fake.uncommitted.delete(page.worktree);
    expect((await svc.abort(created.split.id)).finished).toBe(true);
    expect(existsSync(page.worktree)).toBe(false);
  });

  it('refuses after a squash merge, and keeping the branches cleans up without losing anything', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    // The merged branch was squash-merged into main and deleted: main has the changes, but the
    // part commits are on no other branch.
    fake.branches.delete('mindly/billing/integration');
    fake.onlyOn.set(page.branch, [{ commit: 'page0001page0001', subject: 'Page' }]);
    expect((await svc.status(created.split.id)).parts[1]!.unmergedCommits).toEqual([
      'page0001page Page',
    ]);
    await expect(svc.abort(created.split.id)).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') &&
        /hold work no other branch has: "Part page" \(1 commit only on its branch: page0001page Page\)\. Commits only on the part branches are expected after a squash or rebase merge/.test(
          (e as Error).message,
        ) &&
        (e as { details?: Record<string, unknown> }).details?.['commits'] === true,
    );
    expect(existsSync(page.worktree)).toBe(true);
    const kept = await svc.abort(created.split.id, { keepBranches: true });
    expect(kept.finished).toBe(true);
    expect(kept.removedWorktrees).toEqual([api.worktree, page.worktree]);
    expect(kept.keptBranches).toEqual([api.branch, page.branch]);
    expect(kept.discarded).toEqual([]);
    expect(fake.branches.has(page.branch)).toBe(true);
  });

  it('does not brief a session in a part worktree once the split is merged', async () => {
    const { mindly, svc, pid } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const api = created.parts[0]!;
    await mindly.hooks.handle(event(api.worktree, 'claude-code', 'api-1', 'session_start'));
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    const next = await mindly.hooks.handle(
      event(api.worktree, 'claude-code', 'api-2', 'session_start'),
    );
    expect(next.context ?? '').not.toContain('Your part of the split');
    expect(next.context ?? '').not.toContain('Commit your work in this worktree');
  });

  it('refuses before a merge too, and reports what a discard removes', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    fake.uncommitted.set(api.worktree, ['src/api/a.ts', 'src/api/b.ts']);
    fake.onlyOn.set(page.branch, [{ commit: 'page0001page0001', subject: 'Page' }]);
    await expect(svc.abort(created.split.id)).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') &&
        /hold work no other branch has: "Part api" \(not committed: src\/api\/a\.ts, src\/api\/b\.ts\); "Part page" \(1 commit only on its branch: page0001page Page\)$/.test(
          (e as Error).message,
        ),
    );
    // Keeping the branches keeps the commits; the uncommitted files still stop it.
    await expect(svc.abort(created.split.id, { keepBranches: true })).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict') && !/Part page/.test((e as Error).message),
    );
    expect(mindly.store.splits.get(created.split.id).status).toBe('active');
    fake.uncommitted.delete(api.worktree);
    const kept = await svc.abort(created.split.id, { keepBranches: true });
    expect(kept.finished).toBe(true);
    expect(fake.branches.has(page.branch)).toBe(true);
  });

  it('counts deny-listed files as work, by name and without reading them', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const page = created.parts[1]!;
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    // An untracked `.env.example` (left out of every capture) and an ignored local `.env`.
    mkdirSync(join(page.worktree, 'src', 'app'), { recursive: true });
    writeFileSync(join(page.worktree, 'src', 'app', '.env.example'), 'STRIPE_KEY=\n');
    writeFileSync(join(page.worktree, '.env'), 'STRIPE_KEY=sk_live_1\n');
    fake.uncommitted.set(page.worktree, ['src/app/.env.example']);
    fake.denied.add('src/app/.env.example').add('.env');
    fake.ignoredDenied.set(page.worktree, ['.env']);
    expect((await svc.status(created.split.id)).parts[1]!.uncommitted).toEqual([
      'src/app/.env.example',
    ]);
    const shown = await svc.abortCheck(created.split.id);
    expect(shown.work).toEqual([
      { part: 'page', title: 'Part page', paths: ['.env', 'src/app/.env.example'] },
    ]);
    await expect(svc.abort(created.split.id)).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') &&
        /\.env, src\/app\/\.env\.example/.test((e as Error).message),
    );
    // A change to a deny-listed file is seen by its size and time.
    writeFileSync(join(page.worktree, '.env'), 'STRIPE_KEY=sk_live_22\n');
    await expect(svc.abort(created.split.id, { confirmed: shown })).rejects.toSatisfy((e) =>
      isMindlyError(e, 'conflict'),
    );
    expect(existsSync(join(page.worktree, '.env'))).toBe(true);
    const now = await svc.abortCheck(created.split.id);
    expect((await svc.abort(created.split.id, { confirmed: now })).finished).toBe(true);
    expect(existsSync(page.worktree)).toBe(false);
  });

  it('never lets a yes cover a nested repository, whose content cannot be checked', async () => {
    const { svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const page = created.parts[1]!;
    mkdirSync(join(page.worktree, 'src', 'app', 'vendor'), { recursive: true });
    fake.uncommitted.set(page.worktree, ['src/app/vendor']);
    const shown = await svc.abortCheck(created.split.id);
    expect(shown.work).toEqual([
      { part: 'page', title: 'Part page', paths: ['src/app/vendor'], opaque: ['src/app/vendor'] },
    ]);
    await expect(svc.abort(created.split.id, { confirmed: shown })).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') &&
        /folders whose content cannot be checked: src\/app\/vendor/.test((e as Error).message),
    );
    expect(existsSync(join(page.worktree, 'src', 'app', 'vendor'))).toBe(true);
    const aborted = await svc.abort(created.split.id, { discardUncommitted: true });
    expect(aborted.finished).toBe(true);
    expect(existsSync(page.worktree)).toBe(false);
  });

  it('leaves the last word to git: a worktree it will not remove is kept, and the abort stays pending', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    await svc.merge(created.split.id);
    // Work the listing cannot see (edits inside a submodule): git refuses to remove it.
    const forced: boolean[] = [];
    const removeWorktree = fake.port.removeWorktree;
    fake.port.removeWorktree = async (root, path, options) => {
      forced.push(options?.force !== false);
      if (path === page.worktree && options?.force === false) {
        throw new MindlyError('conflict', 'git did not remove the worktree', {
          details: {
            refused: true,
            reason: 'working trees containing submodules cannot be moved or removed',
          },
        });
      }
      return removeWorktree(root, path, options);
    };
    const aborted = await svc.abort(created.split.id);
    expect(forced).toEqual([false, false]);
    expect(aborted.finished).toBe(false);
    expect(aborted.removedWorktrees).toEqual([api.worktree]);
    expect(aborted.keptWorktrees).toEqual([page.worktree]);
    expect(aborted.keptBranches).toEqual([page.branch]);
    expect(aborted.keptBecause[page.worktree]).toMatch(/submodules/);
    expect(existsSync(page.worktree)).toBe(true);
    expect(fake.branches.has(page.branch)).toBe(true);
    expect(svc.abortPending(mindly.store.splits.get(created.split.id))).toBe(true);
    // The pending state does not depend on the event log.
    mindly.store.db.prepare("DELETE FROM events WHERE type = 'split.aborted'").run();
    expect(svc.abortPending(mindly.store.splits.get(created.split.id))).toBe(true);
    // Only a discard that was not asked about forces it.
    forced.length = 0;
    const done = await svc.abort(created.split.id, { discardUncommitted: true });
    fake.port.removeWorktree = removeWorktree;
    expect(forced).toEqual([true, true]);
    expect(done.finished).toBe(true);
    expect(existsSync(page.worktree)).toBe(false);
    expect(svc.abortPending(mindly.store.splits.get(created.split.id))).toBe(false);
  });

  it('deletes exactly the confirmed files, as they still are, and leaves the rest to git', async () => {
    const run = async (edit?: (page: string) => void) => {
      const { svc, pid, fake } = await setup();
      const created = await svc.create({
        projectId: pid,
        plan: PLAN,
        slug: 'billing',
        plannedBy: 'plan-file',
        connectedAgents: null,
      });
      const page = (created.parts as { worktree: string }[])[1] as { worktree: string };
      mkdirSync(join(page.worktree, 'src', 'app'), { recursive: true });
      writeFileSync(join(page.worktree, 'src', 'app', 'wip.ts'), 'wip\n');
      writeFileSync(join(page.worktree, 'src', 'app', 'old.ts'), 'old\n');
      fake.uncommitted.set(page.worktree, ['src/app/old.ts', 'src/app/wip.ts']);
      const forced: boolean[] = [];
      const removeWorktree = fake.port.removeWorktree;
      fake.port.removeWorktree = async (root, path, options) => {
        forced.push(options?.force !== false);
        return removeWorktree(root, path, options);
      };
      // The page's branch is looked at by the listing, by abort's own check, then once more right
      // before its files go: an edit made then is caught file by file.
      let looks = 0;
      const branchOnlyWork = fake.port.branchOnlyWork;
      fake.port.branchOnlyWork = async (root, branch, options) => {
        if (branch.endsWith('/page') && ++looks === 3) edit?.(page.worktree);
        return branchOnlyWork(root, branch, options);
      };
      const confirmed = await svc.abortCheck(created.split.id);
      const aborted = await svc.abort(created.split.id, { confirmed });
      return { aborted, forced, restored: fake.calls.restored, page: page.worktree };
    };
    // As confirmed: the listed files are deleted and put back to the commit, then git removes the
    // worktree without being overruled.
    const ok = await run();
    expect(ok.aborted.finished).toBe(true);
    expect(ok.forced).toEqual([false, false]);
    expect(ok.restored).toEqual([
      { worktree: ok.page, paths: ['src/app/old.ts', 'src/app/wip.ts'] },
    ]);
    // A listed file edited after the confirmation is kept, and so is the worktree.
    const edited = await run((wt) => writeFileSync(join(wt, 'src', 'app', 'wip.ts'), 'more\n'));
    expect(edited.aborted.finished).toBe(false);
    expect(edited.aborted.keptWorktrees).toEqual([edited.page]);
    expect(edited.aborted.keptBecause[edited.page]).toBe(
      'a file it listed changed after the abort was confirmed: src/app/wip.ts',
    );
    expect(edited.restored).toEqual([]);
    expect(edited.forced).toEqual([false]);
    expect(readFileSync(join(edited.page, 'src', 'app', 'wip.ts'), 'utf8')).toBe('more\n');
  });

  it('moves nested repositories out before a worktree goes, and keeps it when it cannot', async () => {
    const { svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    fake.nestedRepos.set(api.worktree, ['vendor/lib']);
    fake.cannotMove.set(page.worktree, { path: 'deps/x', reason: 'EXDEV: cross-device link' });
    // Nothing to confirm: moving a repository loses nothing.
    expect((await svc.abortCheck(created.split.id)).work).toEqual([]);
    const first = await svc.abort(created.split.id);
    expect(first.keptRepos).toEqual([
      {
        part: 'api',
        path: 'vendor/lib',
        to: expect.stringMatching(new RegExp(`/mindly/kept/${created.split.id}/api/vendor/lib$`)),
      },
    ]);
    expect(first.removedWorktrees).toEqual([api.worktree]);
    expect(first.finished).toBe(false);
    expect(first.keptBecause[page.worktree]).toBe(
      'could not move the git repository deps/x out of it: EXDEV: cross-device link',
    );
    expect(existsSync(page.worktree)).toBe(true);
    fake.cannotMove.delete(page.worktree);
    expect((await svc.abort(created.split.id)).finished).toBe(true);
  });

  it('moves no repository on a discard: everything goes', async () => {
    const { svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const page = (created.parts as { worktree: string }[])[1] as { worktree: string };
    fake.nestedRepos.set(page.worktree, ['vendor/lib']);
    const aborted = await svc.abort(created.split.id, { discardUncommitted: true });
    expect(aborted.keptRepos).toEqual([]);
    expect(aborted.finished).toBe(true);
  });

  it('keeps a worktree that got work its listing counts after the last look at it', async () => {
    const { svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const page = (created.parts as { worktree: string }[])[1] as { worktree: string };
    fake.stray.set(page.worktree, ['.env.local']);
    const aborted = await svc.abort(created.split.id);
    expect(aborted.finished).toBe(false);
    expect(aborted.keptBecause[page.worktree]).toBe(
      'it got new work while the abort ran: .env.local',
    );
    expect(existsSync(page.worktree)).toBe(true);
    fake.stray.delete(page.worktree);
    expect((await svc.abort(created.split.id)).finished).toBe(true);
  });

  it("never reads the project's ignored files, and counts ignored ones only when they are secrets", async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const byId = mindly.projects.byId.bind(mindly.projects);
    vi.spyOn(mindly.projects, 'byId').mockImplementation((id) => {
      const ctx = byId(id);
      return { ...ctx, config: { ...ctx.config, ignore: ['coverage/**', '**/*.log'] } };
    });
    const calls: { extraDeny: readonly string[]; secretDeny: readonly string[] }[] = [];
    const uncommittedWork = fake.port.uncommittedWork;
    fake.port.uncommittedWork = async (root, wt, branch, extraDeny, secretDeny) => {
      calls.push({ extraDeny, secretDeny });
      return uncommittedWork(root, wt, branch, extraDeny, secretDeny);
    };
    await svc.abortCheck(created.split.id);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.extraDeny).toEqual(expect.arrayContaining(['coverage/**', '**/*.log']));
      expect(c.secretDeny).not.toContain('coverage/**');
      expect(c.secretDeny).toEqual(mindly.kernel.config.redaction.denyPaths);
    }
  });

  it('keeps going past a part git fails on, and records it', async () => {
    const { svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [api, page] = created.parts as [
      (typeof created.parts)[number],
      (typeof created.parts)[number],
    ];
    const removeWorktree = fake.port.removeWorktree;
    fake.port.removeWorktree = async (root, path, options) => {
      if (path === api.worktree) throw new MindlyError('internal', 'git worktree failed');
      if (path === page.worktree) {
        throw new MindlyError('conflict', 'git did not remove the worktree', {
          details: { refused: true, locked: true, reason: 'locked' },
        });
      }
      return removeWorktree(root, path, options);
    };
    const aborted = await svc.abort(created.split.id);
    expect(aborted.finished).toBe(false);
    expect(aborted.keptWorktrees).toEqual([api.worktree, page.worktree]);
    expect(aborted.keptBecause[api.worktree]).toMatch(
      /git could not remove it: git worktree failed/,
    );
    expect(aborted.keptBecause[page.worktree]).toBe(
      `it is locked; run git worktree unlock ${page.worktree}, or remove it anyway: mindly split abort --yes --discard`,
    );
    fake.port.removeWorktree = removeWorktree;
    expect((await svc.abort(created.split.id)).finished).toBe(true);
  });

  it('reads an unfinished abort recorded only as an event, once', async () => {
    const { mindly, svc, pid } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    mindly.store.events.append({
      projectId: pid,
      sessionId: null,
      type: 'split.aborted',
      payload: { splitId: created.split.id, finished: false, unfinished: ['page'] },
    });
    const split = mindly.store.splits.get(created.split.id);
    expect(svc.abortPending(split)).toBe(true);
    expect(mindly.store.kv.get(`split.abortPending:${split.id}`)).toEqual(['page']);
    mindly.store.db.prepare("DELETE FROM events WHERE type = 'split.aborted'").run();
    expect(svc.abortPending(split)).toBe(true);
    expect((await svc.abort(created.split.id)).finished).toBe(true);
    expect(mindly.store.kv.get(`split.abortPending:${split.id}`)).toEqual([]);
  });

  it('removes everything with a discard that was not asked about', async () => {
    const { svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    fake.uncommitted.set(created.parts[0]!.worktree, ['src/api/a.ts', 'src/api/b.ts']);
    fake.onlyOn.set(created.parts[1]!.branch, [{ commit: 'page0001page0001', subject: 'Page' }]);
    const aborted = await svc.abort(created.split.id, { discardUncommitted: true });
    expect(aborted.discarded).toEqual([
      { part: 'api', title: 'Part api', paths: ['src/api/a.ts', 'src/api/b.ts'] },
      { part: 'page', title: 'Part page', paths: [], commits: ['page0001page Page'] },
    ]);
    expect(aborted.split.status).toBe('aborted');
  });

  it('briefs the next session of a part again and hands the part to it', async () => {
    const { mindly, svc, pid } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      strict: true,
      connectedAgents: null,
    });
    const api = created.parts[0]!;
    const start = (id: string, startSource: 'startup' | 'compact' | 'resume') =>
      mindly.hooks.handle(event(api.worktree, 'claude-code', id, 'session_start', { startSource }));
    expect((await start('api-1', 'startup')).context).toContain('Your part of the split');
    // The same session after its context was compacted, or resumed: it needs the brief again.
    expect((await start('api-1', 'compact')).context).toContain(
      'Files you own (edit only these): src/api/**',
    );
    expect((await start('api-1', 'resume')).context).toContain('Your part of the split');
    const first = mindly.store.sessions.findByExternal(pid, 'claude-code', 'api-1')!;
    expect(mindly.store.tasks.get(api.taskId).ownerSessionId).toBe(first.id);

    // The agent goes away: the part waits for the next one.
    await mindly.hooks.handle(event(api.worktree, 'claude-code', 'api-1', 'session_end'));
    let status = await svc.status(created.split.id);
    expect(status.parts[0]!.state).toBe('waiting');

    // A new session in the same worktree is briefed and takes the part over.
    const again = await start('api-2', 'startup');
    expect(again.context).toContain('Your part of the split');
    expect(again.context).toContain('Files you own (edit only these): src/api/**');
    expect(again.context).toContain('GET /billing');
    const second = mindly.store.sessions.findByExternal(pid, 'claude-code', 'api-2')!;
    expect(mindly.store.tasks.get(api.taskId).ownerSessionId).toBe(second.id);
    expect(mindly.store.sessions.find(second.id)?.currentTaskId).toBe(api.taskId);
    status = await svc.status(created.split.id);
    expect(status.parts[0]!.state).toBe('working');
    expect(status.parts[0]!.session?.id).toBe(second.id);

    // A second agent in the worktree of a part whose owner still runs is briefed, not the owner.
    expect((await start('api-3', 'startup')).context).toContain('Your part of the split');
    expect(mindly.store.tasks.get(api.taskId).ownerSessionId).toBe(second.id);
    // Sessions outside the part worktrees still get no brief.
    await svc.abort(created.split.id);
    expect((await start('api-4', 'startup')).context ?? '').not.toContain('Your part of the split');
  });

  it('briefs an agent that takes over a part after a usage limit', async () => {
    const { mindly, svc, pid, clock } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      strict: true,
      connectedAgents: null,
    });
    const api = created.parts[0]!;
    const first = await mindly.hooks.handle(
      event(api.worktree, 'claude-code', 'cc-1', 'session_start'),
    );
    expect(first.context).toContain('Your part of the split');
    clock.advance(1000);
    await mindly.hooks.handle(
      event(api.worktree, 'claude-code', 'cc-1', 'prompt', { prompt: 'go' }),
    );
    clock.advance(1000);
    await mindly.hooks.handle(
      event(api.worktree, 'claude-code', 'cc-1', 'stop', {
        lastMessage: 'Claude usage limit reached. Your limit will reset at 3pm.',
      }),
    );
    expect(mindly.store.handoffs.list(pid).filter((h) => h.reason === 'rate_limit')).toHaveLength(
      1,
    );
    // The agent that takes over is started in the part's worktree: it gets the handoff and the
    // part's brief, both.
    const next = await mindly.hooks.handle(event(api.worktree, 'codex', 'cx-2', 'session_start'));
    expect(next.context).toContain('Handoff for you');
    expect(next.context).toContain('Your part of the split');
    expect(next.context).toContain('Files you own (edit only these): src/api/**');
    expect(next.context).toContain('GET /billing');
    expect(next.context).toContain('Commit your work in this worktree on its branch');
    const packet = mindly.store.contextPackets.forSession(
      mindly.store.sessions.findByExternal(pid, 'codex', 'cx-2')!.id,
      1,
    )[0]!;
    expect(packet.tokensUsed).toBeLessThanOrEqual(packet.tokenBudget);
  });

  it('says which parts a merge check could not look at', async () => {
    const { svc, pid } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    rmSync(created.parts[1]!.worktree, { recursive: true, force: true });
    const run = await svc.mergeCheck(created.split.id, 'user');
    expect(run.status).toBe('passed');
    expect((run.result as { missing: string[] }).missing).toEqual(['page']);
  });

  it('finishes the merge when the checks cannot run on the merged branch', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    for (const p of created.parts) mindly.tasks.update(p.taskId, { status: 'done' }, null);
    const byId = mindly.projects.byId.bind(mindly.projects);
    vi.spyOn(mindly.projects, 'byId').mockImplementation((id) => {
      const ctx = byId(id);
      return {
        ...ctx,
        trusted: true,
        config: { ...ctx.config, checks: [{ name: 'unit', argv: ['true'], timeoutSec: 5 }] },
      };
    });
    let calls = 0;
    fake.setRunChecks(async () => {
      calls += 1;
      // The merge check runs them first; the run on the merged branch fails to start.
      if (calls > 1) throw new Error('no space left on device');
      return [{ name: 'unit', status: 'pass', exitCode: 0, durationMs: 1, output: '' }];
    });
    const merged = await svc.merge(created.split.id);
    expect(merged.checks).toBeNull();
    expect(merged.checksSkipped).toBe('error');
    expect(mindly.store.splits.get(created.split.id)).toMatchObject({
      status: 'merged',
      integrationBranch: 'mindly/billing/integration',
    });
  });

  it('abort keeps branches on request, cancels unclaimed briefs and drops open tasks', async () => {
    const { mindly, svc, pid, fake } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    await mindly.hooks.handle(
      event(created.parts[0]!.worktree, 'claude-code', 'api-1', 'session_start'),
    );
    const apiSession = mindly.store.sessions.findByExternal(pid, 'claude-code', 'api-1')!;
    const aborted = await svc.abort(created.split.id, { keepBranches: true });
    expect(aborted.keptBranches).toEqual(['mindly/billing/api', 'mindly/billing/page']);
    expect(aborted.deletedBranches).toEqual([]);
    expect(fake.branches.size).toBe(2);
    expect(
      mindly.store.handoffs
        .list(pid)
        .map((h) => h.status)
        .sort(),
    ).toEqual(['cancelled', 'claimed']);
    expect(mindly.store.tasks.get(created.parts[0]!.taskId).status).toBe('abandoned');
    expect(mindly.store.tasks.get(created.task.id).status).toBe('abandoned');
    expect(mindly.store.intents.activeForSession(apiSession.id)).toHaveLength(0);
    expect(mindly.store.events.query(pid, { types: ['split.aborted'] })).toHaveLength(1);
  });
});

describe('fileDigest', () => {
  it('hashes content in chunks, whatever the size, and the same way each time', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'syn-digest-')));
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(3 * 1024 * 1024 + 7, 1));
    const a = fileDigest(dir, 'a.bin', new Set());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fileDigest(dir, 'a.bin', new Set())).toBe(a);
    // One byte changed past the first chunk.
    const b = Buffer.alloc(3 * 1024 * 1024 + 7, 1);
    b[2 * 1024 * 1024 + 3] = 2;
    writeFileSync(join(dir, 'a.bin'), b);
    expect(fileDigest(dir, 'a.bin', new Set())).not.toBe(a);
    // Over 2 GiB (sparse: no disk used): read like any other file.
    writeFileSync(join(dir, 'big.bin'), '');
    truncateSync(join(dir, 'big.bin'), 2 ** 31 + 10);
    expect(fileDigest(dir, 'big.bin', new Set())).toMatch(/^[0-9a-f]{64}$/);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
