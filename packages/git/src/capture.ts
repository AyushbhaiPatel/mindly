import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { MindlyError, isDeniedPath } from '@mindly/core';
import { driverOverrides, runGit } from './exec.js';
import { findRepoRoot, headCommit } from './repo.js';

/** Identity used for every synthetic commit Mindly creates. */
export const SYNTHETIC_IDENTITY = {
  name: 'Mindly',
  email: 'mindly@localhost.invalid',
  /** Fixed date (git internal format) so identical trees produce identical commit ids. */
  date: '946684800 +0000',
} as const;

/** Environment that makes `commit-tree` use the fixed synthetic author and committer. */
export function syntheticIdentityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: SYNTHETIC_IDENTITY.name,
    GIT_AUTHOR_EMAIL: SYNTHETIC_IDENTITY.email,
    GIT_AUTHOR_DATE: SYNTHETIC_IDENTITY.date,
    GIT_COMMITTER_NAME: SYNTHETIC_IDENTITY.name,
    GIT_COMMITTER_EMAIL: SYNTHETIC_IDENTITY.email,
    GIT_COMMITTER_DATE: SYNTHETIC_IDENTITY.date,
  };
}

/**
 * Creates a commit object for `tree` with the synthetic identity, never signing it and never
 * updating any ref.
 */
export async function commitTree(
  cwd: string,
  tree: string,
  parents: readonly string[],
  message: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  for (const id of [tree, ...parents]) {
    if (!/^[0-9a-f]{40,64}$/.test(id)) throw new MindlyError('invalid_input', 'invalid object id');
  }
  const args = ['commit-tree', '--no-gpg-sign'];
  for (const p of parents) args.push('-p', p);
  args.push('-F', '-', tree);
  const res = await runGit(args, {
    cwd,
    env: syntheticIdentityEnv(),
    input: message.replace(/\0/g, '').slice(0, 2000) || 'mindly',
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return res.stdout.trim();
}

/**
 * Copies the real index to a private file, keeping its timestamps. Git decides whether an entry
 * may be trusted from its stat cache by comparing the entry's mtime with the index file's mtime
 * (the "racily clean" check); a copy with a fresh mtime would make git keep a stale blob for a
 * file rewritten with the same size within the same second as the last `git add`.
 */
export function copyIndex(realIndex: string, target: string): void {
  const st = statSync(realIndex);
  copyFileSync(realIndex, target);
  utimesSync(target, st.atime, st.mtime);
}

/** Options for `captureWorktreeCommit`. */
export interface CaptureOptions {
  /** Commit message (default `mindly capture`). */
  message?: string;
  /** Extra deny globs on top of the core deny-list; matching paths are left out of the capture. */
  extraDeny?: readonly string[];
  /** Timeout for each git step in milliseconds (default 120 s). */
  timeoutMs?: number;
}

/** Result of `captureWorktreeCommit`. */
export interface CapturedCommit {
  /** Synthetic commit id representing the working tree. */
  commit: string;
  /** Tree id of that commit. */
  tree: string;
  /** HEAD commit used as the parent, or null for an unborn branch. */
  parent: string | null;
  /** Repository-relative paths that were changed but left out because they are denied. */
  skipped: string[];
  /**
   * New nested repositories (untracked folders git does not descend into), left out of the
   * tree: recording one would point at a commit only it holds, or fail when it has none.
   */
  nested: string[];
}

/**
 * Captures tracked and untracked (non-ignored) files of the working tree containing `worktree`
 * as a commit object, without modifying the working tree, the real index or any ref.
 *
 * Works on a private copy of the index (`GIT_INDEX_FILE` in a 0700 temp dir), stages changes
 * there, then `write-tree` + `commit-tree` with a fixed synthetic identity. New blobs are written
 * to the object database (they are unreferenced unless the caller stores a ref to the commit and
 * are eventually garbage collected). Changed paths on the secret deny-list keep their HEAD content
 * (or are absent if untracked) and are reported in `skipped`.
 */
export async function captureWorktreeCommit(
  worktree: string,
  options: CaptureOptions = {},
): Promise<CapturedCommit> {
  const root = await findRepoRoot(worktree);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const parent = await headCommit(root);
  const overrides = await driverOverrides(root);
  const indexPath = (
    await runGit(['rev-parse', '--git-path', 'index'], { cwd: root })
  ).stdout.trim();
  const realIndex = isAbsolute(indexPath) ? indexPath : resolve(root, indexPath);

  const tmp = mkdtempSync(join(tmpdir(), 'mindly-capture-'));
  try {
    const tmpIndex = join(tmp, 'index');
    const env = { GIT_INDEX_FILE: tmpIndex };
    const common = { cwd: root, env, config: overrides, timeoutMs };
    // Seed from the real index (keeps its stat cache so only changed files are re-hashed). The
    // real index is only read. Fall back to HEAD's tree if it cannot be copied.
    let seeded = false;
    if (existsSync(realIndex)) {
      try {
        copyIndex(realIndex, tmpIndex);
        seeded = true;
      } catch {
        seeded = false;
      }
    }
    if (!seeded && parent) await runGit(['read-tree', parent], common);

    const split = (out: string): string[] => out.split('\0').filter((p) => p !== '');
    // A file only touched (same content, new time) is not a change: refresh the copy's stat
    // cache first, or it would be reported (and, if deny-listed, counted as skipped).
    await runGit(['update-index', '-q', '--refresh'], { ...common, okExitCodes: [1] });
    // Worktree vs index (modified/deleted tracked files) and new untracked files.
    const unstaged = split(
      (await runGit(['diff-files', '--name-only', '-z', '--ignore-submodules=dirty'], common))
        .stdout,
    );
    const untracked = new Set(
      split((await runGit(['ls-files', '-z', '--others', '--exclude-standard'], common)).stdout),
    );
    // Index vs HEAD (changes the user already staged), only needed for the deny-list check.
    const staged = parent
      ? split(
          (
            await runGit(
              ['diff-index', '--cached', '--name-only', '-z', '--ignore-submodules=dirty', parent],
              common,
            )
          ).stdout,
        )
      : split((await runGit(['ls-files', '-z', '--cached'], common)).stdout);

    const extraDeny = options.extraDeny ?? [];
    const skipped = new Set<string>();
    const nested = new Set<string>();
    const toAdd: string[] = [];
    for (const p of new Set([...unstaged, ...untracked])) {
      // A new nested repository, listed as its folder: left out (see `nested`).
      if (p.endsWith('/')) {
        nested.add(p.slice(0, -1));
        continue;
      }
      if (isDeniedPath(p, extraDeny)) skipped.add(p);
      else toAdd.push(p);
    }
    // Denied paths present in the index with non-HEAD content are restored to HEAD (or removed).
    const deniedInIndex = [...new Set([...unstaged, ...staged])].filter((p) =>
      isDeniedPath(p, extraDeny),
    );
    for (const p of deniedInIndex) skipped.add(p);
    if (deniedInIndex.length > 0) {
      const input = `${deniedInIndex.join('\0')}\0`;
      if (parent) {
        await runGit(['reset', '-q', parent, '--pathspec-from-file=-', '--pathspec-file-nul'], {
          ...common,
          input,
          okExitCodes: [1],
        });
      } else {
        await runGit(['update-index', '--force-remove', '-z', '--stdin'], { ...common, input });
      }
    }
    if (toAdd.length > 0) {
      await runGit(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        ...common,
        input: `${toAdd.join('\0')}\0`,
      });
    }
    const tree = (await runGit(['write-tree'], common)).stdout.trim();
    const commit = await commitTree(
      root,
      tree,
      parent ? [parent] : [],
      options.message ?? 'mindly capture',
    );
    return { commit, tree, parent, skipped: [...skipped].sort(), nested: [...nested].sort() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
