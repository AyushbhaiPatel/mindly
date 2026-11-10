import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  elsewhereGitDirLabel,
  gitDataPaths,
  linkedGitDirLabel,
  worktreeScan,
  listFiles,
  listWorktrees,
  mergeIntoNewBranch,
  removeWorktree,
  restoreFromHead,
} from '../src/index.js';
import { commitAll, git, makeRepo, tempDir, write } from './helpers.js';

const FILE = ['-c', 'protocol.file.allow=always'];

/** git with an explicit git dir, as an agent may run it; `input` goes to its stdin. */
function gd(gitDir: string, args: string[], input = ''): string {
  return execFileSync('git', [`--git-dir=${gitDir}`, ...args], {
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.invalid',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.invalid',
    },
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** A commit made with plumbing through `gitDir`, put on `ref`. */
function commitThrough(gitDir: string, text: string, ref = 'refs/heads/main'): string {
  const blob = gd(gitDir, ['hash-object', '-w', '--stdin'], text);
  const tree = gd(gitDir, ['mktree'], `100644 blob ${blob}\twork.ts\n`);
  const commit = gd(gitDir, ['commit-tree', tree, '-m', 'only here']);
  gd(gitDir, ['update-ref', ref, commit]);
  return commit;
}

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
    expect(await flaggedChanges(path)).toEqual({
      changed: ['.env.local'],
      denied: ['.env.local'],
      uninitialised: [],
    });
    write(path, 'config/local.json', '{"db":"postgres://me:pw@host/db"}\n');
    write(path, 'b.txt', 'edited\n');
    expect(await flaggedChanges(path)).toEqual({
      changed: ['.env.local', 'b.txt', 'config/local.json'],
      denied: ['.env.local'],
      uninitialised: [],
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

  it('finds nested repositories wherever they are, and only the outermost', async () => {
    const root = makeRepo({
      '.gitignore': 'tools/\nnode_modules/\nlib/\n/deps\nsrc/vendor/\n',
      'src/app/page.ts': 'p\n',
      'a/f.txt': 'f\n',
      'a/c/g.txt': 'g\n',
    });
    const repo = (rel: string, commit = true): void => {
      write(root, `${rel}/a.txt`, 'a\n');
      git(join(root, rel), 'init', '-q', '-b', 'main');
      if (commit) commitAll(join(root, rel), 'local');
    };
    // Next to an empty CACHEDIR.TAG, in node_modules or site-packages: still found.
    write(root, 'tools/CACHEDIR.TAG', '');
    repo('tools/patched-dep');
    repo('tools/patched-dep/inner');
    repo('node_modules/dep');
    repo('lib/python3.12/site-packages/pkg');
    repo('tools/empty', false);
    // A `.git` git does not accept (a stale gitfile), alone in a folder git lists nothing in.
    write(root, 'src/vendor/lib/.git', 'gitdir: /elsewhere\n');
    repo('src/newrepo');
    // Made in folders the repository tracks files in, which git looks past; one inside another
    // and a sibling that sorts between them.
    git(join(root, 'src/app'), 'init', '-q');
    git(join(root, 'a'), 'init', '-q');
    git(join(root, 'a/c'), 'init', '-q');
    repo('a.b');
    const upstream = makeRepo({ 'mix.exs': 'x\n' });
    git(root, 'clone', '-q', upstream, join(root, 'deps/jason'));
    expect(await gitDataPaths(root)).toEqual([
      'a',
      'a.b',
      'deps/jason',
      'lib/python3.12/site-packages/pkg',
      'node_modules/dep',
      'src/app',
      'src/newrepo',
      'src/vendor/lib',
      'tools/empty',
      'tools/patched-dep',
    ]);
  });

  it('finds what git does not list: a rejected .git, files in an uninitialised submodule', async () => {
    const sub = makeRepo({ 'x.ts': 'x\n' });
    const root = makeRepo({
      '.gitignore': 'build/\n',
      'objects/a.txt': 'a\n',
      'refs/b.txt': 'b\n',
    });
    git(root, ...FILE, 'submodule', '-q', 'add', sub, 'mods/sub');
    commitAll(root, 'sub');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    // An empty submodule folder holds nothing; one with a file written into it does.
    expect((await worktreeScan(path)).gitData).toEqual([]);
    write(path, 'mods/sub/patch.ts', 'p\n');
    // A repository with a truncated HEAD, deep in an ignored folder.
    write(path, 'build/r/src/f.ts', 'f\n');
    git(join(path, 'build/r'), 'init', '-q');
    writeFileSync(join(path, 'build/r/.git/HEAD'), '');
    // A HEAD at the top beside tracked objects/ and refs/ is not a git directory; a folder with
    // all three untracked is.
    write(path, 'HEAD', 'not a repository\n');
    write(path, 'gd/HEAD', 'ref: refs/heads/main\n');
    write(path, 'gd/objects/ab/cdef', 'x');
    write(path, 'gd/refs/heads/main', '0000\n');
    const scan = await worktreeScan(path);
    expect(scan.gitData).toEqual([
      'build/r',
      'gd',
      'files in the uninitialised submodule folder mods/sub',
    ]);
    expect((await flaggedChanges(path)).uninitialised).toEqual(['mods/sub/patch.ts']);
  });

  it('tells a git directory by its HEAD and objects, refs packed or not', async () => {
    const origin = makeRepo({ 'a.ts': 'a\n' });
    const root = makeRepo({
      '.gitignore': '.repos/\n',
      'x/objects/a.txt': 'a\n',
      'x/refs/b.txt': 'b\n',
    });
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    // A bare clone after `git gc` (refs packed), and a fresh bare repository with no objects.
    git(origin, 'clone', '-q', '--bare', origin, join(path, '.repos/lib.git'));
    git(join(path, '.repos/lib.git'), 'gc', '-q');
    git(path, 'init', '-q', '--bare', join(path, '.repos/empty.git'));
    // A HEAD that reads like git's, beside tracked objects/ and refs/: not a git directory.
    write(path, 'x/HEAD', 'ref: refs/heads/main\n');
    // A HEAD at the top beside untracked objects/: never the worktree itself.
    write(path, 'HEAD', 'build output\n');
    write(path, 'objects/o.txt', 'o\n');
    expect((await worktreeScan(path)).gitData).toEqual(['.repos/empty.git', '.repos/lib.git']);
  });

  it('counts a git directory only when something in it is not tracked', async () => {
    const root = makeRepo({
      'a/objects/x.json': '{}\n',
      'b/objects/x.json': '{}\n',
      'c/objects': 'a file\n',
      'd/objects': 'a file\n',
      // Fully tracked, HEAD included: everything in it is in a commit.
      'e/HEAD': 'ref: refs/heads/main\n',
      'e/objects/x.json': '{}\n',
      'e/refs/heads/main': '0000\n',
    });
    const sha = git(root, 'rev-parse', 'HEAD').trim();
    // An uninitialised submodule named objects (an empty folder on disk).
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${sha},v/objects`);
    git(root, 'commit', '-q', '-m', 'sub');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    for (const d of ['a', 'b', 'c', 'd', 'v']) write(path, `${d}/HEAD`, 'ref: refs/heads/main\n');
    // a: only the tracked file under objects/; b: an untracked one too.
    write(path, 'b/objects/ab/cdef', 'x');
    // c: objects a file, not a folder; d: an empty folder now where the tracked file was (a
    // tracked file deleted: not as in the last commit).
    rmSync(join(path, 'd/objects'));
    mkdirSync(join(path, 'd/objects/pack'), { recursive: true });
    expect((await worktreeScan(path)).gitData).toEqual(['b', 'd']);
    // Something new in e, beside its tracked HEAD: now it counts.
    write(path, 'e/config', '[core]\n');
    expect((await worktreeScan(path)).gitData).toEqual(['b', 'd', 'e']);
  });

  it('counts a git directory with staged files, or with new packs where a tracked link leads', async () => {
    const pushOnlyCopy = (bare: string): void => {
      const wt = join(tempDir('push-'), 'c');
      write(wt, 'new.ts', 'hours of work\n');
      git(wt, 'init', '-q', '-b', 'main');
      commitAll(wt, 'only copy');
      git(wt, 'push', '-q', bare, 'main');
    };
    const root = makeRepo({ '.gitignore': 'packstore/\n' });
    // A tracked bare repository whose objects/pack is a tracked link into an ignored store.
    const tracked = join(root, 'fx/remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', tracked);
    git(tracked, 'config', 'receive.unpackLimit', '1');
    pushOnlyCopy(tracked);
    git(tracked, 'repack', '-a', '-d', '-q');
    mkdirSync(join(root, 'packstore'));
    for (const f of readdirSync(join(tracked, 'objects/pack'))) {
      renameSync(join(tracked, 'objects/pack', f), join(root, 'packstore', f));
    }
    rmSync(join(tracked, 'objects/pack'), { recursive: true });
    symlinkSync('../../../packstore', join(tracked, 'objects/pack'));
    write(tracked, 'objects/info/.keep', '');
    git(root, 'add', '-A');
    git(root, 'add', '-f', 'packstore');
    commitAll(root, 'skeleton');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    // Its packs are reached through a link: it counts as committed already, nothing followed.
    expect((await worktreeScan(path)).gitData).toEqual([linkedGitDirLabel('fx/remote.git')]);
    const clone = join(tempDir('cl-'), 'c');
    git(tempDir(), 'clone', '-q', '--no-local', join(path, 'fx/remote.git'), clone);
    write(clone, 'more.ts', 'more\n');
    commitAll(clone, 'only here');
    git(clone, 'push', '-q', 'origin', 'main');
    // A bare repository whose files are only staged.
    const staged = join(path, 'fixtures/remote.git');
    git(path, 'init', '-q', '--bare', '-b', 'main', staged);
    pushOnlyCopy(staged);
    git(path, 'add', '-A', 'fixtures');
    expect((await worktreeScan(path)).gitData).toEqual([
      'fixtures/remote.git',
      linkedGitDirLabel('fx/remote.git'),
    ]);
  });

  it('counts a git directory whose objects or refs go through a link, following none', async () => {
    const seed = makeRepo({ 'seed.ts': 'seed\n' });
    git(seed, 'repack', '-a', '-d', '-q');
    /** A tracked bare repository at `rel` whose ref points at the seed's commit. */
    const trackedBare = (root: string, rel: string): string => {
      const b = join(root, rel);
      git(root, 'init', '-q', '--bare', '-b', 'main', b);
      for (const f of readdirSync(join(seed, '.git/objects/pack'))) {
        copyFileSync(join(seed, '.git/objects/pack', f), join(b, 'objects/pack', f));
      }
      write(b, 'refs/heads/main', git(seed, 'rev-parse', 'HEAD'));
      write(b, 'objects/info/.keep', '');
      return b;
    };
    const root = makeRepo({ 'README.md': 'x\n', '.gitignore': 'packs/\nbuild/\n' });
    // objects/pack a link to the top of the project.
    const a = trackedBare(root, 'a/remote.git');
    for (const f of readdirSync(join(a, 'objects/pack'))) {
      renameSync(join(a, 'objects/pack', f), join(root, f));
    }
    rmSync(join(a, 'objects/pack'), { recursive: true });
    symlinkSync('../../..', join(a, 'objects/pack'));
    // objects a link to a store whose pack is a further link to an ignored folder.
    const b = trackedBare(root, 'b/remote.git');
    renameSync(join(b, 'objects'), join(root, 'store'));
    symlinkSync('../../store', join(b, 'objects'));
    renameSync(join(root, 'store/pack'), join(root, 'packs'));
    symlinkSync('../packs', join(root, 'store/pack'));
    // Links elsewhere in a git directory, to an ignored build folder and a tracked script.
    const c = join(root, 'c/remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', c);
    write(c, 'objects/info/.keep', '');
    symlinkSync('../../../build', join(c, 'info/site'));
    symlinkSync('../../../tools/hook.sh', join(c, 'hooks/post-update'));
    write(root, 'tools/hook.sh', '#!/bin/sh\n');
    git(root, 'add', '-A');
    git(root, 'add', '-f', 'packs');
    commitAll(root, 'skeleton');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    // Committed as they are: the linked ones count already; the other one does not, whatever
    // its links lead to (a build, a file with others changing beside it).
    write(path, 'build/app.js', 'built\n');
    write(path, 'tools/hook.log', 'ran\n');
    expect((await worktreeScan(path)).gitData).toEqual([
      linkedGitDirLabel('a/remote.git'),
      linkedGitDirLabel('b/remote.git'),
    ]);
  });

  it('counts a git directory whose storage is elsewhere, reading none of it', async () => {
    const root = makeRepo({ 'README.md': 'x\n', '.gitignore': '.cache/\n' });
    // A committed git directory whose common dir is in an ignored folder.
    write(root, 'wt/HEAD', 'ref: refs/heads/main\n');
    write(root, 'wt/commondir', '../.cache/common\n');
    write(root, 'wt/objects/.keep', '');
    // The shape of a linked worktree's git directory: HEAD and commondir, no objects.
    write(root, 'admin/HEAD', 'ref: refs/heads/main\n');
    write(root, 'admin/commondir', '../.cache/common\n');
    // A bare repository whose packed-refs is a tracked link.
    git(root, 'init', '-q', '--bare', '-b', 'main', join(root, 'pr.git'));
    write(root, 'pr.git/objects/info/.keep', '');
    symlinkSync('../.cache/packed-refs', join(root, 'pr.git/packed-refs'));
    commitAll(root, 'skeleton');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    // Commits stored through the common dir: the worktree looks clean.
    const common = join(path, '.cache/common');
    git(path, 'init', '-q', '--bare', '-b', 'main', common);
    renameSync(join(common, 'HEAD'), join(path, '.cache/HEAD.orig'));
    commitThrough(join(path, 'wt'), 'only here\n', 'refs/heads/feature');
    expect(git(path, 'status', '--porcelain')).toBe('');
    // A git directory, committed, whose history is only in an ignored alternate store.
    const store = join(path, '.cache/store.git');
    git(path, 'init', '-q', '--bare', '-b', 'main', store);
    const c = commitThrough(store, 'only here\n');
    renameSync(join(store, 'objects'), join(path, '.cache/objects'));
    const alt = join(path, 'alt.git');
    git(path, 'init', '-q', '--bare', '-b', 'main', alt);
    write(alt, 'objects/info/alternates', '../../.cache/objects\n');
    write(alt, 'refs/heads/main', `${c}\n`);
    commitAll(path, 'agent repo');
    expect(gd(alt, ['log', '--format=%H', 'main'])).toBe(c);
    expect((await worktreeScan(path)).gitData).toEqual([
      elsewhereGitDirLabel('admin'),
      elsewhereGitDirLabel('alt.git'),
      linkedGitDirLabel('pr.git'),
      elsewhereGitDirLabel('wt'),
    ]);
  });

  it('counts a committed linked-worktree fixture while it is on disk, not once deleted', async () => {
    const root = makeRepo({ 'README.md': 'x\n' });
    const g = join(root, 'fx/.gitted');
    git(root, 'init', '-q', '--bare', g);
    commitThrough(g, 'fixture\n');
    write(g, 'worktrees/wt/HEAD', 'ref: refs/heads/main\n');
    write(g, 'worktrees/wt/commondir', '../..\n');
    write(g, 'worktrees/wt/gitdir', '/nowhere/.git\n');
    commitAll(root, 'fixture');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    // Where it points is not read: it counts, unchanged as it is.
    expect((await worktreeScan(path)).gitData).toEqual([
      elsewhereGitDirLabel('fx/.gitted/worktrees/wt'),
    ]);
    // Its common dir changed: it counts as a changed git directory, holding the other.
    write(path, 'fx/.gitted/refs/heads/topic', `${'0'.repeat(40)}\n`);
    expect((await worktreeScan(path)).gitData).toEqual(['fx/.gitted']);
    // Gone from disk: nothing to hold (its deletion is uncommitted work).
    rmSync(join(path, 'fx'), { recursive: true });
    expect((await worktreeScan(path)).gitData).toEqual([]);
  });

  it('counts a git directory with storage elsewhere however git reaches it', async () => {
    const root = makeRepo({
      'README.md': 'x\n',
      '.gitignore': '.cache/\n',
      // A commondir through a tracked link to an ignored folder.
      'wt/HEAD': 'ref: refs/heads/main\n',
      'wt/commondir': '../lnk/common\n',
      'wt/objects/.keep': '',
      // A C-quoted alternates line.
      'q.git/HEAD': 'ref: refs/heads/main\n',
      'q.git/objects/info/alternates': '"../../.cache/objs"\n',
      // Alternates chained through a committed store to an ignored one.
      'c.git/HEAD': 'ref: refs/heads/main\n',
      'c.git/objects/info/alternates': '../../store1\n',
      'store1/info/alternates': '../.cache/objs\n',
      'store1/pack/.keep': '',
    });
    symlinkSync('.cache', join(root, 'lnk'));
    commitAll(root, 'fixtures');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    const common = join(path, '.cache/common');
    git(path, 'init', '-q', '--bare', '-b', 'main', common);
    renameSync(join(common, 'HEAD'), join(path, '.cache/HEAD.orig'));
    commitThrough(join(path, 'wt'), 'hours of work\n', 'refs/heads/feature');
    expect(gd(join(path, 'wt'), ['log', '--format=%s', 'feature'])).toBe('only here');
    expect((await worktreeScan(path)).gitData).toEqual([
      elsewhereGitDirLabel('c.git'),
      elsewhereGitDirLabel('q.git'),
      elsewhereGitDirLabel('wt'),
    ]);
  });

  it('finds a .git git does not accept, alone in a folder git lists nothing in', async () => {
    const root = makeRepo({ 'README.md': 'x\n' });
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    const g = join(path, 'deep/er/keep/.git');
    git(path, 'init', '-q', '--bare', g);
    commitThrough(g, 'only copy\n');
    gd(g, ['pack-refs', '--all']);
    rmSync(join(g, 'refs'), { recursive: true });
    expect(git(path, 'status', '--porcelain', '-uall', '--ignored')).toBe('');
    expect((await worktreeScan(path)).gitData).toEqual(['deep/er/keep']);
  });

  it('looks at many tracked links in git directories in linear time', async () => {
    const root = makeRepo({ 'README.md': 'x\n' });
    const b = join(root, 'fx/remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', b);
    write(b, 'objects/info/.keep', '');
    mkdirSync(join(b, 'l'));
    for (let i = 0; i < 80_000; i++) symlinkSync('../../../README.md', join(b, 'l', `x${i}`));
    commitAll(root, 'links');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    try {
      const t = Date.now();
      expect((await worktreeScan(path)).gitData).toEqual([]);
      // Copying the link list per link took 30 s here.
      expect(Date.now() - t).toBeLessThan(5_000);
    } finally {
      rmSync(path, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  it('takes any HEAD beside an untracked objects for a git directory, as git would', async () => {
    const origin = makeRepo({ 'a.ts': 'a\n' });
    const root = makeRepo({ '.gitignore': '.repos/\n' });
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    const bare = (name: string, args: string[] = []): string => {
      const at = join(path, '.repos', name);
      git(origin, ...args, 'clone', '-q', '--bare', origin, at);
      return at;
    };
    // HEAD a link (core.preferSymlinkRefs), HEAD over 256 bytes, `ref:` with no space.
    bare('link.git', ['-c', 'core.preferSymlinkRefs=true']);
    git(bare('long.git'), 'branch', '-m', 'main', `feature/${'a'.repeat(120)}/${'b'.repeat(130)}`);
    writeFileSync(join(bare('nospace.git'), 'HEAD'), 'ref:refs/heads/main\n');
    // objects a link to a folder elsewhere in the part.
    const linked = bare('linked.git');
    renameSync(join(linked, 'objects'), join(path, '.repos/store'));
    symlinkSync('../store', join(linked, 'objects'));
    // A HEAD of anything beside an untracked objects: may be one, so it counts.
    write(path, 'tmp/y/HEAD', 'build output\n');
    write(path, 'tmp/y/objects/o.txt', 'o\n');
    for (const name of ['link.git', 'long.git', 'nospace.git', 'linked.git']) {
      expect(git(join(path, '.repos', name), 'log', '--format=%s', '-1')).toBe('initial\n');
    }
    expect((await worktreeScan(path)).gitData).toEqual([
      '.repos/link.git',
      linkedGitDirLabel('.repos/linked.git'),
      '.repos/long.git',
      '.repos/nospace.git',
      'tmp/y',
    ]);
  });

  it('finds git directories kept apart from their work tree, in ignored folders', async () => {
    const root = makeRepo({ '.gitignore': '.cache/\n.repos/\n' });
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    // `git init --separate-git-dir` into an ignored folder.
    write(path, 'lib/a.ts', 'a\n');
    write(path, '.cache/keep', '');
    git(path, 'init', '-q', '--separate-git-dir', join(path, '.cache/lib.git'), join(path, 'lib'));
    commitAll(join(path, 'lib'), 'only here');
    // A `.git` symlink to a bare repository in an ignored folder.
    write(path, 'other/a.ts', 'a\n');
    git(path, 'init', '-q', '--bare', join(path, '.repos/other.git'));
    symlinkSync('../.repos/other.git', join(path, 'other/.git'));
    git(join(path, 'other'), 'config', 'core.bare', 'false');
    commitAll(join(path, 'other'), 'only here');
    expect(await gitDataPaths(path)).toEqual([
      '.cache/lib.git',
      '.repos/other.git',
      'lib',
      'other',
    ]);
  });

  it('finds submodules, their git directories and linked worktrees, initialised or not', async () => {
    const inner = makeRepo({ 'i.ts': 'i\n' });
    const sub = makeRepo({ 'x.ts': 'x\n' });
    git(sub, ...FILE, 'submodule', '-q', 'add', inner, 'inner');
    commitAll(sub, 'inner');
    const root = makeRepo({ 'README.md': 'r\n' });
    git(root, ...FILE, 'submodule', '-q', 'add', sub, 'mods/sub');
    commitAll(root, 'sub');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    expect(await gitDataPaths(path)).toEqual([]);
    git(path, ...FILE, 'submodule', '-q', 'update', '--init', '--recursive');
    git(join(path, 'mods/sub'), 'worktree', 'add', '-q', '-b', 'feat', join(path, 'a-wt'));
    const admin = git(path, 'rev-parse', '--absolute-git-dir').trim();
    expect(await gitDataPaths(path)).toEqual(['a-wt', 'mods/sub', join(admin, 'modules')]);
    // Deinitialised, its git directory (and an unpushed commit in it) is still there.
    git(join(path, 'mods/sub'), 'commit', '-q', '--allow-empty', '-m', 'unpushed');
    git(join(path, 'mods/sub'), 'worktree', 'remove', '--force', join(path, 'a-wt'));
    git(path, 'submodule', 'deinit', '-q', '-f', 'mods/sub');
    expect(await gitDataPaths(path)).toEqual([join(admin, 'modules')]);
  });

  it('lists nested repositories in time linear in the ignored folders', async () => {
    const root = makeRepo({ '.gitignore': '__pycache__/\n' });
    for (let i = 0; i < 20_000; i++) {
      write(root, `src/p${Math.floor(i / 100)}/m${i}/__pycache__/__init__.cpython-312.pyc`, '');
    }
    try {
      const t = Date.now();
      expect(await gitDataPaths(root)).toEqual([]);
      // A pairwise comparison of the folders took over 15 s here.
      expect(Date.now() - t).toBeLessThan(8_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses a worktree with an untracked file whatever status.showUntrackedFiles says', async () => {
    const root = makeRepo();
    git(root, 'config', 'status.showUntrackedFiles', 'no');
    const path = join(tempDir(), 'part');
    await addWorktree(root, path, 'mindly/demo/p', 'HEAD');
    write(path, 'late.ts', 'written last\n');
    await expect(removeWorktree(root, path, { force: false })).rejects.toSatisfy(
      (e) => isMindlyError(e, 'conflict') && e.details?.['refused'] === true,
    );
    expect(existsSync(join(path, 'late.ts'))).toBe(true);
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
