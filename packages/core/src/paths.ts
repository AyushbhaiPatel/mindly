import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MindlyError } from './errors.js';
import { globToRegExp, matchesAnyGlob } from './glob.js';
import { DEFAULT_DENY_PATHS } from './redact.js';
import { hasUnsafeChars } from './text.js';

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
      // `.native` returns the on-disk case on case-insensitive file systems (macOS), so deny-list
      // checks see `.env` even when the input says `.ENV`.
      const real = realpathSync.native(current);
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
  if (hasUnsafeChars(input) || input.length > 4096) {
    throw new MindlyError('invalid_input', 'path contains control characters or is too long');
  }
  const realRoot = realpathOrNearest(resolve(root));
  const candidate = realpathOrNearest(
    isAbsolute(input) ? resolve(input) : resolve(realRoot, input),
  );
  const rel = relative(realRoot, candidate);
  // Only a `..` segment leaves the root; a name that merely starts with dots (`..cache`) does not.
  const leaves = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!leaves) {
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
  const opts = { nocase: true };
  return matchesAnyGlob(rel, DEFAULT_DENY_PATHS, opts) || matchesAnyGlob(rel, extraDeny, opts);
}

/**
 * {@link isDeniedPath} for many paths: each pattern is compiled once. A pattern without a slash
 * matches the last segment anywhere, as it does there.
 */
export function deniedPathTest(extraDeny: readonly string[] = []): (rel: string) => boolean {
  const opts = { nocase: true };
  let tests: { anywhere: boolean; re: RegExp; tail: string }[];
  try {
    tests = [...DEFAULT_DENY_PATHS, ...extraDeny].map((g) => {
      // What every matching path ends with, compared before the expression is run.
      const last = g.slice(g.lastIndexOf('/') + 1);
      // (None for a pattern with groups or classes: a group may hold a `/`.)
      const tail = /[[{]/.test(g) ? '' : last.slice(last.search(/[^*?]*$/)).toLowerCase();
      return {
        anywhere: !g.includes('/'),
        re: globToRegExp(g.includes('/') ? g.replace(/^\.\//, '') : g, opts),
        tail,
      };
    });
  } catch {
    // A pattern that does not compile is left to the one-path test, which says so.
    return (rel) => isDeniedPath(rel, extraDeny);
  }
  return (rel) => {
    const path = rel.replace(/^\.\//, '');
    const base = path.slice(path.lastIndexOf('/') + 1);
    const lower = path.toLowerCase();
    return tests.some(
      (t) => (t.tail === '' || lower.endsWith(t.tail)) && t.re.test(t.anywhere ? base : path),
    );
  };
}
