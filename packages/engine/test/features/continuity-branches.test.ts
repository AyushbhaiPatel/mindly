import { describe, expect, it } from 'vitest';
import { branchesModule, branchService, USER } from '../../src/index.js';
import { event } from '../helpers.js';
import { make } from './continuity-helpers.js';

describe('memory branches', () => {
  it('promotes memories of merged branches at session start, with a cached check', async () => {
    const checks: string[] = [];
    const env = make({
      git: {
        isMerged: async (_root, branch, into) => {
          checks.push(`${branch}->${into}`);
          return branch === 'feature/x';
        },
      },
    });
    const { root, clock, synapse } = env;
    synapse.use(branchesModule);
    const pid = (await synapse.projects.resolve(root)).project.id;
    const remember = (title: string, branch: string | null) =>
      synapse.memory.remember({
        projectId: pid,
        projectRoot: root,
        kind: 'decision',
        title,
        body: 'b',
        branch,
        source: USER,
      });
    const x = remember('Cache tokens in memory', 'feature/x');
    const y = remember('Use websockets for push', 'feature/y');
    const m = remember('Main-only note', 'main');

    await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    expect(synapse.store.memories.get(x.id).scope.branch).toBeNull();
    expect(synapse.store.memories.get(y.id).scope.branch).toBe('feature/y');
    expect(synapse.store.memories.get(m.id).scope.branch).toBe('main');
    expect(checks.sort()).toEqual(['feature/x->main', 'feature/y->main']);

    // Not-merged answers are cached for ten minutes.
    clock.advance(60_000);
    await synapse.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(checks).toHaveLength(2);
    clock.advance(10 * 60_000);
    await synapse.hooks.handle(event(root, 'codex', 'cx2', 'session_start'));
    expect(checks).toHaveLength(3);

    const svc = branchService(synapse);
    expect(svc.promote(pid, 'feature/y')).toBe(1);
    expect(synapse.store.memories.get(y.id).scope.branch).toBeNull();
    expect(synapse.store.memories.versions(y.id).at(-1)?.reason).toBe('branch feature/y merged');
    expect(() => svc.promote(pid, '../oops')).toThrow(/invalid branch/);
  });

  it('does nothing without git support', async () => {
    const env = make();
    env.synapse.use(branchesModule);
    const pid = (await env.synapse.projects.resolve(env.root)).project.id;
    const x = env.synapse.memory.remember({
      projectId: pid,
      projectRoot: env.root,
      kind: 'fact',
      title: 'Branch fact',
      body: 'b',
      branch: 'feature/z',
      source: USER,
    });
    const res = await branchService(env.synapse).checkMerged(pid, env.root, 'main');
    expect(res.checked).toEqual([]);
    expect(env.synapse.store.memories.get(x.id).scope.branch).toBe('feature/z');
  });
});
