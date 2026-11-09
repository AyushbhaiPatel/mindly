import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureCheckpoint,
  checkpointRefName,
  createBisectWorkspace,
  isManifestPath,
  lockfileIn,
  openWarmWorkspace,
  removeWarmWorkspace,
  revertStep,
  runChecks,
  stepChanges,
  stepDiff,
} from '../src/index.js';
import { git, makeRepo, tempDir, write } from './helpers.js';

/**
 * A repository whose working tree went through four checkpoints while HEAD stayed at the initial
 * commit:
 *   1. src/a.ts modified (full capture)
 *   2. src/b.ts added
 *   3. src/a.ts modified, README.md deleted
 *   4. src/b.ts modified, src/c.ts added
 * Every version of a file has a different length, so git's stat cache can never mistake one for
 * another when several are written within the same second.
 */
async function chainRepo(): Promise<{ root: string; steps: string[] }> {
  const root = makeRepo({
    '.gitignore': 'node_modules/\n',
    'README.md': '# demo\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  const indexFile = join(tempDir(), 'index');
  const steps: string[] = [];
  const take = async (paths: string[] | null): Promise<void> => {
    const last = steps.at(-1);
    const r = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: last ? { commit: last } : null,
      paths,
      always: true,
      ref: checkpointRefName(root, steps.length + 1),
      message: `step ${steps.length + 1}`,
    });
    steps.push(r.commit as string);
  };
  write(root, 'src/a.ts', 'export const a = 22;\n');
  await take(null);
  write(root, 'src/b.ts', 'export const b = 1;\n');
  await take(['src/b.ts']);
  write(root, 'src/a.ts', 'export const a = 333;\n');
  rmSync(join(root, 'README.md'));
  await take(['src/a.ts', 'README.md']);
  write(root, 'src/b.ts', 'export const b = 22;\n');
  write(root, 'src/c.ts', 'export const c = 1;\n');
  await take(['src/b.ts', 'src/c.ts']);
  return { root, steps };
}

function step(steps: string[], n: number): string {
  return steps[n - 1] as string;
}

/** The user's checkout state, with status lines for `except` paths left out. */
function userState(root: string, except: string[] = []): Record<string, string> {
  const indexPath = git(root, 'rev-parse', '--git-path', 'index').trim();
  const status = git(root, 'status', '--porcelain')
    .split('\n')
    .filter((line) => line !== '' && !except.includes(line.slice(3)))
    .join('\n');
  return {
    index: readFileSync(resolve(root, indexPath)).toString('hex'),
    head: git(root, 'rev-parse', 'HEAD').trim(),
    branch: git(root, 'symbolic-ref', 'HEAD').trim(),
    status,
  };
}

describe('createBisectWorkspace', () => {
  it('checks out checkpoints in a detached scratch worktree outside the repository', async () => {
    const { root, steps } = await chainRepo();
    const ws = await createBisectWorkspace(root, step(steps, 4));
    expect(ws.path.startsWith(root)).toBe(false);
    expect(ws.current).toBe(step(steps, 4));
    expect(git(ws.path, 'rev-parse', 'HEAD').trim()).toBe(step(steps, 4));
    expect(() => git(ws.path, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(readFileSync(join(ws.path, 'src', 'b.ts'), 'utf8')).toBe('export const b = 22;\n');
    expect(existsSync(join(ws.path, 'src', 'c.ts'))).toBe(true);
    expect(existsSync(join(ws.path, 'README.md'))).toBe(false);
    expect(git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${ws.path}`);

    mkdirSync(join(ws.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(ws.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(ws.path, 'src', 'a.ts'), 'scribbled by a check\n');
    mkdirSync(join(ws.path, 'dist'));
    writeFileSync(join(ws.path, 'dist', 'out.js'), 'built by a check\n');

    await ws.checkout(step(steps, 1));
    // What a check built is gone; what an install put in an ignored folder stays.
    expect(existsSync(join(ws.path, 'dist'))).toBe(false);
    expect(ws.current).toBe(step(steps, 1));
    expect(git(ws.path, 'rev-parse', 'HEAD').trim()).toBe(step(steps, 1));
    expect(readFileSync(join(ws.path, 'src', 'a.ts'), 'utf8')).toBe('export const a = 22;\n');
    expect(existsSync(join(ws.path, 'src', 'b.ts'))).toBe(false);
    expect(readFileSync(join(ws.path, 'README.md'), 'utf8')).toBe('# demo\n');
    expect(existsSync(join(ws.path, 'node_modules', 'dep', 'index.js'))).toBe(true);

    await ws.checkout(step(steps, 3));
    expect(readFileSync(join(ws.path, 'src', 'a.ts'), 'utf8')).toBe('export const a = 333;\n');
    expect(readFileSync(join(ws.path, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
    expect(existsSync(join(ws.path, 'src', 'c.ts'))).toBe(false);
    expect(existsSync(join(ws.path, 'node_modules', 'dep', 'index.js'))).toBe(true);

    expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('export const b = 22;\n');

    const path = ws.path;
    await ws.dispose();
    expect(existsSync(path)).toBe(false);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(path);
    await ws.dispose();
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(path);
  });
});

describe('stepChanges and stepDiff', () => {
  it('reports added, modified and deleted paths of a step', async () => {
    const { root, steps } = await chainRepo();
    expect(await stepChanges(root, null, step(steps, 1))).toEqual([
      { path: '.gitignore', status: 'A' },
      { path: 'README.md', status: 'A' },
      { path: 'src/a.ts', status: 'A' },
    ]);
    expect(await stepChanges(root, step(steps, 1), step(steps, 2))).toEqual([
      { path: 'src/b.ts', status: 'A' },
    ]);
    expect(await stepChanges(root, step(steps, 2), step(steps, 3))).toEqual([
      { path: 'README.md', status: 'D' },
      { path: 'src/a.ts', status: 'M' },
    ]);
    expect(await stepChanges(root, step(steps, 3), step(steps, 4))).toEqual([
      { path: 'src/b.ts', status: 'M' },
      { path: 'src/c.ts', status: 'A' },
    ]);
    expect(await stepChanges(root, step(steps, 2), step(steps, 2))).toEqual([]);
  });

  it('summarises a step as a stat or a unified patch', async () => {
    const { root, steps } = await chainRepo();
    const stat = await stepDiff(root, step(steps, 2), step(steps, 3));
    expect(stat).toContain('src/a.ts');
    expect(stat).toContain('README.md');
    expect(stat).toContain('2 files changed');
    expect(stat).not.toContain('@@');

    const patch = await stepDiff(root, step(steps, 2), step(steps, 3), { patch: true });
    expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(patch).toContain('-export const a = 22;');
    expect(patch).toContain('+export const a = 333;');
    expect(patch).toContain('deleted file mode');
    expect(patch).toContain('-# demo');

    const first = await stepDiff(root, null, step(steps, 1), { patch: true });
    expect(first).toContain('new file mode');
    expect(first).toContain('+export const a = 22;');
  });
});

describe('revertStep', () => {
  it('checks without writing, then reverts only the step paths in the working tree', async () => {
    const { root, steps } = await chainRepo();
    write(root, 'scratch.txt', 'untracked, stays\n');
    const stepPaths = ['src/b.ts', 'src/c.ts'];
    const before = userState(root);
    const beforeExceptStep = userState(root, stepPaths);
    expect(before.status).toContain('?? src/c.ts');

    const dry = await revertStep(root, step(steps, 3), step(steps, 4), { apply: false });
    expect(dry).toEqual({ paths: stepPaths, applied: true, conflicts: [], reason: null });
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('export const b = 22;\n');
    expect(existsSync(join(root, 'src', 'c.ts'))).toBe(true);
    expect(userState(root)).toEqual(before);

    const applied = await revertStep(root, step(steps, 3), step(steps, 4), { apply: true });
    expect(applied).toEqual({ paths: stepPaths, applied: true, conflicts: [], reason: null });
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
    expect(existsSync(join(root, 'src', 'c.ts'))).toBe(false);
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 333;\n');
    expect(readFileSync(join(root, 'scratch.txt'), 'utf8')).toBe('untracked, stays\n');
    const after = userState(root);
    expect(userState(root, stepPaths)).toEqual(beforeExceptStep);
    expect(after.index).toBe(before.index);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe('refs/heads/main');
    expect(after.status).toContain('?? src/b.ts');
    expect(after.status).not.toContain('src/c.ts');

    const modifiedStep = await revertStep(root, step(steps, 2), step(steps, 3), { apply: true });
    expect(modifiedStep).toEqual({
      paths: ['README.md', 'src/a.ts'],
      applied: true,
      conflicts: [],
      reason: null,
    });
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 22;\n');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# demo\n');
    expect(userState(root).index).toBe(before.index);
    expect(userState(root).status).not.toContain('README.md');
  });

  it('refuses a step whose lines changed since, writing nothing', async () => {
    const { root, steps } = await chainRepo();
    write(root, 'src/b.ts', 'export const b = 99;\n');
    const before = userState(root);

    for (const apply of [false, true]) {
      const r = await revertStep(root, step(steps, 3), step(steps, 4), { apply });
      expect(r.applied).toBe(false);
      expect(r.paths).toEqual(['src/b.ts', 'src/c.ts']);
      expect(r.conflicts).toContain('src/b.ts');
      expect(r.reason).toMatch(/changed since/);
      expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('export const b = 99;\n');
      expect(existsSync(join(root, 'src', 'c.ts'))).toBe(true);
      expect(userState(root)).toEqual(before);
    }
  });

  it('refuses a step that touches a denied file', async () => {
    const root = makeRepo({ 'app.ts': 'a\n' });
    const indexFile = join(tempDir(), 'index');
    write(root, 'app.ts', 'bb\n');
    const first = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    write(root, 'app.ts', 'ccc\n');
    write(root, 'secrets.txt', 'hidden\n');
    const second = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: first.commit as string },
      paths: ['app.ts', 'secrets.txt'],
      always: true,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
    });
    const r = await revertStep(root, first.commit as string, second.commit as string, {
      apply: true,
      extraDeny: ['**/secrets.txt'],
    });
    expect(r.applied).toBe(false);
    expect(r.conflicts).toEqual(['secrets.txt']);
    expect(r.reason).toMatch(/deny-list/);
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('ccc\n');
  });
});

describe('manifests and lockfiles', () => {
  it('recognises manifest and lockfile paths', () => {
    for (const p of [
      'package.json',
      'pnpm-lock.yaml',
      'requirements-dev.txt',
      'pyproject.toml',
      'go.sum',
      'Cargo.lock',
      'apps/web/package.json',
      'services/api/poetry.lock',
    ]) {
      expect(isManifestPath(p), p).toBe(true);
    }
    for (const p of ['src/index.ts', 'README.md', 'package.json.bak', 'docs/lockfiles.md']) {
      expect(isManifestPath(p), p).toBe(false);
    }
  });

  it('finds a top-level lockfile', () => {
    const dir = tempDir();
    expect(lockfileIn(dir)).toBeNull();
    write(dir, 'nested/pnpm-lock.yaml', '');
    expect(lockfileIn(dir)).toBeNull();
    write(dir, 'pnpm-lock.yaml', '');
    expect(lockfileIn(dir)).toBe('pnpm-lock.yaml');
  });
});

describe('runChecks with a signal', () => {
  const node = process.execPath;
  const sleeper = {
    name: 'sleep',
    argv: [node, '-e', 'setTimeout(() => {}, 10000)'],
    timeoutSec: 30,
  };

  it('kills the check when the signal is already aborted or aborts later', async () => {
    const dir = tempDir();
    const started = Date.now();
    const already = new AbortController();
    already.abort();
    const [pre] = await runChecks(dir, [sleeper], { signal: already.signal, killGraceMs: 200 });
    expect(pre?.status).toBe('error');
    expect(pre?.exitCode).toBeNull();

    const later = new AbortController();
    setTimeout(() => later.abort(), 300);
    const [post] = await runChecks(dir, [sleeper, sleeper], {
      signal: later.signal,
      killGraceMs: 200,
    });
    expect(post?.status).toBe('error');
    expect(post?.durationMs).toBeLessThan(5000);
    expect(Date.now() - started).toBeLessThan(8000);
  });
});

describe('warm workspace (sentinel)', () => {
  const worktreePaths = (root: string): string[] =>
    git(root, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));

  it('is created outside the repository and reused, keeping ignored folders', async () => {
    const { root, steps } = await chainRepo();
    const path = join(tempDir(), 'sentinel', 'tree');
    const first = await openWarmWorkspace(root, path, steps[0] as string);
    expect(first.path).toBe(path);
    expect(first.current).toBe(steps[0]);
    expect(first.fresh).toBe(true);
    expect(readFileSync(join(path, 'src/a.ts'), 'utf8')).toBe('export const a = 22;\n');
    // What a setup command installs (ignored) and what a test run leaves (untracked, modified).
    write(path, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    write(path, 'scratch.log', 'left by the command\n');
    write(path, 'src/a.ts', 'garbage\n');
    await first.dispose();
    expect(existsSync(path)).toBe(true);

    // Reopened at the same commit: reset anyway, dependencies kept.
    const again = await openWarmWorkspace(root, path, steps[0] as string);
    expect(again.fresh).toBe(false);
    expect(readFileSync(join(path, 'src/a.ts'), 'utf8')).toBe('export const a = 22;\n');
    expect(existsSync(join(path, 'scratch.log'))).toBe(false);
    expect(existsSync(join(path, 'node_modules/dep/index.js'))).toBe(true);
    // A checkout of the commit already there still discards what a command wrote meanwhile.
    write(path, 'src/a.ts', 'written by the first check\n');
    write(path, 'out.txt', 'left by the first check\n');
    await again.checkout(steps[0] as string);
    expect(readFileSync(join(path, 'src/a.ts'), 'utf8')).toBe('export const a = 22;\n');
    expect(existsSync(join(path, 'out.txt'))).toBe(false);
    expect(existsSync(join(path, 'node_modules/dep/index.js'))).toBe(true);
    await again.checkout(steps[3] as string);
    expect(again.current).toBe(steps[3]);
    expect(readFileSync(join(path, 'src/c.ts'), 'utf8')).toBe('export const c = 1;\n');
    expect(worktreePaths(root)).toContain(path);

    await removeWarmWorkspace(root, path);
    expect(existsSync(path)).toBe(false);
    expect(worktreePaths(root)).not.toContain(path);
    // Removing it again is fine.
    await removeWarmWorkspace(root, path);
  });

  it('replaces a folder that is not a worktree of this repository', async () => {
    const { root, steps } = await chainRepo();
    const other = makeRepo({ 'x.txt': 'other\n' });
    const path = join(tempDir(), 'tree');
    // Another repository's worktree at the path, and a stale admin entry for a deleted folder.
    git(other, 'worktree', 'add', '--detach', '-q', path, 'HEAD');
    const ws = await openWarmWorkspace(root, path, steps[1] as string);
    expect(existsSync(join(path, 'src/b.ts'))).toBe(true);
    expect(existsSync(join(path, 'x.txt'))).toBe(false);
    expect(worktreePaths(root)).toContain(path);

    rmSync(path, { recursive: true, force: true });
    const recreated = await openWarmWorkspace(root, path, steps[2] as string);
    expect(recreated.current).toBe(steps[2]);
    expect(recreated.fresh).toBe(true);
    expect(existsSync(join(path, 'README.md'))).toBe(false);
    await removeWarmWorkspace(root, ws.path);
  });

  it('is removed even when the checkout it was made for is gone', async () => {
    const { root, steps } = await chainRepo();
    const linked = join(tempDir(), 'part');
    git(root, 'worktree', 'add', '--detach', '-q', linked, 'HEAD');
    const path = join(tempDir(), 'sentinel', 'tree');
    await openWarmWorkspace(linked, path, steps[1] as string);
    write(path, 'node_modules/dep/index.js', 'x\n');
    git(root, 'worktree', 'remove', '--force', linked);
    expect(existsSync(linked)).toBe(false);
    await removeWarmWorkspace(linked, path);
    expect(existsSync(path)).toBe(false);
    expect(worktreePaths(root)).not.toContain(path);
    // A folder that is not a linked worktree is never deleted this way.
    const plain = join(tempDir(), 'plain');
    write(plain, 'keep.txt', 'mine\n');
    await expect(removeWarmWorkspace(linked, plain)).rejects.toThrow(/not a linked git worktree/);
    expect(existsSync(join(plain, 'keep.txt'))).toBe(true);
  });

  it('refuses a path inside or around the repository', async () => {
    const { root, steps } = await chainRepo();
    for (const bad of [join(root, 'tree'), root, resolve(root, '..'), 'relative/tree']) {
      await expect(openWarmWorkspace(root, bad, steps[0] as string)).rejects.toThrow(
        /scratch tree/,
      );
      await expect(removeWarmWorkspace(root, bad)).rejects.toThrow(/scratch tree/);
    }
    expect(existsSync(join(root, 'src/a.ts'))).toBe(true);
  });
});
