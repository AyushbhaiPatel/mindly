// A rescan credits an agent only with edits recorded in the working tree it scans. Every hook
// moves the session to its own cwd, so where the session is now says nothing about where an
// earlier edit was made: an agent that edited src/calc.js in a linked worktree and then sends a
// hook from the main checkout must not be credited (and blamed) for a hand edit there.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bisectList, bisectRun } from '../src/commands/bisect.js';
import { outFor } from '../src/util.js';
import { cli, git, sandbox, tempDir, testIo, write, type Sandbox } from './helpers.js';

const CC = 'cc-session-1';
const CX = 'cx-session-1';
const NODE = process.execPath;

const TEST_SCRIPT = `
const path = require('node:path');
const calc = require(path.join(__dirname, 'src', 'calc.js'));
if (calc.add(2, 2) === 4) { console.log('ok'); process.exit(0); }
console.log('FAIL'); process.exit(1);
`;

function calcSource(step: number, broken: boolean): string {
  return `module.exports = { step: ${step}, add: (a, b) => a + b${broken ? ' + 1' : ''} };\n`;
}

async function hook(
  sb: Sandbox,
  agent: 'claude-code' | 'codex',
  sessionId: string,
  event: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse',
  extra: Record<string, unknown> = {},
  cwd: string = sb.repo,
): Promise<void> {
  const payload = {
    session_id: sessionId,
    transcript_path: join(sb.home, `${sessionId}.jsonl`),
    cwd,
    permission_mode: 'default',
    hook_event_name: event,
    ...(agent === 'codex' ? { model: 'gpt-5-codex', turn_id: 'turn-1' } : {}),
    ...extra,
  };
  const r = await cli(sb, ['hook', agent, event], { stdin: JSON.stringify(payload), cwd });
  expect(r.code).toBe(0);
}

interface StepJson {
  seq: number;
  kind: string;
  gap: boolean;
  agentKind: string | null;
  paths: string[];
}

async function list(sb: Sandbox, cwd = sb.repo): Promise<StepJson[]> {
  const io = testIo(sb, { cwd });
  expect(await bisectList(outFor(io), { json: true })).toBe(0);
  return (JSON.parse(io.out.join('')) as { steps: StepJson[] }).steps.reverse();
}

describe('who a step belongs to', () => {
  it('does not credit a hand edit to an agent whose edit of that path was in another worktree', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.repo, 'src'), { recursive: true });
    write(sb.repo, 'test.cjs', TEST_SCRIPT);
    write(sb.repo, 'src/calc.js', calcSource(0, false));
    git(sb.repo, 'add', '-A');
    git(sb.repo, 'commit', '-q', '-m', 'scripts');
    expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);
    const other = join(tempDir('mindly-wt-'), 'feature');
    git(sb.repo, 'worktree', 'add', '-q', '-b', 'feature', other);
    await hook(sb, 'claude-code', CC, 'SessionStart', { source: 'startup' });
    await hook(sb, 'codex', CX, 'SessionStart', { source: 'startup' }, other);
    await hook(sb, 'codex', CX, 'UserPromptSubmit', { prompt: 'tidy calc' }, other);
    // Codex makes a harmless edit to src/calc.js in its own worktree.
    const previous = readFileSync(join(other, 'src', 'calc.js'), 'utf8');
    writeFileSync(join(other, 'src', 'calc.js'), calcSource(1, false));
    await hook(
      sb,
      'codex',
      CX,
      'PostToolUse',
      {
        tool_name: 'apply_patch',
        tool_input: {
          command: `*** Begin Patch\n*** Update File: src/calc.js\n@@\n-${previous.trimEnd()}\n+${calcSource(1, false).trimEnd()}\n*** End Patch\n`,
        },
        tool_response: { output: 'Done!' },
        tool_use_id: 'call_1',
      },
      other,
    );
    // Somebody breaks the same path by hand in the main checkout. Codex's next prompt comes from
    // the main checkout (the session moved there); that prompt rescans the main checkout.
    write(sb.repo, 'src/calc.js', calcSource(7, true));
    await hook(sb, 'codex', CX, 'UserPromptSubmit', { prompt: 'now look at main' });
    const main = await list(sb);
    const io = testIo(sb);
    await bisectRun(outFor(io), [NODE, 'test.cjs'], { json: true });
    const report = JSON.parse(io.out.join('')) as { mistakeId: string | null };
    expect(main.at(-1)).toMatchObject({ kind: 'outside', agentKind: null });
    expect(report.mistakeId).toBeNull();
    // The edit in the linked worktree is still Codex's step there.
    const feature = await list(sb, other);
    expect(feature.at(-1)).toMatchObject({ kind: 'agent', agentKind: 'codex', gap: false });
  }, 120_000);
});
