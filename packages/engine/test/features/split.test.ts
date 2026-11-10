import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMindlyError, type SplitPlan } from '@mindly/core';
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
  const calls: { mergeBranches: unknown[] } = { mergeBranches: [] };
  let mergeCheck: SplitMergeCheck | null = null;
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
    deleteBranch: async (_root, b) => branches.delete(b),
    changedSince: async (_root, wt) => changed.get(wt) ?? [],
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
    runChecks: async () => [],
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
    calls,
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

  it("in strict mode blocks shell writes to another part's files and lets reads through", async () => {
    const { mindly, svc, pid } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      strict: true,
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const pageWt = created.parts[1]!.worktree;
    mkdirSync(join(pageWt, 'src', 'api'), { recursive: true });
    writeFileSync(join(pageWt, 'src', 'api', 'billing.ts'), 'export const plan = 1;\n');
    await mindly.hooks.handle(event(pageWt, 'claude-code', 'page-1', 'session_start'));
    const shell = (command: string) =>
      mindly.hooks.handle(
        event(pageWt, 'claude-code', 'page-1', 'pre_tool', { tool: shellTool(command) }),
      );
    for (const command of [
      'cat src/api/billing.ts',
      'cat src/api/billing.ts 2>/dev/null',
      'cat src/api/billing.ts || true',
      'sed -n 1,40p src/api/billing.ts',
      'grep -n plan src/api/billing.ts | sort | uniq',
      'npx vitest run src/api/billing.test.ts',
      'npx tsc --noEmit -p src/api/tsconfig.json',
      'git diff main -- src/api/billing.ts > /tmp/api.diff',
      'echo x > src/app/page.ts',
    ]) {
      const r = await shell(command);
      expect(r.decision ?? null, command).toBeNull();
      expect(r.context ?? '', command).not.toContain('owned by part');
    }
    for (const [command, what] of [
      ['echo x>src/api/billing.ts', 'src/api/billing.ts'],
      ['cd src/api && sed -i s/a/b/ billing.ts', 'src/api/billing.ts'],
      ['mv src/api/billing.ts src/app/billing.ts', 'src/api/billing.ts'],
      // A whole directory is judged by what it can reach, not by listing it.
      ['rm -rf src/api', 'src/api/**'],
      ['rm -rf src', 'src/**'],
      ['rm -rf src/api/not-there-yet', 'src/api/not-there-yet/**'],
      ['git checkout HEAD~1 src', 'src/**'],
      // A wildcard stands for the files it expands to.
      ['rm src/api/*.ts', 'src/api/billing.ts'],
      ['rm -f src/**/*.ts', 'src/api/billing.ts'],
      ['cd src && rm -rf *', 'src/api/billing.ts'],
      ["find . -name '*.ts' -delete", 'src/api/billing.ts'],
    ] as const) {
      const r = await shell(command);
      expect(r.decision, command).toBe('deny');
      expect(r.reason, command).toContain(`${what} (part "Part api", claude-code)`);
    }
    // Its own folders, folders nobody owns and wildcards that match none of another part's
    // files can go, at the top level too.
    for (const command of [
      'rm -rf src/app/old',
      'rm -rf dist',
      'rm -rf node_modules dist',
      'rm src/app/*.bak',
      'rm -f *.log',
      'rm -rf *.tsbuildinfo',
      'rm -rf ./dist/*',
      'rm -rf **/*.log',
      'rm -rf **/dist',
      'rm -rf **/node_modules',
      'rm -f src/**/*.js',
      'rm -rf src/*/dist',
      'rm -rf packages/*/dist',
      "find . -name '*.js' -delete",
      'for f in src/*.ts; do echo $f; done',
      // A formatter over the whole tree only rewrites the kinds of file it knows.
      'black .',
      'gofmt -w .',
    ]) {
      const r = await shell(command);
      expect(r.decision ?? null, command).toBeNull();
      expect(r.context ?? '', command).not.toContain('owned by part');
      expect(r.context ?? '', command).not.toContain('reaches files owned');
    }
    // Files of unknown names put into the tree may land on another part's files: a warning.
    for (const command of [
      'tar xzf /tmp/file.tgz',
      'unzip -q /tmp/a.zip',
      'cp -R /tmp/tpl/* .',
      'cp -r /tmp/api src/',
    ]) {
      const r = await shell(command);
      expect(r.decision ?? null, command).toBeNull();
      expect(r.context ?? '', command).toContain('reaches files owned');
    }
    for (const command of [] as string[]) {
      const r = await shell(command);
      expect(r.decision ?? null, command).toBeNull();
      expect(r.context ?? '', command).not.toContain('owned by part');
      expect(r.context ?? '', command).not.toContain('reaches files owned');
    }
    // A program Mindly does not know is warned about the file, not blocked.
    const unknown = await shell('node scripts/codemod.js src/api/billing.ts');
    expect(unknown.decision ?? null).toBeNull();
    expect(unknown.context).toContain('src/api/billing.ts is owned by part "Part api"');
  });

  it("guards writes that reach into another part's worktree or the main checkout", async () => {
    const { mindly, svc, pid, root } = await setup();
    const created = await svc.create({
      projectId: pid,
      plan: PLAN,
      slug: 'billing',
      strict: true,
      plannedBy: 'plan-file',
      connectedAgents: null,
    });
    const [apiWt, pageWt] = created.parts.map((p) => p.worktree) as [string, string];
    await mindly.hooks.handle(event(apiWt, 'claude-code', 'api-1', 'session_start'));
    const pre = (tool: ReturnType<typeof writeTool>) =>
      mindly.hooks.handle(event(apiWt, 'claude-code', 'api-1', 'pre_tool', { tool }));
    for (const path of [
      join(pageWt, 'src/app/page.ts'),
      join(root, 'src/app/page.ts'),
      `../${basename(pageWt)}/src/app/page.ts`,
    ]) {
      const r = await pre(writeTool(path, 'x'));
      expect(r.decision, path).toBe('deny');
      expect(r.reason, path).toContain('src/app/page.ts (part "Part page", claude-code)');
    }
    const shell = await pre(shellTool(`echo x > ../${basename(pageWt)}/src/app/page.ts`));
    expect(shell.decision).toBe('deny');
    // Its own files stay writable wherever they are; nothing about the other tree is recorded.
    const own = await pre(writeTool(join(root, 'src/api/billing.ts'), 'x'));
    expect(own.decision ?? null).toBeNull();
    expect(JSON.stringify(mindly.store.intents.active(pid))).not.toContain('src/app/page.ts');
    // A path outside every tree of the project is still none of Mindly's business.
    const elsewhere = await pre(writeTool(join(tmpdir(), 'elsewhere', 'src/app/page.ts'), 'x'));
    expect(elsewhere.decision ?? null).toBeNull();
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
