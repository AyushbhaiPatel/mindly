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
    const { root, clock, mindly } = env;
    mindly.use(branchesModule);
    const pid = (await mindly.projects.resolve(root)).project.id;
    const remember = (title: string, branch: string | null) =>
      mindly.memory.remember({
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

    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    expect(mindly.store.memories.get(x.id).scope.branch).toBeNull();
    expect(mindly.store.memories.get(y.id).scope.branch).toBe('feature/y');
    expect(mindly.store.memories.get(m.id).scope.branch).toBe('main');
    expect(checks.sort()).toEqual(['feature/x->main', 'feature/y->main']);

    // Not-merged answers are cached for ten minutes.
    clock.advance(60_000);
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(checks).toHaveLength(2);
    clock.advance(10 * 60_000);
    await mindly.hooks.handle(event(root, 'codex', 'cx2', 'session_start'));
    expect(checks).toHaveLength(3);

    const svc = branchService(mindly);
    expect(svc.promote(pid, 'feature/y')).toBe(1);
    expect(mindly.store.memories.get(y.id).scope.branch).toBeNull();
    expect(mindly.store.memories.versions(y.id).at(-1)?.reason).toBe('branch feature/y merged');
    expect(() => svc.promote(pid, '../oops')).toThrow(/invalid branch/);
  });

  it('does nothing without git support', async () => {
    const env = make();
    env.mindly.use(branchesModule);
    const pid = (await env.mindly.projects.resolve(env.root)).project.id;
    const x = env.mindly.memory.remember({
      projectId: pid,
      projectRoot: env.root,
      kind: 'fact',
      title: 'Branch fact',
      body: 'b',
      branch: 'feature/z',
      source: USER,
    });
    const res = await branchService(env.mindly).checkMerged(pid, env.root, 'main');
    expect(res.checked).toEqual([]);
    expect(env.mindly.store.memories.get(x.id).scope.branch).toBe('feature/z');
  });
});
