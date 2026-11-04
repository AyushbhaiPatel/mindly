import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSynapseError } from '@synapse/core';
import {
  captureWorktreeCommit,
  changedFiles,
  createSnapshotRef,
  deleteSnapshotRef,
  diffForFile,
  listSnapshotRefs,
  materializeTree,
  restoreSnapshotToBranch,
  shadowMerge,
} from '../src/index.js';
import { commitAll, git, makeRepo, tempDir, write } from './helpers.js';

describe('snapshots', () => {
  it('creates, lists and restores a snapshot to a new branch only', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    write(root, 'a.txt', 'work in progress\n');
    write(root, 'new.txt', 'untracked\n');
    const statusBefore = git(root, 'status', '--porcelain');

    const snap = await createSnapshotRef(root, root, 'snap-1');
    expect(snap.ref).toBe('refs/synapse/snapshots/snap-1');
    expect(git(root, 'rev-parse', snap.ref).trim()).toBe(snap.commit);
    expect(git(root, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(root, 'branch', '--list').trim()).toBe('* main');

    await expect(createSnapshotRef(root, root, 'snap-1')).rejects.toSatisfy((e: unknown) =>
      isSynapseError(e, 'conflict'),
    );
    await createSnapshotRef(root, root, 'snap-0');
    expect((await listSnapshotRefs(root)).map((s) => s.id)).toEqual(['snap-0', 'snap-1']);

    const restored = await restoreSnapshotToBranch(root, 'snap-1', 'restore/snap-1');
    expect(restored.commit).toBe(snap.commit);
    expect(git(root, 'rev-parse', 'refs/heads/restore/snap-1').trim()).toBe(snap.commit);
    expect(git(root, 'show', 'restore/snap-1:new.txt')).toBe('untracked\n');
    expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('work in progress\n');
    expect(git(root, 'status', '--porcelain')).toBe(statusBefore);

    expect(await deleteSnapshotRef(root, 'snap-0')).toBe(true);
    expect(await deleteSnapshotRef(root, 'snap-0')).toBe(false);
  });

  it('refuses to overwrite an existing branch and validates names', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    const mainBefore = git(root, 'rev-parse', 'main').trim();
    write(root, 'a.txt', 'changed\n');
    await createSnapshotRef(root, root, 's1');
    await expect(restoreSnapshotToBranch(root, 's1', 'main')).rejects.toSatisfy((e: unknown) =>
      isSynapseError(e, 'conflict'),
    );
    expect(git(root, 'rev-parse', 'main').trim()).toBe(mainBefore);
    await expect(restoreSnapshotToBranch(root, 's1', '-f')).rejects.toSatisfy((e: unknown) =>
      isSynapseError(e, 'invalid_input'),
    );
    await expect(restoreSnapshotToBranch(root, 's1', 'a..b')).rejects.toSatisfy((e: unknown) =>
      isSynapseError(e, 'invalid_input'),
    );
    await expect(restoreSnapshotToBranch(root, 'missing', 'x')).rejects.toSatisfy((e: unknown) =>
      isSynapseError(e, 'not_found'),
    );
    await expect(createSnapshotRef(root, root, '../escape')).rejects.toSatisfy((e: unknown) =>
      isSynapseError(e, 'invalid_input'),
    );
    const other = makeRepo();
    await expect(createSnapshotRef(root, other, 'foreign')).rejects.toSatisfy((e: unknown) =>
      isSynapseError(e, 'invalid_input'),
    );
  });
});

describe.skipIf(process.platform === 'win32')('hostile repository configuration', () => {
  it('never runs hooks, fsmonitor, filter or merge drivers during internal operations', async () => {
    const root = makeRepo({
      'f.txt': 'base\n',
      '.gitattributes': '*.txt merge=evil filter=evil\n',
    });
    git(root, 'checkout', '-q', '-b', 'other');
    write(root, 'f.txt', 'other\n');
    commitAll(root, 'other');
    git(root, 'checkout', '-q', 'main');
    write(root, 'f.txt', 'main\n');
    commitAll(root, 'main change');

    const marker = join(tempDir(), 'pwned');
    const script = `#!/bin/sh\ntouch '${marker}'\ncat\n`;
    const hooksDir = join(root, 'evil-hooks');
    for (const hook of [
      'post-checkout',
      'reference-transaction',
      'pre-commit',
      'post-commit',
      'post-index-change',
      'pre-auto-gc',
    ]) {
      write(hooksDir, hook, script);
      chmodSync(join(hooksDir, hook), 0o755);
      write(join(root, '.git', 'hooks'), hook, script);
      chmodSync(join(root, '.git', 'hooks', hook), 0o755);
    }
    write(root, 'evil-fsmonitor.sh', script);
    chmodSync(join(root, 'evil-fsmonitor.sh'), 0o755);
    git(root, 'config', 'core.hooksPath', hooksDir);
    git(root, 'config', 'core.fsmonitor', join(root, 'evil-fsmonitor.sh'));
    git(root, 'config', 'filter.evil.clean', `sh -c "touch '${marker}'; cat"`);
    git(root, 'config', 'filter.evil.smudge', `sh -c "touch '${marker}'; cat"`);
    git(root, 'config', 'filter.evil.required', 'true');
    git(root, 'config', 'merge.evil.driver', `touch '${marker}'`);
    git(root, 'config', 'diff.evil.textconv', `sh -c "touch '${marker}'; cat"`);
    write(root, 'f.txt', 'dirty\n');
    write(root, 'untracked.txt', 'new\n');

    const captured = await captureWorktreeCommit(root);
    await changedFiles(root);
    await diffForFile(root, 'f.txt');
    await createSnapshotRef(root, root, 'evil-test');
    await restoreSnapshotToBranch(root, 'evil-test', 'restored-evil');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const otherHead = git(root, 'rev-parse', 'other').trim();
    const merged = await shadowMerge({
      repoRoot: root,
      sides: [
        { label: 'main', commit: head },
        { label: 'other', commit: otherHead },
      ],
    });
    expect(merged.supported && merged.steps[0]?.status).toBe('conflicted');
    const mat = await materializeTree(root, captured.commit);
    expect(readFileSync(join(mat.path, 'f.txt'), 'utf8')).toBe('dirty\n');
    await mat.dispose();

    expect(existsSync(marker)).toBe(false);

    // Positive control: plain git in the same repository does run the hook.
    git(root, 'update-ref', 'refs/control', 'HEAD');
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
  });
});
