/**
 * `@mindly/git`: safe git invocation, side-effect-free work-tree capture, shadow merge, check
 * runner, snapshot refs and deterministic code analysis (exports, imports, import graph, hunk
 * hashes). Depends only on `@mindly/core` and Node built-ins.
 *
 * Every git call goes through `runGit`: `execFile` with an argument array (never a shell), a
 * minimal environment, hooks/fsmonitor/network protocols disabled, a timeout and an output cap.
 */

export {
  DEFAULT_GIT_MAX_BUFFER,
  DEFAULT_GIT_TIMEOUT_MS,
  HARDENING_CONFIG,
  MAX_GIT_TIMEOUT_MS,
  driverOverrides,
  gitVersion,
  hardenedGitEnv,
  parseGitVersion,
  runGit,
  versionAtLeast,
} from './exec.js';
export type { GitResult, GitVersion, RunGitOptions } from './exec.js';

export {
  assertSafeRelativePath,
  assertValidBranchName,
  assertValidRefName,
  assertValidRevision,
  assertValidSnapshotId,
  isObjectId,
  isValidRefName,
  refNameProblem,
} from './refs.js';

export {
  MAX_BLOB_BYTES,
  changedFiles,
  currentBranch,
  diffForFile,
  fileAtRef,
  fileStateAtRef,
  findRepoRoot,
  gitCommonDir,
  headCommit,
  isGitRepo,
  listWorktrees,
  parseStatusV2,
  parseWorktreeList,
  resolveCommit,
} from './repo.js';
export type { ChangeKind, ChangedFile, DiffOptions, FileAtRefState, WorktreeInfo } from './repo.js';

export {
  SYNTHETIC_IDENTITY,
  captureWorktreeCommit,
  commitTree,
  syntheticIdentityEnv,
} from './capture.js';
export type { CaptureOptions, CapturedCommit } from './capture.js';

export {
  MIN_MERGE_TREE_VERSION,
  materializeTree,
  parseMergeTreeOutput,
  shadowMerge,
} from './merge.js';
export type {
  MaterializedTree,
  MergeSide,
  MergeStep,
  ShadowMergeInput,
  ShadowMergeResult,
} from './merge.js';

export {
  addWorktree,
  branchExists,
  branchOnlyWork,
  deleteBranch,
  listFiles,
  mergeIntoNewBranch,
  removeWorktree,
} from './worktrees.js';
export type {
  BranchOnlyCommit,
  BranchOnlyWork,
  MergeIntoBranchResult,
  MergeSource,
} from './worktrees.js';

export { DEFAULT_CHECK_OUTPUT_BYTES, checkEnv, runChecks } from './checks.js';
export type { CheckResult, CheckSpec, CheckStatus, RunChecksOptions } from './checks.js';

export {
  SNAPSHOT_REF_PREFIX,
  createSnapshotRef,
  deleteSnapshotRef,
  listSnapshotRefs,
  restoreSnapshotToBranch,
  snapshotCommit,
  snapshotRefName,
} from './snapshots.js';
export type { CreatedSnapshot, SnapshotRef } from './snapshots.js';

export {
  CHECKPOINT_GIT_TIMEOUT_MS,
  CHECKPOINT_REF_PREFIX,
  STALE_LOCK_MS,
  captureCheckpoint,
  checkpointDiskUsage,
  checkpointRefName,
  deleteCheckpointRefs,
  listCheckpointRefs,
  mirrorRemotes,
  tryLockCheckpoint,
  worktreeId,
} from './checkpoints.js';
export type {
  CheckpointCaptureInput,
  CheckpointCaptureResult,
  CheckpointLock,
  CheckpointRefEntry,
} from './checkpoints.js';

export {
  LOCKFILES,
  MAX_STEP_DIFF_BYTES,
  createBisectWorkspace,
  isManifestPath,
  lockfileIn,
  openWarmWorkspace,
  removeWarmWorkspace,
  revertStep,
  stepChanges,
  stepDiff,
} from './bisect.js';
export type { BisectWorkspace, RevertStepResult, StepPathChange } from './bisect.js';

export { languageOf } from './analysis/language.js';
export type { Language } from './analysis/language.js';
export { MAX_ANALYSIS_BYTES, diffExportSurface, extractExports } from './analysis/exports.js';
export type { ExportKind, ExportSurfaceDiff, ExportedSymbol } from './analysis/exports.js';
export { extractImports } from './analysis/imports.js';
export {
  DEFAULT_GRAPH_MAX_FILES,
  EXCLUDED_DIRS,
  MAX_GRAPH_FILE_BYTES,
  buildImportGraph,
} from './analysis/graph.js';
export type { ImportGraph, ImportGraphOptions } from './analysis/graph.js';
export { MIN_HUNK_LINE_LENGTH, diffLines, hunkHashes, lineHash } from './analysis/hunks.js';
export type { DiffLines } from './analysis/hunks.js';
