import { resolve } from 'node:path';
import {
  isDeniedPath,
  resolveInsideRoot,
  type ResolvedProjectPath,
  type Session,
} from '@mindly/core';
import type { Mindly, ProjectContext } from '@mindly/engine';
import { openMindly } from '@mindly/runtime';
import type { CliIo } from './io.js';
import { resolveId } from './ids.js';
import { HintedError } from './util.js';

/** An opened Mindly instance and the project of the working directory. */
export interface ProjectScope {
  mindly: Mindly;
  project: ProjectContext;
}

/** Opens Mindly for a CLI command (no pager notifications), closing it when `fn` settles. */
export async function withMindly<T>(io: CliIo, fn: (mindly: Mindly) => Promise<T> | T): Promise<T> {
  const mindly = openMindly({ env: io.env, disableNotify: true });
  try {
    return await fn(mindly);
  } finally {
    mindly.close();
  }
}

/** Opens Mindly and resolves the project of `io.cwd`. */
export async function withProject<T>(
  io: CliIo,
  fn: (scope: ProjectScope) => Promise<T> | T,
): Promise<T> {
  return withMindly(io, async (mindly) => {
    const project = await mindly.projects.resolve(io.cwd);
    return fn({ mindly, project });
  });
}

/**
 * Resolves a path typed by the user (relative to the working directory) inside the project root
 * and refuses deny-listed paths (`.env`, keys, credentials).
 */
export function projectPath(scope: ProjectScope, cwd: string, input: string): ResolvedProjectPath {
  const resolved = resolveInsideRoot(scope.project.root, resolve(cwd, input));
  if (resolved.rel === '') {
    throw new HintedError(
      'invalid_input',
      `${input} is the project folder itself, not a file in it`,
      'Give a file path, e.g. src/auth.ts',
    );
  }
  const deny = [...scope.mindly.config.redaction.denyPaths, ...scope.project.config.ignore];
  if (isDeniedPath(resolved.rel, deny)) {
    throw new HintedError(
      'forbidden',
      `Mindly never reads ${resolved.rel}: it is on the deny-list (files such as .env, keys and credentials)`,
      'Choose another file; the deny-list is redaction.denyPaths in mindly config get',
    );
  }
  return resolved;
}

/**
 * The session named by `--session` (full, short or prefix id), or the most recently seen session
 * of the project. Throws `not_found` when there is none or it belongs to another project.
 */
export function pickSession(scope: ProjectScope, sessionId: string | undefined): Session {
  const store = scope.mindly.store;
  const pid = scope.project.project.id;
  if (sessionId !== undefined) {
    return store.sessions.get(resolveId(store, 'session', pid, sessionId));
  }
  const latest = store.sessions.list(pid, 1)[0];
  if (!latest) {
    throw new HintedError(
      'not_found',
      'No agent has worked in this project yet.',
      'Start Claude Code, Codex or Cursor here (connect them first with: mindly init).',
    );
  }
  return latest;
}
