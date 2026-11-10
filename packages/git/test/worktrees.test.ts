import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMindlyError } from '@mindly/core';
import {
  addWorktree,
  branchExists,
  branchOnlyWork,
  deleteBranch,
  flaggedChanges,
  ignoredDeniedFiles,
  ignoredNestedRepos,
  listFiles,
  listWorktrees,
  mergeIntoNewBranch,
  removeWorktree,
  restoreFromHead,
} from '../src/index.js';
import { commitAll, git, makeRepo, tempDir, write } from './helpers.js';

/** The commits only `branch` has, as `branchOnlyWork` lists them. */
async function only(
  root: string,
  branch: string,
  ignoring: string[] = [],
  max?: number,
): Promise<{ commit: string; subject: string }[]> {
  return (await branchOnlyWork(root, branch, { ignoring, ...(max ? { max } : {}) })).commits;
}

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
    expect(await only(root, 'mindly/demo/a')).toEqual([]);
    write(a, 'a.txt', 'a\n');
    commitAll(a, 'first in a');
    write(a, 'a2.txt', 'a2\n');
    commitAll(a, 'second in a');
    const second = git(a, 'rev-parse', 'HEAD').trim();
    expect((await only(root, 'mindly/demo/a')).map((c) => c.subject)).toEqual([
      'second in a',
      'first in a',
    ]);
    expect((await only(root, 'mindly/demo/a', [], 1))[0]).toEqual({
      commit: second,
      subject: 'second in a',
    });
    // Merged into another branch: nothing is lost by deleting it, unless that one goes too.
    git(root, 'branch', 'integration', 'mindly/demo/a');
    expect(await only(root, 'mindly/demo/a')).toEqual([]);
    git(b, 'merge', '-q', '--no-edit', 'mindly/demo/a');
    git(root, 'branch', '-D', 'integration');
    expect(await only(root, 'mindly/demo/a')).toEqual([]);
    expect(await only(root, 'mindly/demo/a', ['mindly/demo/b'])).toHaveLength(2);
    // A tag holds commits too; a missing branch has none.
    git(root, 'tag', 'kept', 'mindly/demo/a');
    expect(await only(root, 'mindly/demo/a', ['mindly/demo/b'])).toEqual([]);
    expect(await only(root, 'mindly/demo/none')).toEqual([]);
    await expect(only(root, 'bad..name')).rejects.toThrow();
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
    for (const p of parts) expect(await only(root, p, parts)).toEqual([]);
    // A commit made on a part branch after the merge is only there.
    write(join(dir, 'api'), 'late.txt', 'late\n');
    const late = commitAll(join(dir, 'api'), 'late work');
    expect(await only(root, 'mindly/demo/api', parts)).toEqual([
      { commit: late, subject: 'late work' },
    ]);
  });

  it('finds a commit made after a merge even when its date is older than every other', async () => {
    const root = makeRepo({ 'README.md': '# a\n' });
    for (let i = 0; i < 8; i++) {
      write(root, 'history.txt', `${i}\n`);
      commitAll(root, `history ${i}`);
    }
    const dir = tempDir();
    const path = join(dir, 'api');
    await addWorktree(root, path, 'mindly/demo/api', 'HEAD');
    for (let i = 0; i < 60; i++) {
      write(path, 'api.txt', `${i}\n`);
      commitAll(path, `api ${i}`);
    }
    expect(
      await mergeIntoNewBranch({
        repoRoot: root,
        branch: 'mindly/demo/integration',
        base: 'HEAD',
        sources: [{ label: 'api', ref: 'mindly/demo/api' }],
      }),
    ).toMatchObject({ status: 'merged' });
    // A clock set far back: the new commit is dated before everything else in the repository.
    write(path, 'late.txt', 'late\n');
    git(path, 'add', '-A');
    execFileSync('git', ['commit', '-q', '--no-verify', '-m', 'late work'], {
      cwd: path,
      env: {
        PATH: process.env['PATH'],
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test Author',
        GIT_AUTHOR_EMAIL: 'author@example.invalid',
        GIT_COMMITTER_NAME: 'Test Author',
        GIT_COMMITTER_EMAIL: 'author@example.invalid',
        GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
      },
    });
    const late = git(path, 'rev-parse', 'HEAD').trim();
    expect(await only(root, 'mindly/demo/api', ['mindly/demo/api'])).toEqual([
      { commit: late, subject: 'late work' },
    ]);
  });

  it('counts only reachability: squash-merged commits are still only on their branch', async () => {
    const root = makeRepo({ 'README.md': '# a\n' });
    const dir = tempDir();
    const path = join(dir, 'api');
    await addWorktree(root, path, 'mindly/demo/api', 'HEAD');
    for (let i = 0; i < 3; i++) {
      write(path, `api${i}.txt`, 'api\n');
      commitAll(path, `api work ${i}`);
    }
    const ask = (max?: number) =>
      branchOnlyWork(root, 'mindly/demo/api', {
        ignoring: ['mindly/demo/api'],
        ...(max ? { max } : {}),
      });
    expect(await ask()).toMatchObject({ more: false });
    // Squash-merged into main, as a pull request does: main has the changes, not the commits.
    git(root, 'merge', '-q', '--squash', 'mindly/demo/api');
    commitAll(root, 'Add api (#1)');
    const squashed = await ask();
    expect(squashed.commits.map((c) => c.subject)).toEqual([
      'api work 2',
      'api work 1',
      'api work 0',
    ]);
    expect(squashed.tip).toBe(git(path, 'rev-parse', 'HEAD').trim());
    // More commits than asked for: the list says so.
    const capped = await ask(2);
    expect(capped.commits).toHaveLength(2);
    expect(capped.more).toBe(true);
  });

  it('deletes a branch only while it is where it was checked', async () => {
    const root = makeRepo();
    const path = join(tempDir(), 'part');
    const made = await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    write(path, 'late.txt', 'late\n');
    const late = commitAll(path, 'late');
    await removeWorktree(root, path);
    await expect(deleteBranch(root, 'mindly/demo/p', made.commit)).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict') && e.details?.['moved'] === true,
    );
    expect(git(root, 'rev-parse', 'mindly/demo/p').trim()).toBe(late);
    expect(await deleteBranch(root, 'mindly/demo/p', late)).toBe(true);
    expect(await branchExists(root, 'mindly/demo/p')).toBe(false);
  });

  it('lists ignored files on the deny-list, and no other ignored files', async () => {
    const root = makeRepo({ '.gitignore': '.env\nconfig/\nnode_modules/\n*.log\n' });
    write(root, '.env', 'SECRET=1\n');
    write(root, 'config/.env', 'SECRET=2\n');
    write(root, 'config/settings.json', '{}\n');
    write(root, 'node_modules/pkg/index.js', 'x\n');
    write(root, 'debug.log', 'x\n');
    write(root, 'src/server.key', 'not ignored\n');
    expect(await ignoredDeniedFiles(root)).toEqual(['.env', 'config/.env']);
    expect(await ignoredDeniedFiles(root, ['**/*.log'])).toEqual([
      '.env',
      'config/.env',
      'debug.log',
    ]);
  });

  it('lists ignored deny-listed files in any letter case, and none in dependency folders', async () => {
    const root = makeRepo({ '.gitignore': 'certs/\n.venv/\nnode_modules/\n*.secret\n' });
    write(root, 'certs/Prod.KEY', 'k\n');
    write(root, 'certs/.ENV', 'k\n');
    write(root, 'local.secret', 'k\n');
    write(root, '.venv/lib/python3.12/site-packages/certifi/cacert.pem', 'ca\n');
    write(root, 'node_modules/pkg/test/fixture.pem', 'ca\n');
    expect(await ignoredDeniedFiles(root)).toEqual(['certs/.ENV', 'certs/Prod.KEY']);
    expect(await ignoredDeniedFiles(root, ['**/*.secret'])).toEqual([
      'certs/.ENV',
      'certs/Prod.KEY',
      'local.secret',
    ]);
  });

  it('counts secrets in folders that only look like build output, and skips real dependency trees', async () => {
    const root = makeRepo({
      '.gitignore': 'env/\nbuild/\n.venv/\nvenv/\n.tox/\n',
    });
    write(root, 'env/.env', 'k\n');
    write(root, 'deploy/build/signing.key', 'k\n');
    // A real virtualenv: installed files are skipped, a `.env` or a key in it still counts.
    write(root, '.venv/pyvenv.cfg', 'home = /usr/bin\n');
    write(root, '.venv/lib/python3.12/credentials.json', '{}\n');
    write(root, '.venv/.env', 'k\n');
    // Not a virtualenv (no pyvenv.cfg): everything counts.
    write(root, 'venv/credentials.json', '{}\n');
    write(root, '.tox/py312/credentials.json', '{}\n');
    expect(await ignoredDeniedFiles(root)).toEqual([
      '.venv/.env',
      'deploy/build/signing.key',
      'env/.env',
      'venv/credentials.json',
    ]);
  });

  it('keeps a locked worktree unless forced', async () => {
    const root = makeRepo();
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    git(root, 'worktree', 'lock', '--reason', 'agent running', path);
    await expect(removeWorktree(root, path, { force: false })).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict') && e.details?.['locked'] === true,
    );
    expect(existsSync(path)).toBe(true);
    expect(await removeWorktree(root, path, { force: true })).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('removes a worktree without force only when git finds nothing to lose', async () => {
    const root = makeRepo({ '.gitignore': 'build/\n' });
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    write(path, 'wip.txt', 'not committed\n');
    await expect(removeWorktree(root, path, { force: false })).rejects.toSatisfy(
      (e) =>
        isMindlyError(e, 'conflict') &&
        e.details?.['refused'] === true &&
        /modified or untracked files/.test(String(e.details?.['reason'])),
    );
    expect(existsSync(join(path, 'wip.txt'))).toBe(true);
    commitAll(path, 'wip');
    write(path, 'build/out.js', 'ignored\n');
    expect(await removeWorktree(root, path, { force: false })).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('sees an edit to a file flagged skip-worktree or assume-unchanged, and keeps the flags', async () => {
    const root = makeRepo({ 'config/local.json': '{}\n', 'b.txt': 'b\n', '.env.local': 'A=\n' });
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    git(path, 'update-index', '--skip-worktree', 'config/local.json', '.env.local');
    git(path, 'update-index', '--assume-unchanged', 'b.txt');
    expect(git(path, 'status', '--porcelain')).toBe('');
    expect(await flaggedChanges(path)).toEqual({ changed: ['.env.local'], denied: ['.env.local'] });
    write(path, 'config/local.json', '{"db":"postgres://me:pw@host/db"}\n');
    write(path, 'b.txt', 'edited\n');
    expect(await flaggedChanges(path)).toEqual({
      changed: ['.env.local', 'b.txt', 'config/local.json'],
      denied: ['.env.local'],
    });
    // git's own check sees them too (here, the skip-worktree one alone), and a refusal leaves the
    // flags as they were.
    write(path, 'b.txt', 'b\n');
    await expect(removeWorktree(root, path, { force: false })).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict') && e.details?.['refused'] === true,
    );
    expect(git(path, 'ls-files', '-v', 'config/local.json', 'b.txt', '.env.local')).toBe(
      'S .env.local\nh b.txt\nS config/local.json\n',
    );
    // Not on disk (a sparse checkout): nothing to lose.
    rmSync(join(path, 'config/local.json'));
    expect((await flaggedChanges(path)).changed).not.toContain('config/local.json');
  });

  it('puts listed paths back to HEAD without overwriting a file on disk', async () => {
    const root = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    write(path, 'new.txt', 'new\n');
    git(path, 'add', 'new.txt', '-f');
    write(path, 'a.txt', 'edited\n');
    git(path, 'add', 'a.txt');
    rmSync(join(path, 'a.txt'));
    rmSync(join(path, 'new.txt'));
    rmSync(join(path, 'b.txt'));
    write(path, 'c.txt', 'written since\n');
    await restoreFromHead(path, ['a.txt', 'b.txt', 'c.txt', 'new.txt', 'gone.txt']);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('b\n');
    expect(readFileSync(join(path, 'c.txt'), 'utf8')).toBe('written since\n');
    expect(git(path, 'status', '--porcelain')).toBe(' M c.txt\n');
  });

  it('finds nested repositories in ignored folders, and says when it could not look', async () => {
    const root = makeRepo({ '.gitignore': 'tools/\nnode_modules/\ntarget/\nsrc/vendor/\n' });
    git(root, 'init', '-q', join(root, 'tools/patched-dep'));
    write(root, 'src/vendor/lib/.git', 'gitdir: /elsewhere\n');
    // Installed packages and caches are not looked into.
    git(root, 'init', '-q', join(root, 'node_modules/dep'));
    write(root, 'target/CACHEDIR.TAG', 'Signature: 8a477f597d28d172789f06886806bc55\n');
    git(root, 'init', '-q', join(root, 'target/debug/build/x'));
    write(root, 'tools/notes/a.txt', 'a\n');
    expect(await ignoredNestedRepos(root)).toEqual({
      repos: ['src/vendor/lib', 'tools/patched-dep'],
      unchecked: [],
    });
    expect((await ignoredNestedRepos(root, 3)).unchecked.length).toBeGreaterThan(0);
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
