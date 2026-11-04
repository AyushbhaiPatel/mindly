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
