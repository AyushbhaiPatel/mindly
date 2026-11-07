import { codename, shortId } from '@mindly/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cli, git, sandbox, write, type Sandbox } from './helpers.js';

/*
 * End-to-end output of the main commands on a realistic project: two agents, a rule they were
 * told, a conflict, a known pitfall and a handoff (the same story as the manual audit).
 */

function json<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text) as T;
}

async function hook(sb: Sandbox, agent: string, event: string, payload: object): Promise<void> {
  const r = await cli(sb, ['hook', agent, event], {
    stdin: JSON.stringify({ cwd: sb.repo, ...payload }),
  });
  expect(r.code).toBe(0);
}

async function story(): Promise<Sandbox> {
  const sb = sandbox();
  write(
    sb.repo,
    'src/auth.ts',
    'export function login(u: string) {\n  return { role: "admin" };\n}\n',
  );
  write(sb.repo, 'src/dash.ts', "import { login } from './auth';\nexport const d = login('x');\n");
  git(sb.repo, 'add', '-A');
  git(sb.repo, 'commit', '-q', '-m', 'app');
  await hook(sb, 'claude-code', 'SessionStart', { session_id: 'cc1', source: 'startup' });
  await hook(sb, 'codex', 'SessionStart', { session_id: 'cx1', source: 'startup' });
  await hook(sb, 'claude-code', 'UserPromptSubmit', {
    session_id: 'cc1',
    prompt: 'From now on always use pnpm, never npm.',
  });
  await hook(sb, 'claude-code', 'UserPromptSubmit', {
    session_id: 'cc1',
    prompt: "No, don't use default exports.",
  });
  await hook(sb, 'codex', 'PreToolUse', {
    session_id: 'cx1',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        'apply_patch',
        "*** Begin Patch\n*** Update File: src/dash.ts\n@@\n-export const d = login('x');\n+export const d = login('y');\n*** End Patch",
      ],
    },
  });
  write(
    sb.repo,
    'src/auth.ts',
    'export function login(u: string, pw: string) {\n  return { role: "admin" };\n}\n',
  );
  await hook(sb, 'claude-code', 'UserPromptSubmit', {
    session_id: 'cc1',
    prompt: 'Add a password parameter to login',
  });
  await hook(sb, 'claude-code', 'PostToolUse', {
    session_id: 'cc1',
    tool_name: 'Edit',
    tool_input: {
      file_path: `${sb.repo}/src/auth.ts`,
      old_string: 'login(u: string)',
      new_string: 'login(u: string, pw: string)',
    },
    tool_response: { success: true },
  });
  await hook(sb, 'codex', 'PostToolUse', {
    session_id: 'cx1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { exit_code: 1, stderr: 'missing script' },
  });
  expect(
    (await cli(sb, ['memory', 'add', '--kind', 'decision', '--title', 'Auth uses sessions'])).code,
  ).toBe(0);
  expect(
    (await cli(sb, ['handoff', '--summary', 'Finish the dashboard login form', '--to', 'cursor']))
      .code,
  ).toBe(0);
  return sb;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const JARGON_RE =
  /\b(Intents|proposed|session_start|intent_overlap|rate_limited|acknowledged|tokens?|pending|manual|claude-code #|codex #)\b/;

describe('human output on a real project', () => {
  let sb: Sandbox;
  beforeAll(async () => {
    sb = await story();
  }, 60_000);

  it('status answers first, names agents, lists what needs you with short ids', async () => {
    const r = await cli(sb, ['status']);
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toMatch(
      /^Mindly - mindly-cli-repo-\w+ - 2 agents working - 4 things need you$/,
    );
    // Agents are a table: name, status, branch, what the agent is doing.
    expect(r.stdout).toMatch(/Agent[\s|]+Session[\s|]+Status[\s|]+Branch[\s|]+Doing/);
    expect(r.stdout).toMatch(
      /\* Codex[\s|]+[a-z]+-[a-z]+-\d+[\s|]+working[\s|]+main[\s|]+editing src\/dash\.ts/,
    );
    expect(r.stdout).toMatch(
      /\* Claude Code[\s|]+[a-z]+-[a-z]+-\d+[\s|]+working[\s|]+main[\s|]+edited src\/auth\.ts/,
    );
    expect(r.stdout).toMatch(/\[!\] Conflict[\s|]+Claude Code changed/);
    const flat = r.stdout.replace(/[\s|]+/g, ' ');
    expect(flat).toContain('changed the exports of src/auth.ts;');
    expect(flat).toContain("Codex's");
    expect(flat).toContain('src/dash.ts uses them');
    expect(flat).toMatch(/Conflict Claude Code changed .* [a-z]+-[a-z]+-\d+ /);
    expect(flat).toContain('- Rule "Don\'t use default exports" - suggested by you');
    expect(flat).toContain('- Handoff Waiting for Cursor:');
    expect(flat).toContain('Finish the dashboard login form');
    expect(r.stdout).toMatch(
      /^-> mindly conflict [a-z]+-[a-z]+-\d+ resolve\s+mark the conflict resolved$/m,
    );
    expect(r.stdout).not.toMatch(UUID_RE);
    expect(r.stdout).not.toMatch(JARGON_RE);
    expect(r.stdout).not.toMatch(/Tasks|\(0\)/);
  });

  it('every main screen avoids full ids and internal words', async () => {
    for (const argv of [
      ['rules'],
      ['memory', 'list'],
      ['conflicts'],
      ['conflicts', '--all'],
      ['why', 'src/auth.ts:1'],
      ['xray'],
      ['standup'],
      ['handoffs'],
      ['snapshot', 'list'],
    ]) {
      const r = await cli(sb, argv);
      expect(r.code, argv.join(' ')).toBe(0);
      expect(r.stdout, argv.join(' ')).not.toMatch(UUID_RE);
      expect(r.stdout, argv.join(' ')).not.toMatch(JARGON_RE);
    }
    const xray = (await cli(sb, ['xray'])).stdout;
    expect(xray).toMatch(/At session start \(just now\), Codex received 1 item:/);
    expect(xray).toMatch(/Claude Code is working in this project too/);
  });

  it('accepts names, short ids, unique prefixes and full ids; lists candidates when ambiguous', async () => {
    const rules = json<{ proposed: { id: string; title: string }[] }>(
      (await cli(sb, ['rules', '--json'])).stdout,
    );
    const rule = rules.proposed[0];
    if (!rule) throw new Error('expected a proposed rule');
    const show = await cli(sb, ['memory', 'show', shortId(rule.id)]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("Rule: Don't use default exports");
    expect((await cli(sb, ['memory', 'show', rule.id])).code).toBe(0);
    expect((await cli(sb, ['memory', 'show', rule.id.replace(/-/g, '').slice(0, 31)])).code).toBe(
      0,
    );

    // Every id made in this test shares its time prefix.
    const ambiguous = await cli(sb, ['memory', 'show', rule.id.slice(0, 6)]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toMatch(/matches \d+ memories:/);
    expect(ambiguous.stderr).toMatch(
      new RegExp(`${shortId(rule.id)}  [a-z]+-[a-z]+-\\d+  Don't use default exports`),
    );
    expect(ambiguous.stderr).toContain('-> Use one of the ids above');

    const missing = await cli(sb, ['memory', 'show', 'deadbeef']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('[x] No memory named deadbeef in this project.');
    expect(missing.stderr).toContain(
      '-> See the memories and their names with: mindly memory list',
    );

    const bad = await cli(sb, ['memory', 'show', 'nope']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('-> See the options with: mindly memory show --help');

    const approve = await cli(sb, ['rules', '--approve', codename(rule.id)]);
    expect(approve.code).toBe(0);
    expect(approve.stdout).toContain('Approved rule "Don\'t use default exports".');

    const conflict = json<{ id: string }[]>((await cli(sb, ['conflicts', '--json'])).stdout)[0];
    if (!conflict) throw new Error('expected a conflict');
    const ack = await cli(sb, ['conflict', codename(conflict.id), 'ack']);
    expect(ack.stdout).toContain(`Conflict ${codename(conflict.id)} marked seen:`);

    const sessions = json<{ sessions: { id: string; agentKind: string }[] }>(
      (await cli(sb, ['status', '--json'])).stdout,
    ).sessions;
    const claude = sessions.find((s) => s.agentKind === 'claude-code');
    if (!claude) throw new Error('expected a Claude Code session');
    const xray = await cli(sb, ['xray', '--session', shortId(claude.id)]);
    expect(xray.code).toBe(0);
    expect(xray.stdout).toContain(`Context sent to Claude Code - ${shortId(claude.id)}`);

    const snap = json<{ id: string }[]>((await cli(sb, ['snapshot', 'list', '--json'])).stdout)[0];
    if (!snap) throw new Error('expected a snapshot');
    expect((await cli(sb, ['snapshot', 'diff', codename(snap.id)])).code).toBe(0);
  });

  it('keeps --json output exactly as before (full ids, raw enums, ms timestamps)', async () => {
    const memoryKeys = [
      'id',
      'projectId',
      'kind',
      'title',
      'body',
      'tags',
      'scope',
      'trust',
      'status',
      'source',
      'enforce',
      'pinned',
      'version',
      'supersedesId',
      'createdAt',
      'updatedAt',
      'lastVerifiedAt',
    ];
    const status = json<Record<string, unknown>>((await cli(sb, ['status', '--json'])).stdout);
    expect(Object.keys(status)).toEqual([
      'project',
      'trusted',
      'sessions',
      'tasks',
      'intents',
      'conflicts',
      'needsYou',
    ]);
    expect(Object.keys(status['needsYou'] as object)).toEqual([
      'proposedRules',
      'proposedMemories',
      'criticalConflicts',
      'pendingHandoffs',
    ]);

    const list = json<Record<string, unknown>[]>(
      (await cli(sb, ['memory', 'list', '--json'])).stdout,
    );
    for (const m of list) expect(Object.keys(m)).toEqual(memoryKeys);
    expect(list[0]?.['id']).toMatch(UUID_RE);

    const rules = json<Record<string, unknown>>((await cli(sb, ['rules', '--json'])).stdout);
    expect(Object.keys(rules)).toEqual(['approved', 'proposed']);

    const conflicts = json<Record<string, unknown>[]>(
      (await cli(sb, ['conflicts', '--all', '--json'])).stdout,
    );
    expect(Object.keys(conflicts[0] ?? {})).toEqual([
      'id',
      'projectId',
      'kind',
      'severity',
      'status',
      'title',
      'detail',
      'sessionIds',
      'paths',
      'fingerprint',
      'createdAt',
      'updatedAt',
      'resolvedAt',
    ]);
    expect(conflicts[0]?.['kind']).toBe('impact');
    expect(conflicts[0]?.['title']).toMatch(/^claude-code #[0-9a-f]{8} changed the exports/);

    const xray = json<{ label: string; packets: Record<string, unknown>[] }>(
      (await cli(sb, ['xray', '--json'])).stdout,
    );
    expect(Object.keys(xray)).toEqual(['sessionId', 'label', 'packets']);
    expect(xray.label).toMatch(/^codex #[0-9a-f]{8}$/);
    expect(Object.keys(xray.packets[0] ?? {})).toEqual([
      'id',
      'trigger',
      'query',
      'at',
      'tokenBudget',
      'tokensUsed',
      'included',
      'omitted',
    ]);
    expect(xray.packets[0]?.['trigger']).toBe('session_start');

    const handoffs = json<Record<string, unknown>[]>(
      (await cli(sb, ['handoffs', '--json'])).stdout,
    );
    expect(Object.keys(handoffs[0] ?? {})).toEqual([
      'id',
      'projectId',
      'fromSessionId',
      'toAgentKind',
      'taskId',
      'reason',
      'summary',
      'packet',
      'status',
      'claimedBySessionId',
      'createdAt',
      'claimedAt',
    ]);

    const snaps = json<Record<string, unknown>[]>(
      (await cli(sb, ['snapshot', 'list', '--json'])).stdout,
    );
    expect(Object.keys(snaps[0] ?? {})).toEqual([
      'id',
      'projectId',
      'label',
      'gitRef',
      'commit',
      'createdAt',
    ]);

    const doctor = json<{ ok: boolean; checks: Record<string, unknown>[] }>(
      (await cli(sb, ['doctor', '--json'])).stdout,
    );
    expect(Object.keys(doctor)).toEqual(['ok', 'checks']);
    for (const c of doctor.checks) expect(Object.keys(c)).toEqual(['name', 'status', 'detail']);
    expect(doctor.checks.map((c) => c['name']).slice(0, 3)).toEqual(['node', 'node:sqlite', 'git']);
    expect(doctor.checks.find((c) => c['name'] === 'database')?.['detail']).toMatch(
      /^schema v\d+$/,
    );

    expect(json((await cli(sb, ['daemon', 'status', '--json'])).stdout)).toEqual({
      running: false,
    });
  });
});
