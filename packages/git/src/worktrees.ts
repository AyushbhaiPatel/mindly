import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_DENY_PATHS, MindlyError, isDeniedPath, sanitizeLine } from '@mindly/core';
import { commitTree } from './capture.js';
import { driverOverrides, gitVersion, runGit, versionAtLeast } from './exec.js';
import { MIN_MERGE_TREE_VERSION, parseMergeTreeOutput } from './merge.js';
import { assertValidBranchName } from './refs.js';
import { findRepoRoot, gitCommonDir, listWorktrees, resolveCommit } from './repo.js';

/*
 * Linked worktrees and branches for `mindly split`: every part works on its own branch in a
 * folder outside the repository. Nothing here ever touches the main working tree, its index or
 * the checked-out branch; the only refs written are the ones named by the caller, and existing
 * branches and folders are never overwritten.
 */

/** True when `refs/heads/<branch>` exists. */
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  assertValidBranchName(branch);
  const root = await findRepoRoot(repoRoot);
  return (await resolveCommit(root, `refs/heads/${branch}`)) !== null;
}

function assertAbsoluteOutside(path: string, root: string): string {
  if (typeof path !== 'string' || path === '' || path.includes('\0') || !isAbsolute(path)) {
    throw new MindlyError('invalid_input', 'worktree path must be absolute');
  }
  const target = resolve(path);
  if (target === root || target.startsWith(`${root}/`)) {
    throw new MindlyError('invalid_input', 'worktree path must be outside the repository');
  }
  return target;
}

/**
 * Creates a NEW branch `branch` at `startPoint` and checks it out in a NEW linked worktree at
 * `path` (absolute, outside the repository). Throws `conflict` when the branch or the folder
 * already exists. Hooks, filters and LFS downloads are disabled during the checkout.
 */
export async function addWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  startPoint: string,
): Promise<{ path: string; branch: string; commit: string }> {
  assertValidBranchName(branch);
  const root = await findRepoRoot(repoRoot);
  const target = assertAbsoluteOutside(path, root);
  if (existsSync(target)) {
    throw new MindlyError('conflict', 'worktree folder already exists', { details: { path } });
  }
  if (await branchExists(root, branch)) {
    throw new MindlyError('conflict', 'branch already exists', { details: { branch } });
  }
  const commit = await resolveCommit(root, startPoint);
  if (!commit) throw new MindlyError('not_found', 'start point not found');
  await runGit(['worktree', 'add', '-b', branch, target, commit], {
    cwd: root,
    config: await driverOverrides(root),
    timeoutMs: 120_000,
  });
  return { path: realpathSync.native(target), branch, commit };
}

/**
 * Removes the linked worktree at `path` and prunes its administrative files. The worktree must
 * belong to the repository at `repoRoot` and must not be its main working tree. A folder that is
 * no longer a worktree is left alone (returns false).
 *
 * With `force` (the default) uncommitted changes go with it, and a locked worktree too. Without
 * it git itself refuses a worktree with modified or untracked files (files flagged skip-worktree
 * or assume-unchanged included), with submodules, or that is locked. A refusal throws `conflict`
 * with `details.refused`, git's reason and, for a locked worktree, `details.locked`; nothing is
 * removed. Ignored files go either way.
 */
export async function removeWorktree(
  repoRoot: string,
  path: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const root = await findRepoRoot(repoRoot);
  const target = assertAbsoluteOutside(path, root);
  const known = (await listWorktrees(root)).some((w) => {
    try {
      return realpathSync(w.path) === target || w.path === target;
    } catch {
      return w.path === target;
    }
  });
  if (!known) {
    await runGit(['worktree', 'prune'], { cwd: root, timeoutMs: 30_000 });
    return false;
  }
  if (existsSync(target) && (await gitCommonDir(target)) !== (await gitCommonDir(root))) {
    throw new MindlyError('invalid_input', 'worktree does not belong to this repository');
  }
  const force = options.force !== false;
  // git's check reads the status, which skips files flagged skip-worktree or assume-unchanged:
  // unflag the ones on disk, so that an edit to one is seen like any other.
  const flagged = !force && existsSync(target) ? await unflagPresent(target) : [];
  // `--force` twice also removes a locked worktree.
  const res = await runGit(
    ['worktree', 'remove', ...(force ? ['--force', '--force'] : []), target],
    { cwd: root, timeoutMs: 60_000, okExitCodes: [128] },
  );
  if (res.exitCode !== 0) {
    await reflag(target, flagged).catch(() => undefined);
    const reason = sanitizeLine(
      res.stderr
        .split('\n')
        .map((l) => l.replace(/^(fatal|error): /, '').trim())
        .filter((l) => l !== '' && !l.startsWith('hint:'))
        .join('; ') || 'git refused to remove it',
      300,
    );
    const locked = /\blocked\b/i.test(res.stderr);
    throw new MindlyError('conflict', `git did not remove the worktree: ${reason}`, {
      details: { path: target, refused: true, reason, locked },
    });
  }
  await runGit(['worktree', 'prune'], { cwd: root, timeoutMs: 30_000 });
  return true;
}

/** An index entry flagged skip-worktree or assume-unchanged. */
interface FlaggedEntry {
  path: string;
  mode: string;
  object: string;
  skipWorktree: boolean;
  assumeUnchanged: boolean;
}

/**
 * Index entries of the working tree at `root` flagged skip-worktree or assume-unchanged: git's
 * status, and so `git worktree remove`, does not look at their files.
 */
async function flaggedEntries(root: string): Promise<FlaggedEntry[]> {
  const res = await runGit(['ls-files', '-v', '-s', '-z'], { cwd: root, timeoutMs: 60_000 });
  const out: FlaggedEntry[] = [];
  for (const rec of res.stdout.split('\0')) {
    const m = /^(\S) ([0-7]{6}) ([0-9a-f]+) \d\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const tag = m[1] as string;
    // `S`: skip-worktree; a lower-case tag: assume-unchanged.
    const skipWorktree = tag.toUpperCase() === 'S';
    const assumeUnchanged = tag !== tag.toUpperCase();
    if (!skipWorktree && !assumeUnchanged) continue;
    out.push({
      path: m[4] as string,
      mode: m[2] as string,
      object: m[3] as string,
      skipWorktree,
      assumeUnchanged,
    });
  }
  return out;
}

/**
 * The entry at `rel` (repository-relative) under `root`, if there is one: nothing when a folder on
 * the way is missing, a symbolic link or not a folder (git does not look past those either).
 */
function lstatInTree(root: string, rel: string): Stats | null {
  const parts = rel.split('/');
  let at = root;
  try {
    for (let i = 0; i < parts.length - 1; i++) {
      at = join(at, parts[i] as string);
      if (!lstatSync(at).isDirectory()) return null;
    }
    return lstatSync(join(at, parts[parts.length - 1] as string));
  } catch {
    return null;
  }
}

/** Clears both flags of the flagged entries whose file is on disk; returns them. */
async function unflagPresent(worktree: string): Promise<FlaggedEntry[]> {
  const present = (await flaggedEntries(worktree)).filter(
    (e) => lstatInTree(worktree, e.path) !== null,
  );
  await setFlags(worktree, present, false);
  return present;
}

/** Sets the flags `unflagPresent` cleared again. */
async function reflag(worktree: string, entries: readonly FlaggedEntry[]): Promise<void> {
  await setFlags(worktree, entries, true);
}

/**
 * Sets (`on`) or clears each entry's own flags. One flag per call: given both, `update-index`
 * applies only the first.
 */
async function setFlags(
  worktree: string,
  entries: readonly FlaggedEntry[],
  on: boolean,
): Promise<void> {
  for (const [flag, list] of [
    [on ? '--skip-worktree' : '--no-skip-worktree', entries.filter((e) => e.skipWorktree)],
    [on ? '--assume-unchanged' : '--no-assume-unchanged', entries.filter((e) => e.assumeUnchanged)],
  ] as const) {
    if (list.length === 0) continue;
    await runGit(['update-index', flag, '-z', '--stdin'], {
      cwd: worktree,
      input: `${list.map((e) => e.path).join('\0')}\0`,
      timeoutMs: 60_000,
    });
  }
}

/**
 * Files of the working tree at `cwd` flagged skip-worktree or assume-unchanged (a local config
 * kept out of commits) whose content differs from the index: uncommitted work that git's status
 * does not show. Repository-relative. Deny-listed ones (on the built-in list or `extraDeny`) are
 * never read: they count whenever they are on disk, and are also returned in `denied`.
 */
export async function flaggedChanges(
  cwd: string,
  extraDeny: readonly string[] = [],
): Promise<{ changed: string[]; denied: string[] }> {
  const root = await findRepoRoot(cwd);
  const changed: string[] = [];
  const denied: string[] = [];
  const toHash: FlaggedEntry[] = [];
  for (const e of await flaggedEntries(root)) {
    if (e.mode === '160000') continue;
    const st = lstatInTree(root, e.path);
    // Not on disk (a sparse checkout): there is nothing to lose.
    if (!st) continue;
    if (isDeniedPath(e.path, extraDeny)) {
      changed.push(e.path);
      denied.push(e.path);
    } else if (st.isSymbolicLink()) {
      const res = await runGit(['hash-object', '--stdin'], {
        cwd: root,
        input: readlinkSync(join(root, e.path)),
        timeoutMs: 30_000,
      });
      if (e.mode !== '120000' || res.stdout.trim() !== e.object) changed.push(e.path);
    } else if (!st.isFile() || e.mode === '120000' || e.path.includes('\n')) {
      changed.push(e.path);
    } else toHash.push(e);
  }
  if (toHash.length > 0) {
    const res = await runGit(['hash-object', '--stdin-paths'], {
      cwd: root,
      input: `${toHash.map((e) => e.path).join('\n')}\n`,
      config: await driverOverrides(root),
      timeoutMs: 120_000,
    });
    const hashes = res.stdout.split('\n');
    toHash.forEach((e, i) => {
      if (hashes[i]?.trim() !== e.object) changed.push(e.path);
    });
  }
  return { changed: [...new Set(changed)].sort(), denied: denied.sort() };
}

/**
 * Puts `paths` of the worktree back to its HEAD in the index, and writes the committed ones that
 * are missing from disk; a file that is on disk is never overwritten. Used after the files a user
 * confirmed were deleted, so that git's own check of the worktree only finds what was not listed.
 */
export async function restoreFromHead(worktree: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const root = await findRepoRoot(worktree);
  const common = {
    cwd: root,
    input: `${paths.join('\0')}\0`,
    config: await driverOverrides(root),
    timeoutMs: 120_000,
    // A path neither committed nor in the index, or a file in the way: git's check sees to it.
    okExitCodes: [1],
  };
  await runGit(['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], common);
  await runGit(['checkout-index', '-q', '-z', '--stdin'], common);
}

/** How many entries `ignoredNestedRepos` reads at most before it gives up. */
export const NESTED_REPO_SEARCH_LIMIT = 200_000;

/**
 * Nested git repositories in the ignored folders of the working tree at `cwd` (a dependency
 * cloned into an ignored `vendor/` and patched there): git deletes ignored folders with the
 * worktree, and their commits and changes with them. `repos`: their folders. `unchecked`:
 * ignored folders that could not be looked through (unreadable, or more than `limit` entries in
 * all), which may hold one. Repository-relative. Installed packages (`node_modules`,
 * `site-packages`) and cache folders (holding a `CACHEDIR.TAG`) are not looked into.
 */
export async function ignoredNestedRepos(
  cwd: string,
  limit = NESTED_REPO_SEARCH_LIMIT,
): Promise<{ repos: string[]; unchecked: string[] }> {
  const root = await findRepoRoot(cwd);
  const res = await runGit(
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: root, timeoutMs: 60_000 },
  );
  const dirs = res.stdout
    .split('\0')
    .filter((p) => p.endsWith('/'))
    .map((p) => p.slice(0, -1))
    .sort();
  // A folder listed inside another listed one is looked through with it.
  const top = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(`${o}/`)));
  const repos: string[] = [];
  const unchecked: string[] = [];
  let budget = limit;
  for (const dir of top) {
    const stack = [dir];
    let complete = true;
    while (stack.length > 0) {
      const rel = stack.pop() as string;
      const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
      if (PACKAGE_DIRS.includes(name)) continue;
      let entries: Dirent[];
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        complete = false;
        break;
      }
      budget -= entries.length;
      if (budget < 0) {
        complete = false;
        break;
      }
      if (entries.some((e) => e.name === '.git')) {
        repos.push(rel);
        continue;
      }
      if (entries.some((e) => e.name === 'CACHEDIR.TAG' && e.isFile())) continue;
      for (const e of entries) if (e.isDirectory()) stack.push(`${rel}/${e.name}`);
    }
    if (!complete) unchecked.push(dir);
  }
  return { repos: repos.sort(), unchecked };
}

/**
 * Deletes `refs/heads/<branch>` whatever its merge state. Returns false when it did not exist and
 * refuses (`conflict`) a branch that is checked out in any working tree, so work under someone's
 * HEAD is never dropped. With `expectedTip`, also refuses (`conflict`) a branch that has moved
 * since it was looked at, so commits made in between are never dropped either.
 */
export async function deleteBranch(
  repoRoot: string,
  branch: string,
  expectedTip?: string,
): Promise<boolean> {
  assertValidBranchName(branch);
  const root = await findRepoRoot(repoRoot);
  const ref = `refs/heads/${branch}`;
  const commit = await resolveCommit(root, ref);
  if (!commit) return false;
  const moved = (): MindlyError =>
    new MindlyError('conflict', `branch ${branch} has commits made after it was checked`, {
      details: { branch, moved: true },
    });
  if (expectedTip !== undefined && commit !== expectedTip) throw moved();
  const checkedOut = (await listWorktrees(root)).find((w) => w.branch === ref);
  if (checkedOut) {
    throw new MindlyError('conflict', `branch ${branch} is checked out at ${checkedOut.path}`, {
      details: { branch, path: checkedOut.path },
    });
  }
  // Deletes only if the branch is still at `commit`: one that moved in between is kept.
  const res = await runGit(['update-ref', '-d', ref, commit], {
    cwd: root,
    okExitCodes: [1, 128],
  });
  if (res.exitCode !== 0) {
    if ((await resolveCommit(root, ref)) !== null) throw moved();
    return false;
  }
  return true;
}

/** A commit that only one branch holds (see `branchOnlyWork`). */
export interface BranchOnlyCommit {
  commit: string;
  subject: string;
}

/** What deleting a branch would lose (see `branchOnlyWork`). */
export interface BranchOnlyWork {
  /** The branch tip that was looked at; null when the branch does not exist. */
  tip: string | null;
  /** Commits no other branch, tag or remote-tracking branch has, newest first, at most `max`. */
  commits: BranchOnlyCommit[];
  /** True when there are more such commits than `commits` lists. */
  more: boolean;
}

const ONLY_WORK_CACHE = new Map<string, BranchOnlyWork>();
const ONLY_WORK_CACHE_MAX = 256;
/** Unique tips passed to one `merge-base` call: keeps the command line short. */
const MERGE_BASE_CHUNK = 2000;

/**
 * What deleting `refs/heads/<branch>` would lose: its commits that no other branch, tag or
 * remote-tracking branch reaches. Branches in `ignoring` (deleted together with it) do not count
 * as holding a commit. Only reachability counts: a commit whose changes another branch has under
 * a different id (a squash or rebase merge) is still lost with the branch.
 *
 * A walk from the branch with every other ref negated trusts commit dates, and the merge commits
 * of `split merge` carry a fixed old one: it would list commits those refs do have. Instead the
 * newest commits the other refs share with the branch are found with `merge-base`, which does
 * not stop early on dates, and only the branch's own history above them is walked. Results are
 * cached per state of the refs, so asking again is cheap until a ref moves.
 */
export async function branchOnlyWork(
  repoRoot: string,
  branch: string,
  options: { ignoring?: readonly string[]; max?: number } = {},
): Promise<BranchOnlyWork> {
  assertValidBranchName(branch);
  const ignoring = options.ignoring ?? [];
  for (const b of ignoring) assertValidBranchName(b);
  const limit = Math.max(1, Math.floor(options.max ?? 50));
  const root = await findRepoRoot(repoRoot);
  const ref = `refs/heads/${branch}`;
  const tip = await resolveCommit(root, ref);
  if (!tip) return { tip: null, commits: [], more: false };
  const refs = await runGit(
    [
      'for-each-ref',
      '--format=%(objectname) %(objecttype) %(*objectname) %(*objecttype) %(refname)',
      'refs/heads',
      'refs/tags',
      'refs/remotes',
    ],
    { cwd: root, timeoutMs: 30_000 },
  );
  const key = createHash('sha256')
    .update(JSON.stringify([root, ref, tip, [...ignoring].sort(), limit, refs.stdout]))
    .digest('hex');
  const cached = ONLY_WORK_CACHE.get(key);
  if (cached) return cached;

  const going = new Set([branch, ...ignoring].map((b) => `refs/heads/${b}`));
  const others = new Set<string>();
  for (const line of refs.stdout.split('\n')) {
    const [id, type, peeledId, peeledType, ...rest] = line.split(' ');
    const name = rest.join(' ');
    if (!id || !name || going.has(name)) continue;
    const commit = type === 'commit' ? id : peeledType === 'commit' ? peeledId : undefined;
    if (commit) others.add(commit);
  }

  // The newest commits of the branch that some other ref also has.
  const bases = new Set<string>();
  if (others.has(tip)) bases.add(tip);
  else {
    const tips = [...others];
    for (let i = 0; i < tips.length; i += MERGE_BASE_CHUNK) {
      const res = await runGit(
        ['merge-base', '--all', tip, ...tips.slice(i, i + MERGE_BASE_CHUNK)],
        {
          cwd: root,
          timeoutMs: 120_000,
          okExitCodes: [1],
        },
      );
      for (const id of res.stdout.split('\n')) if (id) bases.add(id);
    }
  }
  const commits: BranchOnlyCommit[] = [];
  if (!bases.has(tip)) {
    // Every commit above the bases is the branch's own. Without bases the whole history is: a
    // plain walk then stops at `max`.
    const res = await runGit(
      [
        'log',
        '--no-color',
        '--format=%H%x09%s',
        ...(bases.size > 0 ? ['--topo-order'] : []),
        `--max-count=${limit + 1}`,
        tip,
        ...[...bases].map((b) => `^${b}`),
        '--',
      ],
      { cwd: root, timeoutMs: 120_000 },
    );
    for (const line of res.stdout.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) commits.push({ commit: line.slice(0, tab), subject: line.slice(tab + 1) });
    }
  }

  const more = commits.length > limit;
  const out: BranchOnlyWork = { tip, commits: commits.slice(0, limit), more };
  if (ONLY_WORK_CACHE.size >= ONLY_WORK_CACHE_MAX) {
    const oldest = ONLY_WORK_CACHE.keys().next().value;
    if (oldest !== undefined) ONLY_WORK_CACHE.delete(oldest);
  }
  ONLY_WORK_CACHE.set(key, out);
  return out;
}

/**
 * Folders that hold installed packages: ignored files in them (certifi's `cacert.pem`, test keys
 * of a package) were installed, not written by anyone, and are never listed as work.
 */
export const PACKAGE_DIRS: readonly string[] = ['node_modules', 'site-packages'];

/**
 * Dependency and tool trees: ignored deny-listed files in them are not listed, except `.env*`
 * files and key files, which count wherever they are (outside `PACKAGE_DIRS`). `venv`, `.venv`
 * and `env` are such a tree only when they hold a `pyvenv.cfg`.
 */
export const DEPENDENCY_DIRS: readonly string[] = [
  '__pycache__',
  '.tox',
  '.gradle',
  'vendor/bundle',
  'venv',
  '.venv',
  'env',
];

const VENV_DIRS = new Set(['venv', '.venv', 'env']);
const ALWAYS_COUNTED = /^(\.env.*|.*\.(key|pem|p12|pfx|keystore|kdbx)|id_(rsa|ed25519|ecdsa).*)$/i;

/** Whether an ignored deny-listed file is installed tooling rather than someone's work. */
function installed(root: string, rel: string): boolean {
  const parts = rel.split('/');
  const dirs = parts.slice(0, -1);
  const lower = dirs.map((d) => d.toLowerCase());
  if (lower.some((d) => PACKAGE_DIRS.includes(d))) return true;
  if (ALWAYS_COUNTED.test(parts[parts.length - 1] ?? '')) return false;
  for (let i = 0; i < lower.length; i++) {
    const d = lower[i] as string;
    if (d === '__pycache__' || d === '.tox' || d === '.gradle') return true;
    if (d === 'vendor' && lower[i + 1] === 'bundle') return true;
    if (VENV_DIRS.has(d) && existsSync(join(root, ...dirs.slice(0, i + 1), 'pyvenv.cfg'))) {
      return true;
    }
  }
  return false;
}

/**
 * Ignored files of the working tree at `cwd` that are on the secret deny-list or on `extraDeny`
 * (a local `.env`, a key; any letter case): not part of any commit, but lost with the worktree.
 * Repository-relative; their content is never read. Other ignored files, and installed ones
 * (in `PACKAGE_DIRS`, or in `DEPENDENCY_DIRS` unless they are `.env*` or key files), are not
 * listed.
 */
export async function ignoredDeniedFiles(
  cwd: string,
  extraDeny: readonly string[] = [],
): Promise<string[]> {
  const root = await findRepoRoot(cwd);
  const patterns = [...DEFAULT_DENY_PATHS, ...extraDeny].filter(
    (p) => typeof p === 'string' && p !== '' && !p.includes('\0'),
  );
  const res = await runGit(
    [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...patterns.map((p) => `:(icase,glob)${p}`),
      ...PACKAGE_DIRS.map((d) => `:(exclude,icase,glob)**/${d}/**`),
    ],
    // The deny-list is made of globs: let git read these pathspecs as such.
    { cwd: root, timeoutMs: 60_000, env: { GIT_LITERAL_PATHSPECS: '0' } },
  );
  return res.stdout
    .split('\0')
    .filter((p) => p !== '' && isDeniedPath(p, extraDeny) && !installed(root, p))
    .sort();
}

/** Tracked and untracked (non-ignored) files of the working tree at `cwd`, repository-relative. */
export async function listFiles(cwd: string, max = 20_000): Promise<string[]> {
  const root = await findRepoRoot(cwd);
  const res = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    timeoutMs: 30_000,
  });
  const out: string[] = [];
  for (const f of res.stdout.split('\0')) {
    if (f === '') continue;
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

/** One branch to merge, in order. */
export interface MergeSource {
  /** 1-128 printable characters, used in the merge commit message. */
  label: string;
  /** Branch (short name) or commit to merge. */
  ref: string;
}

/** Result of `mergeIntoNewBranch`. */
export type MergeIntoBranchResult =
  | {
      status: 'merged';
      branch: string;
      /** Tip of the new branch: the last merge commit. */
      commit: string;
      merged: string[];
    }
  | {
      status: 'conflicted';
      /** Label of the source whose merge conflicted; nothing was created. */
      label: string;
      paths: string[];
      merged: string[];
    }
  | { status: 'unsupported'; reason: string };

const LABEL_RE = /^[\x21-\x7E][\x20-\x7E]{0,127}$/;

/**
 * Merges `sources` one after another onto `base` with `git merge-tree` (no working tree, no
 * index) and records each step as a merge commit (never a fast-forward), then creates the NEW
 * branch `branch` at the last merge commit. Stops at the first conflicting source: nothing is
 * created, and the conflicting paths are returned. Throws `conflict` when the branch exists.
 */
export async function mergeIntoNewBranch(input: {
  repoRoot: string;
  branch: string;
  base: string;
  sources: readonly MergeSource[];
  timeoutMs?: number;
}): Promise<MergeIntoBranchResult> {
  assertValidBranchName(input.branch);
  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 64) {
    throw new MindlyError('invalid_input', 'merge needs between 1 and 64 sources');
  }
  for (const s of input.sources) {
    if (typeof s.label !== 'string' || !LABEL_RE.test(s.label)) {
      throw new MindlyError('invalid_input', 'invalid merge source label');
    }
  }
  const version = await gitVersion();
  if (!versionAtLeast(version, MIN_MERGE_TREE_VERSION.major, MIN_MERGE_TREE_VERSION.minor)) {
    return { status: 'unsupported', reason: 'git >= 2.38 is required' };
  }
  const root = await findRepoRoot(input.repoRoot);
  const ref = `refs/heads/${input.branch}`;
  if (await resolveCommit(root, ref)) {
    throw new MindlyError('conflict', 'branch already exists', {
      details: { branch: input.branch },
    });
  }
  const base = await resolveCommit(root, input.base);
  if (!base) throw new MindlyError('not_found', 'merge base not found');
  const commits: string[] = [];
  for (const s of input.sources) {
    const c = await resolveCommit(root, s.ref);
    if (!c)
      throw new MindlyError('not_found', 'merge source not found', { details: { label: s.label } });
    commits.push(c);
  }
  const overrides = await driverOverrides(root);
  const timeoutMs = input.timeoutMs ?? 120_000;
  let acc = base;
  const merged: string[] = [];
  for (let i = 0; i < input.sources.length; i++) {
    const source = input.sources[i] as MergeSource;
    const commit = commits[i] as string;
    const res = await runGit(
      ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', acc, commit],
      { cwd: root, config: overrides, timeoutMs, okExitCodes: [1] },
    );
    const parsed = parseMergeTreeOutput(res.stdout);
    if (!/^[0-9a-f]{40,64}$/.test(parsed.tree)) {
      throw new MindlyError('internal', 'unexpected merge-tree output');
    }
    if (res.exitCode === 1) {
      return { status: 'conflicted', label: source.label, paths: parsed.conflicts, merged };
    }
    acc = await commitTree(
      root,
      parsed.tree,
      [acc, commit],
      `Merge ${source.label} into ${input.branch}`,
    );
    merged.push(source.label);
  }
  const created = await runGit(['update-ref', '--stdin', '-m', 'mindly split merge'], {
    cwd: root,
    input: `create ${ref} ${acc}\n`,
    okExitCodes: [128],
  });
  if (created.exitCode !== 0) {
    throw new MindlyError('conflict', 'branch already exists', {
      details: { branch: input.branch },
    });
  }
  return { status: 'merged', branch: input.branch, commit: acc, merged };
}
