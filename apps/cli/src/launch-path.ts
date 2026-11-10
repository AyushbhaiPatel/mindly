/*
 * Paths `mindly init` writes into agent configs must keep working after the command that wrote
 * them is gone: not a package runner's cache, which npm may clear at any time, and not a Node
 * path that the next Node upgrade removes.
 */
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const RUNNER_CACHES = [/\/_npx\//, /\/dlx[-/]/, /\/\.bun\/install\/cache\//, /\/bunx-[^/]+\//];

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when `path` lies in the temporary cache of a package runner (`npx`, `pnpm dlx`,
 * `yarn dlx`, `bunx`) rather than in an installed package.
 */
export function inRunnerCache(path: string): boolean {
  const p = real(path).replace(/\\/g, '/');
  return RUNNER_CACHES.some((re) => re.test(p));
}

/**
 * Why `init` will not connect agents when the CLI runs from `entry`, or null when it can. Hooks
 * and MCP entries pointing into a package runner's cache break as soon as the cache is cleared.
 */
export function runnerCacheRefusal(entry: string): string | null {
  if (!inRunnerCache(entry)) return null;
  return 'Mindly is running from a temporary package cache (npx, pnpm dlx or bunx) that npm can delete at any time, so hooks pointing there would break. Install it for good, then connect your agents: npm i -g mindly-cli && mindly init';
}

/** Well-known places of a Node that stays put across upgrades (Homebrew, installers, distros). */
const STABLE_NODES = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/home/linuxbrew/.linuxbrew/bin/node',
  '/usr/bin/node',
];

/** Paths that change with each Node version, or only live as long as one shell. */
const VERSIONED = /[\\/](v?\d+\.\d+\.\d+|Cellar|fnm_multishells)[\\/]/;

/**
 * The path to record for the Node running now. `process.execPath` is the resolved binary, which
 * for Homebrew, nvm or fnm names the version (`Cellar/node/22.x/bin/node`) and disappears with
 * the next upgrade. A stable path that resolves to the same binary is preferred: a well-known
 * location first (agents started from a GUI may not have the user's PATH), then `node` on PATH.
 */
export function stableNode(
  env: NodeJS.ProcessEnv,
  execPath: string = process.execPath,
  wellKnown: readonly string[] = STABLE_NODES,
): string {
  if (process.platform === 'win32') return execPath;
  const target = real(execPath);
  const onPath = (env['PATH'] ?? '')
    .split(delimiter)
    .filter((d) => isAbsolute(d))
    .slice(0, 256)
    .map((d) => join(d, 'node'));
  for (const candidate of [...wellKnown, ...onPath]) {
    if (VERSIONED.test(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === target) return candidate;
    } catch {
      // not there
    }
  }
  return execPath;
}
