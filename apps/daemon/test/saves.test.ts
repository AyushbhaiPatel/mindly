import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project, Save, SaveKind, Session } from '@mindly/core';
import { savesOf } from '@mindly/engine';
import {
  createShadowMergeRun,
  executeShadowMerge,
  housekeepingTick,
  type Daemon,
} from '../src/index.js';
import {
  bearer,
  git,
  linkedWorktree,
  repo,
  seedSession,
  tempDir,
  testDaemon,
  write,
  type TestDaemon,
} from './helpers.js';

/*
 * Saves of the kinds the daemon produces, driven through
 * real shadow merges of temporary git repositories and the housekeeping job.
 */

const node = process.execPath;
const DAY = 86_400_000;
let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.daemon.stop();
  t = null;
});

interface Setup {
  d: Daemon;
  root: string;
  wt: string;
  a: Session;
  b: Session;
  project: Project;
}

async function twoWorktrees(wt?: (root: string) => string): Promise<Setup> {
  t = await testDaemon();
  const d = t.daemon;
  const root = repo();
  const tree = wt ? wt(root) : linkedWorktree(root, 'feature');
  const a = seedSession(d, root, { agentKind: 'claude-code' });
  const b = seedSession(d, root, { agentKind: 'codex', worktree: tree });
  return { d, root, wt: tree, a, b, project: d.mindly.store.projects.get(a.projectId) };
}

async function merge(s: Setup) {
  return executeShadowMerge(s.d.jobs, createShadowMergeRun(s.d.jobs, s.project.id, 'user'));
}

function savesOfKind(s: Setup, kind: SaveKind): Save[] {
  return s.d.mindly.store.saves.list(s.project.id, { kinds: [kind] });
}

function total(s: Setup): number {
  return savesOf(s.d.mindly).summary(s.project.id, 0).total;
}

/** Moves every save of the project back in time, as if `ms` had passed. */
function age(s: Setup, ms: number): void {
  s.d.mindly.store.db.prepare('UPDATE saves SET created_at = created_at - ?').run(ms);
}

function trustChecks(s: Setup, checks: { name: string; argv: string[] }[]): void {
  write(s.root, '.mindly/config.json', JSON.stringify({ checks }));
  s.d.mindly.projects.trust(s.project.id, s.d.mindly.projects.byId(s.project.id).configHash ?? '');
}

const conflicting = (s: Setup) => {
  write(s.root, 'a.txt', 'line 1\nline 2 by A\nline 3\n');
  write(s.wt, 'a.txt', 'line 1\nline 2 by B\nline 3\n');
};

describe('saves: merge_conflict_early', () => {
  it('is confirmed at once when both sides are still unmerged', async () => {
    const s = await twoWorktrees();
    conflicting(s);
    await merge(s);
    const [save, ...rest] = savesOfKind(s, 'merge_conflict_early');
    expect(rest).toEqual([]);
    expect(save).toMatchObject({ status: 'confirmed', paths: ['a.txt'] });
    expect(save!.sessionIds.sort()).toEqual([s.a.id, s.b.id].sort());
    expect(save!.title).toBe(
      'A merge conflict between Claude Code and Codex was found before either branch was merged',
    );
    const opened = s.d.mindly.store.events.query(s.project.id, { types: ['conflict.opened'] });
    expect(save!.evidence).toEqual([opened[0]!.id]);
    // The next shadow merge finds the same conflict: still one save.
    await merge(s);
    expect(savesOfKind(s, 'merge_conflict_early')).toHaveLength(1);
    expect(total(s)).toBe(1);
  });

  it('expires when it cannot tell whether a side was merged', async () => {
    // B works on a detached HEAD and committed its change: no branch to compare with main.
    const s = await twoWorktrees((root) => {
      const path = join(tempDir('mindly-daemon-wt-'), 'detached');
      git(root, 'worktree', 'add', '-q', '--detach', path);
      return realpathSync(path);
    });
    conflicting(s);
    git(s.wt, 'commit', '-q', '-am', 'B');
    await merge(s);
    expect(savesOfKind(s, 'merge_conflict_early')[0]?.status).toBe('caught');
    expect(total(s)).toBe(0);
    age(s, DAY + 1000);
    expect(housekeepingTick(s.d.jobs).saves.expired).toBe(1);
    expect(savesOfKind(s, 'merge_conflict_early')[0]?.status).toBe('expired');
    expect(total(s)).toBe(0);
  });

  it('is not a save when one side was already merged into the base branch', async () => {
    const s = await twoWorktrees();
    conflicting(s);
    git(s.root, 'commit', '-q', '-am', 'A lands on main');
    await merge(s);
    expect(s.d.mindly.store.conflicts.list(s.project.id)[0]?.kind).toBe('merge_conflict');
    expect(savesOfKind(s, 'merge_conflict_early')[0]?.status).toBe('rejected');
    expect(total(s)).toBe(0);
  });
});

describe('saves: check_broken_early (shadow merge)', () => {
  async function broken() {
    const s = await twoWorktrees();
    write(s.root, 'a.txt', 'line 1 by A\nline 2\nline 3\n');
    write(s.wt, 'b.txt', 'b changed\n');
    trustChecks(s, [{ name: 'fail', argv: [node, '-e', 'process.exit(1)'] }]);
    expect((await merge(s)).status).toBe('failed');
    expect(savesOfKind(s, 'check_broken_early')[0]?.status).toBe('caught');
    return s;
  }

  it('is confirmed when the check passes again before anything was merged', async () => {
    const s = await broken();
    trustChecks(s, [{ name: 'fail', argv: [node, '-e', 'process.exit(0)'] }]);
    expect((await merge(s)).status).toBe('passed');
    const [save] = savesOfKind(s, 'check_broken_early');
    expect(save?.status).toBe('confirmed');
    expect(save?.evidence).toHaveLength(2);
    expect(total(s)).toBe(1);
  });

  it('expires when the check stays broken', async () => {
    const s = await broken();
    age(s, DAY + 1000);
    housekeepingTick(s.d.jobs);
    expect(savesOfKind(s, 'check_broken_early')[0]?.status).toBe('expired');
    expect(total(s)).toBe(0);
  });

  it('is not a save when the sessions ended before the check was fixed', async () => {
    const s = await broken();
    s.d.mindly.store.sessions.setStatus(s.b.id, 'ended');
    trustChecks(s, [{ name: 'fail', argv: [node, '-e', 'process.exit(0)'] }]);
    await merge(s);
    expect(savesOfKind(s, 'check_broken_early')[0]?.status).toBe('caught');
    expect(total(s)).toBe(0);
  });
});

describe('saves API', () => {
  async function withSave() {
    const s = await twoWorktrees();
    conflicting(s);
    await merge(s);
    const req = (method: 'GET' | 'POST', url: string) =>
      s.d.app.inject({ method, url, headers: bearer(s.d) });
    return { s, req };
  }

  it('lists counted and pending saves with a summary, and filters by status', async () => {
    const { s, req } = await withSave();
    const res = await req('GET', `/api/projects/${s.project.id}/saves`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(['since', 'summary', 'saves']);
    expect(body.summary).toEqual({
      total: 1,
      byKind: { merge_conflict_early: 1 },
      byAgent: { 'claude-code': 1 },
    });
    expect(body.saves).toHaveLength(1);
    expect(
      (await req('GET', `/api/projects/${s.project.id}/saves?status=expired`)).json().saves,
    ).toEqual([]);
    expect((await req('GET', `/api/projects/${s.project.id}/saves?status=nope`)).statusCode).toBe(
      400,
    );
  });

  it('rejects a save ("not a save") and drops it from the totals', async () => {
    const { s, req } = await withSave();
    const [save] = s.d.mindly.store.saves.list(s.project.id);
    const res = await req('POST', `/api/saves/${save!.id}/reject`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');
    const body = (await req('GET', `/api/projects/${s.project.id}/saves`)).json();
    expect(body.summary.total).toBe(0);
    expect(body.saves).toEqual([]);
    expect(
      (await req('POST', '/api/saves/00000000-0000-7000-8000-000000000000/reject')).statusCode,
    ).toBe(404);
  });

  it('serves the share card without project name or paths unless details=1 (AC6)', async () => {
    const { s, req } = await withSave();
    const plain = await req('GET', `/api/projects/${s.project.id}/saves/card.svg`);
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-type']).toContain('image/svg+xml');
    expect(plain.body).toContain('Merge conflicts found before merging');
    for (const secret of [basename(s.root), s.root, 'a.txt', 'line 2 by']) {
      expect(plain.body, secret).not.toContain(secret);
    }
    const detailed = await req('GET', `/api/projects/${s.project.id}/saves/card.svg?details=1`);
    expect(detailed.body).toContain('a.txt');
    expect(detailed.body).toContain(s.project.name);
  });
});
