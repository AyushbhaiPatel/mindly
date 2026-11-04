import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMindlyError } from '@mindly/core';
import {
  captureWorktreeCommit,
  changedFiles,
  currentBranch,
  diffForFile,
  fileAtRef,
  findRepoRoot,
  headCommit,
  isGitRepo,
  listWorktrees,
} from '../src/index.js';
import { commitAll, git, makeRepo, tempDir, write } from './helpers.js';

describe('repository info', () => {
  it('finds the realpath root from a subdirectory and detects non-repos', async () => {
    const root = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    expect(await findRepoRoot(join(root, 'src'))).toBe(realpathSync(root));
    expect(await isGitRepo(root)).toBe(true);
    const plain = tempDir();
    expect(await isGitRepo(plain)).toBe(false);
    expect(await isGitRepo(join(plain, 'missing'))).toBe(false);
    await expect(findRepoRoot(plain)).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'not_found'),
    );
  });

  it('reports branch, HEAD and detached state', async () => {
    const root = makeRepo();
    const head = git(root, 'rev-parse', 'HEAD').trim();
    expect(await currentBranch(root)).toBe('main');
    expect(await headCommit(root)).toBe(head);
    git(root, 'checkout', '-q', '--detach');
    expect(await currentBranch(root)).toBeNull();

    const empty = tempDir();
    git(empty, 'init', '-q');
    expect(await headCommit(empty)).toBeNull();
  });

  it('lists worktrees', async () => {
    const root = makeRepo();
    const wt = join(tempDir(), 'wt');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const list = await listWorktrees(root);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ path: root, branch: 'refs/heads/main', detached: false });
    expect(realpathSync(list[1]?.path ?? '')).toBe(realpathSync(wt));
    expect(list[1]?.branch).toBe('refs/heads/feature');
  });

  it('lists staged, unstaged, untracked, deleted and renamed files', async () => {
    const root = makeRepo({
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'c.txt': 'c\n',
      'r.txt': 'rename me\n',
    });
    write(root, 'a.txt', 'changed\n');
    write(root, 'b.txt', 'staged\n');
    git(root, 'add', 'b.txt');
    unlinkSync(join(root, 'c.txt'));
    git(root, 'mv', 'r.txt', 'renamed file.txt');
    write(root, 'new dir/n.txt', 'new\n');
    write(root, '.gitignore', 'ignored.log\n');
    write(root, 'ignored.log', 'x\n');
    const files = await changedFiles(root);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')).toMatchObject({ kind: 'modified', staged: false, unstaged: true });
    expect(byPath.get('b.txt')).toMatchObject({ kind: 'modified', staged: true, unstaged: false });
    expect(byPath.get('c.txt')).toMatchObject({ kind: 'deleted' });
    expect(byPath.get('renamed file.txt')).toMatchObject({ kind: 'renamed', origPath: 'r.txt' });
    expect(byPath.get('new dir/n.txt')).toMatchObject({ kind: 'untracked' });
    expect(byPath.has('ignored.log')).toBe(false);
  });

  it('diffs a file and reads files at a ref', async () => {
    const root = makeRepo({ 'src/a.ts': 'one\n' });
    const first = git(root, 'rev-parse', 'HEAD').trim();
    write(root, 'src/a.ts', 'two\n');
    const diff = await diffForFile(root, 'src/a.ts');
    expect(diff).toContain('-one');
    expect(diff).toContain('+two');
    expect(await diffForFile(root, join(root, 'src/a.ts'), { staged: true })).toBe('');
    await expect(diffForFile(root, '../outside.txt')).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'path_outside_project'),
    );
    commitAll(root, 'two');
    expect(await fileAtRef(root, first, 'src/a.ts')).toBe('one\n');
    expect(await fileAtRef(root, 'HEAD', 'src/a.ts')).toBe('two\n');
    expect(await fileAtRef(root, 'HEAD', 'src/missing.ts')).toBeNull();
    await expect(fileAtRef(root, 'no-such-branch', 'src/a.ts')).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'not_found'),
    );
    await expect(fileAtRef(root, '-x', 'src/a.ts')).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'invalid_input'),
    );
    await expect(fileAtRef(root, 'HEAD', '../etc/passwd')).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'invalid_input'),
    );
  });
});

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('captureWorktreeCommit', () => {
  it('captures tracked + untracked work without touching index, worktree or refs', async () => {
    const root = makeRepo({ 'a.txt': 'a\n', 'gone.txt': 'bye\n', '.gitignore': 'build/\n' });
    write(root, 'a.txt', 'a modified\n');
    write(root, 'staged.txt', 'staged\n');
    git(root, 'add', 'staged.txt');
    write(root, 'src/new.ts', 'export const n = 1;\n');
    write(root, 'build/out.js', 'ignored\n');
    unlinkSync(join(root, 'gone.txt'));

    const index = join(root, '.git', 'index');
    const statusBefore = git(root, 'status', '--porcelain=v1', '-uall');
    const indexHashBefore = fileHash(index);
    const indexMtimeBefore = statSync(index).mtimeMs;
    const refsBefore = git(root, 'for-each-ref');
    const headBefore = git(root, 'rev-parse', 'HEAD').trim();

    const captured = await captureWorktreeCommit(root);

    expect(git(root, 'status', '--porcelain=v1', '-uall')).toBe(statusBefore);
    expect(fileHash(index)).toBe(indexHashBefore);
    expect(statSync(index).mtimeMs).toBe(indexMtimeBefore);
    expect(git(root, 'for-each-ref')).toBe(refsBefore);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a modified\n');

    expect(captured.parent).toBe(headBefore);
    const tree = git(root, 'ls-tree', '-r', '--name-only', captured.commit).trim().split('\n');
    expect(tree.sort()).toEqual(['.gitignore', 'a.txt', 'src/new.ts', 'staged.txt']);
    expect(git(root, 'show', `${captured.commit}:a.txt`)).toBe('a modified\n');
    expect(git(root, 'log', '-1', '--format=%an <%ae>', captured.commit).trim()).toBe(
      'Mindly <mindly@localhost.invalid>',
    );

    // Deterministic: same state, same commit.
    expect((await captureWorktreeCommit(root)).commit).toBe(captured.commit);
  });

  it('never captures denied paths and works in a repo without commits', async () => {
    const root = tempDir();
    git(root, 'init', '-q');
    write(root, 'app.ts', 'x\n');
    write(root, '.env', 'API_KEY=supersecret\n');
    write(root, 'keys/server.pem', 'pem\n');
    write(root, 'vault/data.txt', 'custom deny\n');
    const captured = await captureWorktreeCommit(root, { extraDeny: ['vault/**'] });
    expect(captured.parent).toBeNull();
    const tree = git(root, 'ls-tree', '-r', '--name-only', captured.commit).trim().split('\n');
    expect(tree).toEqual(['app.ts']);
    expect(captured.skipped).toEqual(['.env', 'keys/server.pem', 'vault/data.txt']);
    expect(git(root, 'status', '--porcelain')).toContain('?? .env');
  });

  it('keeps the HEAD version of a tracked denied file that was modified or staged', async () => {
    const root = makeRepo({ 'config/.env': 'OLD=1\n', 'a.txt': 'a\n' });
    write(root, 'config/.env', 'NEW=secret\n');
    git(root, 'add', 'config/.env');
    const captured = await captureWorktreeCommit(root);
    expect(git(root, 'show', `${captured.commit}:config/.env`)).toBe('OLD=1\n');
    expect(captured.skipped).toEqual(['config/.env']);
  });

  it('captures a linked worktree independently', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    const wt = join(tempDir(), 'wt');
    git(root, 'worktree', 'add', '-q', '-b', 'side', wt);
    write(wt, 'a.txt', 'from worktree\n');
    mkdirSync(join(wt, 'empty-dir'));
    const captured = await captureWorktreeCommit(wt);
    expect(git(root, 'show', `${captured.commit}:a.txt`)).toBe('from worktree\n');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a\n');
    rmSync(join(wt, 'empty-dir'), { recursive: true });
  });
});
