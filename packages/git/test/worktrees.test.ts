import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMindlyError } from '@mindly/core';
import {
  addWorktree,
  branchExists,
  commitsOnlyOn,
  deleteBranch,
  listFiles,
  listWorktrees,
  mergeIntoNewBranch,
  removeWorktree,
} from '../src/index.js';
import { commitAll, git, makeRepo, tempDir, write } from './helpers.js';

/** A snapshot of everything a split must never change in the main working tree. */
function mainState(root: string): { head: string; branch: string; status: string; refs: string } {
  return {
    head: git(root, 'rev-parse', 'HEAD').trim(),
    branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    status: git(root, 'status', '--porcelain'),
    refs: git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/main'),
  };
}

describe('worktrees', () => {
  it('adds a worktree on a new branch at a commit without touching the main tree', async () => {
    const root = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    write(root, 'dirty.txt', 'uncommitted\n');
    const before = mainState(root);
    const path = join(tempDir(), 'part-a');
    const made = await addWorktree(root, path, 'mindly/demo/a', 'HEAD');
    expect(made).toEqual({ path, branch: 'mindly/demo/a', commit: before.head });
    expect(existsSync(join(path, 'src', 'a.ts'))).toBe(true);
    expect(existsSync(join(path, 'dirty.txt'))).toBe(false);
    expect(await branchExists(root, 'mindly/demo/a')).toBe(true);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('mindly/demo/a');
    expect(mainState(root)).toEqual(before);
    expect((await listWorktrees(root)).map((w) => w.path)).toContain(path);
  });

  it('refuses existing folders and branches, paths inside the repository and bad names', async () => {
    const root = makeRepo();
    const dir = tempDir();
    const taken = join(dir, 'taken');
    await addWorktree(root, taken, 'mindly/demo/x', 'HEAD');
    await expect(addWorktree(root, taken, 'mindly/demo/y', 'HEAD')).rejects.toSatisfy((e) =>
      isMindlyError(e, 'conflict'),
    );
    await expect(addWorktree(root, join(dir, 'other'), 'mindly/demo/x', 'HEAD')).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict'),
    );
    git(root, 'branch', 'existing');
    await expect(addWorktree(root, join(dir, 'other'), 'existing', 'HEAD')).rejects.toSatisfy((e) =>
      isMindlyError(e, 'conflict'),
    );
    await expect(
      addWorktree(root, join(root, 'inside'), 'mindly/demo/z', 'HEAD'),
    ).rejects.toSatisfy((e) => isMindlyError(e, 'invalid_input'));
    await expect(addWorktree(root, 'relative', 'mindly/demo/z', 'HEAD')).rejects.toSatisfy((e) =>
      isMindlyError(e, 'invalid_input'),
    );
    await expect(addWorktree(root, join(dir, 'other'), 'bad..name', 'HEAD')).rejects.toThrow();
    await expect(
      addWorktree(root, join(dir, 'other'), 'mindly/demo/z', 'no-such-commit'),
    ).rejects.toSatisfy((e) => isMindlyError(e, 'not_found'));
    expect(existsSync(join(dir, 'other'))).toBe(false);
    expect(await branchExists(root, 'mindly/demo/z')).toBe(false);
  });

  it('removes a worktree with uncommitted work, then its branch, and ignores plain folders', async () => {
    const root = makeRepo();
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    write(path, 'wip.txt', 'not committed\n');
    expect(await removeWorktree(root, path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect((await listWorktrees(root)).map((w) => w.path)).not.toContain(path);
    expect(await branchExists(root, 'mindly/demo/p')).toBe(true);
    expect(await deleteBranch(root, 'mindly/demo/p')).toBe(true);
    expect(await branchExists(root, 'mindly/demo/p')).toBe(false);
    expect(await deleteBranch(root, 'mindly/demo/p')).toBe(false);
    // A branch checked out in any working tree is never deleted.
    const held = join(tempDir(), 'held');
    await addWorktree(root, held, 'mindly/demo/h', 'HEAD');
    await expect(deleteBranch(root, 'mindly/demo/h')).rejects.toSatisfy((e) =>
      isMindlyError(e, 'conflict'),
    );
    expect(await branchExists(root, 'mindly/demo/h')).toBe(true);
    await removeWorktree(root, held);
    expect(await deleteBranch(root, 'mindly/demo/h')).toBe(true);
    const plain = tempDir();
    expect(await removeWorktree(root, plain)).toBe(false);
    expect(existsSync(plain)).toBe(true);
    await expect(removeWorktree(root, root)).rejects.toSatisfy((e) =>
      isMindlyError(e, 'invalid_input'),
    );
  });

  it('lists the commits only a branch holds, ignoring the branches deleted with it', async () => {
    const root = makeRepo();
    const dir = tempDir();
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    await addWorktree(root, a, 'mindly/demo/a', 'HEAD');
    await addWorktree(root, b, 'mindly/demo/b', 'HEAD');
    expect(await commitsOnlyOn(root, 'mindly/demo/a')).toEqual([]);
    write(a, 'a.txt', 'a\n');
    commitAll(a, 'first in a');
    write(a, 'a2.txt', 'a2\n');
    commitAll(a, 'second in a');
    const second = git(a, 'rev-parse', 'HEAD').trim();
    expect((await commitsOnlyOn(root, 'mindly/demo/a')).map((c) => c.subject)).toEqual([
      'second in a',
      'first in a',
    ]);
    expect((await commitsOnlyOn(root, 'mindly/demo/a', [], 1))[0]).toEqual({
      commit: second,
      subject: 'second in a',
    });
    // Merged into another branch: nothing is lost by deleting it, unless that one goes too.
    git(root, 'branch', 'integration', 'mindly/demo/a');
    expect(await commitsOnlyOn(root, 'mindly/demo/a')).toEqual([]);
    git(b, 'merge', '-q', '--no-edit', 'mindly/demo/a');
    git(root, 'branch', '-D', 'integration');
    expect(await commitsOnlyOn(root, 'mindly/demo/a')).toEqual([]);
    expect(await commitsOnlyOn(root, 'mindly/demo/a', ['mindly/demo/b'])).toHaveLength(2);
    // A tag holds commits too; a missing branch has none.
    git(root, 'tag', 'kept', 'mindly/demo/a');
    expect(await commitsOnlyOn(root, 'mindly/demo/a', ['mindly/demo/b'])).toEqual([]);
    expect(await commitsOnlyOn(root, 'mindly/demo/none')).toEqual([]);
    await expect(commitsOnlyOn(root, 'bad..name')).rejects.toThrow();
  });

  it('sees commits merged by a split merge as held, whatever their dates', async () => {
    const root = makeRepo({ 'README.md': '# a\n' });
    for (let i = 0; i < 8; i++) {
      write(root, 'history.txt', `${i}\n`);
      commitAll(root, `history ${i}`);
    }
    const dir = tempDir();
    const keys = ['api', 'webhook', 'page'];
    for (const k of keys) {
      const path = join(dir, k);
      await addWorktree(root, path, `mindly/demo/${k}`, 'HEAD');
      write(path, `${k}.txt`, `${k}\n`);
      commitAll(path, `work in ${k}`);
    }
    git(root, 'branch', 'feature/other', 'mindly/demo/webhook');
    // The merge commits carry a fixed synthetic date, older than the part commits.
    const merged = await mergeIntoNewBranch({
      repoRoot: root,
      branch: 'mindly/demo/integration',
      base: 'HEAD',
      sources: keys.map((k) => ({ label: k, ref: `mindly/demo/${k}` })),
    });
    expect(merged.status).toBe('merged');
    const parts = keys.map((k) => `mindly/demo/${k}`);
    for (const p of parts) expect(await commitsOnlyOn(root, p, parts)).toEqual([]);
    // A commit made on a part branch after the merge is only there.
    write(join(dir, 'api'), 'late.txt', 'late\n');
    const late = commitAll(join(dir, 'api'), 'late work');
    expect(await commitsOnlyOn(root, 'mindly/demo/api', parts)).toEqual([
      { commit: late, subject: 'late work' },
    ]);
  });

  it('lists tracked and untracked files, not ignored ones', async () => {
    const root = makeRepo({ 'src/a.ts': 'a\n', '.gitignore': 'dist/\n' });
    write(root, 'src/new.ts', 'new\n');
    write(root, 'dist/out.js', 'built\n');
    const files = await listFiles(root);
    expect(files).toEqual(expect.arrayContaining(['.gitignore', 'src/a.ts', 'src/new.ts']));
    expect(files).not.toContain('dist/out.js');
    expect(await listFiles(root, 2)).toHaveLength(2);
  });
});

describe('mergeIntoNewBranch', () => {
  function threeParts(): { root: string; base: string } {
    const root = makeRepo({ 'README.md': 'base\n', 'src/shared.ts': 'export const x = 1;\n' });
    const base = git(root, 'rev-parse', 'HEAD').trim();
    return { root, base };
  }

  function branchWith(root: string, branch: string, files: Record<string, string>): string {
    const wt = join(tempDir(), branch.replace(/\//g, '-'));
    git(root, 'worktree', 'add', '-q', '-b', branch, wt);
    for (const [rel, content] of Object.entries(files)) write(wt, rel, content);
    return commitAll(wt, `work on ${branch}`);
  }

  it('merges branches in order into one new branch and leaves everything else alone', async () => {
    const { root, base } = threeParts();
    branchWith(root, 'p/a', { 'src/a.ts': 'export const a = 1;\n' });
    branchWith(root, 'p/b', { 'src/b.ts': 'export const b = 1;\n', 'README.md': 'base\nfrom b\n' });
    write(root, 'dirty.txt', 'uncommitted in main\n');
    const before = mainState(root);
    const r = await mergeIntoNewBranch({
      repoRoot: root,
      branch: 'p/integration',
      base,
      sources: [
        { label: 'a', ref: 'p/a' },
        { label: 'b', ref: 'p/b' },
      ],
    });
    expect(r.status).toBe('merged');
    if (r.status !== 'merged') return;
    expect(r.merged).toEqual(['a', 'b']);
    expect(git(root, 'rev-parse', 'p/integration').trim()).toBe(r.commit);
    const tree = git(root, 'ls-tree', '-r', '--name-only', r.commit).trim().split('\n').sort();
    expect(tree).toEqual(['README.md', 'src/a.ts', 'src/b.ts', 'src/shared.ts']);
    expect(git(root, 'show', `${r.commit}:README.md`)).toBe('base\nfrom b\n');
    // Two merge commits above the base, each with two parents (never a fast-forward).
    expect(git(root, 'rev-list', '--merges', '--count', `${base}..${r.commit}`).trim()).toBe('2');
    expect(git(root, 'log', '-1', '--format=%s', r.commit).trim()).toBe(
      'Merge b into p/integration',
    );
    expect(mainState(root)).toEqual(before);
    expect(readFileSync(join(root, 'dirty.txt'), 'utf8')).toBe('uncommitted in main\n');
  });

  it('stops at the first conflicting source and creates nothing', async () => {
    const { root, base } = threeParts();
    branchWith(root, 'p/a', { 'README.md': 'from a\n' });
    branchWith(root, 'p/b', { 'README.md': 'from b\n' });
    const before = mainState(root);
    const refs = git(root, 'for-each-ref');
    const r = await mergeIntoNewBranch({
      repoRoot: root,
      branch: 'p/integration',
      base,
      sources: [
        { label: 'a', ref: 'p/a' },
        { label: 'b', ref: 'p/b' },
      ],
    });
    expect(r).toEqual({ status: 'conflicted', label: 'b', paths: ['README.md'], merged: ['a'] });
    expect(git(root, 'for-each-ref')).toBe(refs);
    expect(mainState(root)).toEqual(before);
  });

  it('refuses an existing target branch, unknown refs and bad labels', async () => {
    const { root, base } = threeParts();
    branchWith(root, 'p/a', { 'src/a.ts': 'a\n' });
    git(root, 'branch', 'p/integration');
    const sources = [{ label: 'a', ref: 'p/a' }];
    await expect(
      mergeIntoNewBranch({ repoRoot: root, branch: 'p/integration', base, sources }),
    ).rejects.toSatisfy((e) => isMindlyError(e, 'conflict'));
    await expect(
      mergeIntoNewBranch({
        repoRoot: root,
        branch: 'p/other',
        base,
        sources: [{ label: 'x', ref: 'p/nope' }],
      }),
    ).rejects.toSatisfy((e) => isMindlyError(e, 'not_found'));
    await expect(
      mergeIntoNewBranch({
        repoRoot: root,
        branch: 'p/other',
        base,
        sources: [{ label: 'bad\nlabel', ref: 'p/a' }],
      }),
    ).rejects.toSatisfy((e) => isMindlyError(e, 'invalid_input'));
    await expect(
      mergeIntoNewBranch({ repoRoot: root, branch: 'p/other', base, sources: [] }),
    ).rejects.toSatisfy((e) => isMindlyError(e, 'invalid_input'));
    expect(await branchExists(root, 'p/other')).toBe(false);
  });
});
