import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openMindly } from '@mindly/runtime';
import { cli, git, sandbox, tempDir, write, type Sandbox } from './helpers.js';

interface Plan {
  goal: string;
  parts: {
    key: string;
    title: string;
    agent: string;
    owns: string[];
    reads?: string[];
    dependsOn: string[];
    brief: string;
  }[];
  contract: { name: string; owner: string; definition: string }[];
}

const API = 'export function getBilling(id: string) {\n  return { plan: "pro", id };\n}\n';

const PLAN: Plan = {
  goal: 'Add billing: API, webhook handler, page',
  parts: [
    {
      key: 'api',
      title: 'Billing API',
      agent: 'claude-code',
      owns: ['src/api/**'],
      dependsOn: [],
      brief: 'Expose GET /api/billing.',
    },
    {
      key: 'webhook',
      title: 'Stripe webhook handler',
      agent: 'claude-code',
      owns: ['src/webhooks/**'],
      dependsOn: ['api'],
      brief: 'Handle invoice.paid.',
    },
    {
      key: 'page',
      title: 'Billing page',
      agent: 'claude-code',
      owns: ['src/app/**'],
      reads: ['src/api/**'],
      dependsOn: ['api'],
      brief: 'Show the plan from GET /api/billing.',
    },
  ],
  contract: [{ name: 'GET /api/billing', owner: 'api', definition: 'returns { plan, id }' }],
};

/** A sandbox whose repo has files for every part and Claude Code connected (hooks installed). */
async function splitSandbox(): Promise<Sandbox> {
  const sb = sandbox();
  write(sb.repo, 'src/api/billing.ts', API);
  write(sb.repo, 'src/webhooks/stripe.ts', 'export const stripe = 1;\n');
  write(
    sb.repo,
    'src/app/page.ts',
    "import { getBilling } from '../api/billing';\nexport const page = getBilling('x');\n",
  );
  git(sb.repo, 'add', '-A');
  git(sb.repo, 'commit', '-q', '-m', 'files');
  const init = await cli(sb, ['init', '--yes', '--agents', 'claude-code']);
  expect(init.code).toBe(0);
  return sb;
}

function planFile(sb: Sandbox, plan: unknown, name = 'plan.json'): string {
  const path = join(sb.home, name);
  writeFileSync(path, typeof plan === 'string' ? plan : JSON.stringify(plan));
  return path;
}

/** Everything in the user's checkout a split must leave alone. */
function mainState(root: string): Record<string, string> {
  return {
    head: git(root, 'rev-parse', 'HEAD').trim(),
    branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    status: git(root, 'status', '--porcelain'),
  };
}

const worktreeRoot = (sb: Sandbox): string => `${sb.repo}.mindly`;
const partDir = (sb: Sandbox, key: string): string => join(worktreeRoot(sb), `billing-${key}`);
const branches = (sb: Sandbox): string[] =>
  git(sb.repo, 'branch', '--list', '--format=%(refname:short)', 'mindly/*')
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort();
const worktrees = (sb: Sandbox): number =>
  git(sb.repo, 'worktree', 'list').trim().split('\n').length;

interface HookOut {
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

/** Sends a real Claude Code hook payload for a session running in `cwd`. */
async function hook(
  sb: Sandbox,
  cwd: string,
  sessionId: string,
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse',
  extra: Record<string, unknown> = {},
): Promise<HookOut> {
  const payload = {
    session_id: sessionId,
    transcript_path: join(sb.home, `${sessionId}.jsonl`),
    cwd,
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };
  const r = await cli(sb, ['hook', 'claude-code', event], { stdin: JSON.stringify(payload), cwd });
  expect(r.code).toBe(0);
  expect(r.stderr).toBe('');
  return r.stdout.trim() ? (JSON.parse(r.stdout) as HookOut) : {};
}

const writeTool = (file: string, content: string) => ({
  tool_name: 'Write',
  tool_input: { file_path: file, content },
  tool_use_id: 'toolu_1',
});

async function createSplit(sb: Sandbox, args: string[] = []) {
  const r = await cli(sb, [
    'split',
    '--plan',
    planFile(sb, PLAN),
    '--name',
    'billing',
    '--yes',
    ...args,
  ]);
  expect(r.stderr).toBe('');
  expect(r.code).toBe(0);
  return r;
}

interface StatusJson {
  split: {
    id: string;
    status: string;
    strict: boolean;
    baseCommit: string;
    integrationBranch: string | null;
    contract: { name: string; memoryId: string }[];
  };
  parts: {
    part: { key: string; worktree: string; branch: string; taskId: string };
    task: { status: string; parentId: string | null };
    state: string;
    filesChanged: string[];
    uncommitted: string[];
    unmergedCommits: string[];
    session: { id: string } | null;
  }[];
  mergeCheck: { status: string; result: { clean: boolean; conflictedPaths: string[] } } | null;
}

async function statusJson(sb: Sandbox): Promise<StatusJson> {
  const r = await cli(sb, ['split', 'status', '--json']);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as StatusJson;
}

describe('mindly split --plan (acceptance 1: hand-written plan)', () => {
  it('creates 3 worktrees, 3 child tasks and briefs without touching the checkout', async () => {
    const sb = await splitSandbox();
    write(sb.repo, 'wip.txt', 'uncommitted work stays\n');
    const before = mainState(sb.repo);
    const r = await createSplit(sb);
    expect(r.stdout).toContain('Created 3 worktrees next to the repo');
    expect(r.stdout).toContain(worktreeRoot(sb));
    expect(r.stdout).toContain('mindly split status');
    for (const key of ['api', 'webhook', 'page']) {
      expect(existsSync(join(partDir(sb, key), 'src', 'api', 'billing.ts'))).toBe(true);
      expect(existsSync(join(partDir(sb, key), 'wip.txt'))).toBe(false);
      expect(git(partDir(sb, key), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
        `mindly/billing/${key}`,
      );
    }
    expect(branches(sb)).toEqual([
      'mindly/billing/api',
      'mindly/billing/page',
      'mindly/billing/webhook',
    ]);
    expect(worktrees(sb)).toBe(4);
    expect(mainState(sb.repo)).toEqual(before);
    expect(readFileSync(join(sb.repo, 'wip.txt'), 'utf8')).toBe('uncommitted work stays\n');

    const s = await statusJson(sb);
    expect(s.split.status).toBe('active');
    expect(s.split.baseCommit).toBe(before['head']);
    expect(s.split.contract.map((c) => c.name)).toEqual(['GET /api/billing']);
    expect(s.parts.map((p) => p.part.key)).toEqual(['api', 'webhook', 'page']);
    expect(s.parts.map((p) => p.state)).toEqual(['waiting', 'waiting', 'waiting']);
    const parents = new Set(s.parts.map((p) => p.task.parentId));
    expect(parents.size).toBe(1);
    expect([...parents][0]).not.toBeNull();
    const handoffs = await cli(sb, ['handoffs', '--json']);
    expect(
      (JSON.parse(handoffs.stdout) as { status: string }[]).filter((h) => h.status === 'pending'),
    ).toHaveLength(3);
    // The contract became an approved decision.
    const memories = await cli(sb, ['memory', 'list', '--json']);
    expect(memories.stdout).toContain('GET /api/billing');
    // A second split is refused while this one is active.
    const again = await cli(sb, [
      'split',
      '--plan',
      planFile(sb, PLAN),
      '--name',
      'other',
      '--yes',
    ]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already active');
  });

  it('rejects overlapping owns, unknown agents and cycles before anything is created', async () => {
    const sb = await splitSandbox();
    const before = mainState(sb.repo);
    const bad = (patch: (p: Plan) => void): Plan => {
      const p = structuredClone(PLAN);
      patch(p);
      return p;
    };
    const cases: [Plan | string, RegExp][] = [
      [bad((p) => (p.parts[1]!.owns = ['src/**'])), /both own src\/api\/billing\.ts/],
      [bad((p) => (p.parts[1]!.owns = ['**/*.test.ts'])), /not clearly disjoint/],
      [bad((p) => p.contract.push({ ...p.contract[0]! })), /more than once/],
      [bad((p) => (p.parts[2]!.agent = 'codex')), /"codex", which is not connected/],
      [bad((p) => (p.parts[2]!.agent = 'not-an-agent')), /problem/],
      [bad((p) => (p.parts[0]!.dependsOn = ['page'])), /cycle: api (→|->) page (→|->) api/],
      [bad((p) => p.parts.splice(1)), /parts/],
      [
        bad((p) => {
          for (let i = 0; i < 5; i++)
            p.parts.push({ ...p.parts[0]!, key: `x${i}`, owns: [`x${i}/**`] });
        }),
        /parts/,
      ],
      ['{not json', /not valid JSON/],
      [bad((p) => (p.contract[0]!.owner = 'ghost')), /unknown part "ghost"/],
    ];
    for (const [plan, re] of cases) {
      const r = await cli(sb, ['split', '--plan', planFile(sb, plan), '--yes']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(re);
    }
    const missing = await cli(sb, ['split', '--plan', join(sb.home, 'nope.json'), '--yes']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Plan file not found');
    expect(existsSync(worktreeRoot(sb))).toBe(false);
    expect(branches(sb)).toEqual([]);
    expect(worktrees(sb)).toBe(1);
    expect(mainState(sb.repo)).toEqual(before);
    const status = await cli(sb, ['split', 'status']);
    expect(status.code).toBe(1);
    expect(status.stderr).toContain('No split in this project');
  });

  it('reads --json wherever it is typed, bounds a goal given with --plan and cleans planner text', async () => {
    const sb = await splitSandbox();
    const plan = structuredClone(PLAN);
    plan.parts[0]!.title = 'Billing \u001b[31mAPI\u001b[0m';
    const r = await cli(sb, ['split', '--plan', planFile(sb, plan), '--name', 'billing', '--yes']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('\u001b');
    const early = await cli(sb, ['split', '--json', 'status']);
    expect(early.code).toBe(0);
    expect(JSON.parse(early.stdout)).toMatchObject({ split: { status: 'active' } });
    const late = await cli(sb, ['split', 'status', '--json']);
    expect(late.stdout).toBe(early.stdout);
    const long = await cli(sb, ['split', '--plan', planFile(sb, PLAN), 'x'.repeat(501), '--yes']);
    expect(long.code).toBe(1);
    expect(long.stderr).toMatch(/goal/);
    expect((await cli(sb, ['split', 'abort', '-y'])).code).toBe(0);
  });

  it('--dry-run shows the plan and creates nothing; without a terminal the review needs --yes', async () => {
    const sb = await splitSandbox();
    const dry = await cli(sb, ['split', '--plan', planFile(sb, PLAN), '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('Billing API');
    expect(dry.stdout).toContain('src/api/**');
    expect(dry.stdout).toContain('GET /api/billing');
    const dryJson = await cli(sb, ['split', '--plan', planFile(sb, PLAN), '--dry-run', '--json']);
    expect(JSON.parse(dryJson.stdout)).toMatchObject({
      created: false,
      plannedBy: 'plan-file',
      plan: { goal: PLAN.goal },
    });
    const noTty = await cli(sb, ['split', '--plan', planFile(sb, PLAN)]);
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain('Re-run with --yes');
    const declined = await cli(sb, ['split', '--plan', planFile(sb, PLAN)], { answers: ['n'] });
    expect(declined.code).toBe(0);
    expect(declined.stdout).toContain('Nothing created');
    expect(existsSync(worktreeRoot(sb))).toBe(false);
    expect(branches(sb)).toEqual([]);
    // Interactive approval creates the split.
    const approved = await cli(sb, ['split', '--plan', planFile(sb, PLAN), '--name', 'billing'], {
      answers: [''],
    });
    expect(approved.code).toBe(0);
    expect(worktrees(sb)).toBe(4);
  });
});

describe('briefs and ownership through hook events (acceptance 2)', () => {
  it('briefs a session started in a part worktree and warns about writes to other parts', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    const api = partDir(sb, 'api');
    const start = await hook(sb, api, 'api-session', 'SessionStart', { source: 'startup' });
    const ctx = start.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('Your part of the split');
    expect(ctx).toContain('part "Billing API"');
    expect(ctx).toContain('Files you own (edit only these): src/api/**');
    expect(ctx).toContain('GET /api/billing');
    expect(ctx).toContain('branch mindly/billing/api');
    expect(ctx).toContain('Expose GET /api/billing');
    // The brief is claimed by this session only; the other parts keep theirs.
    const s = await statusJson(sb);
    expect(s.parts.map((p) => p.state)).toEqual(['working', 'waiting', 'waiting']);
    expect(s.parts[0]!.session).not.toBeNull();
    const again = await hook(sb, api, 'api-session', 'UserPromptSubmit', { prompt: 'go' });
    expect(again.hookSpecificOutput?.additionalContext ?? '').not.toContain(
      'Your part of the split',
    );
    const page = await hook(sb, partDir(sb, 'page'), 'page-session', 'SessionStart', {
      source: 'startup',
    });
    const pageCtx = page.hookSpecificOutput?.additionalContext ?? '';
    expect(pageCtx).toContain('part "Billing page"');
    expect(pageCtx).toContain('Files you may read for context: src/api/**');
    expect(pageCtx).toContain('depends on part(s): api');
    // A session in the main checkout is not briefed.
    const main = await hook(sb, sb.repo, 'main-session', 'SessionStart', { source: 'startup' });
    expect(main.hookSpecificOutput?.additionalContext ?? '').not.toContain(
      'Your part of the split',
    );

    // Writing a file owned by another part warns and names the owner; own files are silent.
    const warned = await hook(
      sb,
      api,
      'api-session',
      'PreToolUse',
      writeTool(join(api, 'src/app/page.ts'), 'x'),
    );
    expect(warned.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(warned.hookSpecificOutput?.additionalContext).toContain(
      'src/app/page.ts is owned by part "Billing page" (claude-code) of this split',
    );
    const own = await hook(
      sb,
      api,
      'api-session',
      'PreToolUse',
      writeTool(join(api, 'src/api/billing.ts'), 'x'),
    );
    expect(own.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(own.hookSpecificOutput?.additionalContext ?? '').not.toContain('owned by part');
  });

  it("guards shell commands that may write another part's files", async () => {
    const sb = await splitSandbox();
    await createSplit(sb, ['--strict']);
    const api = partDir(sb, 'api');
    await hook(sb, api, 'api-session', 'SessionStart', { source: 'startup' });
    const bash = (command: string) => ({
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'toolu_2',
    });
    const read = await hook(sb, api, 'api-session', 'PreToolUse', bash('cat src/app/page.ts'));
    expect(read.hookSpecificOutput?.permissionDecision).toBeUndefined();
    const denied = await hook(
      sb,
      api,
      'api-session',
      'PreToolUse',
      bash("sed -i '' 's/x/y/' src/app/page.ts"),
    );
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput?.permissionDecisionReason).toContain('src/app/page.ts');
    const own = await hook(sb, api, 'api-session', 'PreToolUse', bash('echo x > src/api/new.ts'));
    expect(own.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('denies writes to other parts with --strict', async () => {
    const sb = await splitSandbox();
    const r = await createSplit(sb, ['--strict']);
    expect(r.stdout).toContain('Strict mode');
    const page = partDir(sb, 'page');
    const start = await hook(sb, page, 'page-session', 'SessionStart', { source: 'startup' });
    expect(start.hookSpecificOutput?.additionalContext).toContain('blocked (strict mode)');
    const denied = await hook(
      sb,
      page,
      'page-session',
      'PreToolUse',
      writeTool(join(page, 'src/api/billing.ts'), 'x'),
    );
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput?.permissionDecisionReason).toContain('strict mode');
    expect(denied.hookSpecificOutput?.permissionDecisionReason).toContain(
      'src/api/billing.ts (part "Billing API", claude-code)',
    );
    const own = await hook(
      sb,
      page,
      'page-session',
      'PreToolUse',
      writeTool(join(page, 'src/app/page.ts'), 'x'),
    );
    expect(own.hookSpecificOutput?.permissionDecision).toBeUndefined();
    // Case never hides a file from its owner: src/API is src/api on macOS and Windows.
    const cased = await hook(
      sb,
      page,
      'page-session',
      'PreToolUse',
      writeTool(join(page, 'src/API/a.ts'), 'x'),
    );
    expect(cased.hookSpecificOutput?.permissionDecision).toBe('deny');
    // (a case-insensitive file system may report the folder's own spelling)
    expect(cased.hookSpecificOutput?.permissionDecisionReason).toMatch(/src\/(API|api)\/a\.ts/);
    expect((await statusJson(sb)).split.strict).toBe(true);
  });
});

describe('contract changes reach dependants (acceptance 3)', () => {
  it('sends an impact update when the owner changes an export its dependants rely on', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    const api = partDir(sb, 'api');
    const page = partDir(sb, 'page');
    const webhook = partDir(sb, 'webhook');
    await hook(sb, api, 'api-session', 'SessionStart', { source: 'startup' });
    await hook(sb, page, 'page-session', 'SessionStart', { source: 'startup' });
    await hook(sb, webhook, 'webhook-session', 'SessionStart', { source: 'startup' });
    // The API owner renames the exported function in its own worktree.
    const changed = API.replace('getBilling', 'fetchBilling');
    writeFileSync(join(api, 'src/api/billing.ts'), changed);
    await hook(sb, api, 'api-session', 'PostToolUse', {
      ...writeTool(join(api, 'src/api/billing.ts'), changed),
      tool_response: { filePath: join(api, 'src/api/billing.ts'), type: 'update' },
    });
    const next = await hook(sb, page, 'page-session', 'UserPromptSubmit', {
      prompt: 'continue the page',
    });
    const ctx = next.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('changed the exports of src/api/billing.ts');
    expect(ctx).toContain('Removed: getBilling');
    expect(ctx).toContain(
      'Your part "Billing page" depends on part "Billing API", which owns src/api/billing.ts',
    );
    const other = await hook(sb, webhook, 'webhook-session', 'UserPromptSubmit', {
      prompt: 'continue',
    });
    expect(other.hookSpecificOutput?.additionalContext ?? '').toContain(
      'changed the exports of src/api/billing.ts',
    );
    // The owner is not told about its own change.
    const owner = await hook(sb, api, 'api-session', 'UserPromptSubmit', { prompt: 'continue' });
    expect(owner.hookSpecificOutput?.additionalContext ?? '').not.toContain('changed the exports');
  });

  it('sends an impact update when a contract decision is edited', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    await hook(sb, partDir(sb, 'page'), 'page-session', 'SessionStart', { source: 'startup' });
    await hook(sb, partDir(sb, 'api'), 'api-session', 'SessionStart', { source: 'startup' });
    const s = await statusJson(sb);
    const mindly = openMindly({ env: sb.env, disableNotify: true, disableLlm: true });
    try {
      mindly.memory.update(
        s.split.contract[0]!.memoryId,
        { body: 'returns { plan, id, renewsAt }' },
        { type: 'user', sessionId: null, agentKind: null },
        'contract change',
      );
    } finally {
      mindly.close();
    }
    const next = await hook(sb, partDir(sb, 'page'), 'page-session', 'UserPromptSubmit', {
      prompt: 'continue',
    });
    expect(next.hookSpecificOutput?.additionalContext).toContain(
      'Contract item "GET /api/billing" of the split changed',
    );
    expect(next.hookSpecificOutput?.additionalContext).toContain('renewsAt');
    const owner = await hook(sb, partDir(sb, 'api'), 'api-session', 'UserPromptSubmit', {
      prompt: 'continue',
    });
    expect(owner.hookSpecificOutput?.additionalContext ?? '').not.toContain('of the split changed');
  });
});

describe('split status, merge and abort (acceptance 4)', () => {
  function commitIn(dir: string, rel: string, content: string): void {
    write(dir, rel, content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `work in ${rel}`);
  }

  it('merges the parts in dependency order into one integration branch and never touches main', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    const before = mainState(sb.repo);
    commitIn(partDir(sb, 'api'), 'src/api/plans.ts', 'export const plans = ["pro"];\n');
    commitIn(partDir(sb, 'webhook'), 'src/webhooks/invoice.ts', 'export const invoice = 1;\n');
    write(partDir(sb, 'page'), 'src/app/billing.ts', 'export const billing = 1;\n');

    const status = await cli(sb, ['split', 'status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('Billing API');
    expect(status.stdout).toContain('1 file changed');
    expect(status.stdout).toContain('merge check: not run yet');
    const s1 = await statusJson(sb);
    expect(s1.parts.map((p) => p.filesChanged)).toEqual([
      ['src/api/plans.ts'],
      ['src/webhooks/invoice.ts'],
      ['src/app/billing.ts'],
    ]);

    // Not done yet: the merge refuses, nothing is created.
    const early = await cli(sb, ['split', 'merge']);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain('3 parts are not done yet');
    expect(early.stderr).toContain('--force');
    expect(branches(sb)).not.toContain('mindly/billing/integration');

    const check = await cli(sb, ['split', 'check']);
    expect(check.code).toBe(0);
    expect(check.stdout).toContain('Merge check clean');
    expect((await statusJson(sb)).mergeCheck?.status).toBe('passed');

    const merged = await cli(sb, ['split', 'merge', '--force', '--json']);
    expect(merged.stderr).toBe('');
    expect(merged.code).toBe(0);
    const m = JSON.parse(merged.stdout) as {
      branch: string;
      commit: string;
      merged: string[];
      checksSkipped: string | null;
      leftBehind: { part: string; paths: string[] }[];
    };
    expect(m.branch).toBe('mindly/billing/integration');
    expect(m.leftBehind).toEqual([
      { part: 'page', title: 'Billing page', paths: ['src/app/billing.ts'] },
    ]);
    expect(m.merged).toEqual(['api', 'webhook', 'page']);
    expect(m.checksSkipped).toBe('none_configured');
    expect(git(sb.repo, 'rev-parse', 'mindly/billing/integration').trim()).toBe(m.commit);
    const tree = git(sb.repo, 'ls-tree', '-r', '--name-only', m.commit).trim().split('\n');
    expect(tree).toEqual(
      expect.arrayContaining(['src/api/plans.ts', 'src/webhooks/invoice.ts', 'src/api/billing.ts']),
    );
    // Only committed work is merged: the page's uncommitted file is not in the tree.
    expect(tree).not.toContain('src/app/billing.ts');
    expect(
      git(sb.repo, 'rev-list', '--merges', '--count', `${before['head']}..${m.commit}`).trim(),
    ).toBe('3');
    expect(mainState(sb.repo)).toEqual(before);
    const s2 = await statusJson(sb);
    expect(s2.split.status).toBe('merged');
    expect(s2.split.integrationBranch).toBe('mindly/billing/integration');
    expect(s2.parts.every((p) => p.task.status === 'done')).toBe(false);
    const again = await cli(sb, ['split', 'merge', '--force']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('merged, not active');

    // The page's file is only in its worktree: status says so and does not suggest removing it.
    const after = await cli(sb, ['split', 'status']);
    expect(after.stdout).toMatch(/1\s+not\s+committed/);
    expect(after.stdout).not.toContain('mindly split abort');
    expect(after.stdout).toContain(`cd ${partDir(sb, 'page')}`);
    // Cleaning up would delete it: -y alone refuses, --discard is the way to say so.
    const cleanup = await cli(sb, ['split', 'abort', '--yes']);
    expect(cleanup.code).toBe(1);
    expect(cleanup.stderr).toContain('does not have the work of "Billing page" (not committed:');
    expect(cleanup.stderr).toContain('src/app/billing.ts');
    expect(cleanup.stderr).toContain('mindly split abort --discard');
    expect(existsSync(join(partDir(sb, 'page'), 'src/app/billing.ts'))).toBe(true);
    const discard = await cli(sb, ['split', 'abort', '--yes', '--discard']);
    expect(discard.code).toBe(0);
    expect(discard.stdout).toContain('Uncommitted work was removed');
    expect(discard.stdout).toContain('Part "Billing page": src/app/billing.ts');
    expect(existsSync(worktreeRoot(sb))).toBe(false);
    expect(branches(sb)).toEqual(['mindly/billing/integration']);
  });

  it('abort after a merge keeps commits a part made on its branch since', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    commitIn(partDir(sb, 'api'), 'src/api/plans.ts', 'export const plans = 1;\n');
    commitIn(partDir(sb, 'page'), 'src/app/billing.ts', 'export const billing = 1;\n');
    expect((await cli(sb, ['split', 'merge', '--force'])).code).toBe(0);
    // The page agent keeps working after the merge and commits on its part branch.
    commitIn(partDir(sb, 'page'), 'src/app/late.ts', 'export const late = 1;\n');
    const late = git(partDir(sb, 'page'), 'rev-parse', 'HEAD').trim();

    const s = await statusJson(sb);
    expect(s.parts.map((p) => p.uncommitted)).toEqual([[], [], []]);
    expect(s.parts.map((p) => p.unmergedCommits)).toEqual([
      [],
      [],
      [`${late.slice(0, 12)} work in src/app/late.ts`],
    ]);
    const status = await cli(sb, ['split', 'status']);
    expect(status.stdout).toMatch(/1\s+commit\s+not\s+merged/);
    expect(status.stdout).toContain(`cd ${partDir(sb, 'page')}`);
    expect(status.stdout).not.toContain('mindly split abort');

    const abort = await cli(sb, ['split', 'abort', '--yes']);
    expect(abort.code).toBe(1);
    expect(abort.stderr).toContain(
      `does not have the work of "Billing page" (1 commit only on its branch: ${late.slice(0, 12)} work in src/app/late.ts)`,
    );
    expect(abort.stderr).toContain('--keep-branches');
    expect(git(sb.repo, 'rev-parse', 'mindly/billing/page').trim()).toBe(late);
    expect(existsSync(partDir(sb, 'page'))).toBe(true);

    // Merged into the integration branch, the commit is safe and the cleanup goes through.
    const integration = join(tempDir('syn-split-int-'), 'integration');
    git(sb.repo, 'worktree', 'add', '-q', integration, 'mindly/billing/integration');
    git(integration, 'merge', '-q', '--no-edit', 'mindly/billing/page');
    git(sb.repo, 'worktree', 'remove', '--force', integration);
    const ok = await cli(sb, ['split', 'abort', '--yes']);
    expect(ok.stderr).toBe('');
    expect(ok.code).toBe(0);
    expect(branches(sb)).toEqual(['mindly/billing/integration']);
    expect(git(sb.repo, 'merge-base', '--is-ancestor', late, 'mindly/billing/integration')).toBe(
      '',
    );
  });

  it('abort after a merge removes commits only on a part branch with --discard', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    expect((await cli(sb, ['split', 'merge', '--force'])).code).toBe(0);
    commitIn(partDir(sb, 'page'), 'src/app/late.ts', 'export const late = 1;\n');
    const r = await cli(sb, ['split', 'abort', '--yes', '--discard']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Work no other branch has was removed');
    expect(r.stdout).toContain('Part "Billing page": 1 commit only on its branch:');
    expect(branches(sb)).toEqual(['mindly/billing/integration']);
  });

  it('refuses to merge while finished work is not committed on the part branches', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    // One part left its file untracked, another committed on a branch of its own.
    write(partDir(sb, 'api'), 'src/api/plans.ts', 'export const plans = 1;\n');
    git(partDir(sb, 'webhook'), 'checkout', '-q', '-b', 'feature/webhook');
    commitIn(partDir(sb, 'webhook'), 'src/webhooks/invoice.ts', 'export const invoice = 1;\n');
    commitIn(partDir(sb, 'page'), 'src/app/billing.ts', 'export const billing = 1;\n');
    const s = await statusJson(sb);
    expect(s.parts.map((p) => p.uncommitted)).toEqual([
      ['src/api/plans.ts'],
      ['src/webhooks/invoice.ts'],
      [],
    ]);
    const mindly = openMindly({ env: sb.env, disableNotify: true, disableLlm: true });
    try {
      for (const p of s.parts) mindly.tasks.update(p.part.taskId, { status: 'done' }, null);
    } finally {
      mindly.close();
    }
    // The merge check sees the worktrees and is clean; the merge would take neither file.
    expect((await cli(sb, ['split', 'check'])).code).toBe(0);
    const status = await cli(sb, ['split', 'status']);
    expect(status.stdout).toContain(`cd ${partDir(sb, 'api')}`);
    expect(status.stdout).not.toContain('mindly split merge');
    const refused = await cli(sb, ['split', 'merge']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('2 parts have work that is not committed on their branch');
    expect(refused.stderr).toContain('"Billing API" (src/api/plans.ts)');
    expect(refused.stderr).toContain('"Stripe webhook handler" (src/webhooks/invoice.ts)');
    expect(refused.stderr).toContain('mindly split merge --force');
    expect(branches(sb)).not.toContain('mindly/billing/integration');
    expect((await statusJson(sb)).split.status).toBe('active');

    // Committed on the part branches, everything is merged and the worktrees can go.
    commitIn(partDir(sb, 'api'), 'src/api/plans.ts', 'export const plans = 1;\n');
    git(partDir(sb, 'webhook'), 'checkout', '-q', 'mindly/billing/webhook');
    git(partDir(sb, 'webhook'), 'merge', '-q', '--ff-only', 'feature/webhook');
    const merged = await cli(sb, ['split', 'merge']);
    expect(merged.stderr).toBe('');
    expect(merged.code).toBe(0);
    expect(merged.stdout).not.toContain('Not merged');
    expect(merged.stdout).toContain('mindly split abort');
    const tree = git(sb.repo, 'ls-tree', '-r', '--name-only', 'mindly/billing/integration');
    expect(tree).toContain('src/api/plans.ts');
    expect(tree).toContain('src/webhooks/invoice.ts');
    expect(tree).toContain('src/app/billing.ts');
    expect((await cli(sb, ['split', 'abort', '--yes'])).code).toBe(0);
  });

  it('says so when a merge check could not look at a part', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    git(sb.repo, 'worktree', 'remove', '--force', partDir(sb, 'page'));
    const check = await cli(sb, ['split', 'check']);
    expect(check.code).toBe(0);
    expect(check.stdout).not.toContain('every part merges');
    expect(check.stdout).toContain('1 part could not');
    expect(check.stdout).toContain('Part "page" was not checked: its worktree folder is gone');
  });

  it('merges when every part is done and reports the checks of a trusted project', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    commitIn(partDir(sb, 'api'), 'src/api/plans.ts', 'export const plans = 1;\n');
    const s = await statusJson(sb);
    const mindly = openMindly({ env: sb.env, disableNotify: true, disableLlm: true });
    try {
      for (const p of s.parts) mindly.tasks.update(p.part.taskId, { status: 'done' }, null);
    } finally {
      mindly.close();
    }
    expect((await statusJson(sb)).parts.map((p) => p.state)).toEqual(['done', 'done', 'done']);
    const merged = await cli(sb, ['split', 'merge']);
    expect(merged.code).toBe(0);
    expect(merged.stdout).toContain('mindly/billing/integration');
    expect(merged.stdout).toContain('git log --oneline mindly/billing/integration');
    expect(merged.stdout).not.toContain('git push --force');
    expect(git(sb.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    // The briefs of a finished split are cancelled: a late session in a part folder gets none.
    const late = await hook(sb, partDir(sb, 'page'), 'late-session', 'SessionStart', {
      source: 'startup',
    });
    expect(late.hookSpecificOutput?.additionalContext ?? '').not.toContain(
      'Your part of the split',
    );
    const handoffs = await cli(sb, ['handoffs', '--json']);
    expect((JSON.parse(handoffs.stdout) as { status: string }[]).map((h) => h.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it('abort keeps a branch the user has checked out and never moves HEAD', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    git(sb.repo, 'worktree', 'remove', '--force', partDir(sb, 'api'));
    git(sb.repo, 'checkout', '-q', 'mindly/billing/api');
    const head = git(sb.repo, 'rev-parse', 'HEAD').trim();
    const r = await cli(sb, ['split', 'abort', '--yes']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('kept 1 branch');
    expect(r.stdout).toContain('mindly/billing/api');
    expect(git(sb.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('mindly/billing/api');
    expect(git(sb.repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(branches(sb)).toEqual(['mindly/billing/api']);
    expect(existsSync(worktreeRoot(sb))).toBe(false);
  });

  it('stops cleanly on a conflict between parts', async () => {
    const sb = await splitSandbox();
    await createSplit(sb);
    const before = mainState(sb.repo);
    commitIn(partDir(sb, 'api'), 'README.md', '# from api\n');
    commitIn(partDir(sb, 'page'), 'README.md', '# from page\n');
    await hook(sb, partDir(sb, 'page'), 'page-session', 'SessionStart', { source: 'startup' });
    const heads = git(sb.repo, 'for-each-ref', 'refs/heads');
    const merge = await cli(sb, ['split', 'merge', '--force']);
    expect(merge.code).toBe(1);
    expect(merge.stderr).toContain('conflicts in README.md');
    expect(git(sb.repo, 'for-each-ref', 'refs/heads')).toBe(heads);
    expect(mainState(sb.repo)).toEqual(before);
    const s = await statusJson(sb);
    expect(s.split.status).toBe('active');
    expect(s.mergeCheck?.status).toBe('failed');
    expect(s.mergeCheck?.result.conflictedPaths).toEqual(['README.md']);
    const status = await cli(sb, ['split', 'status']);
    expect(status.stdout).toContain('README.md');
    const conflicts = await cli(sb, ['conflicts', '--json']);
    expect(
      (JSON.parse(conflicts.stdout) as { kind: string }[]).some((c) => c.kind === 'merge_conflict'),
    ).toBe(true);
    // Once the page part drops its README change the check passes and the merge goes through.
    git(partDir(sb, 'page'), 'reset', '-q', '--hard', 'HEAD~1');
    const ok = await cli(sb, ['split', 'merge', '--force']);
    expect(ok.code).toBe(0);
    expect(branches(sb)).toContain('mindly/billing/integration');
  });

  it('abort removes the worktrees and branches it created and nothing else', async () => {
    const sb = await splitSandbox();
    git(sb.repo, 'branch', 'mindly/billing/unrelated');
    await createSplit(sb);
    const before = mainState(sb.repo);
    write(partDir(sb, 'api'), 'src/api/wip.ts', 'uncommitted\n');
    await hook(sb, partDir(sb, 'api'), 'api-session', 'SessionStart', { source: 'startup' });
    const noTty = await cli(sb, ['split', 'abort']);
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain('Part "Billing API": src/api/wip.ts');
    expect(existsSync(partDir(sb, 'api'))).toBe(true);
    const r = await cli(sb, ['split', 'abort', '--yes']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('removed 3 worktrees, deleted 3');
    // The work that went with them is named.
    expect(r.stdout).toContain('Uncommitted work was removed with a worktree');
    expect(r.stdout).toContain('Part "Billing API": src/api/wip.ts');
    expect(existsSync(worktreeRoot(sb))).toBe(false);
    expect(worktrees(sb)).toBe(1);
    expect(branches(sb)).toEqual(['mindly/billing/unrelated']);
    expect(mainState(sb.repo)).toEqual(before);
    const s = await statusJson(sb);
    expect(s.split.status).toBe('aborted');
    expect(s.parts.map((p) => p.task.status)).toEqual(['abandoned', 'abandoned', 'abandoned']);
    const handoffs = await cli(sb, ['handoffs', '--json']);
    expect(
      (JSON.parse(handoffs.stdout) as { status: string }[]).map((h) => h.status).sort(),
    ).toEqual(['cancelled', 'cancelled', 'claimed']);
    // The contract decisions of an aborted split are archived, not deleted.
    expect((await cli(sb, ['memory', 'list', '--json'])).stdout).not.toContain('GET /api/billing');
    const archived = await cli(sb, ['memory', 'list', '--archived', '--json']);
    expect(archived.stdout).toContain('[split billing] GET /api/billing');
    const again = await cli(sb, ['split', 'abort', '--yes']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already aborted');
    // A new split with the same name can start afterwards.
    await createSplit(sb);
    const kept = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(kept.code).toBe(0);
    expect(branches(sb)).toEqual([
      'mindly/billing/api',
      'mindly/billing/page',
      'mindly/billing/unrelated',
      'mindly/billing/webhook',
    ]);
    expect(worktrees(sb)).toBe(1);
  });
});

describe('agent planning (acceptance 5)', () => {
  /** Puts a fake `claude` on the sandbox PATH that logs its argv and prints `result`. */
  function fakeClaude(
    sb: Sandbox,
    result: string,
  ): { log(): { argv: string[]; stdin: string; cwd: string } | null } {
    const dir = tempDir('mindly-cli-fake-');
    const logPath = join(dir, 'log.json');
    symlinkSync(process.execPath, join(dir, 'node'));
    writeFileSync(
      join(dir, 'claude'),
      `#!/usr/bin/env node
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input, cwd: process.cwd() }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(result)}, session_id: 's', num_turns: 1 }));
});
`,
      { mode: 0o755 },
    );
    sb.env['PATH'] = `${dir}:${sb.env['PATH']}`;
    return {
      log: () =>
        existsSync(logPath)
          ? (JSON.parse(readFileSync(logPath, 'utf8')) as {
              argv: string[];
              stdin: string;
              cwd: string;
            })
          : null,
    };
  }

  it('asks Claude Code read-only and creates the split from its plan', async () => {
    const sb = await splitSandbox();
    expect(
      (await cli(sb, ['memory', 'add', '--kind', 'rule', '--title', 'Use pnpm, never npm'])).code,
    ).toBe(0);
    const fake = fakeClaude(sb, `Here you go:\n\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``);
    const r = await cli(sb, [
      'split',
      'Add billing: API, webhook handler, page',
      '--name',
      'billing',
      '--yes',
      '--parts',
      '3',
    ]);
    expect(r.stderr).toContain('Planning with Claude Code (read-only)');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Created 3 worktrees');
    const log = fake.log();
    expect(log?.cwd).toBe(sb.repo);
    expect(log?.argv).toEqual(expect.arrayContaining(['-p', '--permission-mode', 'plan']));
    expect(log?.argv).not.toContain('acceptEdits');
    expect(log?.argv[log.argv.indexOf('--disallowedTools') + 1]?.split(',')).toEqual(
      expect.arrayContaining(['Edit', 'Write', 'Bash']),
    );
    expect(log?.stdin).toContain('Add billing: API, webhook handler, page');
    expect(log?.stdin).toContain('exactly 3 parts');
    expect(log?.stdin).toContain('src/api/billing.ts');
    expect(log?.stdin).toContain('Use pnpm, never npm');
    expect(log?.stdin).toContain('claude-code');
    expect((await statusJson(sb)).parts).toHaveLength(3);
    const dry = await cli(sb, ['split', 'abort', '--yes']);
    expect(dry.code).toBe(0);
    const json = await cli(sb, ['split', 'Add billing again', '--dry-run', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ created: false, plannedBy: 'claude-code' });
  });

  it('rejects invalid JSON plans with a readable error and nothing created', async () => {
    const sb = await splitSandbox();
    const before = mainState(sb.repo);
    fakeClaude(sb, 'I would split this into an API part and a page part, but here is no JSON.');
    const noJson = await cli(sb, ['split', 'Add billing', '--yes']);
    expect(noJson.code).toBe(1);
    expect(noJson.stderr).toContain('Claude Code did not return a JSON plan');
    expect(noJson.stderr).toContain('mindly split --plan plan.json');

    fakeClaude(
      sb,
      JSON.stringify({
        goal: 'Add billing',
        parts: [
          {
            key: 'only',
            title: 'Only',
            agent: 'claude-code',
            owns: ['src/**'],
            dependsOn: [],
            brief: 'b',
          },
        ],
        contract: [],
      }),
    );
    const invalid = await cli(sb, ['split', 'Add billing', '--yes']);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('Claude Code returned an invalid plan');
    expect(invalid.stderr).toContain('parts');

    fakeClaude(
      sb,
      JSON.stringify({ ...PLAN, parts: [PLAN.parts[0], { ...PLAN.parts[1], owns: ['src/**'] }] }),
    );
    const overlap = await cli(sb, ['split', 'Add billing', '--yes']);
    expect(overlap.code).toBe(1);
    expect(overlap.stderr).toContain('both own');
    expect(existsSync(worktreeRoot(sb))).toBe(false);
    expect(branches(sb)).toEqual([]);
    expect(mainState(sb.repo)).toEqual(before);
  });

  it('explains when no planner is available or the planner is not installed', async () => {
    const sb = await splitSandbox();
    const none = await cli(sb, ['split', 'Add billing', '--yes']);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('No agent is available to plan the split');
    expect(none.stderr).toContain('mindly split --plan plan.json');
    const codex = await cli(sb, ['split', 'Add billing', '--planner', 'codex', '--yes']);
    expect(codex.code).toBe(1);
    expect(codex.stderr).toContain('Codex is not installed or not on PATH');
    const usage = await cli(sb, ['split']);
    expect(usage.code).toBe(2);
    const badPlanner = await cli(sb, ['split', 'goal', '--planner', 'gemini']);
    expect(badPlanner.code).toBe(2);
    mkdirSync(join(sb.home, 'x'));
  });
});
