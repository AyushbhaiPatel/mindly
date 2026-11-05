import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { shortId } from '@mindly/core';
import { cli, git, sandbox, write, type Sandbox } from './helpers.js';

/*
 * `mindly saves`, its card and the saves on the status line, `mindly status` and the standup,
 * on a project whose saves come from real hook calls: Codex is blocked by an enforced rule and
 * finishes its turn (a counted save), and is warned before repeating a failed command (pending).
 */

function json<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text) as T;
}

async function hook(sb: Sandbox, agent: string, event: string, payload: object): Promise<string> {
  const r = await cli(sb, ['hook', agent, event], {
    stdin: JSON.stringify({ cwd: sb.repo, ...payload }),
  });
  expect(r.code).toBe(0);
  return r.stdout;
}

function statusPayload(sb: Sandbox): string {
  return JSON.stringify({ session_id: 'cc1', cwd: sb.repo, workspace: { current_dir: sb.repo } });
}

const SECRET_CODE = 'export const apiKeyHeader = 1;';

async function story(): Promise<Sandbox> {
  const sb = sandbox();
  write(sb.repo, 'src/generated/api.ts', 'export const api = 1;\n');
  git(sb.repo, 'add', '-A');
  git(sb.repo, 'commit', '-q', '-m', 'app');
  const add = await cli(sb, [
    'memory',
    'add',
    '--kind',
    'rule',
    '--title',
    'Never edit generated code',
    '--scope',
    'src/generated/**',
    '--enforce',
  ]);
  expect(add.code).toBe(0);
  await hook(sb, 'claude-code', 'SessionStart', { session_id: 'cc1', source: 'startup' });
  await hook(sb, 'codex', 'SessionStart', { session_id: 'cx1', source: 'startup' });
  const denied = await hook(sb, 'codex', 'PreToolUse', {
    session_id: 'cx1',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        'apply_patch',
        `*** Begin Patch\n*** Update File: src/generated/api.ts\n@@\n-export const api = 1;\n+${SECRET_CODE}\n*** End Patch`,
      ],
    },
  });
  expect(denied).toContain('deny');
  await hook(sb, 'codex', 'Stop', { session_id: 'cx1' });
  await hook(sb, 'claude-code', 'PostToolUse', {
    session_id: 'cc1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { exit_code: 1, stderr: 'missing script' },
  });
  const warned = await hook(sb, 'codex', 'PreToolUse', {
    session_id: 'cx1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  expect(warned).toContain('failed before');
  return sb;
}

interface SavesJson {
  since: number;
  summary: { total: number; byKind: Record<string, number>; byAgent: Record<string, number> };
  saves: { id: string; kind: string; status: string; title: string; evidence: string[] }[];
}

describe('mindly saves', () => {
  let sb: Sandbox;
  beforeAll(async () => {
    sb = await story();
  }, 60_000);

  it('--json lists counted and pending saves with their evidence', async () => {
    const r = await cli(sb, ['saves', '--json']);
    expect(r.code).toBe(0);
    const out = json<SavesJson>(r.stdout);
    expect(Object.keys(out)).toEqual(['since', 'summary', 'saves']);
    expect(out.summary).toEqual({
      total: 1,
      byKind: { rule_enforced: 1 },
      byAgent: { codex: 1 },
    });
    expect(out.saves.map((s) => [s.kind, s.status])).toEqual([
      ['mistake_avoided', 'caught'],
      ['rule_enforced', 'confirmed'],
    ]);
    const rule = out.saves[1]!;
    expect(rule.title).toBe('A write by Codex was blocked by your rule');
    expect(rule.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('shows plain sentences, what is pending and what to do next', async () => {
    const r = await cli(sb, ['saves']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Mindly - mindly-cli-repo-\w+ - 1 save in the last 7 days/);
    expect(r.stdout).toContain('A write by Codex was blocked by your rule');
    expect(r.stdout).toContain('Pending (waiting for evidence, not counted yet)');
    expect(r.stdout).toContain("Codex didn't repeat a command that failed before");
    expect(r.stdout).toMatch(/mindly saves reject [0-9a-f]{8}/);
    expect(r.stdout).not.toMatch(/rule_enforced|mistake_avoided|caught|confirmed/);
  });

  it('leads the status line, adds a line to status and a section to the standup', async () => {
    const line = await cli(sb, ['statusline'], { cwd: sb.home, stdin: statusPayload(sb) });
    expect(line.stdout).toBe('mindly · 1 save today · 1 rule · 0 updates · 0 conflicts\n');
    const status = await cli(sb, ['status']);
    expect(status.stdout).toContain('Mindly saved you once today - mindly saves');
    const standup = await cli(sb, ['standup']);
    expect(standup.stdout).toContain('Mindly saved you once:');
    expect(standup.stdout).toContain('A write by Codex was blocked by your rule');
  });

  it('leaves the --json of existing commands without saves', async () => {
    for (const argv of [
      ['status', '--json'],
      ['standup', '--json'],
    ]) {
      const r = await cli(sb, argv);
      expect(r.code, argv.join(' ')).toBe(0);
      expect(r.stdout, argv.join(' ')).not.toMatch(/save/i);
    }
  });
});

describe('mindly saves card (AC6)', () => {
  let sb: Sandbox;
  beforeAll(async () => {
    sb = await story();
  }, 60_000);

  it('has counts and agent names only, no project name, path or code, without --details', async () => {
    const r = await cli(sb, ['saves', 'card']);
    expect(r.code).toBe(0);
    const svg = r.stdout;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Writes blocked by your rules');
    expect(svg).toContain('Codex');
    for (const secret of [
      basename(sb.repo),
      sb.repo,
      'src/generated',
      'api.ts',
      'npm test',
      'apiKeyHeader',
      SECRET_CODE,
    ]) {
      expect(svg, secret).not.toContain(secret);
    }
    expect(svg).not.toMatch(/[\w-]+\/[\w.-]+\.(?:ts|js|json|md)/);
  });

  it('adds the project name, sentences and files only with --details', async () => {
    const r = await cli(sb, ['saves', 'card', '--details']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(basename(sb.repo));
    expect(r.stdout).toContain('src/generated/api.ts');
    expect(r.stdout).toContain('A write by Codex was blocked by your rule');
    expect(r.stdout).not.toContain(SECRET_CODE);
  });

  it('writes an .svg file, refuses .png and never overwrites without --force', async () => {
    const out = join(sb.home, 'card.svg');
    const first = await cli(sb, ['saves', 'card', '--week', '--out', out]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('no project name, file paths or code');
    expect(readFileSync(out, 'utf8')).not.toContain('src/generated');
    const again = await cli(sb, ['saves', 'card', '--out', out]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('--force');
    expect((await cli(sb, ['saves', 'card', '--out', out, '--force'])).code).toBe(0);
    const png = await cli(sb, ['saves', 'card', '--out', join(sb.home, 'card.png')]);
    expect(png.code).not.toBe(0);
    expect(png.stderr).toContain('Share button under Saves in Mission Control');
    expect(existsSync(join(sb.home, 'card.png'))).toBe(false);
  });
});

describe('mindly saves reject (AC2)', () => {
  it('removes a save from every total', async () => {
    const sb = await story();
    const before = json<SavesJson>((await cli(sb, ['saves', '--json'])).stdout);
    const rule = before.saves.find((s) => s.kind === 'rule_enforced')!;
    const r = await cli(sb, ['saves', 'reject', shortId(rule.id)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Save [0-9a-f]{8} removed from every total/);
    const after = json<SavesJson>((await cli(sb, ['saves', '--json'])).stdout);
    expect(after.summary.total).toBe(0);
    expect(after.saves.map((s) => s.kind)).toEqual(['mistake_avoided']);
    const all = json<SavesJson>((await cli(sb, ['saves', '--all', '--json'])).stdout);
    expect(all.saves.find((s) => s.id === rule.id)?.status).toBe('rejected');
    const line = await cli(sb, ['statusline'], { cwd: sb.home, stdin: statusPayload(sb) });
    expect(line.stdout).toBe('mindly · 1 rule · 0 updates · 0 conflicts\n');
    expect((await cli(sb, ['status'])).stdout).not.toContain('saved you');
    expect((await cli(sb, ['saves', 'card'])).stdout).not.toContain('Writes blocked');
    const twice = await cli(sb, ['saves', 'reject', rule.id]);
    expect(twice.stdout).toContain('was already removed from every total');
  });
});
