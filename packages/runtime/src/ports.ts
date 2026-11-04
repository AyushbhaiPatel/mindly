import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { UserConfig } from '@mindly/core';
import type { GitPort, LlmPort, NotifierPort } from '@mindly/engine';
import {
  buildImportGraph,
  changedFiles,
  createSnapshotRef,
  currentBranch,
  diffExportSurface,
  extractExports,
  fileAtRef,
  findRepoRoot,
  headCommit,
  hunkHashes,
  languageOf,
  restoreSnapshotToBranch,
  runGit,
  assertValidBranchName,
  type ExportedSymbol,
  type ImportGraph,
} from '@mindly/git';
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
