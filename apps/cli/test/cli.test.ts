import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openMindly } from '@mindly/runtime';
import { diffSummary, runHook, styleFor } from '../src/index.js';
import { cli, fixture, sandbox, testIo, write, type Sandbox } from './helpers.js';

function json<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text) as T;
}

/** Adds a memory straight through the engine (e.g. as an agent, which makes it `proposed`). */
function agentMemory(sb: Sandbox, title: string): string {
  const mindly = openMindly({ env: sb.env, disableNotify: true, disableLlm: true });
  try {
    const project = mindly.store.projects.upsertByRoot(sb.repo, 'repo');
    return mindly.memory.remember({
      projectId: project.id,
      projectRoot: sb.repo,
      kind: 'rule',
      title,
      body: 'proposed by an agent',
      source: { type: 'agent', sessionId: null, agentKind: 'codex' },
    }).id;
  } finally {
    mindly.close();
  }
}

describe('init / uninstall', () => {
  it('writes hooks and MCP for a detected agent and is idempotent', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    const first = await cli(sb, ['init', '--yes']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Detected: Claude Code');
    expect(first.stdout).toContain(join(sb.home, '.claude', 'settings.json'));
    expect(first.stdout).toMatch(/\+\d+ -0 lines/);

    const settings = readFileSync(join(sb.home, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('hook claude-code SessionStart');
    expect(settings).toContain(process.execPath);
    const mcp = json<{ mcpServers: Record<string, { args: string[] }> }>(
      readFileSync(join(sb.home, '.claude.json'), 'utf8'),
    );
    expect(mcp.mcpServers['mindly']?.args).toEqual(
      expect.arrayContaining(['mcp', '--agent', 'claude-code']),
    );
    expect(existsSync(join(sb.home, '.codex'))).toBe(false);
    expect(existsSync(join(sb.mindlyHome, 'config.json'))).toBe(true);
    expect(existsSync(join(sb.mindlyHome, 'mindly.db'))).toBe(true);

    const second = await cli(sb, ['init', '--yes']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('already configured');
    expect(readFileSync(join(sb.home, '.claude', 'settings.json'), 'utf8')).toBe(settings);
  });

  it('dry-run and unconfirmed runs write nothing', async () => {
    const sb = sandbox();
    const dry = await cli(sb, ['init', '--agents', 'codex', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('Dry run');
    expect(existsSync(join(sb.home, '.codex'))).toBe(false);

    const noTty = await cli(sb, ['init', '--agents', 'codex']);
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain('--yes');
    expect(existsSync(join(sb.home, '.codex'))).toBe(false);

    const declined = await cli(sb, ['init', '--agents', 'codex'], { answers: ['n'] });
    expect(declined.code).toBe(1);
    expect(existsSync(join(sb.home, '.codex'))).toBe(false);

    const accepted = await cli(sb, ['init', '--agents', 'codex'], { answers: ['y'] });
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain('/hooks');
    expect(readFileSync(join(sb.home, '.codex', 'hooks.json'), 'utf8')).toContain('hook codex');

    const removed = await cli(sb, ['uninstall', '--agents', 'codex', '--yes']);
    expect(removed.code).toBe(0);
    expect(readFileSync(join(sb.home, '.codex', 'hooks.json'), 'utf8')).not.toContain('hook codex');
  });

  it('writes MCP config for MCP-only clients and keeps other servers', async () => {
    const sb = sandbox();
    const geminiFile = join(sb.home, '.gemini', 'settings.json');
    write(
      sb.home,
      join('.gemini', 'settings.json'),
      '{\n  // mine\n  "theme": "GitHub",\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n',
    );
    const r = await cli(sb, ['init', '--agents', 'windsurf,gemini', '--yes']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no automatic capture');
    expect(r.stdout).toContain('mindly_context');

    const windsurf = json<{ mcpServers: Record<string, { command: string; args: string[] }> }>(
      readFileSync(join(sb.home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'),
    );
    expect(windsurf.mcpServers['mindly']?.args.slice(-3)).toEqual(['mcp', '--agent', 'windsurf']);
    const gemini = readFileSync(geminiFile, 'utf8');
    expect(gemini).toContain('// mine');
    expect(gemini).toContain('"other": { "command": "x" }');
    expect(gemini).toMatch(/"--agent",\s+"gemini"/);

    const again = await cli(sb, ['init', '--agents', 'windsurf,gemini', '--yes']);
    expect(again.stdout).toContain('already configured');

    const doctor = await cli(sb, ['doctor', '--json']);
    const checks = json<{ checks: { name: string; status: string }[] }>(doctor.stdout).checks;
    expect(checks.find((c) => c.name === 'windsurf')?.status).toBe('ok');
    expect(checks.find((c) => c.name === 'zed')).toBeUndefined();

    const removed = await cli(sb, ['uninstall', '--yes']);
    expect(removed.code).toBe(0);
    expect(readFileSync(geminiFile, 'utf8')).not.toContain('mindly');
    expect(readFileSync(geminiFile, 'utf8')).toContain('"other"');
  });

  it('lists supported agents with their integration level', async () => {
    const sb = sandbox();
    const r = await cli(sb, ['init', '--list-agents']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/claude-code\s+hooks \+ MCP/);
    expect(r.stdout).toMatch(/windsurf\s+MCP tools/);
    expect(r.stdout).toContain('Claude Desktop (user scope only)');
    expect(existsSync(join(sb.mindlyHome, 'mindly.db'))).toBe(false);
  });

  it('rejects unknown agents as a usage error', async () => {
    const sb = sandbox();
    const r = await cli(sb, ['init', '--agents', 'vim']);
    expect(r.code).toBe(2);
  });
});

describe('hook', () => {
  it('SessionStart prints JSON with additionalContext', async () => {
    const sb = sandbox();
    expect(
      (await cli(sb, ['memory', 'add', '--kind', 'rule', '--title', 'Use pnpm, never npm'])).code,
    ).toBe(0);
    const payload = {
      ...fixture('claude-code.SessionStart'),
      cwd: sb.repo,
      transcript_path: join(sb.home, 'transcript.jsonl'),
    };
    const r = await cli(sb, ['hook', 'claude-code', 'SessionStart'], {
      stdin: JSON.stringify(payload),
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const out = json<{ hookSpecificOutput: { hookEventName: string; additionalContext: string } }>(
      r.stdout,
    );
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Use pnpm, never npm');
  });

  it('fails open on malformed, oversized or unknown input', async () => {
    const sb = sandbox();
    for (const [argv, stdin] of [
      [['hook', 'claude-code', 'SessionStart'], '{not json'],
      [['hook', 'claude-code', 'SessionStart'], ''],
      [['hook', 'claude-code', 'SessionStart'], 'x'.repeat(2 * 1024 * 1024 + 1)],
      [['hook', 'claude-code', 'NoSuchEvent'], '{}'],
      [['hook', 'not-an-agent', 'SessionStart'], '{}'],
      [['hook', 'claude-code', 'SessionStart'], JSON.stringify({ cwd: 42 })],
    ] as const) {
      const r = await cli(sb, [...argv], { stdin });
      expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    }
  });

  it('a hook that exceeds the deadline exits 0 quickly with no output', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '200'])).code).toBe(0);
    const io = testIo(sb, {
      stdin: JSON.stringify({ ...fixture('claude-code.SessionStart'), cwd: sb.repo }),
    });
    let closed = false;
    const started = Date.now();
    const code = await runHook('claude-code', 'SessionStart', io, {
      open: () => ({
        hooks: { handle: () => new Promise(() => undefined) } as never,
        close: () => {
          closed = true;
        },
      }),
    });
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(io.out.join('')).toBe('');
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(1000);
    expect(closed).toBe(false);
    const log = readFileSync(join(sb.mindlyHome, 'logs', 'mindly.log'), 'utf8');
    expect(log).toContain('deadline exceeded');
  });

  it('cold in-process hook latency stays well under a second', async () => {
    const sb = sandbox();
    const payload = JSON.stringify({ ...fixture('claude-code.SessionStart'), cwd: sb.repo });
    const started = performance.now();
    const r = await cli(sb, ['hook', 'claude-code', 'SessionStart'], { stdin: payload });
    const ms = performance.now() - started;
    expect(r.code).toBe(0);
    console.info(`cold in-process hook (new home, migrations, git): ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});

const BUILT_MAIN = join(import.meta.dirname, '..', 'dist', 'main.js');

describe.skipIf(!existsSync(BUILT_MAIN))('built binary', () => {
  it('cold `mindly hook` process latency stays well under a second', async () => {
    const sb = sandbox();
    // Something to say, so SessionStart answers with context.
    await cli(sb, ['memory', 'add', '--kind', 'rule', '--title', 'Use pnpm']);
    const payload = JSON.stringify({ ...fixture('claude-code.SessionStart'), cwd: sb.repo });
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const r = spawnSync(process.execPath, [BUILT_MAIN, 'hook', 'claude-code', 'SessionStart'], {
        input: payload,
        env: sb.env,
        cwd: sb.repo,
        encoding: 'utf8',
      });
      times.push(performance.now() - started);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toHaveProperty('hookSpecificOutput');
    }
    console.info(
      `mindly hook process: first ${times[0]?.toFixed(0)} ms, then ${times
        .slice(1)
        .map((t) => t.toFixed(0))
        .join(' / ')} ms`,
    );
    expect(Math.max(...times)).toBeLessThan(1500);
  });

  it('malformed stdin to the binary exits 0 with no output', () => {
    const sb = sandbox();
    const r = spawnSync(process.execPath, [BUILT_MAIN, 'hook', 'codex', 'PreToolUse'], {
      input: '{"oops"',
      env: sb.env,
      cwd: sb.repo,
      encoding: 'utf8',
    });
    expect(r).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });
});

describe('memory and rules', () => {
  it('add, approve, list and forget', async () => {
    const sb = sandbox();
    const add = await cli(sb, [
      'memory',
      'add',
      '--kind',
      'decision',
      '--title',
      'Sessions live in Redis',
      '--body',
      'Chosen for TTL support.',
      '--tag',
      'auth',
      '--tag',
      'infra',
      '--json',
    ]);
    expect(add.code).toBe(0);
    const added = json<{ id: string; trust: string; tags: string[] }>(add.stdout);
    expect(added.trust).toBe('approved');
    expect(added.tags).toEqual(['auth', 'infra']);

    const proposedId = agentMemory(sb, 'Run tests with vitest');
    const rules = json<{ proposed: { id: string }[] }>((await cli(sb, ['rules', '--json'])).stdout);
    expect(rules.proposed.map((m) => m.id)).toContain(proposedId);
    const approve = await cli(sb, ['memory', 'approve', proposedId]);
    expect(approve.code).toBe(0);
    expect(approve.stdout).toContain('approved');

    const list = json<{ id: string }[]>((await cli(sb, ['memory', 'list', '--json'])).stdout);
    expect(list.map((m) => m.id).sort()).toEqual([added.id, proposedId].sort());
    const search = await cli(sb, ['memory', 'search', 'redis']);
    expect(search.stdout).toContain('Sessions live in Redis');
    const show = await cli(sb, ['memory', 'show', added.id]);
    expect(show.stdout).toContain('Chosen for TTL support.');

    expect((await cli(sb, ['memory', 'forget', added.id])).code).toBe(1);
    const forget = await cli(sb, ['memory', 'forget', added.id, '--yes']);
    expect(forget.code).toBe(0);
    const gone = await cli(sb, ['memory', 'show', added.id]);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain('not found');
  });

  it('validates input', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['memory', 'add', '--kind', 'gossip', '--title', 'x'])).code).toBe(2);
    expect((await cli(sb, ['memory', 'show', 'not-an-id'])).code).toBe(2);
    expect(
      (await cli(sb, ['memory', 'add', '--kind', 'fact', '--title', 'x', '--enforce'])).code,
    ).toBe(2);
    expect((await cli(sb, ['memory', 'list', '--limit', '0'])).code).toBe(2);
  });

  it('contract add shows the pinned hash of a command', async () => {
    const sb = sandbox();
    const m = json<{ id: string }>(
      (await cli(sb, ['memory', 'add', '--kind', 'fact', '--title', 'Typecheck passes', '--json']))
        .stdout,
    );
    const r = await cli(sb, [
      'contract',
      'add',
      m.id,
      '--kind',
      'command',
      '--argv',
      '["pnpm","typecheck"]',
      '--yes',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pinned hash: [0-9a-f]{64}/);
    const bad = await cli(sb, ['contract', 'add', m.id, '--kind', 'file_exists', '--path', '../x']);
    expect(bad.code).toBe(1);
    const deny = await cli(sb, [
      'contract',
      'add',
      m.id,
      '--kind',
      'file_exists',
      '--path',
      '.env',
    ]);
    expect(deny.code).toBe(1);
    expect(deny.stderr).toContain('deny-list');
    write(sb.repo, 'package.json', '{"name":"demo"}\n');
    const ok = await cli(sb, [
      'contract',
      'add',
      m.id,
      '--kind',
      'json_key',
      '--path',
      'package.json',
      '--key',
      'name',
    ]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('pass');
  });
});

describe('why', () => {
  it('traces a line back to the agent edit that wrote it', async () => {
    const sb = sandbox();
    const line = 'export const answer = computeTheAnswerFromDeepThought();';
    write(sb.repo, 'src/answer.ts', `${line}\n`);
    const base = fixture('claude-code.PostToolUse.Write');
    const payload = {
      ...base,
      cwd: sb.repo,
      transcript_path: join(sb.home, 't.jsonl'),
      tool_input: { file_path: join(sb.repo, 'src/answer.ts'), content: `${line}\n` },
      tool_response: { filePath: join(sb.repo, 'src/answer.ts'), type: 'create' },
    };
    expect(
      (await cli(sb, ['hook', 'claude-code', 'PostToolUse'], { stdin: JSON.stringify(payload) }))
        .code,
    ).toBe(0);
    const r = await cli(sb, ['why', 'answer.ts:1', '--json'], { cwd: join(sb.repo, 'src') });
    expect(r.code).toBe(0);
    const result = json<{ path: string; changes: { agentKind: string; tool: string }[] }>(r.stdout);
    expect(result.path).toBe('src/answer.ts');
    expect(result.changes[0]).toMatchObject({ agentKind: 'claude-code', tool: 'Write' });
    const text = await cli(sb, ['why', 'src/answer.ts:1']);
    expect(text.stdout).toContain('Written by');

    expect((await cli(sb, ['why', 'src/answer.ts'])).code).toBe(2);
    expect((await cli(sb, ['why', '../../etc/passwd:1'])).code).toBe(1);
    write(sb.repo, '.env', 'TOKEN=abc\n');
    const denied = await cli(sb, ['why', '.env:1']);
    expect(denied.code).toBe(1);
    expect(denied.stdout).not.toContain('abc');
  });
});

describe('trust', () => {
  it('shows the checks and hash, asks, then trusts that exact config', async () => {
    const sb = sandbox();
    write(
      sb.repo,
      '.mindly/config.json',
      JSON.stringify({ checks: [{ name: 'typecheck', argv: ['pnpm', 'typecheck'] }] }),
    );
    const show = json<{ trusted: boolean; configHash: string; checks: { argv: string[] }[] }>(
      (await cli(sb, ['trust', '--show', '--json'])).stdout,
    );
    expect(show.trusted).toBe(false);
    expect(show.checks[0]?.argv).toEqual(['pnpm', 'typecheck']);

    const refused = await cli(sb, ['trust']);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain(show.configHash);
    expect(refused.stdout).toContain('["pnpm","typecheck"]');

    const declined = await cli(sb, ['trust'], { answers: [''] });
    expect(declined.code).toBe(1);

    const yes = await cli(sb, ['trust', '--yes']);
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('Trusted');
    expect(
      json<{ trusted: boolean }>((await cli(sb, ['trust', '--show', '--json'])).stdout).trusted,
    ).toBe(true);

    write(
      sb.repo,
      '.mindly/config.json',
      JSON.stringify({ checks: [{ name: 'typecheck', argv: ['rm', '-rf', '/'] }] }),
    );
    expect(
      json<{ trusted: boolean }>((await cli(sb, ['trust', '--show', '--json'])).stdout).trusted,
    ).toBe(false);

    expect((await cli(sb, ['trust', '--revoke'])).code).toBe(0);
  });
});

describe('doctor, config, export, misc', () => {
  it('doctor reports checks without secrets', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    const secret = 'A'.repeat(43);
    writeFileSync(join(sb.mindlyHome, 'daemon.token'), `${secret}\n`, { mode: 0o600 });
    const r = await cli(sb, ['doctor']);
    expect(r.stdout).toMatch(/ok\s+node/);
    expect(r.stdout).toMatch(/ok\s+database\s+schema v\d+/);
    expect(r.stdout).toMatch(/ok\s+claude-code\s+hooks and MCP server configured/);
    expect(r.stdout).toMatch(/info\s+daemon\s+not running/);
    expect(r.stdout).toContain('no project config');
    expect(r.stdout).not.toContain(secret);
    expect(r.code).toBe(0);
    const j = json<{ ok: boolean; checks: { name: string }[] }>(
      (await cli(sb, ['doctor', '--json'])).stdout,
    );
    expect(j.ok).toBe(true);
  });

  it('config set validates values and keys', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '1000'])).code).toBe(0);
    expect((await cli(sb, ['config', 'get', 'hooks.timeoutMs'])).stdout.trim()).toBe('1000');
    const tooLow = await cli(sb, ['config', 'set', 'hooks.timeoutMs', '5']);
    expect(tooLow.code).toBe(1);
    expect(tooLow.stderr).toContain('invalid value');
    expect((await cli(sb, ['config', 'set', 'hooks.nope', '1'])).code).toBe(1);
    expect((await cli(sb, ['config', 'set', '__proto__.polluted', '1'])).code).toBe(2);
    expect((await cli(sb, ['config', 'set', 'llm.provider', 'ollama'])).code).toBe(0);
    const file = join(sb.mindlyHome, 'config.json');
    expect(json(readFileSync(file, 'utf8'))).toEqual({
      hooks: { timeoutMs: 1000 },
      llm: { provider: 'ollama' },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await cli(sb, ['config', 'path'])).stdout.trim()).toBe(file);
  });

  it('export writes owner-only JSON and refuses to overwrite', async () => {
    const sb = sandbox();
    await cli(sb, ['memory', 'add', '--kind', 'fact', '--title', 'Exported fact']);
    const r = await cli(sb, ['export', '--out', 'mindly-export.json']);
    expect(r.code).toBe(0);
    const file = join(sb.repo, 'mindly-export.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const data = json<{ format: string; memories: { title: string }[]; events: unknown[] }>(
      readFileSync(file, 'utf8'),
    );
    expect(data.format).toBe('mindly-export');
    expect(data.memories.map((m) => m.title)).toEqual(['Exported fact']);
    expect((await cli(sb, ['export', '--out', 'mindly-export.json'])).code).toBe(1);
    expect((await cli(sb, ['export', '--out', 'mindly-export.json', '--force'])).code).toBe(0);
  });

  it('forget --project deletes the project data after confirmation', async () => {
    const sb = sandbox();
    await cli(sb, ['memory', 'add', '--kind', 'fact', '--title', 'Doomed']);
    expect((await cli(sb, ['forget', '--project'])).code).toBe(1);
    expect((await cli(sb, ['forget', '--project', '--yes'])).code).toBe(0);
    expect(json<unknown[]>((await cli(sb, ['memory', 'list', '--json'])).stdout)).toEqual([]);
  });

  it('status, conflicts, standup, snapshots and daemon status work on a fresh project', async () => {
    const sb = sandbox();
    const status = await cli(sb, ['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('No live agent sessions.');
    expect(status.stdout).not.toContain('\u001b[');
    expect((await cli(sb, ['conflicts'])).stdout).toContain('No open conflicts.');
    expect((await cli(sb, ['standup', '--since', '24h'])).code).toBe(0);
    expect((await cli(sb, ['standup', '--since', 'yesterday'])).code).toBe(2);
    const snap = json<{ id: string }>(
      (await cli(sb, ['snapshot', 'create', 'before', '--json'])).stdout,
    );
    expect((await cli(sb, ['snapshot', 'list'])).stdout).toContain(snap.id);
    expect((await cli(sb, ['snapshot', 'diff', snap.id])).stdout).toContain('Memories added: 0');
    expect((await cli(sb, ['snapshot', 'restore', snap.id])).code).toBe(1);
    expect((await cli(sb, ['daemon', 'status'])).stdout).toContain('Not running');
    expect((await cli(sb, ['xray'])).code).toBe(1);
    expect((await cli(sb, ['handoff', '--summary', 'continue'])).code).toBe(1);
  });

  it('exit codes: usage 2, help 0', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['no-such-command'])).code).toBe(2);
    expect(
      (await cli(sb, ['conflict', '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'explode'])).code,
    ).toBe(2);
    const help = await cli(sb, ['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('init');
  });
});

describe('output helpers', () => {
  it('colour only on a TTY without NO_COLOR', () => {
    expect(styleFor({ write: () => undefined, isTTY: true }, {}).enabled).toBe(true);
    expect(styleFor({ write: () => undefined, isTTY: true }, { NO_COLOR: '1' }).enabled).toBe(
      false,
    );
    expect(styleFor({ write: () => undefined, isTTY: false }, {}).enabled).toBe(false);
  });

  it('diffSummary counts changes and redacts secrets', () => {
    const d = diffSummary(
      '{\n  "a": 1\n}\n',
      '{\n  "a": 1,\n  "token": "ghp_0123456789abcdefghijABCDEFGHIJ012345"\n}\n',
    );
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.join('\n')).not.toContain('ghp_0123456789');
    expect(diffSummary(null, 'x\ny\n')).toMatchObject({ added: 2, removed: 0 });
  });
});
