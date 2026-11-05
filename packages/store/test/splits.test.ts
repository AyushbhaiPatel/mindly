import { describe, expect, it } from 'vitest';
import { isMindlyError } from '@mindly/core';
import { MIGRATIONS, schemaVersion, type Store } from '../src/index.js';
import type { SplitCreate } from '../src/index.js';
import { setup } from './helpers.js';

const packet = {
  goal: 'g',
  plan: [],
  filesChanged: [],
  recentPrompts: [],
  decisions: [],
  blockers: [],
  nextSteps: [],
  branch: 'main',
  headCommit: null,
};

function splitInput(store: Store, projectId: string, slug = 'billing'): SplitCreate {
  const task = store.tasks.create({ projectId, title: 'Add billing' });
  const part = (key: string, position: number, dependsOn: string[] = []) => ({
    key,
    position,
    title: `Part ${key}`,
    agentKind: 'claude-code',
    owns: [`src/${key}/**`],
    reads: [],
    dependsOn,
    brief: `do ${key}`,
    worktree: `/tmp/repo.mindly/${slug}-${key}`,
    branch: `mindly/${slug}/${key}`,
    taskId: store.tasks.create({ projectId, title: `Part ${key}`, parentId: task.id }).id,
    handoffId: null,
  });
  return {
    projectId,
    slug,
    goal: 'Add billing',
    taskId: task.id,
    baseCommit: 'abc123',
    baseBranch: 'main',
    strict: false,
    worktreeRoot: '/tmp/repo.mindly',
    contract: [{ name: 'GET /billing', owner: 'api', definition: 'returns plan', memoryId: 'm-1' }],
    plannedBy: 'plan-file',
    parts: [part('api', 0), part('page', 1, ['api'])],
  };
}

describe('migration v3 (split)', () => {
  it('adds the split tables and the handoff worktree column', () => {
    const { store } = setup();
    expect(MIGRATIONS).toHaveLength(3);
    expect(schemaVersion(store.db)).toBe(3);
    const tables = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['splits', 'split_parts']));
    const cols = (store.db.prepare('PRAGMA table_info(handoffs)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('worktree');
  });
});

describe('SplitRepo', () => {
  it('creates a split with its parts and finds them by worktree, task and contract memory', () => {
    const { store, project } = setup();
    const { split, parts } = store.splits.create(splitInput(store, project.id));
    expect(split.status).toBe('active');
    expect(split.contract[0]?.memoryId).toBe('m-1');
    expect(parts.map((p) => p.key)).toEqual(['api', 'page']);
    expect(parts[1]?.dependsOn).toEqual(['api']);
    expect(store.splits.get(split.id).goal).toBe('Add billing');
    expect(store.splits.find('00000000-0000-7000-8000-000000000000')).toBeNull();
    let missing: unknown = null;
    try {
      store.splits.get('00000000-0000-7000-8000-000000000000');
    } catch (err) {
      missing = err;
    }
    expect(isMindlyError(missing, 'not_found')).toBe(true);
    expect(store.splits.active(project.id)?.id).toBe(split.id);
    expect(store.splits.parts(split.id).map((p) => p.position)).toEqual([0, 1]);
    expect(store.splits.partForWorktree(project.id, '/tmp/repo.mindly/billing-api')?.key).toBe(
      'api',
    );
    expect(
      store.splits.partForWorktree(project.id, '/tmp/repo.mindly/billing-api/src/x')?.key,
    ).toBe('api');
    expect(store.splits.partForWorktree(project.id, '/tmp/repo.mindly/billing-apix')).toBeNull();
    expect(store.splits.partForWorktree(project.id, '/tmp/repo')).toBeNull();
    expect(store.splits.partForTask(parts[0]!.taskId)?.key).toBe('api');
    expect(store.splits.findByContractMemory('m-1')?.id).toBe(split.id);
    expect(store.splits.findByContractMemory('m-2')).toBeNull();
    store.splits.setPartHandoff(parts[0]!.id, 'h-1');
    expect(store.splits.part(parts[0]!.id).handoffId).toBe('h-1');
  });

  it('allows one active split per project and keeps finished ones in the list', () => {
    const { store, project, clock } = setup();
    const { split } = store.splits.create(splitInput(store, project.id));
    clock.advance(1000);
    const merged = store.splits.update(split.id, {
      status: 'merged',
      integrationBranch: 'mindly/billing/integration',
      finishedAt: clock.now(),
    });
    expect(merged.status).toBe('merged');
    expect(merged.integrationBranch).toBe('mindly/billing/integration');
    expect(merged.finishedAt).toBe(clock.now());
    expect(merged.updatedAt).toBe(clock.now());
    expect(store.splits.active(project.id)).toBeNull();
    // A part of a finished split no longer claims its worktree.
    expect(store.splits.partForWorktree(project.id, '/tmp/repo.mindly/billing-api')).toBeNull();
    const second = store.splits.create(splitInput(store, project.id, 'second'));
    expect(store.splits.list(project.id).map((s) => s.id)).toEqual([second.split.id, split.id]);
    expect(store.splits.list(project.id, { statuses: ['merged'] }).map((s) => s.id)).toEqual([
      split.id,
    ]);
    expect(store.splits.list(project.id, { limit: 1 })).toHaveLength(1);
    expect(() => store.splits.update(split.id, { status: 'nope' as never })).toThrow();
  });

  it('deletes splits with the project', () => {
    const { store, project } = setup();
    const { split } = store.splits.create(splitInput(store, project.id));
    store.projects.delete(project.id);
    expect(store.splits.find(split.id)).toBeNull();
    expect(store.splits.parts(split.id)).toHaveLength(0);
  });
});

describe('worktree-targeted handoffs', () => {
  it('offers a targeted handoff only to sessions in that worktree or below it', () => {
    const { store, project, a } = setup();
    const targeted = store.handoffs.create({
      projectId: project.id,
      fromSessionId: a.id,
      toAgentKind: 'codex',
      taskId: null,
      reason: 'manual',
      summary: 'part brief',
      packet,
      worktree: '/tmp/repo.mindly/billing-api',
    });
    const general = store.handoffs.create({
      projectId: project.id,
      fromSessionId: a.id,
      toAgentKind: 'codex',
      taskId: null,
      reason: 'manual',
      summary: 'anyone',
      packet,
    });
    const ids = (hs: { id: string }[]) => hs.map((h) => h.id);
    expect(ids(store.handoffs.pendingFor(project.id, 'codex', 'other'))).toEqual([general.id]);
    expect(ids(store.handoffs.pendingFor(project.id, 'codex', 'other', '/tmp/repo'))).toEqual([
      general.id,
    ]);
    expect(
      ids(store.handoffs.pendingFor(project.id, 'codex', 'other', '/tmp/repo.mindly/billing-api')),
    ).toEqual([targeted.id, general.id]);
    expect(
      ids(
        store.handoffs.pendingFor(project.id, 'codex', 'other', '/tmp/repo.mindly/billing-api/src'),
      ),
    ).toEqual([targeted.id, general.id]);
    expect(
      ids(store.handoffs.pendingFor(project.id, 'codex', 'other', '/tmp/repo.mindly/billing-apix')),
    ).toEqual([general.id]);
    expect(
      ids(
        store.handoffs.pendingFor(
          project.id,
          'claude-code',
          'other',
          '/tmp/repo.mindly/billing-api',
        ),
      ),
    ).toEqual([]);
    expect(store.handoffs.cancelForWorktree(project.id, '/tmp/repo.mindly/billing-api')).toBe(1);
    expect(store.handoffs.get(targeted.id).status).toBe('cancelled');
    expect(store.handoffs.get(general.id).status).toBe('pending');
    expect(store.handoffs.cancelForWorktree(project.id, '/tmp/repo.mindly/billing-api')).toBe(0);
  });
});
