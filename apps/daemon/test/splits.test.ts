import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@mindly/core';
import { splitOf, type CreatedSplit } from '@mindly/engine';
import type { Daemon } from '../src/index.js';
import { bearer, git, repo, seedSession, testDaemon, write, type TestDaemon } from './helpers.js';

let t: TestDaemon;
let d: Daemon;
let root: string;
let project: Project;
let created: CreatedSplit;

beforeEach(async () => {
  t = await testDaemon();
  d = t.daemon;
  root = repo();
  write(root, 'src/api/billing.ts', 'export const billing = 1;\n');
  write(root, 'src/app/page.ts', 'export const page = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'files');
  project = d.mindly.store.projects.upsertByRoot(root, 'repo');
  created = await splitOf(d.mindly).create({
    projectId: project.id,
    plan: {
      goal: 'Add billing',
      parts: [
        {
          key: 'api',
          title: 'Billing API',
          agent: 'claude-code',
          owns: ['src/api/**'],
          reads: [],
          dependsOn: [],
          brief: 'api',
        },
        {
          key: 'page',
          title: 'Billing page',
          agent: 'codex',
          owns: ['src/app/**'],
          reads: [],
          dependsOn: ['api'],
          brief: 'page',
        },
      ],
      contract: [{ name: 'GET /billing', owner: 'api', definition: 'returns { plan }' }],
    },
    slug: 'billing',
    plannedBy: 'plan-file',
    connectedAgents: null,
  });
});

afterEach(async () => {
  await splitOf(d.mindly)
    .abort(created.split.id)
    .catch(() => undefined);
  await d.stop();
});

const get = (url: string) => d.app.inject({ method: 'GET', url, headers: bearer(d) });

describe('split endpoints', () => {
  it('lists splits and reports one split with its parts, contract and merge check', async () => {
    const list = await get(`/api/projects/${project.id}/splits`);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string; slug: string }[]).map((s) => s.slug)).toEqual(['billing']);
    expect((await get(`/api/projects/${project.id}/splits?status=merged`)).json()).toEqual([]);
    expect((await get(`/api/projects/${project.id}/splits?status=nope`)).statusCode).toBe(400);

    const page = seedSession(d, root, { agentKind: 'codex', worktree: created.parts[1]!.worktree });
    write(
      created.parts[1]!.worktree,
      'src/app/page.ts',
      'export const page = 2;\nexport const more = true;\n',
    );
    const res = await get(`/api/splits/${created.split.id}`);
    expect(res.statusCode).toBe(200);
    const s = res.json() as {
      split: { id: string; status: string; contract: { name: string }[] };
      parts: {
        part: { key: string };
        state: string;
        session: { id: string } | null;
        filesChanged: string[];
        task: { parentId: string | null };
      }[];
      contract: { name: string; memoryId: string }[];
      mergeCheck: unknown;
    };
    expect(s.split.id).toBe(created.split.id);
    expect(s.parts.map((p) => [p.part.key, p.state])).toEqual([
      ['api', 'waiting'],
      ['page', 'working'],
    ]);
    expect(s.parts[1]!.session?.id).toBe(page.id);
    expect(s.parts[1]!.filesChanged).toEqual(['src/app/page.ts']);
    expect(s.parts.every((p) => p.task.parentId === created.task.id)).toBe(true);
    expect(s.contract[0]!.name).toBe('GET /billing');
    expect(s.mergeCheck).toBeNull();

    expect((await get('/api/splits/not-a-uuid')).statusCode).toBe(400);
    expect((await get('/api/splits/00000000-0000-7000-8000-000000000000')).statusCode).toBe(404);
    const noAuth = await d.app.inject({
      method: 'GET',
      url: `/api/splits/${created.split.id}`,
      headers: { host: bearer(d)['host'] as string },
    });
    expect(noAuth.statusCode).toBe(401);
  });

  it('puts a blocked part and a failed merge check under "needs you" in the overview', async () => {
    const overview = async () =>
      (await get(`/api/projects/${project.id}/overview`)).json() as {
        needsYou: { blockedParts: number; failedMergeChecks: number };
        split: {
          id: string;
          blockedParts: { key: string }[];
          mergeCheck: { status: string; conflictedPaths: string[] } | null;
        } | null;
      };
    const quiet = await overview();
    expect(quiet.needsYou).toMatchObject({ blockedParts: 0, failedMergeChecks: 0 });
    expect(quiet.split).toMatchObject({ id: created.split.id, blockedParts: [], mergeCheck: null });

    d.mindly.tasks.update(
      created.parts[1]!.taskId,
      { status: 'blocked', blockers: ['waits for the API'] },
      null,
    );
    write(created.parts[0]!.worktree, 'README.md', 'from api\n');
    write(created.parts[1]!.worktree, 'README.md', 'from page\n');
    await splitOf(d.mindly).mergeCheck(created.split.id, 'user');
    const needy = await overview();
    expect(needy.needsYou).toMatchObject({ blockedParts: 1, failedMergeChecks: 1 });
    expect(needy.split?.blockedParts).toEqual(
      [{ key: 'page' }].map((p) => expect.objectContaining(p)),
    );
    expect(needy.split?.mergeCheck).toMatchObject({
      status: 'failed',
      conflictedPaths: ['README.md'],
    });

    await splitOf(d.mindly).abort(created.split.id);
    expect((await overview()).split).toBeNull();
  });

  it('tells dependants through the API when a contract decision is edited', async () => {
    const page = seedSession(d, root, { agentKind: 'codex', worktree: created.parts[1]!.worktree });
    const api = seedSession(d, root, {
      agentKind: 'claude-code',
      worktree: created.parts[0]!.worktree,
    });
    const memoryId = created.split.contract[0]!.memoryId as string;
    const res = await d.app.inject({
      method: 'PATCH',
      url: `/api/memories/${memoryId}`,
      headers: bearer(d, { 'content-type': 'application/json' }),
      payload: JSON.stringify({ body: 'returns { plan, renewsAt }' }),
    });
    expect(res.statusCode).toBe(200);
    const impacts = d.mindly.store.deliveries.list(project.id).filter((x) => x.kind === 'impact');
    expect(impacts.map((x) => x.targetSessionId)).toEqual([page.id]);
    expect(impacts[0]!.title).toBe('Contract item "GET /billing" of the split changed');
    expect(impacts[0]!.body).toContain('renewsAt');
    expect(impacts.some((x) => x.targetSessionId === api.id)).toBe(false);
  });
});
