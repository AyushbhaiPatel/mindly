import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryProcessLock } from '@mindly/engine';
import { describe, expect, it } from 'vitest';
import { cli, git, sandbox, write, type Sandbox } from './helpers.js';

/*
 * End to end: real Claude Code and Codex hook payloads make checkpoints in a sandbox repository,
 * `mindly sentinel run` runs the trusted check in its warm scratch tree, finds the Codex edit
 * that broke it, and Codex hears about it at its next prompt.
 */

const CC = 'cc-session-1';
const CX = 'cx-session-1';
const node = process.execPath;

const TEST_SCRIPT = `
const calc = require('./src/calc.js');
if (calc.add(2, 2) === 4) { console.log('ok'); process.exit(0); }
console.log('FAIL add(2,2) is ' + calc.add(2, 2));
process.exit(1);
`;
const SETUP_SCRIPT = `require('node:fs').appendFileSync(process.argv[2], 'ran\\n');`;
const calcSource = (step: number, broken: boolean): string =>
  `module.exports = { step: ${step}, add: (a, b) => a + b${broken ? ' + 1' : ''} };\n`;

async function hook(
  sb: Sandbox,
  agent: 'claude-code' | 'codex',
  event: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse',
  extra: Record<string, unknown> = {},
): Promise<string> {
  const sessionId = agent === 'codex' ? CX : CC;
  const payload = {
    session_id: sessionId,
    transcript_path: join(sb.home, `${sessionId}.jsonl`),
    cwd: sb.repo,
    permission_mode: 'default',
    hook_event_name: event,
    ...(agent === 'codex' ? { model: 'gpt-5-codex', turn_id: 'turn-1' } : {}),
    ...extra,
  };
  const r = await cli(sb, ['hook', agent, event], { stdin: JSON.stringify(payload) });
  expect(r.code).toBe(0);
  return r.stdout;
}

async function edit(sb: Sandbox, agent: 'claude-code' | 'codex', content: string): Promise<void> {
  const rel = 'src/calc.js';
  const previous = readFileSync(join(sb.repo, rel), 'utf8');
  write(sb.repo, rel, content);
  if (agent === 'claude-code') {
    await hook(sb, 'claude-code', 'PostToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: join(sb.repo, rel), content },
      tool_response: { filePath: join(sb.repo, rel), type: 'update' },
      tool_use_id: 'toolu_1',
    });
    return;
  }
  await hook(sb, 'codex', 'PostToolUse', {
    tool_name: 'apply_patch',
    tool_input: {
      command: `*** Begin Patch\n*** Update File: ${rel}\n@@\n-${previous.trimEnd()}\n+${content.trimEnd()}\n*** End Patch\n`,
    },
    tool_response: { output: 'Done!' },
    tool_use_id: 'call_1',
  });
}

/** A repository with the check committed and trusted, and both agents' sessions started. */
async function story(sb: Sandbox, setupLog: string): Promise<void> {
  mkdirSync(join(sb.repo, 'src'), { recursive: true });
  write(sb.repo, 'test.cjs', TEST_SCRIPT);
  write(sb.repo, 'setup.cjs', SETUP_SCRIPT);
  write(sb.repo, 'src/calc.js', calcSource(0, false));
  write(
    sb.repo,
    '.mindly/config.json',
    JSON.stringify({
      checks: [{ name: 'unit', argv: [node, 'test.cjs'], timeoutSec: 60 }],
      sentinel: { setup: [node, 'setup.cjs', setupLog] },
    }),
  );
  git(sb.repo, 'add', '-A');
  git(sb.repo, 'commit', '-q', '-m', 'calc');
  expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);
  await hook(sb, 'claude-code', 'SessionStart', { source: 'startup' });
  await hook(sb, 'codex', 'SessionStart', { source: 'startup' });
  await hook(sb, 'claude-code', 'UserPromptSubmit', { prompt: 'make add faster' });
  await hook(sb, 'codex', 'UserPromptSubmit', { prompt: 'inline the addition' });
}

interface PassJson {
  status: string;
  step: number;
  checks: {
    name: string;
    outcome: string;
    transition: string;
    told: string[];
    output: string | null;
    bisect: { status: string; firstBad: { seq: number; agentKind: string; prompt: string } | null };
  }[];
}

describe('mindly sentinel', () => {
  it('explains how to turn it on, and refuses to run untrusted checks', async () => {
    const sb = sandbox();
    const off = await cli(sb, ['sentinel']);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('The sentinel is off.');
    expect(off.stdout).toContain('mindly config set sentinel.enabled true');

    write(
      sb.repo,
      '.mindly/config.json',
      JSON.stringify({ checks: [{ name: 'unit', argv: [node, '-e', '1'] }] }),
    );
    const r = await cli(sb, ['sentinel', 'run']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('not trusted');
    expect(r.stderr).toContain('mindly trust');

    const json = JSON.parse((await cli(sb, ['sentinel', '--json'])).stdout) as {
      enabled: boolean;
      daemon: boolean;
      readiness: { ready: boolean; reason: string };
    };
    expect(json).toMatchObject({
      enabled: false,
      daemon: false,
      readiness: { ready: false, reason: 'untrusted' },
    });
  });

  it('does not call checks that could not run passing', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.repo, 'src'), { recursive: true });
    write(sb.repo, 'test.cjs', TEST_SCRIPT);
    write(sb.repo, 'src/calc.js', calcSource(0, false));
    write(
      sb.repo,
      '.mindly/config.json',
      JSON.stringify({
        checks: [
          { name: 'unit', argv: [node, 'test.cjs'], timeoutSec: 60 },
          { name: 'lint', argv: [node, '-e', '1'], timeoutSec: 60 },
        ],
        sentinel: { setup: [node, '-e', 'process.exit(3)'] },
      }),
    );
    git(sb.repo, 'add', '-A');
    git(sb.repo, 'commit', '-q', '-m', 'calc');
    expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);
    await hook(sb, 'claude-code', 'SessionStart', { source: 'startup' });
    expect((await cli(sb, ['trust', '-y'])).code).toBe(0);
    await edit(sb, 'claude-code', calcSource(1, false));

    // The setup command fails, so neither check runs.
    const none = await cli(sb, ['sentinel', 'run']);
    expect(none.code).toBe(1);
    expect(none.stdout).toContain('2 checks');
    expect(none.stdout).toContain('none could run');
    expect(none.stdout).not.toContain('all passing');
    expect(none.stdout).not.toContain('[ok]');
    expect(none.stdout).toContain('The setup command failed');

    // One check exits 125 ("cannot run here"), the other passes.
    write(
      sb.repo,
      '.mindly/config.json',
      JSON.stringify({
        checks: [
          { name: 'unit', argv: [node, 'test.cjs'], timeoutSec: 60 },
          { name: 'lint', argv: [node, '-e', 'process.exit(125)'], timeoutSec: 60 },
        ],
      }),
    );
    expect((await cli(sb, ['trust', '-y'])).code).toBe(0);
    const some = await cli(sb, ['sentinel', 'run']);
    expect(some.code).toBe(1);
    expect(some.stdout).toContain('1 did not run');
    expect(some.stdout).not.toContain('all passing');

    write(
      sb.repo,
      '.mindly/config.json',
      JSON.stringify({ checks: [{ name: 'unit', argv: [node, 'test.cjs'], timeoutSec: 60 }] }),
    );
    expect((await cli(sb, ['trust', '-y'])).code).toBe(0);
    const all = await cli(sb, ['sentinel', 'run']);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain('1 check, all passing');
  });

  it('finds the edit that broke the check and tells the agent that made it', async () => {
    const sb = sandbox();
    const setupLog = join(sb.home, 'setup.log');
    await story(sb, setupLog);
    // `mindly trust` shows the setup command too.
    const trust = await cli(sb, ['trust', '-y']);
    expect(trust.code).toBe(0);
    expect(trust.stdout).toContain('setup.cjs');

    await edit(sb, 'claude-code', calcSource(1, false));
    const base = await cli(sb, ['sentinel', 'run']);
    expect(base.code).toBe(0);
    expect(base.stdout).toContain('all passing');
    const status = git(sb.repo, 'status', '--porcelain');

    await edit(sb, 'codex', calcSource(2, false));
    await edit(sb, 'claude-code', calcSource(3, false));
    await edit(sb, 'codex', calcSource(4, true));
    await edit(sb, 'claude-code', calcSource(5, true));
    const run = await cli(sb, ['sentinel', 'run', '--json']);
    expect(run.code).toBe(1);
    const r = JSON.parse(run.stdout) as PassJson;
    const unit = r.checks[0]!;
    expect(unit).toMatchObject({ name: 'unit', outcome: 'fail', transition: 'broke' });
    expect(unit.bisect.status).toBe('found');
    expect(unit.bisect.firstBad).toMatchObject({
      agentKind: 'codex',
      prompt: 'inline the addition',
    });
    expect(unit.output).toContain('FAIL add(2,2) is 5');
    expect(unit.told).toHaveLength(1);
    const brokeAt = unit.bisect.firstBad!.seq;
    // Progress went to stderr.
    expect(run.stderr).toContain('finding the edit that broke unit');

    // The setup ran once in the warm tree; the user's checkout is untouched.
    expect(readFileSync(setupLog, 'utf8')).toBe('ran\n');
    expect(git(sb.repo, 'status', '--porcelain')).toBe(status);
    expect(git(sb.repo, 'worktree', 'list')).toContain(join(sb.mindlyHome, 'sentinel'));

    // Codex hears about it at its next prompt; Claude Code does not.
    const cx = await hook(sb, 'codex', 'UserPromptSubmit', { prompt: 'next thing' });
    expect(cx).toContain('Your edit broke check');
    expect(cx).toContain('FAIL add(2,2) is 5');
    const cc = await hook(sb, 'claude-code', 'UserPromptSubmit', { prompt: 'next thing' });
    expect(cc).not.toContain('Your edit broke check');

    const shown = await cli(sb, ['sentinel']);
    expect(shown.stdout).toContain(`unit - broke at step ${brokeAt} - codex #`);
    expect(shown.stdout).toContain(`mindly bisect revert ${brokeAt}`);
    const conflicts = await cli(sb, ['conflicts']);
    expect(conflicts.stdout).toContain(`Check "unit" broke at step ${brokeAt}`);

    // Codex fixes it; the conflict closes and the save counts.
    await edit(sb, 'codex', calcSource(6, false));
    const fixed = await cli(sb, ['sentinel', 'run']);
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain('passes again');
    const saves = await cli(sb, ['saves', '--json']);
    expect(JSON.stringify(JSON.parse(saves.stdout))).toContain('check_broken_early');
    // Nothing installed again: no lockfile or manifest changed.
    expect(readFileSync(setupLog, 'utf8')).toBe('ran\n');

    // Doctor reports it: off, since it only ran by hand here.
    const doctor = JSON.parse((await cli(sb, ['doctor', '--json'])).stdout) as {
      checks: { name: string; status: string; detail: string }[];
    };
    expect(doctor.checks.find((c) => c.name === 'sentinel')).toMatchObject({ status: 'info' });

    // While a pass holds the checkout (here: this test process), reset and forget refuse.
    const [watchDir] = readdirSync(join(sb.mindlyHome, 'sentinel'));
    const held = tryProcessLock(join(sb.mindlyHome, 'sentinel', watchDir as string, 'lock'))!;
    const busy = await cli(sb, ['sentinel', 'reset', '-y']);
    expect(busy.code).not.toBe(0);
    expect(busy.stderr).toContain('The sentinel is checking this checkout right now');
    expect((await cli(sb, ['forget', '--project', '-y'])).code).not.toBe(0);
    expect(git(sb.repo, 'worktree', 'list')).toContain(join(sb.mindlyHome, 'sentinel'));
    held.release();

    // Reset, then forget the project: the warm tree leaves the repository.
    expect((await cli(sb, ['sentinel', 'reset', '-y'])).code).toBe(0);
    expect(git(sb.repo, 'worktree', 'list')).not.toContain(join(sb.mindlyHome, 'sentinel'));
    await cli(sb, ['sentinel', 'run']);
    expect(git(sb.repo, 'worktree', 'list')).toContain(join(sb.mindlyHome, 'sentinel'));
    expect((await cli(sb, ['forget', '--project', '-y'])).code).toBe(0);
    expect(git(sb.repo, 'worktree', 'list')).not.toContain(join(sb.mindlyHome, 'sentinel'));
    expect(existsSync(join(sb.mindlyHome, 'sentinel'))).toBe(true);
  });
});
