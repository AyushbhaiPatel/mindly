/*
 * Ports: the narrow interfaces the engine needs from the outside world. Real implementations
 * (git, model providers, notifications, headless agent runners) are wired in by the entry point;
 * tests use fakes. Keeping these small keeps the engine deterministic and easy to test.
 */

export interface ExportSurfaceDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface GitPort {
  /** Canonical (realpath) top-level directory of the repository containing `cwd`, or null. */
  findRepoRoot(cwd: string): Promise<string | null>;
  /**
   * Root of the repository's *main* working tree, shared by every linked worktree (derived from
   * the git common dir). Sessions in different worktrees of one repository belong to one project.
   * Optional; falls back to `findRepoRoot`.
   */
  projectRoot?(cwd: string): Promise<string | null>;
  currentBranch(cwd: string): Promise<string | null>;
  headCommit(cwd: string): Promise<string | null>;
  /** Project-relative paths with uncommitted changes (staged, unstaged, untracked). */
  changedFiles(cwd: string): Promise<string[]>;
  /** File content at a ref, or null when missing. */
  fileAtRef(cwd: string, ref: string, path: string): Promise<string | null>;
  /** Hashes of normalised non-trivial lines (code provenance). */
  hunkHashes(text: string): string[];
  /** Exported symbols with a coarse signature fingerprint, keyed by name. */
  exportSurface(source: string, path: string): Map<string, string> | null;
  diffExportSurface(before: Map<string, string>, after: Map<string, string>): ExportSurfaceDiff;
  /** Repo-relative files that import `file` (bounded). */
  dependentsOf(repoRoot: string, file: string): Promise<string[]>;
  /**
   * Optional (time machine): records tracked and untracked work of `worktree` under a hidden ref
   * `refs/mindly/snapshots/<id>` without touching the index or working tree. Null when nothing
   * could be captured.
   */
  createSnapshotRef?(
    repoRoot: string,
    worktree: string,
    id: string,
  ): Promise<{ ref: string; commit: string } | null>;
  /** Optional (time machine): creates a *new* branch `branch` pointing at snapshot `id`. */
  restoreSnapshotToBranch?(repoRoot: string, id: string, branch: string): Promise<void>;
  /** Optional (memory branches): whether `branch` is fully merged into `into`. */
  isMerged?(repoRoot: string, branch: string, into: string): Promise<boolean>;
  /** Optional (splits): the operations `mindly split` needs; absent when git is unavailable. */
  split?: SplitGitPort;
  /** Optional (bisect): checkpoints of the working tree after every agent edit. */
  checkpoints?: CheckpointGitPort;
}

/** What one checkpoint capture needs. */
export interface CheckpointCaptureInput {
  /** The working tree (canonical path). */
  worktree: string;
  /** Private index file for this working tree, outside the repository. */
  indexFile: string;
  /** The previous checkpoint, the new commit's parent. */
  parent: { commit: string } | null;
  /** Paths an edit tool touched (only they are refreshed), or null for a full rescan. */
  paths: readonly string[] | null;
  /** Create the commit even when the tree is unchanged. */
  always: boolean;
  ref: string;
  message: string;
  extraDeny: readonly string[];
  timeoutMs: number;
}

/** Result of one checkpoint capture. */
export interface CheckpointCaptureResult {
  /** The new commit, or null when nothing changed and `always` was false. */
  commit: string | null;
  tree: string;
  changed: boolean;
  changedPaths: string[];
  /** Denied paths left out. */
  skipped: string[];
  /** True when the private index did not exist, so the whole tree was scanned. */
  fresh: boolean;
}

/** A checkpoint ref found in a repository. */
export interface CheckpointRefEntry {
  worktreeId: string;
  seq: number;
  ref: string;
  commit: string;
  /** When the checkpoint commit was made (ms since the epoch). */
  createdAt: number;
}

/** Git operations behind checkpoints. Every method may throw a `MindlyError`. */
export interface CheckpointGitPort {
  /** Canonical (`realpath.native`) top-level directory of the working tree containing `cwd`, or null. */
  worktreeRoot(cwd: string): Promise<string | null>;
  /** Stable id of a working tree, as used in its ref names. */
  worktreeId(worktree: string): string;
  /** Ref name of step `seq` of `worktree`. */
  refName(worktree: string, seq: number): string;
  capture(input: CheckpointCaptureInput): Promise<CheckpointCaptureResult>;
  /** Checkpoint refs of the repository containing `repoDir` (any existing directory of it). */
  listRefs(repoDir: string): Promise<CheckpointRefEntry[]>;
  /** Deletes checkpoint refs of the repository containing `repoDir`; missing ones are ignored. */
  deleteRefs(repoDir: string, refs: readonly string[]): Promise<number>;
  /** Approximate bytes checkpoint objects take on disk, or null when unknown. */
  diskUsage(repoDir: string): Promise<number | null>;
  /** Takes the per-worktree lock (a create-exclusive file) without waiting; null when busy. */
  tryLock(lockFile: string): { release(): void } | null;
}

/** One side of a split merge check: a part's worktree. */
export interface SplitMergeSide {
  label: string;
  worktree: string;
}

/** Result of a split merge check (shadow merge of every part's worktree). */
export interface SplitMergeCheck {
  supported: boolean;
  reason?: string;
  clean: boolean;
  /** Sides whose work is in the merged tree. */
  merged: string[];
  /** Sides whose merge conflicted, with the conflicting paths. */
  conflicts: { label: string; paths: string[] }[];
  /** Synthetic commit of the merged tree (every cleanly merging side), or null. */
  commit: string | null;
}

/** Outcome of one check command run against a tree. */
export interface SplitCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/** Git operations behind `mindly split`. Every method may throw a `MindlyError`. */
export interface SplitGitPort {
  /** Tracked and untracked (non-ignored) files of the working tree, repository-relative. */
  listFiles(repoRoot: string): Promise<string[]>;
  branchExists(repoRoot: string, branch: string): Promise<boolean>;
  /** Creates branch `branch` at `startPoint` in a new worktree at `path`; refuses existing ones. */
  addWorktree(repoRoot: string, path: string, branch: string, startPoint: string): Promise<string>;
  /** Removes a linked worktree (and its uncommitted work). False when it was not a worktree. */
  removeWorktree(repoRoot: string, path: string): Promise<boolean>;
  deleteBranch(repoRoot: string, branch: string): Promise<boolean>;
  /** Paths that differ between `base` and the worktree's current content (committed or not). */
  changedSince(repoRoot: string, worktree: string, base: string): Promise<string[]>;
  /** Shadow-merges the sides' worktrees (uncommitted work included) on top of `base`. */
  mergeCheck(
    repoRoot: string,
    base: string,
    sides: readonly SplitMergeSide[],
  ): Promise<SplitMergeCheck>;
  /** Merges `branches` in order onto `base` into the NEW branch `into` with merge commits. */
  mergeBranches(
    repoRoot: string,
    into: string,
    base: string,
    branches: readonly { label: string; branch: string }[],
  ): Promise<
    | { status: 'merged'; commit: string }
    | { status: 'conflicted'; label: string; paths: string[] }
    | { status: 'unsupported'; reason: string }
  >;
  /** Runs the project's checks against `commit` in a temporary tree. */
  runChecks(
    repoRoot: string,
    commit: string,
    checks: readonly { name: string; argv: readonly string[]; timeoutSec: number }[],
  ): Promise<SplitCheckResult[]>;
}

export interface LlmPort {
  readonly available: boolean;
  classifyCorrection(
    prompt: string,
  ): Promise<{ isRule: boolean; rule: string; scopeGlobs: string[]; confidence: number } | null>;
  summarizeTurn(input: {
    prompts: string[];
    filesChanged: string[];
    lastMessage: string | null;
  }): Promise<string | null>;
}

export type NotifyTrigger =
  | 'agent_blocked'
  | 'rate_limited'
  | 'conflict_critical'
  | 'check_failed'
  | 'review_ready'
  | 'standup';

export interface NotifierPort {
  send(n: {
    trigger: NotifyTrigger;
    title: string;
    body: string;
    projectName?: string;
    priority?: 'low' | 'default' | 'high';
    dedupeKey?: string;
  }): Promise<void>;
}

export const nullNotifier: NotifierPort = { send: async () => undefined };

export const nullLlm: LlmPort = {
  available: false,
  classifyCorrection: async () => null,
  summarizeTurn: async () => null,
};

/** Git port that knows nothing; used when git is unavailable. */
export const nullGit: GitPort = {
  findRepoRoot: async () => null,
  currentBranch: async () => null,
  headCommit: async () => null,
  changedFiles: async () => [],
  fileAtRef: async () => null,
  hunkHashes: () => [],
  exportSurface: () => null,
  diffExportSurface: () => ({ added: [], removed: [], changed: [] }),
  dependentsOf: async () => [],
};

export interface Ports {
  git: GitPort;
  llm: LlmPort;
  notifier: NotifierPort;
}
