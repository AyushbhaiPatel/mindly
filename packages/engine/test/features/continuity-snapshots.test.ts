import { describe, expect, it } from 'vitest';
import {
  isValidBranchName,
  snapshotService,
  snapshotsModule,
  USER,
  type GitPort,
} from '../../src/index.js';
import { event } from '../helpers.js';
import { make } from './continuity-helpers.js';

async function seed(env: ReturnType<typeof make>) {
  const { root, synapse } = env;
  const ctx = await synapse.projects.resolve(root);
  const pid = ctx.project.id;
  const a = synapse.memory.remember({
    projectId: pid,
    projectRoot: root,
    kind: 'fact',
    title: 'Auth uses JWT',
    body: 'version one',
    source: USER,
  });
  const b = synapse.memory.remember({
    projectId: pid,
    projectRoot: root,
    kind: 'decision',
    title: 'Use Postgres',
    body: 'chosen for JSONB',
    source: USER,
  });
  const task = synapse.tasks.create({ projectId: pid, title: 'Ship login', plan: ['form', 'api'] });
  return { pid, a, b, task };
}

describe('time machine', () => {
  it('diffs and restores non-destructively', async () => {
    const env = make();
    const { synapse, clock, root } = env;
    const { pid, a, b, task } = await seed(env);
    const svc = snapshotService(synapse);
    clock.advance(1000);
    const snap = await svc.create(pid, 'before refactor');
    expect(snap.gitRef).toBeNull();

    clock.advance(1000);
    synapse.memory.update(a.id, { body: 'version two' }, USER, 'edit');
    synapse.memory.archive(b.id);
    const c = synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Sessions live in Redis',
      body: 'new',
      source: USER,
    });
    synapse.tasks.update(
      task.id,
      {
        status: 'done',
        plan: [
          { text: 'form', done: true },
          { text: 'api', done: true },
        ],
      },
      null,
    );

    const diff = svc.diff(snap.id);
    expect(diff.memories.added.map((m) => m.id)).toEqual([c.id]);
    expect(diff.memories.updated).toEqual([{ id: a.id, title: a.title, from: 1, to: 2 }]);
    expect(diff.memories.archived.map((m) => m.id)).toEqual([b.id]);
    expect(diff.tasks.changed).toEqual([
      { id: task.id, title: 'Ship login', from: 'open', to: 'done', planChanged: true },
    ]);

    clock.advance(1000);
    const res = await svc.restore(snap.id);
    expect(res).toMatchObject({ memoriesRestored: 2, memoriesArchived: 1, tasksRestored: 1 });

    const a2 = synapse.store.memories.get(a.id);
    expect(a2.body).toBe('version one');
    expect(a2.version).toBe(3);
    expect(synapse.store.memories.versions(a.id).map((v) => v.body)).toEqual([
      'version one',
      'version two',
      'version one',
    ]);
    const b2 = synapse.store.memories.get(b.id);
    expect(b2.status).toBe('active');
    expect(b2.version).toBe(3);
    const c2 = synapse.store.memories.find(c.id);
    expect(c2?.status).toBe('archived');
    const t2 = synapse.store.tasks.get(task.id);
    expect(t2.status).toBe('open');
    expect(t2.plan.every((s) => !s.done)).toBe(true);

    const types = synapse.store.events.query(pid, {
      types: ['snapshot.created', 'snapshot.restored'],
    });
    expect(types.map((e) => e.type)).toEqual(['snapshot.created', 'snapshot.restored']);
    const after = svc.diff(snap.id);
    expect(after.memories.added).toEqual([]);
    expect(after.memories.archived).toEqual([]);
    expect(after.tasks.changed).toEqual([]);
  });

  it('validates branch names and restores code only onto a new branch', async () => {
    const calls: string[][] = [];
    const git: Partial<GitPort> = {
      createSnapshotRef: async (_root, _wt, id) => ({
        ref: `refs/synapse/snapshots/${id}`,
        commit: 'f'.repeat(40),
      }),
      restoreSnapshotToBranch: async (root, id, branch) => {
        calls.push([root, id, branch]);
      },
    };
    const env = make({ git });
    const { pid } = await seed(env);
    const svc = snapshotService(env.synapse);
    const snap = await svc.create(pid, 'with code');
    expect(snap.gitRef).toBe(`refs/synapse/snapshots/${snap.id}`);

    for (const bad of ['../evil', '-x', 'a..b', 'a b', 'feat;rm', '', '/abs', 'x.lock', 'a//b']) {
      expect(isValidBranchName(bad)).toBe(false);
      await expect(svc.restore(snap.id, { branch: bad })).rejects.toThrow(/invalid branch/);
    }
    expect(calls).toHaveLength(0);
    expect(isValidBranchName('restore/feature-1.2_x')).toBe(true);

    const res = await svc.restore(snap.id, { branch: 'restore/one' });
    expect(res.branch).toBe('restore/one');
    expect(calls).toEqual([[env.root, snap.id, 'restore/one']]);
  });

  it('refuses a branch restore without git support before changing anything', async () => {
    const env = make();
    const { pid, a } = await seed(env);
    const svc = snapshotService(env.synapse);
    const snap = await svc.create(pid, 'no git');
    env.clock.advance(1000);
    env.synapse.memory.update(a.id, { body: 'changed' }, USER, 'edit');
    await expect(svc.restore(snap.id, { branch: 'restore/x' })).rejects.toThrow(/git ref/);
    expect(env.synapse.store.memories.get(a.id).body).toBe('changed');
  });

  it('takes an automatic snapshot at session start at most every six hours', async () => {
    const env = make();
    const { root, clock, synapse } = env;
    synapse.use(snapshotsModule);
    await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const pid = synapse.store.projects.list()[0]!.id;
    expect(synapse.store.snapshots.list(pid)).toHaveLength(0);

    clock.advance(1000);
    await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: 'hello' }));
    clock.advance(1000);
    await synapse.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    const snaps = synapse.store.snapshots.list(pid);
    expect(snaps.map((s) => s.label)).toEqual(['auto']);

    clock.advance(60_000);
    await synapse.hooks.handle(event(root, 'cursor', 'cu', 'session_start'));
    expect(synapse.store.snapshots.list(pid)).toHaveLength(1);

    clock.advance(7 * 60 * 60_000);
    await synapse.hooks.handle(event(root, 'cursor', 'cu', 'prompt', { prompt: 'more' }));
    await synapse.hooks.handle(event(root, 'codex', 'cx2', 'session_start'));
    expect(synapse.store.snapshots.list(pid)).toHaveLength(2);
  });
});
