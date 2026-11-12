import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { utimes } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  defaultUserConfig,
  EMPTY_HOOK_RESULT,
  MindlyError,
  sha256,
  type UserConfig,
} from '@mindly/core';
import {
  LIVE_WINDOW_MS,
  Mindly,
  PRUNE_INTERVAL_MS,
  type CheckpointCaptureInput,
  type CheckpointGitPort,
  type CheckpointRefEntry,
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
  const refs: CheckpointRefEntry[] = [];
  const state = {
    commits: 0,
    busy: false,
    failing: false,
    /** The next capture by path finds the tree already equal to the previous step. */
    alreadyTaken: false,
    rescanChanges: [] as string[],
    now: 0,
  };
  const parseRef = (ref: string) => {
    const [worktreeId, seq] = ref.slice('refs/mindly/steps/'.length).split('/');
    return { worktreeId: worktreeId as string, seq: Number(seq) };
  };
  const port: CheckpointGitPort = {
    worktreeRoot: async (cwd) => (cwd === root || cwd.startsWith(`${root}/`) ? root : null),
    worktreeId: (worktree) => basename(worktree),
    refName: (worktree, seq) => `refs/mindly/steps/${basename(worktree)}/${seq}`,
    capture: async (input) => {
      captures.push(input);
      if (state.failing) throw new Error('git index locked');
      const taken = state.alreadyTaken && input.paths !== null;
      state.alreadyTaken = false;
      const changedPaths = taken ? [] : input.paths ? [...input.paths] : state.rescanChanges;
      if (!input.paths) state.rescanChanges = [];
      const changed = input.parent === null || changedPaths.length > 0;
      if (!changed && !input.always) {
        return {
          commit: null,
          tree: 'tree-same',
          changed: false,
          changedPaths: [],
          skipped: [],
          fresh: false,
        };
      }
      if (refs.some((r) => r.ref === input.ref)) {
        throw new MindlyError('conflict', 'checkpoint ref already exists');
      }
      state.commits += 1;
      const commit = `commit-${state.commits}`;
      refs.push({ ...parseRef(input.ref), ref: input.ref, commit, createdAt: state.now });
      return {
        commit,
        tree: `tree-${state.commits}`,
        changed,
        changedPaths,
        skipped: [],
        fresh: false,
      };
    },
    listRefs: async () => [...refs],
    deleteRefs: async (repoDir, wanted) => {
      const existing = refs.filter((r) => wanted.includes(r.ref));
      deleted.push({ worktree: repoDir, refs: existing.map((r) => r.ref) });
      for (const r of existing) refs.splice(refs.indexOf(r), 1);
      return existing.length;
    },
    diskUsage: async () => 4096,
    tryLock: () => (state.busy ? null : { release: () => undefined }),
  };
  return { port, captures, deleted, refs, state };
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
      always: false,
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

  it('never reuses a step number: rows may go, refs and the high-water mark stay', async () => {
    const { root, mindly, fake, pid, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const edit = (text: string) =>
      mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', text) }),
      );
    await edit('a');
    await edit('b');
    expect(rows().map((c) => c.seq)).toEqual([1, 2, 3]);
    // Rows lost without their refs (a reset database): numbering goes on from the mark.
    mindly.store.checkpoints.delete(rows().map((c) => c.id));
    await edit('c');
    expect(rows().map((c) => c.seq)).toEqual([4]);
    // The mark lost too (a reset home): the refs themselves give the next free number.
    mindly.store.checkpoints.delete(rows().map((c) => c.id));
    mindly.store.kv.delete(`checkpoints:seq:${pid()}:${sha256(root).slice(0, 16)}`);
    await edit('d');
    expect(rows().map((c) => c.seq)).toEqual([5]);
    expect(fake.refs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(mindly.store.checkpoints.count(pid())).toBe(1);
  });

  it('skips a step when the lock is busy or git fails, and marks the next one as a gap', async () => {
    const { root, mindly, fake, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const edit = (text: string, path = 'src/auth.ts') =>
      mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool(path, text) }),
      );

    fake.state.busy = true;
    await expect(edit('busy')).resolves.toEqual(EMPTY_HOOK_RESULT);
    expect(fake.captures).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    fake.state.busy = false;
    // The step after a skipped one scans the whole tree, so it holds the edit that was missed.
    fake.state.rescanChanges = ['src/auth.ts', 'src/other.ts'];
    await edit('after busy', 'src/other.ts');
    expect(fake.captures.at(-1)).toMatchObject({ paths: null });
    expect(rows().map((c) => [c.seq, c.kind, c.gap, c.paths])).toEqual([
      [1, 'baseline', false, []],
      [2, 'agent', true, ['src/auth.ts', 'src/other.ts']],
    ]);
    // Nothing is left over for a later rescan to pin on nobody.
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'go on' }));
    expect(rows()).toHaveLength(2);
    await edit('plain');
    expect(fake.captures.at(-1)).toMatchObject({ paths: ['src/auth.ts'] });
    expect(rows().at(-1)).toMatchObject({ seq: 3, gap: false });

    fake.state.failing = true;
    await expect(edit('failing')).resolves.toEqual(EMPTY_HOOK_RESULT);
    expect(rows()).toHaveLength(3);
    fake.state.failing = false;
    fake.state.rescanChanges = ['src/auth.ts'];
    await edit('after failure');
    expect(fake.captures.at(-1)).toMatchObject({ paths: null });
    expect(rows().at(-1)).toMatchObject({ seq: 4, gap: true, paths: ['src/auth.ts'] });
    await edit('plain again');
    expect(rows().at(-1)).toMatchObject({ seq: 5, gap: false });
  });

  it('credits a step a rescan took first to the agent, as a gap when it holds more', async () => {
    const { root, clock, mindly, fake, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const prompt = async () => {
      clock.advance(10);
      await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'something else' }));
    };
    let n = 0;
    const write = async () => {
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'a') }),
      );
      writeFileSync(join(root, 'src', 'auth.ts'), `export const n = ${++n};\n`);
    };
    const lateEdit = () => {
      fake.state.alreadyTaken = true;
      return mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'a') }),
      );
    };
    // Another session's prompt rescans between the write and its hook: the step is the edit.
    await write();
    fake.state.rescanChanges = ['src/auth.ts'];
    await prompt();
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'outside', gap: false });
    await lateEdit();
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'agent', tool: 'Edit', gap: false });
    // The same race, but the rescan also picked up a file nobody's edit explains.
    await write();
    fake.state.rescanChanges = ['src/auth.ts', 'src/other.ts'];
    await prompt();
    expect(rows().at(-1)).toMatchObject({ seq: 3, kind: 'outside', gap: false });
    await lateEdit();
    expect(rows().at(-1)).toMatchObject({
      seq: 3,
      kind: 'agent',
      gap: true,
      paths: ['src/auth.ts', 'src/other.ts'],
    });
    expect(rows()).toHaveLength(3);
  });

  it('keeps an outside step taken before the write began, or by a write of other paths', async () => {
    const { root, clock, mindly, fake, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const write = (path: string) =>
      mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool(path, 'a') }),
      );
    const unchangedWrite = () => {
      fake.state.alreadyTaken = true;
      return mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'a') }),
      );
    };
    // A hand edit is rescanned into a step; later the agent writes the same content again.
    fake.state.rescanChanges = ['src/auth.ts'];
    clock.advance(10);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'look' }));
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'outside' });
    clock.advance(10);
    await write('src/auth.ts');
    clock.advance(10);
    await unchangedWrite();
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'outside', sessionId: null });
    // No pre-tool hook was seen for this write: when it began cannot be told.
    await unchangedWrite();
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'outside', sessionId: null });
    // The pre-tool hook named another file than the one written.
    await write('src/other.ts');
    fake.state.rescanChanges = ['src/auth.ts'];
    clock.advance(10);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'look again' }));
    expect(rows().at(-1)).toMatchObject({ seq: 3, kind: 'outside' });
    await unchangedWrite();
    expect(rows().at(-1)).toMatchObject({ seq: 3, kind: 'outside', sessionId: null });
  });

  it('keeps a hand edit rescanned while a write that changed nothing was on its way', async () => {
    const { root, clock, mindly, fake, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    // The file is edited by hand; the agent starts a write that leaves it as it now is.
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const hand = 1;\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'a') }),
    );
    // Another session's prompt rescans the hand edit before the write's post-tool hook.
    fake.state.rescanChanges = ['src/auth.ts'];
    clock.advance(10);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'look' }));
    fake.state.alreadyTaken = true;
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'a') }),
    );
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'outside', sessionId: null });
  });

  it('gives overlapping writes of one file in one session each their own note', async () => {
    const { root, clock, mindly, fake, pid, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const cc = () => mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!.id;
    const pre = () =>
      mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'a') }),
      );
    const post = (taken: boolean) => {
      fake.state.alreadyTaken = taken;
      return mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'a') }),
      );
    };
    // Subagent A writes auth.ts and a rescan takes it; subagent B starts a write of the same
    // file before A's post-tool hook comes.
    clock.advance(10);
    await pre();
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const a = 1;\n');
    fake.state.rescanChanges = ['src/auth.ts'];
    clock.advance(10);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'look' }));
    clock.advance(10);
    await pre();
    await post(true);
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'agent', sessionId: cc() });
    // B's note is still there for B's own write.
    clock.advance(10);
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const b = 1;\n');
    fake.state.rescanChanges = ['src/auth.ts'];
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'look again' }));
    expect(rows().at(-1)).toMatchObject({ seq: 3, kind: 'outside' });
    await post(true);
    expect(rows().at(-1)).toMatchObject({ seq: 3, kind: 'agent', sessionId: cc() });
  });

  it('does not let a write that never finished stand in for a later one', async () => {
    const { root, clock, mindly, fake, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const pre = () =>
      mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'a') }),
      );
    // A write the user denied: its pre-tool hook ran, its post-tool hook never comes.
    clock.advance(10);
    await pre();
    // The file is edited by hand; the agent then writes it with that same content.
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const hand = 1;\n');
    clock.advance(10);
    await pre();
    fake.state.rescanChanges = ['src/auth.ts'];
    clock.advance(10);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'look' }));
    fake.state.alreadyTaken = true;
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'a') }),
    );
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'outside', sessionId: null });
  });

  it('tells a write of a large file by its size and modification time', async () => {
    const { root, clock, mindly, fake, pid, rows } = make();
    const big = join(root, 'src', 'data.json');
    writeFileSync(big, 'x'.repeat(9 * 1024 * 1024));
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const cc = () => mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!.id;
    let writes = 0;
    const write = async (content: string | null) => {
      clock.advance(10);
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/data.json', 'y') }),
      );
      if (content !== null) {
        writeFileSync(big, content.repeat(9 * 1024 * 1024));
        // Writes in one tick of the file system's clock would look the same: one minute apart.
        const at = new Date(Date.UTC(2030, 0, 1) + 60_000 * ++writes);
        await utimes(big, at, at);
      }
      fake.state.rescanChanges = ['src/data.json'];
      clock.advance(10);
      await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'look' }));
      fake.state.alreadyTaken = true;
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/data.json', 'y') }),
      );
      return rows().at(-1);
    };
    expect(await write('y')).toMatchObject({ seq: 2, kind: 'agent', sessionId: cc() });
    // A write that left it as it was takes nothing.
    expect(await write(null)).toMatchObject({ seq: 3, kind: 'outside', sessionId: null });
  });

  it('matches each write of a session with its own pre-tool hook', async () => {
    const { root, clock, mindly, fake, pid, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const pre = (path: string) =>
      mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool(path, 'a') }),
      );
    const post = (path: string, taken: boolean) => {
      fake.state.alreadyTaken = taken;
      return mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool(path, 'a') }),
      );
    };
    const rescan = async () => {
      fake.state.rescanChanges = ['src/auth.ts'];
      clock.advance(10);
      await mindly.hooks.handle(event(root, 'codex', 'cx', 'prompt', { prompt: 'look' }));
    };
    const cc = () => mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!.id;
    // Two subagents of one session: A writes auth.ts, a rescan takes it, B starts another write.
    await pre('src/auth.ts');
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const a = 1;\n');
    await rescan();
    await pre('src/other.ts');
    await post('src/auth.ts', true);
    expect(rows().at(-1)).toMatchObject({ seq: 2, kind: 'agent', sessionId: cc() });
    writeFileSync(join(root, 'src', 'other.ts'), 'export const b = 1;\n');
    await post('src/other.ts', false);
    expect(rows().at(-1)).toMatchObject({ seq: 3, kind: 'agent', paths: ['src/other.ts'] });
    // A write whose post-tool hook never came (denied by the user) is forgotten after a while.
    await pre('src/auth.ts');
    clock.advance(6 * 60_000);
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const a = 2;\n');
    await rescan();
    await post('src/auth.ts', true);
    expect(rows().at(-1)).toMatchObject({ seq: 4, kind: 'outside', sessionId: null });
    // And when the session ends.
    await pre('src/auth.ts');
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_end'));
    expect(mindly.store.kv.get(`checkpoints:writing:${cc()}`)).toBeNull();
  });

  it('drops the notes of writes in flight of a session ended as stale', async () => {
    const { root, clock, mindly, pid } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const cc = mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!.id;
    // A write whose post-tool hook never comes, in a window killed without its end hook.
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    expect(mindly.store.kv.get(`checkpoints:writing:${cc}`)).not.toBeNull();
    // A later session's start ends it as stale.
    clock.advance(LIVE_WINDOW_MS * 4 + 1);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc2', 'session_start'));
    expect(mindly.store.sessions.get(cc).status).toBe('ended');
    expect(mindly.store.kv.get(`checkpoints:writing:${cc}`)).toBeNull();
  });

  it('prunes the notes of writes in flight once they expired, however the session ended', async () => {
    const { root, clock, mindly, pid } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    const cc = mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!.id;
    const cx = mindly.store.sessions.findByExternal(pid(), 'codex', 'cx')!.id;
    const pre = (agent: string, id: string) =>
      mindly.hooks.handle(
        event(root, agent, id, 'pre_tool', { tool: writeTool('src/auth.ts', 'x') }),
      );
    await pre('claude-code', 'cc');
    clock.advance(6 * 60_000);
    await pre('codex', 'cx');
    // An unrelated key with the same start is left alone.
    mindly.store.kv.set('checkpoints:pruned:x', 1);
    await mindly.checkpoints.pruneAll();
    expect(mindly.store.kv.get(`checkpoints:writing:${cc}`)).toBeNull();
    expect(mindly.store.kv.get(`checkpoints:writing:${cx}`)).not.toBeNull();
    expect(mindly.store.kv.get('checkpoints:pruned:x')).toBe(1);
    // The daily prune of the hooks (no daemon) sweeps them too.
    clock.advance(PRUNE_INTERVAL_MS);
    expect(await mindly.checkpoints.pruneIfDue(pid())).not.toBeNull();
    expect(mindly.store.kv.get(`checkpoints:writing:${cx}`)).toBeNull();
  });

  it('credits a rescan only with edits recorded in its working tree', async () => {
    const { root, clock, mindly, fake, pid, rows } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const session = mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!;
    const record = (worktree: string | null | undefined) => {
      clock.advance(10);
      mindly.store.fileChanges.record({
        projectId: pid(),
        sessionId: session.id,
        path: 'src/auth.ts',
        tool: 'Edit',
        hunkHashes: [],
        addedLines: 1,
        removedLines: 0,
        promptEventId: null,
        ...(worktree === undefined ? {} : { worktree }),
      });
    };
    const rescan = async () => {
      fake.state.rescanChanges = ['src/auth.ts'];
      clock.advance(10);
      await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'go' }));
      return rows().at(-1)!;
    };
    // An edit recorded in another working tree, while the session now runs here.
    record(`${root}-feature`);
    expect(await rescan()).toMatchObject({ kind: 'outside', sessionId: null, gap: false });
    // An edit recorded before its working tree was kept: it may be here, so nobody is blamed.
    record(undefined);
    expect(await rescan()).toMatchObject({ kind: 'outside', sessionId: null, gap: true });
    record(null);
    record(root);
    expect(await rescan()).toMatchObject({ kind: 'agent', sessionId: session.id, gap: true });
    record(root);
    expect(await rescan()).toMatchObject({ kind: 'agent', sessionId: session.id, gap: false });
  });

  it('records the working tree of every agent edit', async () => {
    const { root, mindly, pid } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    expect(mindly.store.fileChanges.forPath(pid(), 'src/auth.ts')[0]).toMatchObject({
      worktree: root,
    });
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

  it('leaves a ref without a row alone until it is an hour old', async () => {
    const { root, clock, mindly, fake, pid } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    // A capture in another process has created the ref of step 2; its row is still to come.
    const ref = `refs/mindly/steps/${basename(root)}/2`;
    fake.refs.push({
      worktreeId: basename(root),
      seq: 2,
      ref,
      commit: 'commit-x',
      createdAt: clock.now(),
    });
    clock.advance(60_000);
    expect(await mindly.checkpoints.prune(pid())).toEqual({ refsDeleted: 0, rowsDeleted: 0 });
    expect(fake.refs.map((r) => r.seq)).toEqual([1, 2]);
    clock.advance(3_600_000);
    expect(await mindly.checkpoints.prune(pid())).toEqual({ refsDeleted: 1, rowsDeleted: 0 });
    expect(fake.deleted).toEqual([{ worktree: root, refs: [ref] }]);
  });

  it('leaves a ref without a row alone when its age cannot be told', async () => {
    const { root, clock, mindly, fake, pid } = make();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const ref = `refs/mindly/steps/${basename(root)}/2`;
    fake.refs.push({ worktreeId: basename(root), seq: 2, ref, commit: 'commit-x', createdAt: 0 });
    clock.advance(30 * DAY_MS);
    await mindly.checkpoints.prune(pid());
    expect(fake.refs.map((r) => r.ref)).toContain(ref);
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
    // A write whose post-tool hook never came: its note goes with the project.
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'y') }),
    );
    const cc = mindly.store.sessions.findByExternal(pid(), 'claude-code', 'cc')!.id;
    expect(mindly.store.kv.get(`checkpoints:writing:${cc}`)).not.toBeNull();
    expect(await mindly.checkpoints.forget(pid())).toEqual({ refsDeleted: 2, rowsDeleted: 2 });
    expect(mindly.store.kv.get(`checkpoints:writing:${cc}`)).toBeNull();
    expect(fake.deleted).toHaveLength(1);
    expect(fake.deleted[0]!.refs).toHaveLength(2);
    expect(mindly.store.checkpoints.count(pid())).toBe(0);
    expect(await mindly.checkpoints.stats(pid())).toEqual({ count: 0, diskBytes: null });
    expect(await mindly.checkpoints.forget(pid())).toEqual({ refsDeleted: 0, rowsDeleted: 0 });
  });
});
