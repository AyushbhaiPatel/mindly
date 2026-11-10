// An agent write that leaves a file as it was finds no change to record. The step a rescan took
// earlier (a hand edit) must not become the agent's, and the write must not explain a later hand
// edit of the same file either: bisect would blame the agent for both.
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

function calcSource(step: number, broken: boolean): string {
  return `module.exports = { step: ${step}, add: (a, b) => a + b${broken ? ' + 1' : ''} };\n`;
}

async function hook(
  sb: Sandbox,
  event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse',
  extra: Record<string, unknown> = {},
): Promise<void> {
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

/** The agent writes src/calc.js with `content`, with or without its pre-tool hook. */
async function writeCalc(sb: Sandbox, content: string, preTool: boolean): Promise<void> {
  const file = join(sb.repo, 'src/calc.js');
  const tool = { tool_name: 'Write', tool_input: { file_path: file, content } };
  if (preTool) await hook(sb, 'PreToolUse', { ...tool, tool_use_id: 'toolu_1' });
  write(sb.repo, 'src/calc.js', content);
  await hook(sb, 'PostToolUse', {
    ...tool,
    tool_response: { filePath: file, type: 'update' },
    tool_use_id: 'toolu_1',
  });
}

interface StepJson {
  seq: number;
  kind: string;
  gap: boolean;
  agentKind: string | null;
}

async function list(sb: Sandbox): Promise<StepJson[]> {
  const io = testIo(sb);
  expect(await bisectList(outFor(io), { json: true })).toBe(0);
  return (JSON.parse(io.out.join('')) as { steps: StepJson[] }).steps.reverse();
}

async function bisect(sb: Sandbox): Promise<{ mistakeId: string | null }> {
  const io = testIo(sb);
  await bisectRun(outFor(io), [NODE, 'test.cjs'], { json: true });
  return JSON.parse(io.out.join('')) as { mistakeId: string | null };
}

async function setup(): Promise<Sandbox> {
  const sb = sandbox();
  mkdirSync(join(sb.repo, 'src'), { recursive: true });
  write(sb.repo, 'test.cjs', TEST_SCRIPT);
  write(sb.repo, 'src/calc.js', calcSource(0, false));
  git(sb.repo, 'add', '-A');
  git(sb.repo, 'commit', '-q', '-m', 'scripts');
  expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);
  await hook(sb, 'SessionStart', { source: 'startup' });
  return sb;
}

describe('a write that changes nothing', () => {
  for (const preTool of [false, true]) {
    it(`does not take over an earlier hand edit (${preTool ? 'with' : 'without'} a pre-tool hook)`, async () => {
      const sb = await setup();
      // The user breaks calc.js by hand; the next prompt rescans it into an outside step.
      const broken = calcSource(7, true);
      write(sb.repo, 'src/calc.js', broken);
      await hook(sb, 'UserPromptSubmit', { prompt: 'have a look at calc' });
      // Later the agent writes the file with the content it already has.
      await writeCalc(sb, broken, preTool);
      const steps = await list(sb);
      expect(steps.at(-1)).toMatchObject({ seq: 2, kind: 'outside', agentKind: null });
      expect((await bisect(sb)).mistakeId).toBeNull();
    }, 120_000);
  }

  it('does not explain a later hand edit of the same file', async () => {
    const sb = await setup();
    write(sb.repo, 'src/calc.js', calcSource(1, false));
    await hook(sb, 'UserPromptSubmit', { prompt: 'have a look at calc' });
    await writeCalc(sb, calcSource(1, false), true);
    // The user breaks the file by hand after the agent's write; a prompt rescans it.
    write(sb.repo, 'src/calc.js', calcSource(2, true));
    await hook(sb, 'UserPromptSubmit', { prompt: 'and now?' });
    const steps = await list(sb);
    expect(steps.map((s) => [s.seq, s.kind])).toEqual([
      [1, 'baseline'],
      [2, 'outside'],
      [3, 'outside'],
    ]);
    expect((await bisect(sb)).mistakeId).toBeNull();
  }, 120_000);
});
