import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MindlyError, isDeniedPath, sha256 } from '@mindly/core';
import { commitTree, copyIndex } from './capture.js';
import { driverOverrides, runGit } from './exec.js';
import { assertSafeRelativePath } from './refs.js';
import { findRepoRoot, gitCommonDir, headCommit } from './repo.js';

/*
 * Checkpoints: a commit object holding the whole working tree as it was after one agent edit,
 * stored under a hidden ref. The user's index, HEAD, branches, stash and files are never touched:
 * every git call works on a private index file the caller keeps outside the repository. Git
 * deduplicates content, so unchanged files cost nothing. Checkpoint commits have no parent: the
 * previous step is kept by the caller, so deleting a ref really frees the step (after git gc).
 */

/** Namespace holding checkpoint refs: `refs/mindly/steps/<worktree id>/<seq>`. */
export const CHECKPOINT_REF_PREFIX = 'refs/mindly/steps/';
/** Wall-clock limit for each git call while taking a checkpoint (hooks must stay fast). */
export const CHECKPOINT_GIT_TIMEOUT_MS = 2000;
/** Most changed paths reported for one checkpoint. */
const MAX_CHANGED_PATHS = 50;
/** Repository config (merge/diff/filter drivers) is re-read after this long. */
const OVERRIDES_TTL_MS = 60_000;

/** Stable id of a working tree (from its canonical path), safe inside a ref name. */
export function worktreeId(worktree: string): string {
  return sha256(worktree).slice(0, 16);
}

/** Ref name of step `seq` of `worktree`. */
export function checkpointRefName(worktree: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new MindlyError('invalid_input', 'invalid checkpoint step');
  }
  return `${CHECKPOINT_REF_PREFIX}${worktreeId(worktree)}/${seq}`;
}

/** Input of `captureCheckpoint`. */
export interface CheckpointCaptureInput {
  /** A directory inside the working tree to capture (its top level is used). */
  worktree: string;
  /** Private index file for this working tree, absolute and outside the repository. */
  indexFile: string;
  /** The previous checkpoint of the working tree, whose tree the new one is compared with. */
  parent: { commit: string } | null;
  /**
   * Working-tree-relative paths an edit tool touched: only they are refreshed in the index. Null
   * rescans the whole tree (modified, deleted and untracked files).
   */
  paths: readonly string[] | null;
  /** Create the commit even when the tree equals the parent's. */
  always: boolean;
  /** Ref to create for the new commit; must not exist yet. */
  ref: string;
  message: string;
  /** Extra deny globs on top of the core deny-list; matching paths keep their HEAD content. */
  extraDeny?: readonly string[];
  /** Timeout for each git call (default 2 s). */
  timeoutMs?: number;
}

/** Result of `captureCheckpoint`. */
export interface CheckpointCaptureResult {
  /** The new commit, or null when nothing changed and `always` was false (no ref created). */
  commit: string | null;
  tree: string;
  /** Whether the tree differs from the parent's (always true without a parent). */
  changed: boolean;
  /** Paths that differ from the parent (a rescan), or the paths refreshed (an edit); capped. */
  changedPaths: string[];
  /** Paths left out because they are on the deny-list. */
  skipped: string[];
  /** True when the private index did not exist, so the whole tree was scanned. */
  fresh: boolean;
}

const overridesCache = new Map<string, { at: number; value: Promise<string[]> }>();

function cachedOverrides(root: string): Promise<string[]> {
  const hit = overridesCache.get(root);
  if (hit && Date.now() - hit.at < OVERRIDES_TTL_MS) return hit.value;
  const value = driverOverrides(root).catch((err: unknown) => {
    overridesCache.delete(root);
    throw err;
  });
  overridesCache.set(root, { at: Date.now(), value });
  return value;
}

function splitNul(out: string): string[] {
  return out.split('\0').filter((p) => p !== '');
}

/**
 * True when something is at `path`, a symlink whose target is missing included (`existsSync`
 * follows links, so it would report such a link as deleted).
 */
export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertIndexFile(indexFile: string, root: string): void {
  if (typeof indexFile !== 'string' || !isAbsolute(indexFile) || indexFile.includes('\0')) {
    throw new MindlyError('invalid_input', 'checkpoint index file must be an absolute path');
  }
  const target = resolve(indexFile);
  if (target === root || target.startsWith(`${root}/`)) {
    throw new MindlyError('invalid_input', 'checkpoint index file must be outside the repository');
  }
}

type GitCommon = { cwd: string; env: Record<string, string>; config: string[]; timeoutMs: number };

/**
 * Resets every denied path the index holds with content other than HEAD's back to HEAD (or
 * removes it when HEAD has none), so a secret staged by the user, or a file denied since it was
 * captured, never reaches a checkpoint tree. Returns the paths it touched.
 */
async function dropDeniedEntries(
  common: GitCommon,
  head: string | null,
  extraDeny: readonly string[],
): Promise<string[]> {
  const staged = head
    ? splitNul(
        (
          await runGit(
            ['diff-index', '--cached', '--name-only', '-z', '--ignore-submodules=dirty', head],
            common,
          )
        ).stdout,
      )
    : splitNul((await runGit(['ls-files', '-z', '--cached'], common)).stdout);
  const denied = staged.filter((p) => isDeniedPath(p, extraDeny));
  if (denied.length === 0) return [];
  const input = `${denied.join('\0')}\0`;
  if (head) {
    await runGit(['reset', '-q', head, '--pathspec-from-file=-', '--pathspec-file-nul'], {
      ...common,
      input,
      okExitCodes: [1],
    });
  } else {
    await runGit(['update-index', '--force-remove', '-z', '--stdin'], { ...common, input });
  }
  return denied;
}

/**
 * Seeds a new private index from the real index (read only, keeps its stat cache) or from HEAD.
 * The seed is built in a temporary file and moved into place only once every denied path has
 * been reset to HEAD, so an interrupted seeding leaves no index holding a staged secret.
 */
async function seedIndex(
  root: string,
  indexFile: string,
  common: GitCommon,
  head: string | null,
  extraDeny: readonly string[],
): Promise<string[]> {
  mkdirSync(dirname(indexFile), { recursive: true, mode: 0o700 });
  const seed = `${indexFile}.seed`;
  rmSync(seed, { force: true });
  const seeding = { ...common, env: { GIT_INDEX_FILE: seed } };
  try {
    const indexPath = (
      await runGit(['rev-parse', '--git-path', 'index'], { cwd: root, timeoutMs: common.timeoutMs })
    ).stdout.trim();
    const realIndex = isAbsolute(indexPath) ? indexPath : resolve(root, indexPath);
    let seeded = false;
    if (existsSync(realIndex)) {
      try {
        copyIndex(realIndex, seed);
        seeded = true;
      } catch {
        seeded = false;
      }
    }
    let denied: string[] = [];
    if (seeded) denied = await dropDeniedEntries(seeding, head, extraDeny);
    else await runGit(head ? ['read-tree', head] : ['read-tree', '--empty'], seeding);
    renameSync(seed, indexFile);
    return denied;
  } catch (err) {
    rmSync(seed, { force: true });
    throw err;
  }
}

/**
 * Records the working tree containing `worktree` as a parentless commit, using a private index
 * file so the real index, HEAD, branches and files stay untouched. With `paths`, only those
 * entries are refreshed from disk (fast: an edit tool's own files); without, the whole tree is
 * rescanned. Denied paths (`.env`, keys, credentials) keep the content HEAD has and are never
 * stored. Every git call has a short timeout; any failure throws and the caller skips the
 * checkpoint.
 */
export async function captureCheckpoint(
  input: CheckpointCaptureInput,
): Promise<CheckpointCaptureResult> {
  const root = await findRepoRoot(input.worktree);
  assertIndexFile(input.indexFile, root);
  const timeoutMs = input.timeoutMs ?? CHECKPOINT_GIT_TIMEOUT_MS;
  const extraDeny = input.extraDeny ?? [];
  const env = { GIT_INDEX_FILE: input.indexFile };
  const common: GitCommon = { cwd: root, env, config: await cachedOverrides(root), timeoutMs };
  const skipped = new Set<string>();

  // The caller holds the per-worktree lock, so a lock file left by a killed git process is stale.
  rmSync(`${input.indexFile}.lock`, { force: true });
  const head = await headCommit(root);
  const fresh = !existsSync(input.indexFile);
  if (fresh) {
    for (const p of await seedIndex(root, input.indexFile, common, head, extraDeny)) skipped.add(p);
  }
  let candidates: string[] = [];
  let full = input.paths === null || fresh;
  if (!full) {
    candidates = [...new Set((input.paths ?? []).map((p) => assertSafeRelativePath(p)))];
    // A folder would be added whole, denied files inside it included: rescan instead. A link to
    // a folder is stored as a link, so it is not followed.
    full = candidates.some((p) => {
      try {
        return lstatSync(resolve(root, p)).isDirectory();
      } catch {
        return false;
      }
    });
  }
  if (full) {
    const unstaged = splitNul(
      (await runGit(['diff-files', '--name-only', '-z', '--ignore-submodules=dirty'], common))
        .stdout,
    );
    const untracked = splitNul(
      (await runGit(['ls-files', '-z', '--others', '--exclude-standard'], common)).stdout,
    );
    candidates = [...new Set([...unstaged, ...untracked])];
  }
  const refresh: string[] = [];
  for (const p of candidates) {
    if (isDeniedPath(p, extraDeny)) skipped.add(p);
    else refresh.push(p);
  }

  const present = refresh.filter((p) => entryExists(resolve(root, p)));
  const missing = refresh.filter((p) => !entryExists(resolve(root, p)));
  if (present.length > 0) {
    // `add` honours .gitignore (exit 1 lists the ignored paths, the rest are added).
    await runGit(
      ['add', '-A', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'],
      {
        ...common,
        input: `${present.join('\0')}\0`,
        okExitCodes: [1],
      },
    );
  }
  if (missing.length > 0) {
    await runGit(['update-index', '--force-remove', '-z', '--stdin'], {
      ...common,
      input: `${missing.join('\0')}\0`,
    });
  }
  // Whatever got in before (a staged secret, a path denied since): back to HEAD, every time.
  for (const p of await dropDeniedEntries(common, head, extraDeny)) skipped.add(p);
  const tree = (await runGit(['write-tree'], common)).stdout.trim();

  let changed = true;
  let changedPaths = full ? [] : refresh.slice(0, MAX_CHANGED_PATHS);
  if (input.parent) {
    const parentTree = (
      await runGit(['rev-parse', '--verify', `${input.parent.commit}^{tree}`], {
        cwd: root,
        timeoutMs,
      })
    ).stdout.trim();
    changed = tree !== parentTree;
    if (full && changed) {
      changedPaths = splitNul(
        (
          await runGit(['diff-tree', '-r', '--name-only', '--no-renames', '-z', parentTree, tree], {
            cwd: root,
            timeoutMs,
          })
        ).stdout,
      ).slice(0, MAX_CHANGED_PATHS);
    }
  }
  const sortedSkipped = [...skipped].sort();
  if (!changed && !input.always) {
    return { commit: null, tree, changed: false, changedPaths: [], skipped: sortedSkipped, fresh };
  }
  const commit = await commitTree(root, tree, [], input.message, { timeoutMs });
  const created = await runGit(['update-ref', '--stdin', '-m', input.message], {
    cwd: root,
    input: `create ${input.ref} ${commit}\n`,
    okExitCodes: [128],
    timeoutMs,
  });
  if (created.exitCode !== 0) {
    throw new MindlyError('conflict', 'checkpoint ref already exists or could not be created');
  }
  return { commit, tree, changed, changedPaths, skipped: sortedSkipped, fresh };
}

/** A checkpoint ref of the repository. */
export interface CheckpointRefEntry {
  worktreeId: string;
  seq: number;
  ref: string;
  commit: string;
  /**
   * When the ref was created (ms since the epoch), or 0 when that cannot be told. Checkpoint
   * commits carry a fixed date, so this comes from the ref's file.
   */
  createdAt: number;
}

/** Modification time of `path` (ms since the epoch), or 0 when it cannot be read. */
function writtenAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Lists the checkpoint refs of the repository containing `repoDir` (any existing directory of
 * it, such as the project root), optionally only those of one working tree id, oldest step
 * first per working tree.
 */
export async function listCheckpointRefs(
  repoDir: string,
  onlyWorktreeId?: string,
): Promise<CheckpointRefEntry[]> {
  const root = await findRepoRoot(repoDir);
  const res = await runGit(
    ['for-each-ref', '--format=%(refname)%00%(objectname)', CHECKPOINT_REF_PREFIX],
    { cwd: root, timeoutMs: 10_000 },
  );
  const commonDir = await gitCommonDir(root);
  // A ref is its own file until git packs it; `packed-refs` is never older than a ref it holds,
  // and neither is the table list of a repository that keeps its refs in reftables.
  const packedAt =
    writtenAt(join(commonDir, 'packed-refs')) ||
    writtenAt(join(commonDir, 'reftable', 'tables.list'));
  const out: CheckpointRefEntry[] = [];
  for (const line of res.stdout.split('\n')) {
    if (line === '') continue;
    const [ref, commit] = line.split('\0');
    if (!ref || !commit || !ref.startsWith(CHECKPOINT_REF_PREFIX)) continue;
    const [id, seqText] = ref.slice(CHECKPOINT_REF_PREFIX.length).split('/');
    const seq = Number(seqText);
    if (!id || !Number.isInteger(seq)) continue;
    if (onlyWorktreeId !== undefined && id !== onlyWorktreeId) continue;
    out.push({
      worktreeId: id,
      seq,
      ref,
      commit,
      createdAt: writtenAt(join(commonDir, ref)) || packedAt,
    });
  }
  return out.sort((a, b) => a.worktreeId.localeCompare(b.worktreeId) || a.seq - b.seq);
}

/**
 * Deletes checkpoint refs of the repository containing `repoDir` (the commits stay until git
 * garbage-collects them). Refs that no longer exist are ignored. Returns how many were deleted.
 */
export async function deleteCheckpointRefs(
  repoDir: string,
  refs: readonly string[],
): Promise<number> {
  const wanted = new Set(refs);
  const existing = (await listCheckpointRefs(repoDir)).filter((r) => wanted.has(r.ref));
  if (existing.length === 0) return 0;
  const root = await findRepoRoot(repoDir);
  await runGit(['update-ref', '--stdin', '-m', 'mindly checkpoint prune'], {
    cwd: root,
    input: existing.map((r) => `delete ${r.ref} ${r.commit}\n`).join(''),
    timeoutMs: 10_000,
  });
  return existing.length;
}

/**
 * Approximate bytes the checkpoint objects of the repository take on disk, beyond what branches,
 * tags and remotes already hold. Null when git cannot tell (older than 2.31).
 */
export async function checkpointDiskUsage(repoDir: string): Promise<number | null> {
  const root = await findRepoRoot(repoDir);
  try {
    const res = await runGit(
      [
        'rev-list',
        '--objects',
        '--disk-usage',
        `--glob=${CHECKPOINT_REF_PREFIX}*`,
        '--not',
        '--branches',
        '--tags',
        '--remotes',
      ],
      { cwd: root, timeoutMs: 30_000 },
    );
    const n = Number(res.stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Names of remotes configured with `remote.<name>.mirror = true` (`git push --mirror` pushes hidden refs). */
export async function mirrorRemotes(repoDir: string): Promise<string[]> {
  const root = await findRepoRoot(repoDir);
  const res = await runGit(['config', '--get-regexp', '^remote\\..+\\.mirror$'], {
    cwd: root,
    okExitCodes: [1],
    timeoutMs: 10_000,
  });
  const out: string[] = [];
  for (const line of res.stdout.split('\n')) {
    const m = /^remote\.(.+)\.mirror (true|yes|on|1)$/i.exec(line.trim());
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** A held per-worktree checkpoint lock. */
export interface CheckpointLock {
  release(): void;
}

/** A lock older than this is considered abandoned by a crashed process. */
export const STALE_LOCK_MS = 30_000;

/**
 * Takes the per-worktree checkpoint lock with a create-exclusive file, without waiting: null
 * when another process holds it. An abandoned lock (older than `STALE_LOCK_MS`) is replaced.
 */
export function tryLockCheckpoint(lockFile: string): CheckpointLock | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
      const fd = openSync(lockFile, 'wx', 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          try {
            unlinkSync(lockFile);
          } catch {
            // already gone
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs <= STALE_LOCK_MS) return null;
        unlinkSync(lockFile);
      } catch {
        return null;
      }
    }
  }
  return null;
}
