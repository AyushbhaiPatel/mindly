import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Save, SaveKind } from '@mindly/core';
import {
  createFailoverModule,
  SAVE_WINDOW_MS,
  savesModule,
  savesOf,
  USER,
  contractsOf,
  type Mindly,
} from '../../src/index.js';
import { event, shellTool, writeTool } from '../helpers.js';
import { make } from './continuity-helpers.js';
import { AUTH_V1, featureSetup } from './fixtures.js';

/*
 * Saves of every kind, driven through real hook events: every kind is
 * caught by the hook that intervened, then confirmed, expired or dropped by later hook events and
 * the housekeeping sweep.
 */

function savesOfKind(mindly: Mindly, pid: string, kind: SaveKind): Save[] {
  return mindly.store.saves.list(pid, { kinds: [kind] });
}

function only(mindly: Mindly, pid: string, kind: SaveKind): Save {
  const all = savesOfKind(mindly, pid, kind);
  expect(all).toHaveLength(1);
  return all[0]!;
}

function total(mindly: Mindly, pid: string): number {
  return savesOf(mindly).summary(pid, 0).total;
}

/** Every evidence id of a save is a real event of its project. */
function expectEvidence(mindly: Mindly, s: Save): void {
  expect(s.evidence.length).toBeGreaterThan(0);
  const ids = new Set(mindly.store.events.query(s.projectId, { limit: 1000 }).map((e) => e.id));
  for (const id of s.evidence) expect(ids.has(id), id).toBe(true);
}

const AUTH_V2 = AUTH_V1.replace('export function login', 'export function signIn');

/** Claude changes the exports of src/auth.ts while Codex is about to edit an importer of it. */
async function impactSetup() {
  const f = await featureSetup();
  await f.mindly.hooks.handle(
    event(f.root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/dashboard.ts', 'x') }),
  );
  f.clock.advance(1000);
  f.write('src/auth.ts', AUTH_V2);
  await f.mindly.hooks.handle(
    event(f.root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'signIn') }),
  );
  f.clock.advance(1000);
  return f;
}

async function tellCodex(f: Awaited<ReturnType<typeof featureSetup>>) {
  const res = await f.mindly.hooks.handle(
    event(f.root, 'codex', 'cx', 'prompt', { prompt: 'continue with the dashboard' }),
  );
  expect(res.context).toContain('changed the exports of src/auth.ts');
  f.clock.advance(1000);
}

/** Claude Code starts editing src/auth.ts; Codex is warned when it is about to write it too. */
async function overlapSetup() {
  const f = await featureSetup();
  await f.mindly.hooks.handle(
    event(f.root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'a') }),
  );
  f.clock.advance(1000);
  const res = await f.mindly.hooks.handle(
    event(f.root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/auth.ts', 'b') }),
  );
  expect(res.context).toContain('Coordination warning');
  f.clock.advance(1000);
  return f;
}

/** A user rule enforced on src/generated/ denies Codex's write. */
async function ruleSetup() {
  const f = await featureSetup();
  f.mindly.memory.remember({
    projectId: f.pid,
    projectRoot: f.root,
    kind: 'rule',
    title: 'Never edit generated code',
    body: 'src/generated is produced by codegen',
    scopePaths: ['src/generated/**'],
    source: USER,
    enforce: true,
  });
  const res = await f.mindly.hooks.handle(
    event(f.root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/generated/api.ts', 'x') }),
  );
  expect(res.decision).toBe('deny');
  f.clock.advance(1000);
  return f;
}

/** `npm test` failed for Claude Code; Codex is warned before running it. */
async function mistakeSetup() {
  const f = await featureSetup();
  await f.mindly.hooks.handle(
    event(f.root, 'claude-code', 'cc', 'post_tool', {
      tool: shellTool('npm test', true, 'ERR! missing script: test'),
    }),
  );
  f.clock.advance(1000);
  const res = await f.mindly.hooks.handle(
    event(f.root, 'codex', 'cx', 'pre_tool', { tool: shellTool('npm test') }),
  );
  expect(res.context).toContain('failed before');
  f.clock.advance(1000);
  return f;
}

/** A contract on src/auth.ts that Claude Code breaks with a write. */
async function contractSetup() {
  const f = await featureSetup();
  const memory = f.mindly.memory.remember({
    projectId: f.pid,
    projectRoot: f.root,
    kind: 'decision',
    title: 'login returns user.role',
    body: 'The login response always carries the role.',
    source: USER,
  });
  contractsOf(f.mindly).create(
    memory.id,
    'pattern_present',
    { path: 'src/auth.ts', pattern: 'role:' },
    USER,
  );
  f.write('src/auth.ts', AUTH_V1.replace('{ role: "admin" }', '{ ok: true }'));
  await f.mindly.hooks.handle(
    event(f.root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'ok') }),
  );
  f.clock.advance(1000);
  return f;
}

/** Claude Code hits its usage limit with a rate-limit handoff to Codex. */
async function limitSetup(config?: NonNullable<Parameters<typeof make>[0]>['config']) {
  const env = make(config ? { config } : {});
  env.mindly.use(createFailoverModule({}));
  env.mindly.use(savesModule);
  const { root, clock, mindly } = env;
  await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
  clock.advance(1000);
  await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'fix login' }));
  clock.advance(1000);
  const transcript = join(root, 'transcript.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(clock.t).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Claude usage limit reached.' }],
      },
    }) + '\n',
  );
  await mindly.hooks.handle(
    event(root, 'claude-code', 'cc', 'stop', { transcriptPath: transcript }),
  );
  clock.advance(1000);
  const pid = mindly.store.projects.list()[0]!.id;
  expect(mindly.store.handoffs.list(pid)[0]?.reason).toBe('rate_limit');
  return { ...env, pid };
}

describe('saves: impact_warned', () => {
  it('is confirmed when the warned agent then edits the dependent file', async () => {
    const f = await impactSetup();
    await tellCodex(f);
    expect(only(f.mindly, f.pid, 'impact_warned').status).toBe('caught');
    expect(total(f.mindly, f.pid)).toBe(0);

    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'signIn') }),
    );
    const s = only(f.mindly, f.pid, 'impact_warned');
    expect(s.status).toBe('confirmed');
    expect(s.sessionIds).toEqual([f.cx.id, f.cc.id]);
    expect(s.paths).toEqual(['src/dashboard.ts']);
    expect(s.title).toBe(
      'Codex was told Claude Code changed code it uses before it wrote code using it',
    );
    expectEvidence(f.mindly, s);
    expect(total(f.mindly, f.pid)).toBe(1);
    expect(f.mindly.store.events.query(f.pid, { types: ['save.confirmed'] })).toHaveLength(1);
  });

  it('is confirmed when the conflict is resolved within the window', async () => {
    const f = await impactSetup();
    await tellCodex(f);
    const caught = only(f.mindly, f.pid, 'impact_warned');
    expect(caught.status).toBe('caught');
    // What `mindly conflict <id> resolve` does.
    const c = f.mindly.store.conflicts.setStatus(caught.refs.conflictId!, 'resolved');
    f.mindly.store.events.append({
      projectId: f.pid,
      sessionId: null,
      type: 'conflict.updated',
      payload: { conflictId: c.id, kind: c.kind, status: 'resolved', by: 'user' },
    });
    const s = only(f.mindly, f.pid, 'impact_warned');
    expect(s.status).toBe('confirmed');
    expectEvidence(f.mindly, s);
    expect(total(f.mindly, f.pid)).toBe(1);
  });

  it('is not confirmed by a resolution after the window', async () => {
    const f = await impactSetup();
    await tellCodex(f);
    const caught = only(f.mindly, f.pid, 'impact_warned');
    f.clock.advance(SAVE_WINDOW_MS.impact_warned + 1);
    const c = f.mindly.store.conflicts.setStatus(caught.refs.conflictId!, 'resolved');
    f.mindly.store.events.append({
      projectId: f.pid,
      sessionId: null,
      type: 'conflict.updated',
      payload: { conflictId: c.id, kind: c.kind, status: 'resolved', by: 'user' },
    });
    expect(only(f.mindly, f.pid, 'impact_warned').status).toBe('caught');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('expires when no evidence arrives within 2 hours', async () => {
    const f = await impactSetup();
    await tellCodex(f);
    f.clock.advance(SAVE_WINDOW_MS.impact_warned + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'impact_warned').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is not a save when the agent wrote the dependent file before it was told', async () => {
    const f = await impactSetup();
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'login') }),
    );
    f.clock.advance(1000);
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'prompt', { prompt: 'continue' }));
    expect(savesOfKind(f.mindly, f.pid, 'impact_warned')).toHaveLength(0);
    expect(total(f.mindly, f.pid)).toBe(0);
  });
});

describe('saves: overlap_avoided', () => {
  /** Codex's later calls: it edits src/dashboard.ts instead, then runs the linter. */
  async function codexWorksElsewhere(f: Awaited<ReturnType<typeof overlapSetup>>) {
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/dashboard.ts', 'v') }),
    );
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'v') }),
    );
    f.clock.advance(1000);
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: shellTool('cat src/auth.ts') }),
    );
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: shellTool('cat src/auth.ts') }),
    );
    f.clock.advance(1000);
  }

  it('is confirmed when the warned write did not run and the agent edits another file', async () => {
    const f = await overlapSetup();
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('caught');
    await codexWorksElsewhere(f);
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    // Nothing is decided before the window ends.
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('caught');
    f.clock.advance(SAVE_WINDOW_MS.overlap_avoided);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    const s = only(f.mindly, f.pid, 'overlap_avoided');
    expect(s.status).toBe('confirmed');
    expect(s.sessionIds).toEqual([f.cx.id, f.cc.id]);
    expect(s.paths).toEqual(['src/auth.ts']);
    expect(s.title).toBe("Codex stopped before overwriting Claude Code's work");
    expectEvidence(f.mindly, s);
    const later = f.mindly.store.events.query(f.pid, { types: ['tool.before'] });
    expect(s.evidence).toContain(later.find((e) => e.id !== s.evidence[0])!.id);
    expect(total(f.mindly, f.pid)).toBe(1);
  });

  it("is confirmed when the agent writes the file only after the other agent's intent closed", async () => {
    const f = await overlapSetup();
    await codexWorksElsewhere(f);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'session_end'));
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/auth.ts', 'b') }),
    );
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/auth.ts', 'b') }),
    );
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('confirmed');
    expect(total(f.mindly, f.pid)).toBe(1);
  });

  it('expires when the warned Edit fails and the agent stops', async () => {
    const f = await overlapSetup();
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', {
        tool: { ...writeTool('src/auth.ts', 'b')!, failed: true },
      }),
    );
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('expired');
    f.clock.advance(SAVE_WINDOW_MS.overlap_avoided + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is dropped when the agent overwrites the file through the shell (sed -i)', async () => {
    const f = await overlapSetup();
    const sed = shellTool("sed -i 's/admin/root/' src/auth.ts");
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'pre_tool', { tool: sed }));
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'post_tool', { tool: sed }));
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('rejected');
    f.clock.advance(SAVE_WINDOW_MS.overlap_avoided + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is dropped when the shell writes the file by basename (cp, tee, mv)', async () => {
    for (const command of [
      'cp /tmp/auth.ts src/',
      'echo x | tee auth.ts',
      'mv draft.ts src/auth.ts',
      'printf x > src/auth.ts',
    ]) {
      const f = await overlapSetup();
      await f.mindly.hooks.handle(
        event(f.root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }),
      );
      expect(only(f.mindly, f.pid, 'overlap_avoided').status, command).toBe('rejected');
    }
  });

  it('is dropped when the warned write lands while the other intent is active', async () => {
    const f = await overlapSetup();
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/auth.ts', 'b') }),
    );
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('rejected');
    f.clock.advance(SAVE_WINDOW_MS.overlap_avoided + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('expires when the warned agent makes no later tool call (a prompt is not one)', async () => {
    const f = await overlapSetup();
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'prompt', { prompt: 'go on' }));
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    f.clock.advance(SAVE_WINDOW_MS.overlap_avoided + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });
});

describe('saves: rule_enforced', () => {
  it('is confirmed when the turn ends without the blocked write', async () => {
    const f = await ruleSetup();
    expect(only(f.mindly, f.pid, 'rule_enforced').status).toBe('caught');
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    const s = only(f.mindly, f.pid, 'rule_enforced');
    expect(s.status).toBe('confirmed');
    expect(s.paths).toEqual(['src/generated/api.ts']);
    expect(s.title).toBe('A write by Codex was blocked by your rule');
    expectEvidence(f.mindly, s);
    expect(total(f.mindly, f.pid)).toBe(1);
  });

  it('expires when the session never finishes its turn', async () => {
    const f = await ruleSetup();
    f.clock.advance(SAVE_WINDOW_MS.rule_enforced + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'rule_enforced').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is dropped when the blocked file is written anyway', async () => {
    const f = await ruleSetup();
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/generated/api.ts', 'x') }),
    );
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    expect(only(f.mindly, f.pid, 'rule_enforced').status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is dropped when the denied file is then written through the shell', async () => {
    const f = await ruleSetup();
    const cp = shellTool('cp x src/generated/api.ts');
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'pre_tool', { tool: cp }));
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'post_tool', { tool: cp }));
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    const s = only(f.mindly, f.pid, 'rule_enforced');
    expect(s.status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
    const rejected = f.mindly.store.events.query(f.pid, { types: ['save.rejected'] });
    expect(rejected.map((e) => e.payload.reason)).toEqual(['problem_occurred']);
  });

  it('is still confirmed when later shell commands only read the denied file', async () => {
    const f = await ruleSetup();
    const cat = shellTool('cat src/generated/api.ts | head -n 5');
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'pre_tool', { tool: cat }));
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'post_tool', { tool: cat }));
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    expect(only(f.mindly, f.pid, 'rule_enforced').status).toBe('confirmed');
  });
});

/** `failed` failed for Claude Code; Codex is warned before running `warned`. */
async function mistakeOf(failed: string, warned: string) {
  const f = await featureSetup();
  await f.mindly.hooks.handle(
    event(f.root, 'claude-code', 'cc', 'post_tool', {
      tool: shellTool(failed, true, 'ERR! tests failed'),
    }),
  );
  f.clock.advance(1000);
  const res = await f.mindly.hooks.handle(
    event(f.root, 'codex', 'cx', 'pre_tool', { tool: shellTool(warned) }),
  );
  expect(res.context).toContain('failed before');
  f.clock.advance(1000);
  return f;
}

describe('saves: mistake_avoided', () => {
  it('is not a save when the warned command itself runs and passes', async () => {
    const f = await mistakeOf('pnpm test', 'pnpm test');
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('caught');
    expect(only(f.mindly, f.pid, 'mistake_avoided').title).toBe(
      'Codex was warned about a command that failed before',
    );
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: shellTool('pnpm test', false) }),
    );
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('expired');
    f.clock.advance(SAVE_WINDOW_MS.mistake_avoided + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is not a save when the same command line runs with other spacing and passes', async () => {
    const f = await mistakeOf('npm test', 'npm test');
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: shellTool('  npm   test ', false) }),
    );
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is confirmed when a changed command line succeeds instead', async () => {
    const f = await mistakeOf('npm test', 'npm test');
    // The warned call never ran; Codex runs a changed command line (warned again, same problem).
    const changed = shellTool('npm test -- --runInBand');
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'pre_tool', { tool: changed }));
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('caught');
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', {
        tool: shellTool('npm test -- --runInBand', false),
      }),
    );
    const s = only(f.mindly, f.pid, 'mistake_avoided');
    expect(s.status).toBe('confirmed');
    expect(s.title).toBe('Codex changed a command it was warned about, and it succeeded');
    expect(s.sessionIds).toEqual([f.cx.id]);
    expectEvidence(f.mindly, s);
    expect(total(f.mindly, f.pid)).toBe(1);
  });

  it('is confirmed when the warned call did not run and the agent kept working', async () => {
    const f = await mistakeOf('npm test', 'npm test');
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: shellTool('pnpm vitest run') }),
    );
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: shellTool('pnpm vitest run', false) }),
    );
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('caught');
    f.clock.advance(SAVE_WINDOW_MS.mistake_avoided);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    const s = only(f.mindly, f.pid, 'mistake_avoided');
    expect(s.status).toBe('confirmed');
    expect(s.title).toBe("Codex didn't run a command that failed before");
    expectEvidence(f.mindly, s);
    expect(total(f.mindly, f.pid)).toBe(1);
  });

  it('expires when the agent makes no later tool call (a prompt is not one)', async () => {
    const f = await mistakeOf('npm test', 'npm test');
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'prompt', { prompt: 'use pnpm' }));
    f.clock.advance(SAVE_WINDOW_MS.mistake_avoided + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('expires when the only later call is the warned command again, not run', async () => {
    const f = await mistakeOf('npm test', 'npm test');
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: shellTool('npm test') }),
    );
    f.clock.advance(SAVE_WINDOW_MS.mistake_avoided + 1);
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('expired');
  });

  it('is dropped when the command runs and fails again', async () => {
    const f = await mistakeOf('npm test', 'npm test');
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: shellTool('npm test', true, 'ERR!') }),
    );
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('post_tool loads no mistake memories when no mistake save is pending', async () => {
    const f = await mistakeOf('npm test', 'npm test');
    const list = vi.spyOn(f.mindly.store.memories, 'list');
    const search = vi.spyOn(f.mindly.store.memories, 'search');
    // Claude Code has no pending save: its shell commands cost no memory lookups at all.
    await f.mindly.hooks.handle(
      event(f.root, 'claude-code', 'cc', 'post_tool', { tool: shellTool('npm test', false) }),
    );
    expect(list).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(f.mindly.store.events.query(f.pid, { types: ['tool.after'] })).toHaveLength(0);
    // Codex has one: its post_tool is settled from the pending save, still without memories.
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: shellTool('npm test', false) }),
    );
    expect(only(f.mindly, f.pid, 'mistake_avoided').status).toBe('expired');
    expect(list).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    list.mockRestore();
    search.mockRestore();
  });
});

describe('saves: check_broken_early (contract)', () => {
  it('is confirmed when the breaking session fixes the check', async () => {
    const f = await contractSetup();
    expect(only(f.mindly, f.pid, 'check_broken_early').status).toBe('caught');
    f.write('src/auth.ts', AUTH_V1);
    await f.mindly.hooks.handle(
      event(f.root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'role') }),
    );
    const s = only(f.mindly, f.pid, 'check_broken_early');
    expect(s.status).toBe('confirmed');
    expect(s.title).toBe('A check Claude Code broke was caught and fixed before merging');
    expect(s.paths).toEqual(['src/auth.ts']);
    expectEvidence(f.mindly, s);
    expect(total(f.mindly, f.pid)).toBe(1);
  });

  it('expires when the check stays broken past the window', async () => {
    const f = await contractSetup();
    f.clock.advance(SAVE_WINDOW_MS.check_broken_early + 1);
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    expect(only(f.mindly, f.pid, 'check_broken_early').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is dropped when the session ends with the check still failing', async () => {
    const f = await contractSetup();
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'session_end'));
    expect(only(f.mindly, f.pid, 'check_broken_early').status).toBe('rejected');
    f.write('src/auth.ts', AUTH_V1);
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/auth.ts', 'role') }),
    );
    expect(only(f.mindly, f.pid, 'check_broken_early').status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
  });
});

describe('saves: limit_handoff', () => {
  it('is confirmed when another agent claims the handoff', async () => {
    const f = await limitSetup();
    expect(only(f.mindly, f.pid, 'limit_handoff').status).toBe('caught');
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'session_start'));
    const s = only(f.mindly, f.pid, 'limit_handoff');
    expect(s.status).toBe('confirmed');
    expect(s.title).toBe('Work continued in Codex after Claude Code hit its usage limit');
    expectEvidence(f.mindly, s);
    expect(total(f.mindly, f.pid)).toBe(1);
  });

  it('expires when nobody picks the work up', async () => {
    const f = await limitSetup();
    f.clock.advance(SAVE_WINDOW_MS.limit_handoff + 1);
    savesOf(f.mindly).sweep();
    expect(only(f.mindly, f.pid, 'limit_handoff').status).toBe('expired');
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'session_start'));
    expect(only(f.mindly, f.pid, 'limit_handoff').status).toBe('expired');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is not a save when the same agent kind claims the handoff', async () => {
    // With no other agent in the failover order the handoff is open to any agent.
    const f = await limitSetup((c) => {
      c.failover.order = ['claude-code'];
    });
    expect(f.mindly.store.handoffs.list(f.pid)[0]?.toAgentKind).toBeNull();
    expect(only(f.mindly, f.pid, 'limit_handoff').status).toBe('caught');
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc2', 'session_start'));
    expect(f.mindly.store.handoffs.list(f.pid)[0]?.status).not.toBe('pending');
    expect(only(f.mindly, f.pid, 'limit_handoff').status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
  });

  it('is not a save when the agent stopped without hitting a limit', async () => {
    const { root, clock, mindly } = make();
    mindly.use(createFailoverModule({}));
    mindly.use(savesModule);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'stop', { lastMessage: 'All done.' }),
    );
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.saves.list(pid)).toHaveLength(0);
  });
});

describe('saves: dismissal and rejection (AC2)', () => {
  it('drops the save of a conflict the user dismisses', async () => {
    const f = await impactSetup();
    await tellCodex(f);
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'signIn') }),
    );
    const s = only(f.mindly, f.pid, 'impact_warned');
    expect(s.status).toBe('confirmed');
    const c = f.mindly.store.conflicts.setStatus(s.refs.conflictId!, 'dismissed');
    f.mindly.store.events.append({
      projectId: f.pid,
      sessionId: null,
      type: 'conflict.updated',
      payload: { conflictId: c.id, kind: c.kind, status: 'dismissed', by: 'user' },
    });
    expect(only(f.mindly, f.pid, 'impact_warned').status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
    const rejected = f.mindly.store.events.query(f.pid, { types: ['save.rejected'] });
    expect(rejected.map((e) => e.payload.reason)).toEqual(['conflict_dismissed']);
  });

  it('removes a save the user rejects from every total, for good', async () => {
    const f = await ruleSetup();
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    const s = only(f.mindly, f.pid, 'rule_enforced');
    expect(total(f.mindly, f.pid)).toBe(1);
    expect(f.mindly.store.saves.countConfirmed(f.pid, 0)).toBe(1);
    expect(savesOf(f.mindly).rejectByUser(s.id).status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
    expect(f.mindly.store.saves.countConfirmed(f.pid, 0)).toBe(0);
    // The same denial again is the same problem: it does not come back.
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/generated/api.ts', 'y') }),
    );
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    expect(only(f.mindly, f.pid, 'rule_enforced').status).toBe('rejected');
    expect(total(f.mindly, f.pid)).toBe(0);
  });
});

describe('saves: one problem counts once (AC3)', () => {
  it('dedupes retries in a session and the same problem across sessions', async () => {
    const f = await ruleSetup();
    // Codex retries the same write; Claude Code tries it too.
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/generated/api.ts', 'x2') }),
    );
    await f.mindly.hooks.handle(
      event(f.root, 'claude-code', 'cc', 'pre_tool', {
        tool: writeTool('src/generated/api.ts', 'x3'),
      }),
    );
    await f.mindly.hooks.handle(event(f.root, 'codex', 'cx', 'stop'));
    await f.mindly.hooks.handle(event(f.root, 'claude-code', 'cc', 'stop'));
    expect(savesOfKind(f.mindly, f.pid, 'rule_enforced')).toHaveLength(1);
    expect(total(f.mindly, f.pid)).toBe(1);
    expect(f.mindly.store.events.query(f.pid, { types: ['save.caught'] })).toHaveLength(1);
  });

  it('dedupes a repeated warning and a redelivered impact', async () => {
    const f = await mistakeSetup();
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: shellTool('npm test') }),
    );
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'post_tool', { tool: shellTool('npm test -- --ci', false) }),
    );
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: shellTool('npm test') }),
    );
    expect(savesOfKind(f.mindly, f.pid, 'mistake_avoided')).toHaveLength(1);
    expect(total(f.mindly, f.pid)).toBe(1);

    const g = await impactSetup();
    await tellCodex(g);
    await g.mindly.hooks.handle(event(g.root, 'codex', 'cx', 'prompt', { prompt: 'again' }));
    await g.mindly.hooks.handle(event(g.root, 'codex', 'cx', 'session_start'));
    expect(savesOfKind(g.mindly, g.pid, 'impact_warned')).toHaveLength(1);
  });

  it('never counts an expired problem again on a retry', async () => {
    const f = await overlapSetup();
    f.clock.advance(SAVE_WINDOW_MS.overlap_avoided + 1);
    savesOf(f.mindly).sweep(f.pid);
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('expired');
    await f.mindly.hooks.handle(
      event(f.root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/auth.ts', 'c') }),
    );
    expect(only(f.mindly, f.pid, 'overlap_avoided').status).toBe('expired');
  });
});
