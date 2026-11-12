import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MindlyError, isMindlyError, resolveInsideRoot } from '@mindly/core';
import { driverOverrides, gitVersion, runGit, versionAtLeast } from './exec.js';
import { assertSafeRelativePath, assertValidRevision } from './refs.js';

function absoluteDir(cwd: string): string {
  if (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0')) {
    throw new MindlyError('invalid_input', 'invalid directory');
  }
  return resolve(cwd);
}

/**
 * Returns the realpath of the top-level directory of the working tree containing `cwd`.
 * Throws `not_found` when `cwd` is not inside a git working tree.
 */
export async function findRepoRoot(cwd: string): Promise<string> {
  const dir = absoluteDir(cwd);
  const known = cachedRoot(dir);
  if (known) return known;
  const res = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, okExitCodes: [128] });
  const top = res.stdout.trim();
  if (res.exitCode !== 0 || top === '') {
    throw new MindlyError('not_found', 'not inside a git working tree');
  }
  const root = realpathSync(top);
  remember(dir, root);
  return root;
}

/*
 * `findRepoRoot` answers are kept, by folder, while they provably still hold: the top-level's
 * `.git` is the same entry, and no folder between the asked one and it has a `.git` of its own
 * (a repository made inside since). Anything else asks git again.
 */
const ROOT_CACHE = new Map<string, { root: string; dotgit: string }>();
const ROOT_CACHE_MAX = 512;

function dotGitId(root: string): string {
  const st = lstatSync(join(root, '.git'));
  return `${st.dev}:${st.ino}:${st.mode}`;
}

function remember(dir: string, root: string): void {
  try {
    const real = realpathSync(dir);
    if (ROOT_CACHE.size >= ROOT_CACHE_MAX) ROOT_CACHE.clear();
    ROOT_CACHE.set(real, { root, dotgit: dotGitId(root) });
  } catch {
    // Not cached: asked again next time.
  }
}

function cachedRoot(dir: string): string | null {
  try {
    const real = realpathSync(dir);
    const hit = ROOT_CACHE.get(real);
    if (!hit || !statSync(real).isDirectory() || dotGitId(hit.root) !== hit.dotgit) return null;
    for (let d = real; d !== hit.root; d = dirname(d)) {
      if (d === dirname(d)) return null;
      try {
        lstatSync(join(d, '.git'));
        return null;
      } catch {
        // None here: keep going up.
      }
    }
    return hit.root;
  } catch {
    return null;
  }
}

/** True when `cwd` is inside a git working tree. Never throws for ordinary directories. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await findRepoRoot(cwd);
    return true;
  } catch (err) {
    if (isMindlyError(err, 'not_found') || isMindlyError(err, 'invalid_input')) return false;
    throw err;
  }
}

/** Short name of the checked-out branch, or null when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const res = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: absoluteDir(cwd),
    okExitCodes: [1],
  });
  const name = res.stdout.trim();
  return res.exitCode === 0 && name !== '' ? name : null;
}

/** Full object id of the HEAD commit, or null for an unborn branch. */
export async function headCommit(cwd: string): Promise<string | null> {
  return resolveCommit(absoluteDir(cwd), 'HEAD');
}

/**
 * Resolves a revision (object id, `HEAD` or ref name) to a full commit id, or null when it does
 * not exist or is not a commit.
 */
export async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  assertValidRevision(rev);
  const res = await runGit(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`],
    { cwd: absoluteDir(cwd), okExitCodes: [1, 128] },
  );
  const id = res.stdout.trim();
  return res.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(id) ? id : null;
}

/** Absolute, symlink-resolved path of the repository's common git directory. */
export async function gitCommonDir(cwd: string): Promise<string> {
  const dir = absoluteDir(cwd);
  const res = await runGit(['rev-parse', '--git-common-dir'], { cwd: dir });
  const raw = res.stdout.trim();
  return realpathSync(isAbsolute(raw) ? raw : resolve(dir, raw));
}

/** One entry of `git worktree list`. */
export interface WorktreeInfo {
  /** Absolute path of the working tree. */
  path: string;
  /** Commit checked out, or null for an unborn branch / bare entry. */
  head: string | null;
  /** Full ref name (`refs/heads/…`) or null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parses `git worktree list --porcelain` output (NUL- or newline-separated). */
export function parseWorktreeList(output: string, nulSeparated: boolean): WorktreeInfo[] {
  const lines = output.split(nulSeparated ? '\0' : '\n');
  const result: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const line of lines) {
    if (line === '') {
      if (current) result.push(current);
      current = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (current) result.push(current);
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = /^0+$/.test(value) ? null : value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  if (current) result.push(current);
  return result;
}

/** Lists every working tree attached to the repository containing `cwd`. */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const dir = absoluteDir(cwd);
  const nul = versionAtLeast(await gitVersion(), 2, 36);
  const args = ['worktree', 'list', '--porcelain'];
  if (nul) args.push('-z');
  const res = await runGit(args, { cwd: dir });
  return parseWorktreeList(res.stdout, nul);
}

/** Kind of change reported by `changedFiles`. */
export type ChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'conflicted'
  | 'untracked';

/** One changed path reported by `changedFiles`. */
export interface ChangedFile {
  /** Repository-relative POSIX path. */
  path: string;
  /** For renames/copies: the path it came from. */
  origPath: string | null;
  kind: ChangeKind;
  /** True when the index differs from HEAD for this path. */
  staged: boolean;
  /** True when the working tree differs from the index for this path. */
  unstaged: boolean;
}

function kindFromXY(x: string, y: string): ChangeKind {
  const pick = x !== '.' ? x : y;
  switch (pick) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}

/** Parses `git status --porcelain=v2 -z` output. */
export function parseStatusV2(output: string): ChangedFile[] {
  const fields = output.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? '';
    if (entry === '' || entry.startsWith('#')) continue;
    const type = entry[0];
    if (type === '?') {
      files.push({
        path: entry.slice(2),
        origPath: null,
        kind: 'untracked',
        staged: false,
        unstaged: true,
      });
    } else if (type === '1' || type === '2' || type === 'u') {
      // 1 XY sub mH mI mW hH hI <path>
      // 2 XY sub mH mI mW hH hI Xscore <path>\0<origPath>
      // u XY sub m1 m2 m3 mW h1 h2 h3 <path>
      const fixedFields = type === '1' ? 8 : type === '2' ? 9 : 10;
      const parts = entry.split(' ');
      const path = parts.slice(fixedFields).join(' ');
      const xy = parts[1] ?? '..';
      const x = xy[0] ?? '.';
      const y = xy[1] ?? '.';
      let origPath: string | null = null;
      if (type === '2') {
        origPath = fields[i + 1] ?? null;
        i += 1;
      }
      files.push({
        path,
        origPath,
        kind: type === 'u' ? 'conflicted' : kindFromXY(x, y),
        staged: type === 'u' || x !== '.',
        unstaged: type === 'u' || y !== '.',
      });
    }
  }
  return files;
}

/**
 * Lists staged, unstaged and untracked (non-ignored) changes of the working tree containing
 * `cwd`. Paths are relative to the working tree root. Does not write the index.
 */
export async function changedFiles(cwd: string): Promise<ChangedFile[]> {
  const root = await findRepoRoot(cwd);
  const res = await runGit(
    ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty'],
    { cwd: root, config: await driverOverrides(root) },
  );
  return parseStatusV2(res.stdout);
}

function relativeInside(root: string, path: string): string {
  const { rel } = resolveInsideRoot(root, path);
  if (rel === '') throw new MindlyError('invalid_input', 'path must name a file');
  return assertSafeRelativePath(rel);
}

/** Options for `diffForFile`. */
export interface DiffOptions {
  /** Diff the index against HEAD instead of the working tree against the index. */
  staged?: boolean;
  /** Diff the working tree against this revision instead (overrides `staged`). */
  against?: string;
  /** Lines of context (default 3, max 1000). */
  context?: number;
}

/**
 * Unified diff for one file. `path` may be absolute or relative to the working tree root and must
 * resolve inside it. External diff drivers and textconv filters are never run.
 */
export async function diffForFile(
  cwd: string,
  path: string,
  options: DiffOptions = {},
): Promise<string> {
  const root = await findRepoRoot(cwd);
  const rel = relativeInside(root, path);
  const context = Math.min(Math.max(0, Math.floor(options.context ?? 3)), 1000);
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `-U${context}`];
  if (options.against !== undefined) {
    assertValidRevision(options.against);
    const commit = await resolveCommit(root, options.against);
    if (!commit) throw new MindlyError('not_found', 'revision not found');
    args.push(commit);
  } else if (options.staged) {
    args.push('--cached');
  }
  args.push('--', rel);
  // Comparing against the working tree runs clean filters; disable repository-defined ones.
  const res = await runGit(args, { cwd: root, config: await driverOverrides(root) });
  return res.stdout;
}

/** Maximum blob size returned by `fileAtRef`. */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/**
 * Contents of `path` (repository-relative) at revision `ref`, decoded as UTF-8, or null when the
 * path does not exist at that revision. Throws `not_found` for an unknown revision and
 * `invalid_input` for blobs over 8 MiB.
 */
export async function fileAtRef(cwd: string, ref: string, path: string): Promise<string | null> {
  assertValidRevision(ref);
  const rel = assertSafeRelativePath(path);
  const dir = absoluteDir(cwd);
  const commit = await resolveCommit(dir, ref);
  if (!commit) throw new MindlyError('not_found', 'revision not found');
  const spec = `${commit}:${rel}`;
  const type = await runGit(['cat-file', '-t', spec], { cwd: dir, okExitCodes: [1, 128] });
  if (type.exitCode !== 0) return null;
  if (type.stdout.trim() !== 'blob') {
    throw new MindlyError('invalid_input', 'path does not name a file at that revision');
  }
  const size = await runGit(['cat-file', '-s', spec], { cwd: dir });
  if (Number(size.stdout.trim()) > MAX_BLOB_BYTES) {
    throw new MindlyError('invalid_input', 'file too large');
  }
  const res = await runGit(['cat-file', 'blob', spec], {
    cwd: dir,
    maxBuffer: MAX_BLOB_BYTES + 1024,
  });
  return res.stdout;
}

/** What a path holds at a ref: a file (with its content), nothing, or more than `maxBytes`. */
export type FileAtRefState =
  | { state: 'file'; content: string }
  | { state: 'absent' }
  | { state: 'no_ref' }
  | { state: 'too_large' };

/**
 * Like `fileAtRef`, but tells a missing ref, a missing path and a file over `maxBytes` apart
 * (the content of a large file is never read).
 */
export async function fileStateAtRef(
  cwd: string,
  ref: string,
  path: string,
  maxBytes: number,
): Promise<FileAtRefState> {
  assertValidRevision(ref);
  const rel = assertSafeRelativePath(path);
  const dir = absoluteDir(cwd);
  const commit = await resolveCommit(dir, ref);
  if (!commit) return { state: 'no_ref' };
  const spec = `${commit}:${rel}`;
  const type = await runGit(['cat-file', '-t', spec], { cwd: dir, okExitCodes: [1, 128] });
  if (type.exitCode !== 0 || type.stdout.trim() !== 'blob') return { state: 'absent' };
  const size = Number((await runGit(['cat-file', '-s', spec], { cwd: dir })).stdout.trim());
  if (!Number.isFinite(size) || size > Math.min(maxBytes, MAX_BLOB_BYTES)) {
    return { state: 'too_large' };
  }
  const res = await runGit(['cat-file', 'blob', spec], { cwd: dir, maxBuffer: size + 1024 });
  return { state: 'file', content: res.stdout };
}
