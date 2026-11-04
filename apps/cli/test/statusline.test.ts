import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatGlance, NEUTRAL_LINE } from '../src/index.js';
import { cli, sandbox, tempDir, type Sandbox } from './helpers.js';

const OWN = { type: 'command', command: '~/.claude/statusline.sh' };

function payload(dir: string, sessionId = 'cc-session-1'): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd: dir,
    model: { id: 'claude-opus', display_name: 'Opus' },
    workspace: { current_dir: dir, project_dir: dir },
  });
}

function settingsOf(sb: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sb.home, '.claude', 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('mindly statusline', () => {
  it('formats counts with singular and plural words', () => {
    expect(formatGlance({ projectName: 'p', rules: 3, updates: 1, conflicts: 0 })).toBe(
      'mindly · 3 rules · 1 update · 0 conflicts',
    );
  });

  it('prints the counts for the session project', async () => {
    const sb = sandbox();
    await cli(sb, ['memory', 'add', '--kind', 'rule', '--title', 'Use pnpm']);
    const sub = join(sb.repo, 'src');
    mkdirSync(sub);
    const r = await cli(sb, ['statusline'], { cwd: sb.home, stdin: payload(sub) });
    expect(r).toEqual({
      code: 0,
      stdout: 'mindly · 1 rule · 0 updates · 0 conflicts\n',
      stderr: '',
    });
  });

  it('degrades to a short neutral line and never creates the database', async () => {
    const sb = sandbox();
    const none = await cli(sb, ['statusline'], { stdin: payload(sb.repo) });
    expect(none).toEqual({ code: 0, stdout: `${NEUTRAL_LINE}\n`, stderr: '' });
    expect(existsSync(join(sb.mindlyHome, 'mindly.db'))).toBe(false);

    await cli(sb, ['memory', 'add', '--kind', 'rule', '--title', 'Use pnpm']);
    const elsewhere = await cli(sb, ['statusline'], { stdin: payload(tempDir('mindly-x-')) });
    expect(elsewhere.stdout).toBe('mindly · not set up here\n');

    for (const junk of ['', 'not json', '[1,2]', '{"cwd": 5}']) {
      const r = await cli(sb, ['statusline'], { stdin: junk });
      // Without a usable payload it answers for the working directory (the repo here).
      expect(r).toEqual({
        code: 0,
        stdout: 'mindly · 1 rule · 0 updates · 0 conflicts\n',
        stderr: '',
      });
    }

    const gone = await cli(sb, ['statusline'], { stdin: payload(join(sb.repo, 'missing')) });
    expect(gone).toEqual({ code: 0, stdout: `${NEUTRAL_LINE}\n`, stderr: '' });
  });
});

describe('statusline setup', () => {
  it('init adds it, doctor reports it and uninstall removes it', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    const init = await cli(sb, ['init', '--yes', '--agents', 'claude-code']);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('Register Mindly hooks and status line for Claude Code');
    expect(settingsOf(sb)['statusLine']).toMatchObject({
      type: 'command',
      command: expect.stringMatching(/ statusline$/) as unknown,
    });

    const doctor = await cli(sb, ['doctor', '--json']);
    const checks = (JSON.parse(doctor.stdout) as { checks: { name: string; status: string }[] })
      .checks;
    expect(checks.find((c) => c.name === 'claude-code')?.status).toBe('ok');
    expect(checks.find((c) => c.name === 'claude-code-statusline')?.status).toBe('ok');

    const un = await cli(sb, ['uninstall', '--yes', '--agents', 'claude-code']);
    expect(un.code).toBe(0);
    expect(settingsOf(sb)['statusLine']).toBeUndefined();
  });

  it("init keeps the user's own status line and explains how to chain it", async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    writeFileSync(join(sb.home, '.claude', 'settings.json'), JSON.stringify({ statusLine: OWN }));
    const init = await cli(sb, ['init', '--yes', '--agents', 'claude-code']);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('Claude Code already has a status line');
    expect(init.stdout).toContain('mindly statusline');
    expect(settingsOf(sb)['statusLine']).toEqual(OWN);

    const doctor = await cli(sb, ['doctor', '--json']);
    const checks = (JSON.parse(doctor.stdout) as { checks: { name: string; status: string }[] })
      .checks;
    expect(checks.find((c) => c.name === 'claude-code')?.status).toBe('ok');
    expect(checks.find((c) => c.name === 'claude-code-statusline')).toMatchObject({
      status: 'info',
    });

    await cli(sb, ['uninstall', '--yes', '--agents', 'claude-code']);
    expect(settingsOf(sb)['statusLine']).toEqual(OWN);
  });

  it('keeps a user status line that pipes into mindly statusline through init and uninstall', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    const piped = { type: 'command', command: 'sh ~/.claude/status.sh | mindly statusline' };
    writeFileSync(join(sb.home, '.claude', 'settings.json'), JSON.stringify({ statusLine: piped }));
    const init = await cli(sb, ['init', '--yes', '--agents', 'claude-code']);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('Claude Code already has a status line');
    expect(settingsOf(sb)['statusLine']).toEqual(piped);
    const un = await cli(sb, ['uninstall', '--yes', '--agents', 'claude-code']);
    expect(un.code).toBe(0);
    expect(settingsOf(sb)['statusLine']).toEqual(piped);
  });

  it('init --no-statusline connects Claude Code without it', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    const init = await cli(sb, ['init', '--yes', '--agents', 'claude-code', '--no-statusline']);
    expect(init.code).toBe(0);
    expect(settingsOf(sb)['statusLine']).toBeUndefined();
    expect(settingsOf(sb)['hooks']).toBeDefined();
    const doctor = await cli(sb, ['doctor', '--json']);
    expect(doctor.stdout).toContain('"claude-code-statusline"');
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true });
  });
});

const BUILT_MAIN = join(import.meta.dirname, '..', 'dist', 'main.js');

describe.skipIf(!existsSync(BUILT_MAIN))('built binary', () => {
  it('answers fast, and without stdin it neither hangs nor fails', async () => {
    const sb = sandbox();
    await cli(sb, ['memory', 'add', '--kind', 'rule', '--title', 'Use pnpm']);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const r = spawnSync(process.execPath, [BUILT_MAIN, 'statusline'], {
        input: payload(sb.repo),
        env: sb.env,
        cwd: sb.home,
        encoding: 'utf8',
      });
      times.push(performance.now() - started);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toBe('mindly · 1 rule · 0 updates · 0 conflicts\n');
    }
    console.info(`mindly statusline process: ${times.map((t) => t.toFixed(0)).join(' / ')} ms`);
    // Generous for loaded CI machines; typical is well under 100 ms.
    expect(Math.min(...times)).toBeLessThan(1000);

    // stdin left open (as in a terminal): the stdin wait is bounded.
    const open = spawnSync(process.execPath, [BUILT_MAIN, 'statusline'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sb.env,
      cwd: sb.repo,
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(open.status).toBe(0);
    expect(open.stdout).toBe('mindly · 1 rule · 0 updates · 0 conflicts\n');
  });
});
