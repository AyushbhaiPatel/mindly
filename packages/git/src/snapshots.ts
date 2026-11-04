import { SynapseError } from '@synapse/core';
import { captureWorktreeCommit } from './capture.js';
import type { CaptureOptions } from './capture.js';
import { runGit } from './exec.js';
import { assertValidBranchName, assertValidSnapshotId } from './refs.js';
import { findRepoRoot, gitCommonDir, resolveCommit } from './repo.js';

/** Namespace holding snapshot refs. Hidden from `git branch` and not fetched or pushed by default. */
export const SNAPSHOT_REF_PREFIX = 'refs/synapse/snapshots/';

/** A snapshot stored under `refs/synapse/snapshots/`. */
export interface SnapshotRef {
  id: string;
  /** Full ref name, e.g. `refs/synapse/snapshots/<id>`. */
  ref: string;
  commit: string;
}

/** Result of `createSnapshotRef`. */
export interface CreatedSnapshot extends SnapshotRef {
  tree: string;
  /** HEAD of the captured worktree at capture time (null for an unborn branch). */
  parent: string | null;
  /** Changed paths left out because they are on the secret deny-list. */
  skipped: string[];
}

/** Ref name for a snapshot id (validated). */
export function snapshotRefName(id: string): string {
  assertValidSnapshotId(id);
  return `${SNAPSHOT_REF_PREFIX}${id}`;
}

/** Creates `ref` pointing at `commit`, failing with `conflict` if the ref already exists. */
async function createRefExclusive(cwd: string, ref: string, commit: string, why: string) {
  const res = await runGit(['update-ref', '--stdin', '-m', why], {
    cwd,
    input: `create ${ref} ${commit}\n`,
    okExitCodes: [128],
  });
  if (res.exitCode !== 0) {
    throw new SynapseError('conflict', 'reference already exists or could not be created');
  }
}

/**
 * Captures the working tree containing `worktree` (tracked + untracked, see
 * `captureWorktreeCommit`) and stores it under `refs/synapse/snapshots/<id>`. Never touches the
 * working tree, index or branches. `worktree` must belong to the repository at `repoRoot`. Throws
 * `conflict` if a snapshot with that id already exists.
 */
export async function createSnapshotRef(
  repoRoot: string,
  worktree: string,
  id: string,
  options: CaptureOptions = {},
): Promise<CreatedSnapshot> {
  const ref = snapshotRefName(id);
  const root = await findRepoRoot(repoRoot);
  const [rootCommon, wtCommon] = await Promise.all([gitCommonDir(root), gitCommonDir(worktree)]);
  if (rootCommon !== wtCommon) {
    throw new SynapseError('invalid_input', 'worktree does not belong to this repository');
  }
  const captured = await captureWorktreeCommit(worktree, {
    message: `synapse snapshot ${id}`,
    ...options,
  });
  await createRefExclusive(root, ref, captured.commit, `synapse snapshot ${id}`);
  return {
    id,
    ref,
    commit: captured.commit,
    tree: captured.tree,
    parent: captured.parent,
    skipped: captured.skipped,
  };
}

/** Lists every snapshot ref of the repository, sorted by id. */
export async function listSnapshotRefs(repoRoot: string): Promise<SnapshotRef[]> {
  const root = await findRepoRoot(repoRoot);
  const res = await runGit(
    ['for-each-ref', '--format=%(refname)%00%(objectname)', SNAPSHOT_REF_PREFIX],
    { cwd: root },
  );
  const out: SnapshotRef[] = [];
  for (const line of res.stdout.split('\n')) {
    if (line === '') continue;
    const [ref, commit] = line.split('\0');
    if (!ref || !commit || !ref.startsWith(SNAPSHOT_REF_PREFIX)) continue;
    out.push({ id: ref.slice(SNAPSHOT_REF_PREFIX.length), ref, commit });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Resolves a snapshot id to its commit, or null when it does not exist. */
export async function snapshotCommit(repoRoot: string, id: string): Promise<string | null> {
  const ref = snapshotRefName(id);
  const root = await findRepoRoot(repoRoot);
  return resolveCommit(root, ref);
}

/**
 * Creates a NEW branch `branchName` pointing at the snapshot's commit. Never overwrites an existing
 * branch (throws `conflict`), never checks anything out and never touches the working tree.
 */
export async function restoreSnapshotToBranch(
  repoRoot: string,
  id: string,
  branchName: string,
): Promise<{ branch: string; ref: string; commit: string }> {
  assertValidBranchName(branchName);
  const root = await findRepoRoot(repoRoot);
  const commit = await snapshotCommit(root, id);
  if (!commit) throw new SynapseError('not_found', 'snapshot not found', { details: { id } });
  const ref = `refs/heads/${branchName}`;
  if (await resolveCommit(root, ref)) {
    throw new SynapseError('conflict', 'branch already exists', {
      details: { branch: branchName },
    });
  }
  await createRefExclusive(root, ref, commit, `synapse restore snapshot ${id}`);
  return { branch: branchName, ref, commit };
}

/** Deletes a snapshot ref (the commit stays until git garbage-collects it). Returns false if absent. */
export async function deleteSnapshotRef(repoRoot: string, id: string): Promise<boolean> {
  const ref = snapshotRefName(id);
  const root = await findRepoRoot(repoRoot);
  const commit = await resolveCommit(root, ref);
  if (!commit) return false;
  await runGit(['update-ref', '-d', ref, commit], { cwd: root });
  return true;
}
