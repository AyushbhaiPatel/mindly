import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SynapseError } from '@synapse/core';
import { commitTree } from './capture.js';
import { driverOverrides, gitVersion, runGit, versionAtLeast } from './exec.js';
import type { GitVersion } from './exec.js';
import { assertValidRevision } from './refs.js';
import { findRepoRoot, resolveCommit } from './repo.js';

/** One side of a shadow merge (usually one agent's captured work). */
export interface MergeSide {
  /** Human label for the side (e.g. a session id); 1-128 printable characters. */
  label: string;
  /** Commit id or ref name of the side's work (e.g. from `captureWorktreeCommit`). */
  commit: string;
}

/** Input for `shadowMerge`. */
export interface ShadowMergeInput {
  repoRoot: string;
  /** Explicit merge base for every step (requires git >= 2.40). Default: computed from history. */
  base?: string;
  /** Sides merged in order; at least one. */
  sides: readonly MergeSide[];
  /** Timeout per git step in milliseconds (default 120 s). */
  timeoutMs?: number;
}

/** Result of merging one side into the accumulated tree. */
export interface MergeStep {
  label: string;
  /** Resolved commit id of the side. */
  commit: string;
  status: 'clean' | 'conflicted';
  /** Paths with conflicts (empty when clean). */
  conflicts: string[];
  /** Tree produced by this step (contains conflict markers when conflicted). */
  tree: string;
}

/** Result of `shadowMerge`; `supported: false` when the installed git is too old. */
export type ShadowMergeResult =
  | {
      supported: true;
      /** True when every side merged cleanly. */
      clean: boolean;
      /** One entry per side after the first. */
      steps: MergeStep[];
      /** Labels whose work is included in the final tree. */
      merged: string[];
      /** Labels skipped because merging them conflicted. */
      skipped: string[];
      /** Final merged tree id (all cleanly merging sides). */
      tree: string;
      /** Synthetic commit wrapping `tree` (parents: the merged sides), usable with `materializeTree`. */
      commit: string;
    }
  | { supported: false; reason: string; gitVersion: string };

/** Minimum git version for `merge-tree --write-tree`. */
export const MIN_MERGE_TREE_VERSION = { major: 2, minor: 38 } as const;

const LABEL_RE = /^[\x21-\x7E][\x20-\x7E]{0,127}$/;

/** Parses `git merge-tree --write-tree --name-only -z` output. */
export function parseMergeTreeOutput(output: string): { tree: string; conflicts: string[] } {
  const fields = output.split('\0');
  const tree = (fields[0] ?? '').trim();
  const conflicts: string[] = [];
  for (let i = 1; i < fields.length; i++) {
    const f = fields[i] ?? '';
    if (f === '') break;
    conflicts.push(f);
  }
  return { tree, conflicts: [...new Set(conflicts)] };
}

/**
 * Merges every side's commit in memory with `git merge-tree --write-tree` (never touching any
 * working tree, index or branch) and returns per-step results and the final tree.
 *
 * Sides are merged sequentially into an accumulator that starts with the first side. A side whose
 * merge conflicts is reported (with its conflicted paths) and left out, so the final tree holds
 * every side that merged cleanly. Returns `{ supported: false }` on git older than 2.38 (or older
 * than 2.40 when an explicit `base` is given). Repository-defined merge drivers are disabled.
 */
export async function shadowMerge(input: ShadowMergeInput): Promise<ShadowMergeResult> {
  const version: GitVersion = await gitVersion();
  if (!versionAtLeast(version, MIN_MERGE_TREE_VERSION.major, MIN_MERGE_TREE_VERSION.minor)) {
    return { supported: false, reason: 'git >= 2.38 is required', gitVersion: version.raw };
  }
  if (input.base !== undefined && !versionAtLeast(version, 2, 40)) {
    return {
      supported: false,
      reason: 'git >= 2.40 is required for an explicit merge base',
      gitVersion: version.raw,
    };
  }
  if (!Array.isArray(input.sides) || input.sides.length === 0 || input.sides.length > 64) {
    throw new SynapseError('invalid_input', 'shadow merge needs between 1 and 64 sides');
  }
  for (const side of input.sides) {
    if (typeof side.label !== 'string' || !LABEL_RE.test(side.label)) {
      throw new SynapseError('invalid_input', 'invalid merge side label');
    }
    assertValidRevision(side.commit);
  }
  const root = await findRepoRoot(input.repoRoot);
  const timeoutMs = input.timeoutMs ?? 120_000;

  const resolveOrThrow = async (rev: string): Promise<string> => {
    const id = await resolveCommit(root, rev);
    if (!id) throw new SynapseError('not_found', 'merge commit not found');
    return id;
  };
  let base: string | null = null;
  if (input.base !== undefined) {
    assertValidRevision(input.base);
    base = await resolveOrThrow(input.base);
  }
  const commits: string[] = [];
  for (const side of input.sides) commits.push(await resolveOrThrow(side.commit));

  const overrides = await driverOverrides(root);
  const first = input.sides[0] as MergeSide;
  let acc = commits[0] as string;
  let accTree = (
    await runGit(['rev-parse', '--verify', `${acc}^{tree}`], { cwd: root })
  ).stdout.trim();
  const merged = [first.label];
  const skipped: string[] = [];
  const steps: MergeStep[] = [];

  for (let i = 1; i < input.sides.length; i++) {
    const side = input.sides[i] as MergeSide;
    const commit = commits[i] as string;
    const args = ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages'];
    if (base) args.push(`--merge-base=${base}`);
    args.push(acc, commit);
    const res = await runGit(args, {
      cwd: root,
      config: overrides,
      timeoutMs,
      okExitCodes: [1],
    });
    const parsed = parseMergeTreeOutput(res.stdout);
    if (!/^[0-9a-f]{40,64}$/.test(parsed.tree)) {
      throw new SynapseError('internal', 'unexpected merge-tree output');
    }
    const conflicted = res.exitCode === 1;
    steps.push({
      label: side.label,
      commit,
      status: conflicted ? 'conflicted' : 'clean',
      conflicts: conflicted ? parsed.conflicts : [],
      tree: parsed.tree,
    });
    if (conflicted) {
      skipped.push(side.label);
      continue;
    }
    merged.push(side.label);
    accTree = parsed.tree;
    acc = await commitTree(root, accTree, [acc, commit], `synapse shadow merge: ${side.label}`);
  }

  // Wrap the final tree so callers always get a commit, even for a single side.
  const commit =
    merged.length === 1 ? acc : await commitTree(root, accTree, [acc], 'synapse shadow merge');
  return {
    supported: true,
    clean: skipped.length === 0,
    steps,
    merged,
    skipped,
    tree: accTree,
    commit,
  };
}

/** A temporary detached worktree created by `materializeTree`. */
export interface MaterializedTree {
  /** Absolute path of the temporary detached worktree. */
  path: string;
  /** Commit checked out in it. */
  commit: string;
  /** Removes the worktree and its administrative files. Safe to call more than once. */
  dispose(): Promise<void>;
}

/**
 * Checks out a tree or commit into a new detached worktree inside a private temp directory, so
 * checks can run against it. Never creates or moves a branch; hooks, filters from repository
 * config and LFS downloads are disabled. Always call `dispose()` when done.
 */
export async function materializeTree(
  repoRoot: string,
  treeOrCommit: string,
  options: { timeoutMs?: number } = {},
): Promise<MaterializedTree> {
  assertValidRevision(treeOrCommit);
  const root = await findRepoRoot(repoRoot);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const typeRes = await runGit(['cat-file', '-t', '--end-of-options', treeOrCommit], {
    cwd: root,
    okExitCodes: [1, 128],
  });
  const type = typeRes.stdout.trim();
  let commit: string;
  if (typeRes.exitCode === 0 && type === 'tree') {
    const tree = (
      await runGit(['rev-parse', '--verify', `${treeOrCommit}^{tree}`], { cwd: root })
    ).stdout.trim();
    commit = await commitTree(root, tree, [], 'synapse materialized tree');
  } else {
    const resolved = await resolveCommit(root, treeOrCommit);
    if (!resolved) throw new SynapseError('not_found', 'tree or commit not found');
    commit = resolved;
  }

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'synapse-tree-')));
  const path = join(tmp, 'tree');
  const overrides = await driverOverrides(root);
  try {
    await runGit(['worktree', 'add', '--detach', '--quiet', path, commit], {
      cwd: root,
      config: overrides,
      timeoutMs,
    });
  } catch (err) {
    await removeWorktree(root, path, tmp);
    throw err;
  }

  let disposed = false;
  return {
    path,
    commit,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await removeWorktree(root, path, tmp);
    },
  };
}

async function removeWorktree(root: string, path: string, tmp: string): Promise<void> {
  await runGit(['worktree', 'remove', '--force', '--force', path], {
    cwd: root,
    okExitCodes: [128],
  }).catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
  // Drops the administrative entry if `remove` could not (e.g. the directory was already gone).
  await runGit(['worktree', 'prune'], { cwd: root }).catch(() => undefined);
}
