import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { UserConfig } from '@mindly/core';
import type { GitPort, LlmPort, NotifierPort } from '@mindly/engine';
import {
  addWorktree,
  branchExists,
  buildImportGraph,
  captureCheckpoint,
  captureWorktreeCommit,
  changedFiles,
  createBisectWorkspace,
  checkpointDiskUsage,
  checkpointRefName,
  branchOnlyWork,
  createSnapshotRef,
  deleteCheckpointRefs,
  currentBranch,
  deleteBranch,
  diffExportSurface,
  extractExports,
  fileAtRef,
  fileStateAtRef,
  findRepoRoot,
  flaggedChanges,
  ignoredDeniedFiles,
  keepNestedRepos,
  keptReposDir,
  nestedRepoPaths,
  headCommit,
  hunkHashes,
  isManifestPath,
  languageOf,
  listCheckpointRefs,
  listFiles,
  materializeTree,
  mergeIntoNewBranch,
  openWarmWorkspace,
  removeWarmWorkspace,
  removeWorktree,
  restoreFromHead,
  restoreSnapshotToBranch,
  runChecks,
  runGit,
  shadowMerge,
  stepChanges,
  tryLockCheckpoint,
  worktreeId,
  assertValidBranchName,
  type ExportedSymbol,
  type ImportGraph,
} from '@mindly/git';
import type { CheckpointGitPort, SplitGitPort, StepGitPort } from '@mindly/engine';

/** `CheckpointGitPort` backed by `@mindly/git`. Errors propagate: the checkpoint service fails open. */
export function createCheckpointGitPort(): CheckpointGitPort {
  return {
    worktreeRoot: async (cwd) => {
      try {
        return realpathSync.native(await findRepoRoot(cwd));
      } catch {
        return null;
      }
    },
    worktreeId: (worktree) => worktreeId(worktree),
    refName: (worktree, seq) => checkpointRefName(worktree, seq),
    capture: (input) => captureCheckpoint(input),
    listRefs: (repoDir) => listCheckpointRefs(repoDir),
    deleteRefs: (repoDir, refs) => deleteCheckpointRefs(repoDir, refs),
    diskUsage: (repoDir) => checkpointDiskUsage(repoDir),
    tryLock: (lockFile) => tryLockCheckpoint(lockFile),
  };
}

/** `StepGitPort` backed by `@mindly/git`. Errors propagate: bisect and the sentinel report them. */
export function createStepGitPort(): StepGitPort {
  return {
    scratch: (repoDir, commit) => createBisectWorkspace(repoDir, commit),
    warm: (repoDir, path, commit) => openWarmWorkspace(repoDir, path, commit),
    removeWarm: (repoDir, path) => removeWarmWorkspace(repoDir, path),
    changedPaths: async (repoDir, from, to) =>
      (await stepChanges(repoDir, from, to)).map((c) => c.path),
    isManifestPath: (path) => isManifestPath(path),
    run: async (dir, command, signal) => {
      const [r] = await runChecks(
        dir,
        [{ name: command.name, argv: command.argv, timeoutSec: command.timeoutSec }],
        signal ? { signal } : {},
      );
      if (!r) throw new Error('the command did not run');
      return {
        name: r.name,
        status: r.status,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        output: r.output,
      };
    },
  };
}

/** A filter keeping the paths that are not in (or one of) the nested repositories `repos`. */
function outsideNestedRepos(repos: readonly { path: string }[]): (path: string) => boolean {
  return (p) => !repos.some((r) => p === r.path || p.startsWith(`${r.path}/`));
}

/** `SplitGitPort` backed by `@mindly/git`. Errors propagate: split commands report them. */
export function createSplitGitPort(): SplitGitPort {
  return {
    listFiles: (repoRoot) => listFiles(repoRoot),
    branchExists: (repoRoot, branch) => branchExists(repoRoot, branch),
    addWorktree: async (repoRoot, path, branch, startPoint) =>
      (await addWorktree(repoRoot, path, branch, startPoint)).path,
    removeWorktree: (repoRoot, path, options) => removeWorktree(repoRoot, path, options),
    restoreFromHead: (_repoRoot, worktree, paths) => restoreFromHead(worktree, paths),
    keepNestedRepos: async (repoRoot, worktree, holding) =>
      keepNestedRepos(worktree, join(await keptReposDir(repoRoot), ...holding)),
    strayWork: async (_repoRoot, worktree, secretDeny) => {
      const untracked = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], {
        cwd: worktree,
        timeoutMs: 120_000,
      });
      // Nested repositories are moved out before the worktree goes: not stray.
      const inRepo = outsideNestedRepos(await nestedRepoPaths(worktree));
      return [
        ...new Set([
          ...untracked.stdout.split('\0').filter((p) => p !== '' && !p.endsWith('/')),
          ...(await ignoredDeniedFiles(worktree, secretDeny)),
        ]),
      ]
        .filter(inRepo)
        .sort();
    },
    deleteBranch: (repoRoot, branch, expectedTip) => deleteBranch(repoRoot, branch, expectedTip),
    branchOnlyWork: (repoRoot, branch, options) => branchOnlyWork(repoRoot, branch, options),
    uncommittedWork: async (repoRoot, worktree, branch, extraDeny, secretDeny) => {
      const captured = await captureWorktreeCommit(worktree, {
        message: 'mindly split status',
        extraDeny,
      });
      const res = await runGit(
        [
          'diff',
          '--name-only',
          '-z',
          '--no-renames',
          `refs/heads/${branch}`,
          captured.commit,
          '--',
        ],
        { cwd: repoRoot, timeoutMs: 30_000 },
      );
      const ignored = await ignoredDeniedFiles(worktree, secretDeny);
      // Edited files flagged skip-worktree or assume-unchanged: neither the capture nor git's
      // status sees them.
      const flagged = await flaggedChanges(worktree, extraDeny);
      // Nested repositories, and what is in them, are moved out whole before the worktree goes:
      // nothing in them is lost, so none of it is listed (a submodule's new commit included).
      const outside = outsideNestedRepos(await nestedRepoPaths(worktree));
      const paths = new Set(
        [
          ...res.stdout.split('\0').filter((p) => p !== ''),
          // Left out of the capture because they are on the deny-list: still work in the worktree.
          ...captured.skipped,
          ...flagged.changed,
        ].filter(outside),
      );
      return {
        paths: [...paths].sort(),
        denied: [...new Set([...captured.skipped, ...ignored, ...flagged.denied])].sort(),
        ignoredDenied: ignored.filter((p) => !paths.has(p) && outside(p)),
      };
    },
    changedSince: async (repoRoot, worktree, base, extraDeny) => {
      const captured = await captureWorktreeCommit(worktree, {
        message: 'mindly split status',
        extraDeny,
      });
      const res = await runGit(
        ['diff', '--name-only', '-z', '--no-renames', base, captured.commit, '--'],
        { cwd: repoRoot, timeoutMs: 30_000 },
      );
      return res.stdout.split('\0').filter((p) => p !== '');
    },
    mergeCheck: async (repoRoot, base, sides, extraDeny) => {
      const captured: { label: string; commit: string }[] = [];
      for (const side of sides) {
        const c = await captureWorktreeCommit(side.worktree, {
          message: `mindly split capture ${side.label}`,
          extraDeny,
        });
        captured.push({ label: side.label, commit: c.commit });
      }
      const result = await shadowMerge({
        repoRoot,
        base,
        sides: [{ label: 'base', commit: base }, ...captured],
      });
      if (!result.supported) {
        return {
          supported: false,
          reason: result.reason,
          clean: false,
          merged: [],
          conflicts: [],
          commit: null,
        };
      }
      return {
        supported: true,
        clean: result.clean,
        merged: result.merged.filter((l) => l !== 'base'),
        conflicts: result.steps
          .filter((s) => s.status === 'conflicted')
          .map((s) => ({ label: s.label, paths: s.conflicts })),
        commit: result.commit,
      };
    },
    mergeBranches: async (repoRoot, into, base, branches) => {
      const r = await mergeIntoNewBranch({
        repoRoot,
        branch: into,
        base,
        sources: branches.map((b) => ({ label: b.label, ref: `refs/heads/${b.branch}` })),
      });
      if (r.status === 'merged') return { status: 'merged', commit: r.commit };
      if (r.status === 'conflicted')
        return { status: 'conflicted', label: r.label, paths: r.paths };
      return { status: 'unsupported', reason: r.reason };
    },
    runChecks: async (repoRoot, commit, checks) => {
      const tree = await materializeTree(repoRoot, commit);
      try {
        const results = await runChecks(
          tree.path,
          checks.map((c) => ({ name: c.name, argv: c.argv, timeoutSec: c.timeoutSec })),
        );
        return results.map((c) => ({
          name: c.name,
          status: c.status,
          exitCode: c.exitCode,
          durationMs: c.durationMs,
          output: c.output,
        }));
      } finally {
        await tree.dispose();
      }
    },
  };
}
import { createLlmHelpers, createProvider } from '@mindly/llm';
import { createNotifier } from '@mindly/notify';

const GRAPH_TTL_MS = 60_000;
const GRAPH_MAX_FILES = 5_000;

/**
 * `GitPort` backed by `@mindly/git`. Every call is fail-soft (errors become null/empty results)
 * because callers run inside agent hooks; the hardened git runner already bounds time and output.
 */
export function createGitPort(): GitPort {
  const graphs = new Map<string, { at: number; graph: Promise<ImportGraph | null> }>();

  const graphFor = (repoRoot: string): Promise<ImportGraph | null> => {
    const cached = graphs.get(repoRoot);
    if (cached && Date.now() - cached.at < GRAPH_TTL_MS) return cached.graph;
    const graph = (async () => {
      try {
        const res = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
          cwd: repoRoot,
          timeoutMs: 5_000,
        });
        const files = res.stdout.split('\0').filter((f) => f.length > 0);
        return await buildImportGraph(repoRoot, files, { maxFiles: GRAPH_MAX_FILES });
      } catch {
        return null;
      }
    })();
    graphs.set(repoRoot, { at: Date.now(), graph });
    return graph;
  };

  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const toSurface = (symbols: readonly ExportedSymbol[]): Map<string, string> =>
    new Map(symbols.map((s) => [s.name, `${s.kind}:${s.signature ?? ''}`]));

  return {
    findRepoRoot: (cwd) => safe(async () => realpathSync(await findRepoRoot(cwd)), null),
    projectRoot: (cwd) =>
      safe(async () => {
        const top = realpathSync(await findRepoRoot(cwd));
        const res = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
          cwd: top,
          timeoutMs: 5_000,
        });
        const common = realpathSync(res.stdout.trim());
        // A normal repository's common dir is `<main worktree>/.git`; linked worktrees share it.
        // Bare repositories (no main worktree) fall back to the worktree's own top level.
        return basename(common) === '.git' ? dirname(common) : top;
      }, null),
    currentBranch: (cwd) => safe(() => currentBranch(cwd), null),
    headCommit: (cwd) => safe(() => headCommit(cwd), null),
    changedFiles: (cwd) => safe(async () => (await changedFiles(cwd)).map((f) => f.path), []),
    fileAtRef: (cwd, ref, path) => safe(() => fileAtRef(cwd, ref, path), null),
    fileStateAtRef: (cwd, ref, path, maxBytes) =>
      safe(() => fileStateAtRef(cwd, ref, path, maxBytes), null),
    hunkHashes: (text) => hunkHashes(text),
    exportSurface: (source, path) => {
      const lang = languageOf(path);
      if (!lang) return null;
      return toSurface(extractExports(source, lang));
    },
    diffExportSurface: (before, after) => {
      const toSymbols = (m: Map<string, string>): ExportedSymbol[] =>
        [...m].map(([name, sig]) => {
          const i = sig.indexOf(':');
          return { name, kind: sig.slice(0, i), signature: sig.slice(i + 1) } as ExportedSymbol;
        });
      const d = diffExportSurface(toSymbols(before), toSymbols(after));
      return {
        added: d.added.map((s) => s.name),
        removed: d.removed.map((s) => s.name),
        changed: d.changed.map((c) => c.name),
      };
    },
    dependentsOf: async (repoRoot, file) => {
      const graph = await graphFor(repoRoot);
      return graph ? graph.dependentsOf(file).slice(0, 500) : [];
    },
    createSnapshotRef: (repoRoot, worktree, id) =>
      safe(async () => {
        const s = await createSnapshotRef(repoRoot, worktree, id);
        return { ref: s.ref, commit: s.commit };
      }, null),
    restoreSnapshotToBranch: async (repoRoot, id, branch) => {
      await restoreSnapshotToBranch(repoRoot, id, branch);
    },
    isMerged: (repoRoot, branch, into) =>
      safe(async () => {
        assertValidBranchName(branch);
        assertValidBranchName(into);
        const res = await runGit(
          ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${into}`],
          { cwd: repoRoot, okExitCodes: [0, 1], timeoutMs: 5_000 },
        );
        return res.exitCode === 0;
      }, false),
    split: createSplitGitPort(),
    checkpoints: createCheckpointGitPort(),
    steps: createStepGitPort(),
  };
}

export function createLlmPort(
  config: UserConfig['llm'],
  env: NodeJS.ProcessEnv = process.env,
): LlmPort {
  const provider = createProvider(config, env);
  const helpers = createLlmHelpers(provider);
  return {
    available: provider.name !== 'none',
    classifyCorrection: (prompt) => helpers.classifyCorrection(prompt),
    summarizeTurn: (input) => helpers.summarizeTurn(input),
  };
}

export function createNotifierPort(config: UserConfig['notify']): NotifierPort {
  const notifier = createNotifier(config);
  return {
    send: async (n) => {
      try {
        await notifier.send(n);
      } catch {
        // Notifications are best-effort.
      }
    },
  };
}
