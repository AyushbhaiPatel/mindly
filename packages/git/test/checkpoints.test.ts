import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMindlyError } from '@mindly/core';
import {
  CHECKPOINT_REF_PREFIX,
  STALE_LOCK_MS,
  captureCheckpoint,
  checkpointDiskUsage,
  checkpointRefName,
  deleteCheckpointRefs,
  listCheckpointRefs,
  mirrorRemotes,
  tryLockCheckpoint,
  worktreeId,
} from '../src/index.js';
import { commitAll, git, makeRepo, tempDir, write } from './helpers.js';

/** A repository that keeps its refs in reftables, or null when this git cannot (before 2.45). */
function reftableRepo(): string | null {
  const root = tempDir('syn-reftable-');
  try {
    git(root, 'init', '-q', '--ref-format=reftable');
  } catch {
    return null;
  }
  write(root, 'a.txt', 'a\n');
  commitAll(root);
  return root;
}

/** Everything in the user's checkout a checkpoint must leave byte-identical. */
function checkoutState(root: string): {
  index: string;
  head: string;
  branch: string;
  status: string;
  files: Record<string, string>;
} {
  const indexPath = git(root, 'rev-parse', '--git-path', 'index').trim();
  const files: Record<string, string> = {};
  for (const rel of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (rel === '.git' || rel.startsWith(`.git${sep}`)) continue;
    const abs = join(root, rel);
    if (statSync(abs).isFile()) files[rel] = readFileSync(abs, 'utf8');
  }
  return {
    index: readFileSync(resolve(root, indexPath)).toString('hex'),
    head: git(root, 'rev-parse', 'HEAD').trim(),
    branch: git(root, 'symbolic-ref', 'HEAD').trim(),
    status: git(root, 'status', '--porcelain'),
    files,
  };
}

function treePaths(root: string, commit: string): string[] {
  return git(root, 'ls-tree', '-r', '--name-only', commit).trim().split('\n').sort();
}

function blob(root: string, commit: string, path: string): string {
  return git(root, 'show', `${commit}:${path}`);
}

describe('captureCheckpoint', () => {
  it('records the tree and chains an edit-only capture onto the first one', async () => {
    const root = makeRepo({ 'README.md': '# demo\n', 'src/a.ts': 'export const a = 1;\n' });
    const indexFile = join(tempDir(), 'index');
    write(root, 'src/a.ts', 'export const a = 22;\n');
    write(root, 'src/new.ts', 'export const fresh = true;\n');

    const first = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: false,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(first.changed).toBe(true);
    expect(first.skipped).toEqual([]);
    const step1 = first.commit as string;
    expect(git(root, 'rev-parse', checkpointRefName(root, 1)).trim()).toBe(step1);
    expect(git(root, 'rev-list', '--parents', '-n', '1', step1).trim()).toBe(step1);
    expect(treePaths(root, step1)).toEqual(['README.md', 'src/a.ts', 'src/new.ts']);
    expect(blob(root, step1, 'src/a.ts')).toBe('export const a = 22;\n');
    expect(blob(root, step1, 'src/new.ts')).toBe('export const fresh = true;\n');

    write(root, 'src/a.ts', 'export const a = 333;\n');
    const second = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: step1 },
      paths: ['src/a.ts'],
      always: false,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
    });
    const step2 = second.commit as string;
    expect(step2).toMatch(/^[0-9a-f]{40}$/);
    expect(second.changed).toBe(true);
    expect(second.changedPaths).toEqual(['src/a.ts']);
    expect(git(root, 'rev-list', '--parents', '-n', '1', step2).trim()).toBe(step2);
    expect(blob(root, step2, 'src/a.ts')).toBe('export const a = 333;\n');
    expect(blob(root, step2, 'src/new.ts')).toBe('export const fresh = true;\n');
    expect(git(root, 'diff', '--name-only', step1, step2).trim()).toBe('src/a.ts');
  });

  it('skips the commit when nothing changed unless always is set', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    const indexFile = join(tempDir(), 'index');
    write(root, 'a.txt', 'bb\n');
    const first = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: false,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    const step1 = first.commit as string;

    const quiet = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: step1 },
      paths: null,
      always: false,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
    });
    expect(quiet.commit).toBeNull();
    expect(quiet.changed).toBe(false);
    expect(quiet.tree).toBe(first.tree);
    expect(git(root, 'for-each-ref', '--format=%(refname)', CHECKPOINT_REF_PREFIX).trim()).toBe(
      checkpointRefName(root, 1),
    );

    const quietEdit = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: step1 },
      paths: ['a.txt'],
      always: false,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
    });
    expect(quietEdit.commit).toBeNull();
    expect(quietEdit.changed).toBe(false);

    const forced = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: step1 },
      paths: null,
      always: true,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
    });
    expect(forced.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(forced.changed).toBe(false);
    expect(forced.tree).toBe(first.tree);
    expect(git(root, 'rev-list', '--parents', '-n', '1', forced.commit as string).trim()).toBe(
      forced.commit,
    );
    expect((await listCheckpointRefs(root)).map((r) => r.seq)).toEqual([1, 2]);
  });

  it('never stores denied files, keeping the HEAD content of tracked ones', async () => {
    const root = makeRepo({ '.env': 'SECRET=old\n', 'app.ts': 'ok\n' });
    const indexFile = join(tempDir(), 'index');
    write(root, '.env', 'SECRET=new\n');
    write(root, '.env.local', 'LOCAL=1\n');
    write(root, 'private.txt', 'mine\n');
    write(root, 'app.ts', 'changed\n');

    const full = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: false,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
      extraDeny: ['**/private.txt'],
    });
    const step1 = full.commit as string;
    expect(full.skipped).toEqual(['.env', '.env.local', 'private.txt']);
    expect(treePaths(root, step1)).toEqual(['.env', 'app.ts']);
    expect(blob(root, step1, '.env')).toBe('SECRET=old\n');
    expect(blob(root, step1, 'app.ts')).toBe('changed\n');

    write(root, '.env', 'SECRET=newer\n');
    write(root, 'private.txt', 'still mine\n');
    const edit = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: step1 },
      paths: ['.env', 'private.txt', 'app.ts'],
      always: true,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
      extraDeny: ['**/private.txt'],
    });
    const step2 = edit.commit as string;
    expect(edit.skipped).toEqual(['.env', 'private.txt']);
    expect(edit.changedPaths).toEqual(['app.ts']);
    expect(treePaths(root, step2)).toEqual(['.env', 'app.ts']);
    expect(blob(root, step2, '.env')).toBe('SECRET=old\n');
    expect(git(root, 'rev-list', '--objects', '--all', '--glob=refs/mindly/*')).not.toContain(
      git(root, 'hash-object', join(root, '.env')).trim(),
    );
  });

  it('leaves the index, HEAD, branch, files and status byte-identical', async () => {
    const root = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    write(root, 'a.txt', 'edited\n');
    write(root, 'c.txt', 'new\n');
    rmSync(join(root, 'b.txt'));
    git(root, 'add', 'c.txt');
    const indexFile = join(tempDir(), 'index');
    const before = checkoutState(root);

    const first = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    expect(checkoutState(root)).toEqual(before);

    write(root, 'a.txt', 'edited twice\n');
    const after = checkoutState(root);
    await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: first.commit as string },
      paths: ['a.txt'],
      always: true,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
    });
    expect(checkoutState(root)).toEqual(after);
    expect(after.index).toBe(before.index);
    expect(after.status).toContain('A  c.txt');
  });

  it('refuses an index file inside the repository and an existing ref', async () => {
    const root = makeRepo();
    const indexFile = join(tempDir(), 'index');
    write(root, 'x.txt', 'x\n');
    const base = {
      worktree: root,
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    };
    await expect(
      captureCheckpoint({ ...base, indexFile: join(root, 'private-index') }),
    ).rejects.toSatisfy((e: unknown) => isMindlyError(e, 'invalid_input'));
    await expect(
      captureCheckpoint({ ...base, indexFile: join(root, '.git', 'mindly-index') }),
    ).rejects.toSatisfy((e: unknown) => isMindlyError(e, 'invalid_input'));
    await expect(captureCheckpoint({ ...base, indexFile: 'relative/index' })).rejects.toSatisfy(
      (e: unknown) => isMindlyError(e, 'invalid_input'),
    );
    expect(await listCheckpointRefs(root)).toEqual([]);

    const first = await captureCheckpoint({ ...base, indexFile });
    await expect(captureCheckpoint({ ...base, indexFile })).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'conflict'),
    );
    expect(git(root, 'rev-parse', checkpointRefName(root, 1)).trim()).toBe(first.commit);
  });

  it('drops a tracked file deleted on disk when captured by path', async () => {
    const root = makeRepo({ 'keep.txt': 'keep\n', 'gone.txt': 'gone\n' });
    const indexFile = join(tempDir(), 'index');
    const first = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    expect(treePaths(root, first.commit as string)).toEqual(['gone.txt', 'keep.txt']);
    rmSync(join(root, 'gone.txt'));
    const second = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: first.commit as string },
      paths: ['gone.txt'],
      always: false,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
    });
    expect(second.changed).toBe(true);
    expect(treePaths(root, second.commit as string)).toEqual(['keep.txt']);
    expect(git(root, 'ls-files', '--error-unmatch', 'gone.txt').trim()).toBe('gone.txt');
  });

  it('stores a link whose target is missing, and a retargeted one, as links', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    symlinkSync('a.txt', join(root, 'link'));
    git(root, 'add', 'link');
    git(root, 'commit', '-q', '-m', 'link');
    const indexFile = join(tempDir(), 'index');
    const mode = (commit: string, path: string) =>
      git(root, 'ls-tree', commit, path).trim().split(/\s+/)[0];
    const first = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    // A new link to a file that does not exist yet (a build output, say), captured by path.
    symlinkSync('not-yet-there.txt', join(root, 'pending'));
    const second = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: first.commit as string },
      paths: ['pending'],
      always: false,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
    });
    expect(second.changed).toBe(true);
    expect(treePaths(root, second.commit as string)).toEqual(['a.txt', 'link', 'pending']);
    expect(mode(second.commit as string, 'pending')).toBe('120000');
    expect(blob(root, second.commit as string, 'pending')).toBe('not-yet-there.txt');
    // The tracked link now points at something missing: it stays in the tree, retargeted.
    rmSync(join(root, 'link'));
    symlinkSync('build/out.js', join(root, 'link'));
    const third = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: second.commit as string },
      paths: null,
      always: false,
      ref: checkpointRefName(root, 3),
      message: 'step 3',
    });
    expect(third.changedPaths).toEqual(['link']);
    expect(treePaths(root, third.commit as string)).toEqual(['a.txt', 'link', 'pending']);
    expect(blob(root, third.commit as string, 'link')).toBe('build/out.js');
  });

  it('sees a same-size rewrite made within a second of the last git add', async () => {
    // Git trusts an index entry's stat cache unless the entry is "racily clean" (its mtime is
    // not older than the index file's). The private index is seeded from the real one, so it
    // must keep the real index's timestamps or a same-length edit in that second is missed.
    const wait = (until: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
    await wait(Math.ceil(Date.now() / 1000) * 1000 + 20);
    const root = makeRepo({ 'f.txt': 'version A\n' });
    write(root, 'f.txt', 'version B\n');
    await wait(Math.ceil(Date.now() / 1000) * 1000 + 20);
    const indexFile = join(tempDir(), 'index');
    const captured = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: ['f.txt'],
      always: true,
      ref: 'refs/mindly/steps/racy/1',
      message: 'step 1',
    });
    expect(blob(root, captured.commit as string, 'f.txt')).toBe('version B\n');
  });
});

describe('checkpoint refs', () => {
  it('names refs from a stable worktree id', () => {
    const id = worktreeId('/home/me/project');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(worktreeId('/home/me/project')).toBe(id);
    expect(worktreeId('/home/me/other')).not.toBe(id);
    expect(checkpointRefName('/home/me/project', 7)).toBe(`${CHECKPOINT_REF_PREFIX}${id}/7`);
    for (const seq of [0, -1, 1.5, Number.NaN]) {
      expect(() => checkpointRefName('/home/me/project', seq)).toThrow();
    }
  });

  it('drops a staged secret and a path denied after it was captured, on every capture', async () => {
    const root = makeRepo({ 'a.txt': 'a\n', 'config/app.txt': 'plain\n' });
    const indexFile = join(tempDir(), 'index');
    write(root, '.env', 'SECRET=1\n');
    git(root, 'add', '--force', '.env');
    write(root, 'config/app.txt', 'token=abc\n');
    const first = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    expect(first.skipped).toEqual(['.env']);
    expect(treePaths(root, first.commit as string)).toEqual(['a.txt', 'config/app.txt']);
    expect(blob(root, first.commit as string, 'config/app.txt')).toBe('token=abc\n');

    const second = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: { commit: first.commit as string },
      paths: ['a.txt'],
      always: true,
      ref: checkpointRefName(root, 2),
      message: 'step 2',
      extraDeny: ['config/*'],
    });
    expect(second.skipped).toEqual(['config/app.txt']);
    expect(blob(root, second.commit as string, 'config/app.txt')).toBe('plain\n');
    expect(treePaths(root, second.commit as string)).toEqual(['a.txt', 'config/app.txt']);
    expect(git(root, 'ls-files', '--stage', '.env')).toContain('.env');
  });

  it('lists oldest first, deletes only the named refs and measures disk usage', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    const indexFile = join(tempDir(), 'index');
    const commits: string[] = [];
    for (const seq of [1, 2, 3]) {
      write(root, 'a.txt', `version ${seq}\n`);
      const last = commits.at(-1);
      const r = await captureCheckpoint({
        worktree: root,
        indexFile,
        parent: last ? { commit: last } : null,
        paths: last ? ['a.txt'] : null,
        always: true,
        ref: checkpointRefName(root, seq),
        message: `step ${seq}`,
      });
      commits.push(r.commit as string);
    }
    const listed = await listCheckpointRefs(root);
    const id = worktreeId(root);
    expect(listed).toEqual([
      {
        worktreeId: id,
        seq: 1,
        ref: checkpointRefName(root, 1),
        commit: commits[0],
        createdAt: expect.any(Number),
      },
      {
        worktreeId: id,
        seq: 2,
        ref: checkpointRefName(root, 2),
        commit: commits[1],
        createdAt: expect.any(Number),
      },
      {
        worktreeId: id,
        seq: 3,
        ref: checkpointRefName(root, 3),
        commit: commits[2],
        createdAt: expect.any(Number),
      },
    ]);
    expect(await listCheckpointRefs(root, id)).toEqual(listed);
    expect(await listCheckpointRefs(root, 'nobody')).toEqual([]);
    mkdirSync(join(root, 'elsewhere'));
    expect(await listCheckpointRefs(join(root, 'elsewhere'))).toEqual(listed);

    const usage = await checkpointDiskUsage(root);
    expect(usage === null || usage > 0).toBe(true);

    expect(
      await deleteCheckpointRefs(root, [
        checkpointRefName(root, 1),
        checkpointRefName(root, 3),
        checkpointRefName(root, 9),
        'refs/heads/main',
      ]),
    ).toBe(2);
    expect((await listCheckpointRefs(root)).map((r) => r.seq)).toEqual([2]);
    expect(git(root, 'rev-parse', 'refs/heads/main').trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(await deleteCheckpointRefs(root, [checkpointRefName(root, 1)])).toBe(0);
    expect(await deleteCheckpointRefs(root, [])).toBe(0);
  });

  it('dates a ref by when it was written, not by the fixed date of its commit', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    const started = Date.now();
    const r = await captureCheckpoint({
      worktree: root,
      indexFile: join(tempDir(), 'index'),
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    expect(git(root, 'show', '-s', '--format=%ct', r.commit as string).trim()).toBe('946684800');
    const [loose] = await listCheckpointRefs(root);
    // File times can be a little coarser than the clock.
    expect(loose?.createdAt).toBeGreaterThanOrEqual(started - 2000);
    expect(loose?.createdAt).toBeLessThanOrEqual(Date.now() + 2000);
    // Once git packs the ref its own file is gone; the packed file is never older than the ref.
    git(root, 'pack-refs', '--all');
    const [packed] = await listCheckpointRefs(root);
    expect(packed?.commit).toBe(r.commit);
    expect(packed?.createdAt).toBeGreaterThanOrEqual(started - 2000);
  });

  const reftable = reftableRepo();
  it.skipIf(reftable === null)('dates a ref kept in a reftable by its table list', async () => {
    const root = reftable as string;
    const started = Date.now();
    await captureCheckpoint({
      worktree: root,
      indexFile: join(tempDir(), 'index'),
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'step 1',
    });
    const [ref] = await listCheckpointRefs(root);
    expect(ref?.createdAt).toBeGreaterThanOrEqual(started - 2000);
  });

  it('reports only remotes configured as mirrors', async () => {
    const root = makeRepo();
    expect(await mirrorRemotes(root)).toEqual([]);
    git(root, 'remote', 'add', 'origin', '/nonexistent/origin.git');
    git(root, 'remote', 'add', 'backup', '/nonexistent/backup.git');
    git(root, 'remote', 'add', 'off', '/nonexistent/off.git');
    git(root, 'config', 'remote.backup.mirror', 'true');
    git(root, 'config', 'remote.off.mirror', 'false');
    expect(await mirrorRemotes(root)).toEqual(['backup']);
  });
});

describe('tryLockCheckpoint', () => {
  it('is exclusive until released and replaces a stale lock', () => {
    const lockFile = join(tempDir(), 'locks', 'wt.lock');
    const held = tryLockCheckpoint(lockFile);
    expect(held).not.toBeNull();
    expect(readFileSync(lockFile, 'utf8')).toBe(String(process.pid));
    expect(tryLockCheckpoint(lockFile)).toBeNull();
    held?.release();
    const again = tryLockCheckpoint(lockFile);
    expect(again).not.toBeNull();
    again?.release();
    again?.release();

    const stale = tryLockCheckpoint(lockFile);
    expect(stale).not.toBeNull();
    const past = (Date.now() - STALE_LOCK_MS - 60_000) / 1000;
    utimesSync(lockFile, past, past);
    const replaced = tryLockCheckpoint(lockFile);
    expect(replaced).not.toBeNull();
    expect(statSync(lockFile).mtimeMs).toBeGreaterThan(Date.now() - STALE_LOCK_MS);
    expect(tryLockCheckpoint(lockFile)).toBeNull();
    replaced?.release();
  });
});
