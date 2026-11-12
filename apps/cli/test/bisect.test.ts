import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@mindly/store';
import {
  bisectList,
  bisectRevert,
  bisectRun,
  bisectShow,
  splitCommandLine,
} from '../src/commands/bisect.js';
import { outFor } from '../src/util.js';
import { withProject } from '../src/context.js';
import { cli, git, sandbox, tempDir, testIo, write, type Sandbox } from './helpers.js';

/*
 * End to end: real hook payloads from two agents produce checkpoints in a sandbox repository, and
 * `mindly bisect` finds the edit that broke a test script, run in a scratch worktree.
 */

const CC = 'cc-session-1';
const CX = 'cx-session-1';
const CC_PROMPT = 'make add faster';
const CX_PROMPT = 'tidy the calculator and skip the \u001b[31mdb\u001b[0m lookup';
/** The edit (1-based) that breaks `add`; even edits are made by Codex. */
const BREAK = 20;
const EDITS = 30;

/** The command under test, run inside the scratch tree. Options control skip, hang and flaky behaviour. */
const TEST_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const calc = require(path.join(__dirname, 'src', 'calc.js'));
const sleep = opt('--sleep-ms');
if (sleep !== null) { const until = Date.now() + Number(sleep); while (Date.now() < until) {} }
if (opt('--skip-at') !== null && calc.step === Number(opt('--skip-at'))) process.exit(125);
if (opt('--hang-at') !== null && calc.step === Number(opt('--hang-at'))) {
  setTimeout(() => process.exit(0), 60_000);
} else if (calc.add(2, 2) === 4) {
  console.log('ok');
  process.exit(0);
} else {
  const state = opt('--flaky-state');
  if (state !== null && fs.existsSync(state)) { console.log('ok (second time)'); process.exit(0); }
  if (state !== null) fs.writeFileSync(state, '1');
  console.log('\\u001b[31mFAIL\\u001b[0m add(2,2) !== 4');
  process.exit(1);
}
`;

const SETUP_SCRIPT = `
require('node:fs').appendFileSync(process.argv[2], 'ran\\n');
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
  expect(r.stderr).toBe('');
}

/** Writes the file like the agent did, then sends the hook payload that follows the edit. */
async function edit(
  sb: Sandbox,
  agent: 'claude-code' | 'codex',
  rel: string,
  content: string,
): Promise<void> {
  const previous = existsSync(join(sb.repo, rel)) ? readFileSync(join(sb.repo, rel), 'utf8') : '';
  write(sb.repo, rel, content);
  if (agent === 'claude-code') {
    await hook(sb, 'claude-code', CC, 'PostToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: join(sb.repo, rel), content },
      tool_response: { filePath: join(sb.repo, rel), type: previous ? 'update' : 'create' },
      tool_use_id: 'toolu_1',
    });
    return;
  }
  const patch = previous
    ? `*** Begin Patch\n*** Update File: ${rel}\n@@\n-${previous.trimEnd()}\n+${content.trimEnd()}\n*** End Patch\n`
    : `*** Begin Patch\n*** Add File: ${rel}\n+${content.trimEnd()}\n*** End Patch\n`;
  await hook(sb, 'codex', CX, 'PostToolUse', {
    tool_name: 'apply_patch',
    tool_input: { command: patch },
    tool_response: { output: 'Done!' },
    tool_use_id: 'call_1',
  });
}

/** A repository with the scripts committed, then `edits` agent edits (the BREAKth breaks add). */
async function story(sb: Sandbox, edits = EDITS, breakAt = BREAK): Promise<void> {
  mkdirSync(join(sb.repo, 'src'), { recursive: true });
  write(sb.repo, 'test.cjs', TEST_SCRIPT);
  write(sb.repo, 'setup.cjs', SETUP_SCRIPT);
  write(sb.repo, 'src/calc.js', calcSource(0, false));
  git(sb.repo, 'add', '-A');
  git(sb.repo, 'commit', '-q', '-m', 'scripts');
  // A loaded CI runner must not make a hook miss its deadline and skip a checkpoint.
  expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);
  await hook(sb, 'claude-code', CC, 'SessionStart', { source: 'startup' });
  await hook(sb, 'codex', CX, 'SessionStart', { source: 'startup' });
  await hook(sb, 'claude-code', CC, 'UserPromptSubmit', { prompt: CC_PROMPT });
  await hook(sb, 'codex', CX, 'UserPromptSubmit', { prompt: CX_PROMPT });
  for (let i = 1; i <= edits; i++) {
    const agent = i % 2 === 0 ? 'codex' : 'claude-code';
    if (i <= breakAt) await edit(sb, agent, 'src/calc.js', calcSource(i, i >= breakAt));
    else await edit(sb, agent, `src/note-${i}.txt`, `note ${i}\n`);
  }
}

interface StepJson {
  seq: number;
  kind: string;
  gap: boolean;
  agentKind: string | null;
  sessionLabel: string | null;
  tool: string | null;
  paths: string[];
  prompt: string | null;
  promptState: string;
  rules: unknown[];
  commit: string;
  parentCommit: string | null;
}

interface ReportJson {
  status: string;
  command: string[];
  worktree: string;
  range: { good: number; bad: number; since: string | null };
  runs: number;
  durationMs: number;
  firstBad: StepJson | null;
  lastGood: StepJson | null;
  flaky: boolean;
  skipped: number[];
  output: string | null;
  mistakeId: string | null;
  run: { id: string; status: string };
}

const NODE = process.execPath;

async function bisect(
  sb: Sandbox,
  argv: string[],
  options: Record<string, unknown> = {},
  deps: { signal?: AbortSignal; onWorkspace?: (p: string) => void } = {},
): Promise<{ code: number; report: ReportJson; stderr: string }> {
  const io = testIo(sb);
  const code = await bisectRun(outFor(io), argv, { json: true, ...options }, deps);
  return { code, report: JSON.parse(io.out.join('')) as ReportJson, stderr: io.err.join('') };
}

function steps(sb: Sandbox): string[] {
  return git(sb.repo, 'for-each-ref', '--format=%(refname)', 'refs/mindly/steps/')
    .split('\n')
    .filter((l) => l !== '');
}

describe('mindly bisect', () => {
  let sb: Sandbox;
  let found: ReportJson;
  beforeAll(async () => {
    sb = sandbox();
    await story(sb);
    found = (await bisect(sb, [NODE, 'test.cjs'])).report;
  }, 120_000);

  it('saves one checkpoint per agent edit, in order, from real hook payloads', async () => {
    const io = testIo(sb);
    expect(await bisectList(outFor(io), { json: true })).toBe(0);
    const list = JSON.parse(io.out.join('')) as { steps: StepJson[] };
    // The baseline, then one step per edit; newest first.
    expect(list.steps).toHaveLength(EDITS + 1);
    const newest = list.steps[0] as StepJson;
    expect(newest.seq).toBe(EDITS + 1);
    expect(list.steps[list.steps.length - 1]).toMatchObject({
      seq: 1,
      kind: 'baseline',
      paths: [],
    });
    const agents = list.steps
      .slice(0, EDITS)
      .reverse()
      .map((s) => s.agentKind);
    expect(agents.slice(0, 4)).toEqual(['claude-code', 'codex', 'claude-code', 'codex']);
    expect(list.steps.slice(0, EDITS).every((s) => s.kind === 'agent' && !s.gap)).toBe(true);
    expect(newest.tool).toBe('apply_patch');
    expect(newest.paths).toEqual([`src/note-${EDITS}.txt`]);
    expect(newest.prompt).toContain('tidy the calculator');
    expect(list.steps[1]?.tool).toBe('Write');
    expect(list.steps[1]?.prompt).toBe(CC_PROMPT);
    expect(steps(sb)).toHaveLength(EDITS + 1);
    // The user's checkout is untouched: nothing staged, HEAD and branch as before.
    expect(git(sb.repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(sb.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('finds the step, the agent and the prompt in about log2(steps) runs', () => {
    expect(found.status).toBe('found');
    const bad = found.firstBad as StepJson;
    expect(bad.seq).toBe(BREAK + 1);
    expect(bad.agentKind).toBe('codex');
    expect(bad.tool).toBe('apply_patch');
    expect(bad.paths).toEqual(['src/calc.js']);
    expect(bad.promptState).toBe('kept');
    expect(bad.prompt).toContain('tidy the calculator and skip the');
    expect(bad.prompt).not.toContain('\u001b');
    expect(found.lastGood?.seq).toBe(BREAK);
    expect(found.lastGood?.agentKind).toBe('claude-code');
    expect(found.range).toEqual({ good: 1, bad: EDITS + 1, since: '24h' });
    expect(found.runs).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(EDITS)) + 2);
    expect(found.flaky).toBe(false);
    expect(found.output).toBe('FAIL add(2,2) !== 4');
    expect(git(sb.repo, 'show', `${bad.commit}:src/calc.js`)).toContain('a + b + 1');
    expect(git(sb.repo, 'show', `${bad.parentCommit}:src/calc.js`)).not.toContain('+ 1');
  });

  it('--json has a stable shape and the run is recorded', () => {
    expect(Object.keys(found)).toEqual([
      'status',
      'command',
      'worktree',
      'range',
      'runs',
      'durationMs',
      'firstBad',
      'lastGood',
      'flaky',
      'skipped',
      'output',
      'mistakeId',
      'run',
    ]);
    expect(found.command).toEqual([NODE, 'test.cjs']);
    expect(found.worktree).toBe(sb.repo);
    expect(found.run.status).toBe('passed');
    const store = Store.open(join(sb.mindlyHome, 'mindly.db'));
    try {
      const run = store.runs.get(found.run.id);
      expect(run.kind).toBe('bisect');
      expect(run.input).toMatchObject({
        command: [NODE, 'test.cjs'],
        range: { good: 1, bad: EDITS + 1 },
      });
      expect(run.result).toMatchObject({ status: 'found', firstBad: BREAK + 1, lastGood: BREAK });
      // The blamed step is kept with the result (mindly track reads it after pruning).
      expect(run.result).toMatchObject({
        blame: { kind: 'agent', gap: false, paths: ['src/calc.js'] },
      });
      const blame = (run.result as { blame: { sessionId: string; at: number } }).blame;
      expect(store.sessions.get(blame.sessionId).agentKind).toBe('codex');
      expect(blame.at).toBeLessThanOrEqual(run.createdAt);
    } finally {
      store.close();
    }
  });

  it("records a mistake memory from the user, scoped to the step's paths", async () => {
    expect(found.mistakeId).toBeTruthy();
    const r = await cli(sb, ['memory', 'list', '--kind', 'mistake', '--json']);
    expect(r.code).toBe(0);
    const memories = JSON.parse(r.stdout) as {
      id: string;
      kind: string;
      title: string;
      source: { type: string };
      scope: { paths: string[] };
      tags: string[];
    }[];
    const m = memories.find((x) => x.id === found.mistakeId);
    expect(m).toBeDefined();
    expect(m?.kind).toBe('mistake');
    expect(m?.source.type).toBe('user');
    expect(m?.scope.paths).toEqual(['src/calc.js']);
    expect(m?.title).toContain(`codex step ${BREAK + 1} broke`);
    expect(m?.tags).toContain('bisect');
  });

  it('prints plain words: who, the prompt, the last good step and what to do next', async () => {
    const io = testIo(sb);
    const code = await bisectRun(outFor(io), [NODE, 'test.cjs'], {});
    expect(code).toBe(0);
    const text = io.out.join('');
    expect(text).toMatch(
      new RegExp(`^Broke at step ${BREAK + 1} of ${EDITS + 1} - \\d+ runs - \\d+s`),
    );
    expect(text).toContain('codex #');
    expect(text).toContain('apply_patch src/calc.js');
    expect(text).toContain('prompt: tidy the calculator and skip the');
    expect(text).toContain(`last good: step ${BREAK} (claude-code #`);
    expect(text).toContain('failing output (tail):');
    expect(text).toContain('FAIL add(2,2) !== 4');
    expect(text).toContain(`mindly bisect show ${BREAK + 1} --patch`);
    expect(text).toContain(`mindly bisect revert ${BREAK + 1}`);
    expect(text).not.toContain('\u001b');
    expect(io.err.join('')).toMatch(/checking step \d+ of \d+ \(1 of ~\d+ runs\)/);
  });

  it('skips a step that exits 125 and still finds the break', async () => {
    const { code, report } = await bisect(sb, [NODE, 'test.cjs', '--skip-at', String(BREAK - 5)]);
    expect(code).toBe(0);
    expect(report.status).toBe('found');
    expect(report.firstBad?.seq).toBe(BREAK + 1);
    expect(report.skipped).toEqual([]);
    // A skipped step right before the break leaves the answer open, as with git bisect.
    const open = await bisect(sb, [NODE, 'test.cjs', '--skip-at', String(BREAK - 1)]);
    expect(open.code).toBe(1);
    expect(open.report.status).toBe('inconclusive');
    expect(open.report.skipped).toEqual([BREAK]);
    expect(open.report.firstBad?.seq).toBe(BREAK + 1);
    expect(open.report.lastGood?.seq).toBe(BREAK - 1);
    expect(open.report.mistakeId).toBeNull();
  });

  it('treats a timeout as a skip and reports it', async () => {
    const { report } = await bisect(sb, [NODE, 'test.cjs', '--hang-at', String(BREAK - 2)], {
      timeout: 1,
    });
    expect(report.status).toBe('found');
    expect(report.firstBad?.seq).toBe(BREAK + 1);
    const store = Store.open(join(sb.mindlyHome, 'mindly.db'));
    try {
      const checks = (
        store.runs.get(report.run.id).result as {
          checks: { seq: number; skipReason: string | null }[];
        }
      ).checks;
      expect(checks.some((c) => c.seq === BREAK - 1 && c.skipReason === 'timeout')).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);

  it('calls a flaky command unreliable instead of blaming an agent', async () => {
    const state = join(sb.home, 'flaky-state');
    const { code, report } = await bisect(sb, [NODE, 'test.cjs', '--flaky-state', state]);
    expect(code).toBe(1);
    expect(report.status).toBe('unreliable');
    expect(report.flaky).toBe(true);
    expect(report.mistakeId).toBeNull();
    expect(report.run.status).toBe('failed');
    const io = testIo(sb);
    writeFileSync(state, '');
    await bisectRun(outFor(io), [NODE, 'test.cjs', '--flaky-state', join(sb.home, 'flaky-2')], {});
    expect(io.out.join('')).toContain('Unreliable');
    expect(io.out.join('')).toContain('looks flaky');
  });

  it('refuses when the good end already fails or the bad end passes', async () => {
    const fails = await bisect(sb, [NODE, 'test.cjs'], { good: BREAK + 1 });
    expect(fails.code).toBe(1);
    expect(fails.report.status).toBe('good_fails');
    const passes = await bisect(sb, [NODE, 'test.cjs'], { good: 1, bad: BREAK });
    expect(passes.code).toBe(1);
    expect(passes.report.status).toBe('bad_passes');
    const io = testIo(sb);
    await bisectRun(outFor(io), [NODE, 'test.cjs'], { good: BREAK + 1 });
    expect(io.out.join('')).toContain('already fails at the oldest step');
  });

  it('removes the scratch worktree on success and on failure', async () => {
    let scratch = '';
    await bisect(sb, [NODE, 'test.cjs'], {}, { onWorkspace: (p) => (scratch = p) });
    expect(scratch).not.toBe('');
    expect(scratch.startsWith(sb.repo)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    await bisect(sb, [NODE, 'missing.cjs'], {}, { onWorkspace: (p) => (scratch = p) });
    expect(existsSync(scratch)).toBe(false);
    expect(git(sb.repo, 'worktree', 'list')).not.toContain('mindly-bisect-');
  });

  it('cleans up when cancelled while a run is in progress', async () => {
    const ac = new AbortController();
    let scratch = '';
    const started = Date.now();
    setTimeout(() => ac.abort(), 500);
    const { code, report } = await bisect(
      sb,
      [NODE, 'test.cjs', '--sleep-ms', '5000'],
      {},
      { signal: ac.signal, onWorkspace: (p) => (scratch = p) },
    );
    expect(code).toBe(1);
    expect(report.status).toBe('cancelled');
    expect(report.run.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(scratch)).toBe(false);
  });

  it('shows a step with its summary or full patch', async () => {
    const io = testIo(sb);
    expect(await bisectShow(outFor(io), String(BREAK + 1), {})).toBe(0);
    const text = io.out.join('');
    expect(text).toMatch(new RegExp(`^Step ${BREAK + 1} - codex #`));
    expect(text).toContain('src/calc.js | 2 +-');
    const patch = testIo(sb);
    await bisectShow(outFor(patch), String(BREAK + 1), { patch: true });
    expect(patch.out.join('')).toContain(
      '+module.exports = { step: 20, add: (a, b) => a + b + 1 };',
    );
    const json = testIo(sb);
    await bisectShow(outFor(json), String(BREAK + 1), { json: true });
    const shown = JSON.parse(json.out.join('')) as { step: StepJson; diff: string };
    expect(shown.step.seq).toBe(BREAK + 1);
    expect(shown.diff).toContain('src/calc.js');
    const missing = await cli(sb, ['bisect', 'show', '999']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Step 999 does not exist');
  });

  it('is registered with list, show and revert subcommands and needs a command', async () => {
    const r = await cli(sb, ['bisect']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('after --');
    const list = await cli(sb, ['bisect', 'list', '--since', '7d']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(`${EDITS + 1} steps in the last 7d`);
    expect(list.stdout).toContain(`step ${BREAK + 1}`);
    expect(list.stdout).toContain('prompt: make add faster');
    expect(list.stdout).not.toContain('\u001b');
    const bad = await cli(sb, ['bisect', '--since', '1h', '--good', '2', '--', 'true']);
    expect(bad.code).toBe(2);
  });

  it('doctor reports checkpoints', async () => {
    const r = await cli(sb, ['doctor', '--json']);
    const checks = (
      JSON.parse(r.stdout) as { checks: { name: string; status: string; detail: string }[] }
    ).checks;
    const c = checks.find((x) => x.name === 'checkpoints');
    expect(c?.status).toBe('ok');
    expect(c?.detail).toContain(`on: ${EDITS + 1} stored`);
    expect(checks.some((x) => x.name === 'checkpoints-mirror')).toBe(false);
    git(sb.repo, 'remote', 'add', 'backup', join(sb.home, 'backup.git'));
    git(sb.repo, 'config', 'remote.backup.mirror', 'true');
    const warned = await cli(sb, ['doctor', '--json']);
    const mirror = (
      JSON.parse(warned.stdout) as { checks: { name: string; status: string; detail: string }[] }
    ).checks.find((x) => x.name === 'checkpoints-mirror');
    expect(mirror?.status).toBe('warn');
    expect(mirror?.detail).toContain('backup');
  });
});

describe('mindly bisect revert', () => {
  it('undoes one step in the checkout after asking, and refuses once the lines changed', async () => {
    const sb = sandbox();
    await story(sb, 8, 6);
    const { report } = await bisect(sb, [NODE, 'test.cjs']);
    expect(report.firstBad?.seq).toBe(7);
    const file = join(sb.repo, 'src', 'calc.js');
    const before = readFileSync(file, 'utf8');
    // Without a terminal nothing is applied.
    const asked = testIo(sb);
    expect(await bisectRevert(outFor(asked), '7', {})).toBe(1);
    expect(asked.err.join('')).toContain('Re-run with --yes');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(asked.out.join('')).toContain('Step 7 (apply_patch src/calc.js) will be undone');
    const io = testIo(sb, { answers: ['y'] });
    expect(await bisectRevert(outFor(io), '7', {})).toBe(0);
    expect(io.out.join('')).toContain(
      'Undid step 7: 1 file changed in your checkout, nothing committed.',
    );
    expect(readFileSync(file, 'utf8')).toBe(calcSource(5, false));
    expect(git(sb.repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(sb.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    // The lines changed since: refused with a reason.
    writeFileSync(file, 'module.exports = { step: 99, add: (a, b) => a * b };\n');
    const conflict = await cli(sb, ['bisect', 'revert', '7', '--yes']);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('Cannot undo step 7');
    expect(conflict.stderr).toContain('mindly bisect show 7 --patch');
  }, 60_000);

  it('refuses the first step of a checkout, which holds every file', async () => {
    const sb = sandbox();
    await story(sb, 2, 99);
    const before = git(sb.repo, 'status', '--porcelain');
    const refused = await cli(sb, ['bisect', 'revert', '1', '--yes']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Cannot undo step 1');
    expect(refused.stderr).toContain('starting point');
    expect(git(sb.repo, 'status', '--porcelain')).toBe(before);
    expect(existsSync(join(sb.repo, 'test.cjs'))).toBe(true);
    expect(readFileSync(join(sb.repo, 'src', 'calc.js'), 'utf8')).toBe(calcSource(2, false));
  }, 60_000);
});

describe('who a step belongs to', () => {
  async function list(sb: Sandbox, cwd = sb.repo): Promise<StepJson[]> {
    const io = testIo(sb, { cwd });
    expect(await bisectList(outFor(io), { json: true })).toBe(0);
    return (JSON.parse(io.out.join('')) as { steps: StepJson[] }).steps.reverse();
  }

  async function start(sb: Sandbox): Promise<void> {
    mkdirSync(join(sb.repo, 'src'), { recursive: true });
    write(sb.repo, 'test.cjs', TEST_SCRIPT);
    write(sb.repo, 'src/calc.js', calcSource(0, false));
    git(sb.repo, 'add', '-A');
    git(sb.repo, 'commit', '-q', '-m', 'scripts');
    expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);
  }

  it('does not credit a change to an agent that edited the same path in another worktree', async () => {
    const sb = sandbox();
    await start(sb);
    const other = join(tempDir('mindly-wt-'), 'feature');
    git(sb.repo, 'worktree', 'add', '-q', '-b', 'feature', other);
    await hook(sb, 'claude-code', CC, 'SessionStart', { source: 'startup' });
    await hook(sb, 'codex', CX, 'SessionStart', { source: 'startup' }, other);
    await hook(sb, 'claude-code', CC, 'UserPromptSubmit', { prompt: CC_PROMPT });
    await hook(sb, 'codex', CX, 'UserPromptSubmit', { prompt: CX_PROMPT }, other);
    // Codex makes a harmless edit to src/calc.js in its own worktree.
    const previous = readFileSync(join(other, 'src', 'calc.js'), 'utf8');
    write(other, 'src/calc.js', calcSource(1, false));
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
    // Somebody breaks the same path by hand in the main checkout; the next prompt rescans.
    write(sb.repo, 'src/calc.js', calcSource(7, true));
    await hook(sb, 'claude-code', CC, 'UserPromptSubmit', { prompt: 'go on' });
    const main = await list(sb);
    expect(main.at(-1)).toMatchObject({
      kind: 'outside',
      agentKind: null,
      paths: ['src/calc.js'],
    });
    expect((await list(sb, other)).at(-1)).toMatchObject({ kind: 'agent', agentKind: 'codex' });
    const { report } = await bisect(sb, [NODE, 'test.cjs']);
    expect(report.status).toBe('found');
    expect(report.firstBad).toMatchObject({ kind: 'outside', agentKind: null });
    expect(report.mistakeId).toBeNull();
  }, 120_000);

  it('puts an edit whose checkpoint was skipped into the next step, marked as a gap', async () => {
    const sb = sandbox();
    await start(sb);
    await hook(sb, 'claude-code', CC, 'SessionStart', { source: 'startup' });
    await hook(sb, 'codex', CX, 'SessionStart', { source: 'startup' });
    await hook(sb, 'claude-code', CC, 'UserPromptSubmit', { prompt: CC_PROMPT });
    await hook(sb, 'codex', CX, 'UserPromptSubmit', { prompt: CX_PROMPT });
    await edit(sb, 'claude-code', 'src/calc.js', calcSource(1, false));
    // Another process holds the checkpoint lock while the breaking edit arrives.
    const dir = join(sb.mindlyHome, 'checkpoints');
    const lock = join(dir, readdirSync(dir)[0] as string, 'lock');
    writeFileSync(lock, '1');
    await edit(sb, 'claude-code', 'src/calc.js', calcSource(2, true));
    rmSync(lock);
    await edit(sb, 'codex', 'src/notes.txt', 'hello\n');
    await hook(sb, 'claude-code', CC, 'UserPromptSubmit', { prompt: 'go on' });
    const all = await list(sb);
    expect(all.map((s) => [s.seq, s.kind, s.gap])).toEqual([
      [1, 'baseline', false],
      [2, 'agent', false],
      [3, 'agent', true],
    ]);
    expect([...(all[2] as StepJson).paths].sort()).toEqual(['src/calc.js', 'src/notes.txt']);
    // The break is found at the step that holds it, and nobody is blamed for a step with a gap.
    const { report } = await bisect(sb, [NODE, 'test.cjs']);
    expect(report.status).toBe('found');
    expect(report.firstBad).toMatchObject({ seq: 3, gap: true });
    expect(report.mistakeId).toBeNull();
  }, 120_000);

  it('keeps a ref whose row is still being written when a prune runs', async () => {
    const sb = sandbox();
    await start(sb);
    await hook(sb, 'claude-code', CC, 'SessionStart', { source: 'startup' });
    const [first] = steps(sb);
    // A capture in another process has just created the ref of step 2.
    const second = (first as string).replace(/\/1$/, '/2');
    git(sb.repo, 'update-ref', second, git(sb.repo, 'rev-parse', first as string).trim());
    const io = testIo(sb);
    await withProject(io, async (scope) => {
      expect(await scope.mindly.checkpoints.prune(scope.project.project.id)).toEqual({
        refsDeleted: 0,
        rowsDeleted: 0,
      });
      return 0;
    });
    expect(steps(sb)).toEqual([first, second]);
  }, 60_000);
});

describe('mindly bisect --setup', () => {
  it('runs the setup command first and again only when a manifest changes', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.repo, 'src'), { recursive: true });
    write(sb.repo, 'test.cjs', TEST_SCRIPT);
    write(sb.repo, 'setup.cjs', SETUP_SCRIPT);
    write(sb.repo, 'src/calc.js', calcSource(0, false));
    write(sb.repo, 'package.json', '{ "name": "demo", "version": "1" }\n');
    git(sb.repo, 'add', '-A');
    git(sb.repo, 'commit', '-q', '-m', 'scripts');
    expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);
    await hook(sb, 'claude-code', CC, 'SessionStart', { source: 'startup' });
    await hook(sb, 'claude-code', CC, 'UserPromptSubmit', { prompt: CC_PROMPT });
    for (let i = 1; i <= 4; i++) await edit(sb, 'claude-code', 'src/calc.js', calcSource(i, false));
    await edit(sb, 'claude-code', 'package.json', '{ "name": "demo", "version": "2" }\n');
    for (let i = 6; i <= 9; i++)
      await edit(sb, 'claude-code', 'src/calc.js', calcSource(i, i >= 8));
    const log = join(sb.home, 'setup.log');
    const quoted = `"${NODE}" setup.cjs ${log}`;
    expect(splitCommandLine(quoted)).toEqual([NODE, 'setup.cjs', log]);
    // Steps 1..5 (before package.json changed): setup runs once.
    const narrow = await bisect(sb, [NODE, 'test.cjs'], { good: 7, setup: quoted });
    expect(narrow.report.status).toBe('found');
    expect(narrow.report.firstBad?.seq).toBe(9);
    expect(readFileSync(log, 'utf8').split('ran').length - 1).toBe(1);
    // Across the manifest change: setup runs again, but not on every run.
    writeFileSync(log, '');
    const wide = await bisect(sb, [NODE, 'test.cjs'], { setup: quoted });
    expect(wide.report.status).toBe('found');
    const ran = readFileSync(log, 'utf8').split('ran').length - 1;
    expect(ran).toBeGreaterThanOrEqual(2);
    expect(ran).toBeLessThan(wide.report.runs);
    // Without --setup a lockfile earns a hint.
    write(sb.repo, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const hinted = await bisect(sb, [NODE, 'test.cjs']);
    expect(hinted.stderr).toContain('pnpm-lock.yaml found');
  }, 120_000);
});

describe('checkpoint removal', () => {
  it('forget --project deletes the hidden refs and uninstall does too', async () => {
    const sb = sandbox();
    await story(sb, 4, 3);
    expect(steps(sb)).toHaveLength(5);
    const dry = await cli(sb, ['uninstall', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('Delete 5 saved copies of the code after agent edits');
    expect(steps(sb)).toHaveLength(5);
    const un = await cli(sb, ['uninstall', '--yes']);
    expect(un.code).toBe(0);
    expect(un.stdout).toContain('Removed 5 checkpoints');
    expect(steps(sb)).toHaveLength(0);
    await story(sb, 2, 2);
    expect(steps(sb)).toHaveLength(3);
    const forget = await cli(sb, ['forget', '--project', '--yes']);
    expect(forget.code).toBe(0);
    expect(steps(sb)).toHaveLength(0);
    const empty = await cli(sb, ['bisect', 'list']);
    expect(empty.stdout).toContain('No checkpoints in the last 24h');
  }, 60_000);

  it('explains itself outside git', async () => {
    const sb = sandbox();
    const r = await cli(sb, ['bisect', '--', 'true'], { cwd: sb.home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not inside a git repository');
    expect(r.stderr).toContain('Checkpoints need git');
  });
});
