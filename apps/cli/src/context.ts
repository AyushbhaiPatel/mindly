import { resolve } from 'node:path';
import {
  isDeniedPath,
  MindlyError,
  resolveInsideRoot,
  type ResolvedProjectPath,
  type Session,
} from '@mindly/core';
import type { Mindly, ProjectContext } from '@mindly/engine';
import { openMindly } from '@mindly/runtime';
import type { CliIo } from './io.js';
import { requireId } from './util.js';

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
  if (resolved.rel === '')
    throw new MindlyError('invalid_input', 'path must be inside the project');
  const deny = [...scope.mindly.config.redaction.denyPaths, ...scope.project.config.ignore];
  if (isDeniedPath(resolved.rel, deny)) {
    throw new MindlyError('forbidden', 'that path is on the deny-list');
  }
  return resolved;
}

/**
 * The session named by `--session`, or the most recently seen session of the project. Throws
 * `not_found` when there is none or it belongs to another project.
 */
export function pickSession(scope: ProjectScope, sessionId: string | undefined): Session {
  const store = scope.mindly.store;
  if (sessionId !== undefined) {
    const s = store.sessions.find(requireId(sessionId, 'session'));
    if (!s || s.projectId !== scope.project.project.id) {
      throw new MindlyError('not_found', 'session not found in this project');
    }
    return s;
  }
  const latest = store.sessions.list(scope.project.project.id, 1)[0];
  if (!latest) throw new MindlyError('not_found', 'no agent session recorded for this project yet');
  return latest;
}
