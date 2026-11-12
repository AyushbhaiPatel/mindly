// Two Claude Code subagents run in parallel in one session (they share its session_id). One of
// them writes src/calc.js and breaks it; while that write's PostToolUse hook is still on its way,
// the other subagent runs a shell command (a rescan, which takes the write as an outside step)
// and starts its own write of another file before the first write's PostToolUse arrives. The
// breaking write must still be credited to the agent.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bisectList, bisectRun } from '../src/commands/bisect.js';
import { outFor } from '../src/util.js';
import { cli, git, sandbox, testIo, write, type Sandbox } from './helpers.js';

const CC = 'cc-session-1';
const NODE = process.execPath;

const TEST_SCRIPT = `
const path = require('node:path');
const calc = require(path.join(__dirname, 'src', 'calc.js'));
if (calc.add(2, 2) === 4) { console.log('ok'); process.exit(0); }
console.log('FAIL'); process.exit(1);
`;

const calcSource = (broken: boolean) =>
  `module.exports = { add: (a, b) => a + b${broken ? ' + 1' : ''} };\n`;

async function hook(sb: Sandbox, event: string, extra: Record<string, unknown> = {}) {
  const payload = {
    session_id: CC,
    transcript_path: join(sb.home, `${CC}.jsonl`),
    cwd: sb.repo,
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };
  const r = await cli(sb, ['hook', 'claude-code', event], { stdin: JSON.stringify(payload) });
  expect(r.code).toBe(0);
}

const writeTool = (sb: Sandbox, rel: string, content: string, id: string) => ({
  tool_name: 'Write',
  tool_input: { file_path: join(sb.repo, rel), content },
  tool_use_id: id,
});

describe('parallel subagents of one session', () => {
  it('credit a write a rescan took first to the agent', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.repo, 'src'), { recursive: true });
    write(sb.repo, 'test.cjs', TEST_SCRIPT);
    write(sb.repo, 'src/calc.js', calcSource(false));
    write(sb.repo, 'src/util.js', 'module.exports = {};\n');
    git(sb.repo, 'add', '-A');
    git(sb.repo, 'commit', '-q', '-m', 'init');
    expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);
    await hook(sb, 'SessionStart', { source: 'startup' });

    // Subagent A: PreToolUse, then the write that breaks calc.js.
    const a = writeTool(sb, 'src/calc.js', calcSource(true), 'toolu_A');
    await hook(sb, 'PreToolUse', a);
    write(sb.repo, 'src/calc.js', calcSource(true));
    // Subagent B runs a shell command meanwhile: its PostToolUse rescans the tree.
    const bash = {
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_use_id: 'toolu_B1',
    };
    await hook(sb, 'PreToolUse', bash);
    await hook(sb, 'PostToolUse', { ...bash, tool_response: { stdout: '', stderr: '' } });
    // Subagent B starts a write of another file.
    const b = writeTool(sb, 'src/util.js', 'module.exports = { x: 1 };\n', 'toolu_B2');
    await hook(sb, 'PreToolUse', b);
    // A's PostToolUse arrives.
    await hook(sb, 'PostToolUse', {
      ...a,
      tool_response: { filePath: join(sb.repo, 'src/calc.js'), type: 'update' },
    });

    const io = testIo(sb);
    expect(await bisectList(outFor(io), { json: true })).toBe(0);
    const steps = (
      JSON.parse(io.out.join('')) as {
        steps: { seq: number; kind: string; agentKind: string | null }[];
      }
    ).steps.reverse();
    expect(steps.find((s) => s.seq === 2)).toMatchObject({
      kind: 'agent',
      agentKind: 'claude-code',
    });

    const io2 = testIo(sb);
    await bisectRun(outFor(io2), [NODE, 'test.cjs'], { json: true });
    const out = JSON.parse(io2.out.join('')) as { mistakeId: string | null };
    expect(out.mistakeId).not.toBeNull();
  }, 120_000);
});
