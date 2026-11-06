import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultUserConfig, EMPTY_HOOK_RESULT, type UserConfig } from '@mindly/core';
import {
  Mindly,
  PRUNE_INTERVAL_MS,
  type CheckpointCaptureInput,
  type CheckpointGitPort,
} from '../../src/index.js';
import { event, FakeClock, fakeGit, shellTool, writeTool } from '../helpers.js';

const DAY_MS = 86_400_000;

/**
 * An in-memory stand-in for the git side of checkpoints: every capture is recorded and answered
 * with a new fake commit; a full rescan only changes something when the test says so.
 */
function fakeCheckpointGit(root: string) {
  const captures: CheckpointCaptureInput[] = [];
  const deleted: { worktree: string; refs: string[] }[] = [];
  const state = { commits: 0, busy: false, failing: false, rescanChanges: [] as string[] };
  const port: CheckpointGitPort = {
    worktreeRoot: async (cwd) => (cwd === root || cwd.startsWith(`${root}/`) ? root : null),
    refName: (worktree, seq) => `refs/mindly/steps/${basename(worktree)}/${seq}`,
    capture: async (input) => {
      captures.push(input);
      if (state.failing) throw new Error('git index locked');
      const changedPaths = input.paths ? [...input.paths] : state.rescanChanges;
      state.rescanChanges = [];
      const changed = input.parent === null || changedPaths.length > 0;
      if (!changed && !input.always) {
        return { commit: null, tree: 'tree-same', changed: false, changedPaths: [], skipped: [] };
      }
      state.commits += 1;
      return {
        commit: `commit-${state.commits}`,
        tree: `tree-${state.commits}`,
        changed,
        changedPaths,
        skipped: [],
      };
    },
    deleteRefs: async (worktree, refs) => {
      deleted.push({ worktree, refs: [...refs] });
      return refs.length;
    },
    diskUsage: async () => 4096,
    tryLock: () => (state.busy ? null : { release: () => undefined }),
  };
  return { port, captures, deleted, state };
}

function make(configure?: (c: UserConfig) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-checkpoints-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function login() {}\n');
  writeFileSync(join(root, 'src', 'other.ts'), 'export const other = 1;\n');
  const clock = new FakeClock();
  const fake = fakeCheckpointGit(root);
  const config = defaultUserConfig();
  configure?.(config);
  const mindly = Mindly.open({
    inMemory: true,
    clock,
    config,
    ports: { git: { ...fakeGit, checkpoints: fake.port } },
  });
  const pid = () => mindly.store.projects.list()[0]!.id;
  const rows = () => mindly.store.checkpoints.list(pid(), root);
  return { root, clock, mindly, fake, pid, rows };
}

describe('checkpoints through hooks', () => {
  it('takes a baseline at session start and nothing when a rescan finds no change', async () => {
    const { root, mindly, fake, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    expect(fake.captures).toHaveLength(1);
    expect(fake.captures[0]).toMatchObject({
      worktree: root,
      paths: null,
      parent: null,
      always: false,
      ref: `refs/mindly/steps/${basename(root)}/1`,
    });
    expect(fake.captures[0]!.indexFile).not.toContain(root);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      seq: 1,
      kind: 'baseline',
      commit: 'commit-1',
      parentCommit: null,
      sessionId: null,
      tool: null,
      paths: [],
      gap: false,
    });

    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'hello' }));
    expect(fake.captures).toHaveLength(2);
    expect(fake.captures[1]).toMatchObject({
      paths: null,
      parent: { commit: 'commit-1' },
      always: false,
    });
    expect(rows()).toHaveLength(1);
  });

  it('records an agent step for every edit, linked to its change and prompt', async () => {
    const { root, mindly, fake, pid, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'add admin role' }),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    const session = mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!;
    const prompt = mindly.store.events.query(pid(), { types: ['prompt.submitted'] })[0]!;
    const change = mindly.store.fileChanges.forPath(pid(), 'src/auth.ts')[0]!;
    expect(fake.captures.at(-1)).toMatchObject({
      paths: ['src/auth.ts'],
      always: true,
      parent: { commit: 'commit-1' },
      ref: `refs/mindly/steps/${basename(root)}/2`,
      message: 'mindly step 2',
    });
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toMatchObject({
      seq: 2,
      kind: 'agent',
      commit: 'commit-2',
      parentCommit: 'commit-1',
      sessionId: session.id,
      tool: 'Edit',
      paths: ['src/auth.ts'],
      fileChangeId: change.id,
      promptEventId: prompt.id,
      gap: false,
    });
    expect(change.promptEventId).toBe(prompt.id);
  });

  it('numbers the steps of two sessions in one checkout in arrival order', async () => {
    const { root, mindly, pid, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    const edits: [string, string, string][] = [
      ['claude-code', 'cc', 'src/auth.ts'],
      ['codex', 'cx', 'src/other.ts'],
      ['claude-code', 'cc', 'src/auth.ts'],
      ['codex', 'cx', 'src/other.ts'],
    ];
    for (const [agent, external, path] of edits) {
      await mindly.hooks.handle(
        event(root, agent, external, 'post_tool', { tool: writeTool(path, 'y') }),
      );
    }
    const cc = mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!;
    const cx = mindly.store.sessions.findByExternal(pid(), 'codex', 'cx')!;
    expect(cc.id).not.toBe(cx.id);
    const steps = rows().slice(1);
    expect(steps.map((c) => c.seq)).toEqual([2, 3, 4, 5]);
    expect(steps.map((c) => c.sessionId)).toEqual([cc.id, cx.id, cc.id, cx.id]);
    expect(steps.map((c) => c.paths)).toEqual([
      ['src/auth.ts'],
      ['src/other.ts'],
      ['src/auth.ts'],
      ['src/other.ts'],
    ]);
    expect(steps.map((c) => c.parentCommit)).toEqual([
      'commit-1',
      'commit-2',
      'commit-3',
      'commit-4',
    ]);
  });

  it('records changes no edit explains as an outside step', async () => {
    const { root, mindly, fake, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'a') }),
    );
    fake.state.rescanChanges = ['src/other.ts', 'README.md'];
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'go on' }));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'b') }),
    );
    const steps = rows();
    expect(steps.map((c) => [c.seq, c.kind])).toEqual([
      [1, 'baseline'],
      [2, 'agent'],
      [3, 'outside'],
      [4, 'agent'],
    ]);
    expect(steps[2]).toMatchObject({
      sessionId: null,
      tool: null,
      fileChangeId: null,
      promptEventId: null,
      paths: ['src/other.ts', 'README.md'],
    });
    expect(steps[1]!.paths).toEqual(['src/auth.ts']);
    expect(steps[3]!.paths).toEqual(['src/auth.ts']);
    expect(steps[1]!.sessionId).not.toBeNull();
    expect(steps[3]!.sessionId).toBe(steps[1]!.sessionId);
  });

  it('skips a step when the lock is busy or git fails, and marks the next one as a gap', async () => {
    const { root, mindly, fake, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const edit = (text: string) =>
      mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', text) }),
      );

    fake.state.busy = true;
    await expect(edit('busy')).resolves.toEqual(EMPTY_HOOK_RESULT);
    expect(fake.captures).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    fake.state.busy = false;
    await edit('after busy');
    expect(rows().map((c) => [c.seq, c.gap])).toEqual([
      [1, false],
      [2, true],
    ]);
    await edit('plain');
    expect(rows().at(-1)).toMatchObject({ seq: 3, gap: false });

    fake.state.failing = true;
    await expect(edit('failing')).resolves.toEqual(EMPTY_HOOK_RESULT);
    expect(fake.captures).toHaveLength(4);
    expect(rows()).toHaveLength(3);
    fake.state.failing = false;
    await edit('after failure');
    expect(rows().at(-1)).toMatchObject({ seq: 4, gap: true, paths: ['src/auth.ts'] });
    await edit('plain again');
    expect(rows().at(-1)).toMatchObject({ seq: 5, gap: false });
  });

  it('records nothing when checkpoints are disabled', async () => {
    const { root, mindly, fake, pid } = make((c) => {
      c.checkpoints.enabled = false;
    });
    expect(mindly.checkpoints.enabled).toBe(false);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: shellTool('pnpm format') }),
    );
    expect(fake.captures).toHaveLength(0);
    expect(mindly.store.checkpoints.count(pid())).toBe(0);
    expect(mindly.store.fileChanges.forPath(pid(), 'src/auth.ts')).toHaveLength(1);
  });

  it('rescans after a shell command that may write files, not after a read', async () => {
    const { root, mindly, fake } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const shell = (command: string) =>
      mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: shellTool(command) }),
      );
    await shell('ls src');
    await shell('cat src/auth.ts | grep login');
    await shell('git status');
    expect(fake.captures).toHaveLength(1);
    await shell('sed -i s/a/b/ src/x.ts');
    expect(fake.captures).toHaveLength(2);
    expect(fake.captures[1]).toMatchObject({ paths: null, always: false });
    await shell('pnpm format');
    expect(fake.captures).toHaveLength(3);
    await shell('echo hi > notes.txt');
    expect(fake.captures).toHaveLength(4);
  });

  it('prunes by age, deleting refs through git and the rows', async () => {
    const { root, clock, mindly, fake, pid, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    clock.advance(mindly.config.checkpoints.keepDays * DAY_MS - 1000);
    expect(await mindly.checkpoints.prune(pid())).toEqual({ refsDeleted: 0, rowsDeleted: 0 });
    expect(fake.deleted).toEqual([]);
    clock.advance(2000);
    expect(await mindly.checkpoints.prune(pid())).toEqual({ refsDeleted: 2, rowsDeleted: 2 });
    expect(fake.deleted).toEqual([
      {
        worktree: root,
        refs: [`refs/mindly/steps/${basename(root)}/1`, `refs/mindly/steps/${basename(root)}/2`],
      },
    ]);
    expect(rows()).toEqual([]);
  });

  it('keeps only the newest maxPerWorktree checkpoints', async () => {
    const { root, mindly, pid, rows } = make((c) => {
      c.checkpoints.maxPerWorktree = 2;
    });
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    for (const text of ['a', 'b', 'c']) {
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', text) }),
      );
    }
    expect(rows().map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(await mindly.checkpoints.prune(pid())).toEqual({ refsDeleted: 2, rowsDeleted: 2 });
    expect(rows().map((c) => c.seq)).toEqual([3, 4]);
  });

  it('prunes from the hook at most once a day', async () => {
    const { root, clock, mindly, pid, rows } = make((c) => {
      c.checkpoints.maxPerWorktree = 1;
    });
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    for (const text of ['a', 'b']) {
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', text) }),
      );
    }
    expect(rows().map((c) => c.seq)).toEqual([1, 2, 3]);
    // Session start already pruned at this clock time.
    expect(await mindly.checkpoints.pruneIfDue(pid())).toBeNull();
    clock.advance(PRUNE_INTERVAL_MS - 1);
    expect(await mindly.checkpoints.pruneIfDue(pid())).toBeNull();
    expect(rows()).toHaveLength(3);
    clock.advance(1);
    expect(await mindly.checkpoints.pruneIfDue(pid())).toEqual({ refsDeleted: 2, rowsDeleted: 2 });
    expect(rows().map((c) => c.seq)).toEqual([3]);
    expect(await mindly.checkpoints.pruneIfDue(pid())).toBeNull();
  });

  it('forgets every checkpoint of a project and reports stats', async () => {
    const { root, mindly, fake, pid } = make();
    expect(await mindly.checkpoints.stats('nobody')).toEqual({ count: 0, diskBytes: null });
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    expect(await mindly.checkpoints.stats(pid())).toEqual({ count: 2, diskBytes: 4096 });
    expect(await mindly.checkpoints.forget(pid())).toEqual({ refsDeleted: 2, rowsDeleted: 2 });
    expect(fake.deleted).toHaveLength(1);
    expect(fake.deleted[0]!.refs).toHaveLength(2);
    expect(mindly.store.checkpoints.count(pid())).toBe(0);
    expect(await mindly.checkpoints.stats(pid())).toEqual({ count: 0, diskBytes: null });
    expect(await mindly.checkpoints.forget(pid())).toEqual({ refsDeleted: 0, rowsDeleted: 0 });
  });
});
