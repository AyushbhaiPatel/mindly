import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { MindlyError, isDeniedPath } from '@mindly/core';
import { copyIndex } from './capture.js';
import { driverOverrides, runGit } from './exec.js';
import { assertValidRevision } from './refs.js';
import { findRepoRoot, resolveCommit } from './repo.js';

/*
 * Git operations behind `mindly bisect`: a scratch worktree that checks out one checkpoint after
 * another, the diff of one step, and the reverse application of one step to the user's working
 * tree without touching their index.
 */

/** The empty tree, parent of a step that has none. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A detached scratch worktree in a temp dir that checks out one checkpoint at a time. */
export interface BisectWorkspace {
  /** Absolute path of the scratch worktree. */
  path: string;
  /** Commit currently checked out. */
  current: string;
  /** Checks out `commit`, keeping untracked files (dependency folders) in place. */
  checkout(commit: string): Promise<void>;
  /** Removes the worktree and its administrative files. Safe to call more than once. */
  dispose(): Promise<void>;
}

/**
 * Creates a detached scratch worktree at `commit` inside a private temp directory. Hooks,
 * repository-defined filters and LFS downloads are disabled, as in `materializeTree`. Always call
 * `dispose()` when done.
 */
export async function createBisectWorkspace(
  repoRoot: string,
  commit: string,
  options: { timeoutMs?: number } = {},
): Promise<BisectWorkspace> {
  assertValidRevision(commit);
  const root = await findRepoRoot(repoRoot);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const resolved = await resolveCommit(root, commit);
  if (!resolved) throw new MindlyError('not_found', 'checkpoint commit not found');
  const overrides = await driverOverrides(root);
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-bisect-')));
  const path = join(tmp, 'tree');

  const remove = async (): Promise<void> => {
    await runGit(['worktree', 'remove', '--force', '--force', path], {
      cwd: root,
      okExitCodes: [128],
      timeoutMs: 60_000,
    }).catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
    await runGit(['worktree', 'prune'], { cwd: root, timeoutMs: 30_000 }).catch(() => undefined);
  };

  try {
    await runGit(['worktree', 'add', '--detach', '--quiet', path, resolved], {
      cwd: root,
      config: overrides,
      timeoutMs,
    });
  } catch (err) {
    await remove();
    throw err;
  }

  let disposed = false;
  const ws: BisectWorkspace = {
    path,
    current: resolved,
    async checkout(next) {
      assertValidRevision(next);
      if (disposed) throw new MindlyError('internal', 'bisect workspace was removed');
      const id = await resolveCommit(root, next);
      if (!id) throw new MindlyError('not_found', 'checkpoint commit not found');
      if (id === ws.current) return;
      // `--force` discards what the command under test wrote to tracked files; untracked files
      // (node_modules, .venv) stay, so a setup step runs only when a manifest changed.
      await runGit(['checkout', '--quiet', '--force', '--detach', id], {
        cwd: path,
        config: overrides,
        timeoutMs,
      });
      ws.current = id;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await remove();
    },
  };
  return ws;
}

/** Status of one path between two checkpoints. */
export interface StepPathChange {
  path: string;
  /** A: added, D: deleted, M: modified, T: type changed. */
  status: 'A' | 'D' | 'M' | 'T';
}

/** Paths that differ between `parent` (null: nothing) and `commit`, with their status. */
export async function stepChanges(
  repoRoot: string,
  parent: string | null,
  commit: string,
): Promise<StepPathChange[]> {
  assertValidRevision(commit);
  if (parent !== null) assertValidRevision(parent);
  const root = await findRepoRoot(repoRoot);
  const res = await runGit(
    ['diff-tree', '-r', '--name-status', '--no-renames', '-z', parent ?? EMPTY_TREE, commit],
    { cwd: root, timeoutMs: 60_000 },
  );
  const fields = res.stdout.split('\0');
  const out: StepPathChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = (fields[i] ?? '')[0];
    const path = fields[i + 1] ?? '';
    if (path === '') continue;
    if (status === 'A' || status === 'D' || status === 'M' || status === 'T') {
      out.push({ path, status });
    } else {
      out.push({ path, status: 'M' });
    }
  }
  return out;
}

/** Largest patch text `stepDiff` returns. */
export const MAX_STEP_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * The diff of one step as text: `--stat` or the full patch (external diff drivers and textconv
 * never run). Output is capped at `MAX_STEP_DIFF_BYTES`.
 */
export async function stepDiff(
  repoRoot: string,
  parent: string | null,
  commit: string,
  options: { patch?: boolean } = {},
): Promise<string> {
  assertValidRevision(commit);
  if (parent !== null) assertValidRevision(parent);
  const root = await findRepoRoot(repoRoot);
  const args = ['diff-tree', '-r', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
  args.push(options.patch ? '-p' : '--stat');
  args.push(parent ?? EMPTY_TREE, commit);
  const res = await runGit(args, {
    cwd: root,
    timeoutMs: 60_000,
    maxBuffer: MAX_STEP_DIFF_BYTES + 1024,
  });
  return res.stdout.length > MAX_STEP_DIFF_BYTES
    ? `${res.stdout.slice(0, MAX_STEP_DIFF_BYTES)}\n[diff truncated]\n`
    : res.stdout;
}

/** Result of `revertStep`. */
export interface RevertStepResult {
  /** Paths the revert changes in the working tree. */
  paths: string[];
  /** True when the reverse patch applies cleanly (and, with `apply`, was written). */
  applied: boolean;
  /** Paths whose current lines no longer match what the step left, so the revert was refused. */
  conflicts: string[];
  /** Why the revert was refused, when it was. */
  reason: string | null;
}

/**
 * Undoes one step (`parent` -> `commit`) in the working tree at `worktree` by applying its
 * patch in reverse with a 3-way merge (`git apply -R --3way`). The merge runs against a private
 * copy of the index that holds the current working tree content, so the real index is never
 * touched and nothing is committed or staged; only the step's own paths are written. With
 * `apply: false` the merge is only checked. Refuses when the current lines have changed since
 * the step (a conflict), or when the step touches a file on the deny-list.
 */
export async function revertStep(
  worktree: string,
  parent: string | null,
  commit: string,
  options: { apply: boolean; extraDeny?: readonly string[]; timeoutMs?: number },
): Promise<RevertStepResult> {
  assertValidRevision(commit);
  if (parent !== null) assertValidRevision(parent);
  const root = await findRepoRoot(worktree);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const changes = await stepChanges(root, parent, commit);
  const paths = changes.map((c) => c.path);
  if (paths.length === 0) return { paths, applied: true, conflicts: [], reason: null };
  const denied = paths.filter((p) => isDeniedPath(p, options.extraDeny ?? []));
  if (denied.length > 0) {
    return {
      paths,
      applied: false,
      conflicts: denied,
      reason: 'the step touches a file on the deny-list, which Mindly never writes',
    };
  }
  const patch = (
    await runGit(
      [
        'diff-tree',
        '-r',
        '-p',
        '--full-index',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        parent ?? EMPTY_TREE,
        commit,
      ],
      { cwd: root, timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    )
  ).stdout;

  const indexPath = (
    await runGit(['rev-parse', '--git-path', 'index'], { cwd: root, timeoutMs })
  ).stdout.trim();
  const realIndex = isAbsolute(indexPath) ? indexPath : resolve(root, indexPath);
  const tmp = mkdtempSync(join(tmpdir(), 'mindly-revert-'));
  try {
    const tmpIndex = join(tmp, 'index');
    const env = { GIT_INDEX_FILE: tmpIndex };
    const overrides = await driverOverrides(root);
    const common = { cwd: root, env, config: overrides, timeoutMs };
    if (existsSync(realIndex)) copyIndex(realIndex, tmpIndex);
    else await runGit(['read-tree', '--empty'], common);
    // The private index gets the current working tree content of the step's paths, so the 3-way
    // merge sees what is on disk now (including unstaged edits).
    const present = paths.filter((p) => existsSync(resolve(root, p)));
    const missing = paths.filter((p) => !existsSync(resolve(root, p)));
    if (present.length > 0) {
      await runGit(['add', '-A', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        ...common,
        input: `${present.join('\0')}\0`,
      });
    }
    if (missing.length > 0) {
      await runGit(['update-index', '--force-remove', '-z', '--stdin'], {
        ...common,
        input: `${missing.join('\0')}\0`,
      });
    }
    const applied = await runGit(['apply', '-R', '--3way', '--cached', '--whitespace=nowarn'], {
      ...common,
      input: patch,
      okExitCodes: [1, 128],
    });
    const unmerged = (await runGit(['ls-files', '-u', '-z'], common)).stdout
      .split('\0')
      .filter((l) => l !== '')
      .map((l) => l.slice(l.lastIndexOf('\t') + 1));
    const conflicts = [...new Set(unmerged)];
    if (applied.exitCode !== 0 || conflicts.length > 0) {
      return {
        paths,
        applied: false,
        conflicts: conflicts.length > 0 ? conflicts : paths,
        reason:
          conflicts.length > 0
            ? 'those lines have changed since that step'
            : 'the step no longer applies to the current files (they changed since then)',
      };
    }
    if (!options.apply) return { paths, applied: true, conflicts: [], reason: null };
    // Write the merged result out: files the step created are removed, the rest come from the
    // private index. The real index is not read or written at any point.
    const added = changes.filter((c) => c.status === 'A').map((c) => c.path);
    const written = paths.filter((p) => !added.includes(p));
    for (const p of added) {
      try {
        unlinkSync(resolve(root, p));
      } catch {
        // already gone
      }
    }
    if (written.length > 0) {
      await runGit(['checkout-index', '-f', '-z', '--stdin'], {
        ...common,
        input: `${written.join('\0')}\0`,
      });
    }
    return { paths, applied: true, conflicts: [], reason: null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Files whose change means dependencies may need installing again (`--setup` reruns). */
const MANIFEST_RE =
  /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|requirements[^/]*\.txt|pyproject\.toml|go\.sum|go\.mod|Cargo\.lock|Cargo\.toml|Gemfile\.lock|composer\.lock|[^/]+\.lock)$/;

/** True when `path` is a lockfile or manifest. */
export function isManifestPath(path: string): boolean {
  return MANIFEST_RE.test(path);
}

/** Lockfiles that suggest a `--setup` step, checked at the top level of a tree. */
export const LOCKFILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'requirements.txt',
  'Gemfile.lock',
  'composer.lock',
] as const;

/** The first lockfile present at the top level of `dir`, or null. */
export function lockfileIn(dir: string): string | null {
  for (const name of LOCKFILES) if (existsSync(join(dir, name))) return name;
  return null;
}
