import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MindlyError } from './errors.js';
import { matchesAnyGlob } from './glob.js';
import { DEFAULT_DENY_PATHS } from './redact.js';

/** Directory holding the database, daemon token, logs and user config. */
export function mindlyHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['MINDLY_HOME'];
  if (fromEnv && fromEnv.trim() !== '') {
    if (!isAbsolute(fromEnv)) {
      throw new MindlyError('invalid_input', 'MINDLY_HOME must be an absolute path');
    }
    return resolve(fromEnv);
  }
  return join(homedir(), '.mindly');
}

export interface HomePaths {
  home: string;
  db: string;
  config: string;
  token: string;
  daemonState: string;
  logs: string;
  run: string;
}

export function homePaths(home: string): HomePaths {
  return {
    home,
    db: join(home, 'mindly.db'),
    config: join(home, 'config.json'),
    token: join(home, 'daemon.token'),
    daemonState: join(home, 'daemon.json'),
    logs: join(home, 'logs'),
    run: join(home, 'run'),
  };
}

/**
 * Creates the Mindly home (and its logs/run subdirectories) with owner-only permissions and
 * tightens permissions if the directory already existed with looser ones.
 */
export function ensureHome(home: string): HomePaths {
  const paths = homePaths(home);
  for (const dir of [paths.home, paths.logs, paths.run]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      const mode = statSync(dir).mode & 0o777;
      if (mode !== 0o700) chmodSync(dir, 0o700);
    }
  }
  return paths;
}

/** Converts a path to POSIX separators (used for every project-relative path we store). */
export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function realpathOrNearest(p: string): string {
  // Resolve symlinks of the deepest existing ancestor so a not-yet-created file inside a
  // symlinked directory is still checked against its real location.
  let current = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return p;
      tail.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

export interface ResolvedProjectPath {
  /** Absolute, symlink-resolved path. */
  abs: string;
  /** Project-relative POSIX path. */
  rel: string;
}

/**
 * Resolves `input` (absolute or relative to `root`) and guarantees the result stays inside the
 * project root after symlink resolution. Throws `path_outside_project` otherwise.
 */
export function resolveInsideRoot(root: string, input: string): ResolvedProjectPath {
  if (input.includes('\0')) {
    throw new MindlyError('invalid_input', 'path contains a NUL byte');
  }
  const realRoot = realpathOrNearest(resolve(root));
  const candidate = realpathOrNearest(
    isAbsolute(input) ? resolve(input) : resolve(realRoot, input),
  );
  const rel = relative(realRoot, candidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return { abs: candidate, rel: toPosix(rel) };
  }
  throw new MindlyError('path_outside_project', 'path resolves outside the project root');
}

/** Like `resolveInsideRoot` but returns null instead of throwing. */
export function tryResolveInsideRoot(root: string, input: string): ResolvedProjectPath | null {
  try {
    return resolveInsideRoot(root, input);
  } catch {
    return null;
  }
}

/** True when Mindly must never read or capture this project-relative path. */
export function isDeniedPath(rel: string, extraDeny: readonly string[] = []): boolean {
  return matchesAnyGlob(rel, DEFAULT_DENY_PATHS) || matchesAnyGlob(rel, extraDeny);
}
