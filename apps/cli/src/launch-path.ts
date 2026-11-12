/*
 * Paths `mindly init` writes into agent configs must keep working after the command that wrote
 * them is gone: not a package runner's cache, which npm may clear at any time, and not a Node
 * path that the next Node upgrade removes. They must also be the same whichever shell computes
 * them, since other commands compare the configs with what init would write.
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * The folders package runners install into, by their actual layout rather than a folder name,
 * so a user called `dlx` or a project called `bunx-demo` is not mistaken for one:
 * - npm (npx, npm exec): `<cache>/_npx/<hex hash>/node_modules/`
 * - pnpm dlx 9+: `<cache>/dlx/<base32 hash>/<time>-<pid>/node_modules/`
 * - yarn dlx: `<tmp>/xfs-<hash>/dlx-<pid>/…`; with yarn's default PnP linker the package runs
 *   from its zip in yarn's cache (`.yarn/berry/cache/<package>.zip/…`)
 * - bunx: `<tmp>/bunx-<uid>-<package>@<version>/node_modules/`, or bun's own install cache
 * Anything inside a zip archive counts too: plain Node cannot run it.
 */
const RUNNER_CACHES = [
  /\/_npx\/[0-9a-f]{8,64}\/node_modules\//,
  /\/dlx\/[0-9a-z]{16,64}\/(?:[0-9a-f]+-[0-9a-f]+\/)?node_modules\//,
  /\/xfs-[0-9a-z]+\/dlx-\d+\//,
  /\/bunx-\d+-[^/]+@[^/]+\/node_modules\//,
  /\/\.bun\/install\/cache\//,
  /\/\.yarn\/(?:berry\/)?cache\//,
  /\.zip\//i,
];

/** Older pnpm dlx: `<OS temp dir>/dlx-<pid>/node_modules/`; only under the temp dir. */
const TEMP_DLX = /^\/dlx-\d+\/(?:[^/]+\/)*node_modules\//;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const slashes = (p: string): string => p.replace(/\\/g, '/');

function tempRoots(): string[] {
  const t = tmpdir();
  return [...new Set([t, real(t), '/tmp', '/private/tmp', '/var/tmp'].map(slashes))];
}

function matchesRunner(path: string): boolean {
  const p = slashes(path);
  if (RUNNER_CACHES.some((re) => re.test(p))) return true;
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  return tempRoots().some(
    (root) => fold(p).startsWith(`${fold(root)}/`) && TEMP_DLX.test(p.slice(root.length)),
  );
}

/**
 * True when `path`, as given or once links are resolved, lies in the temporary cache of a
 * package runner (`npx`, `pnpm dlx`, `yarn dlx`, `bunx`) rather than in an installed package.
 * Both are checked: pnpm with a global virtual store links a dlx folder into its store, so only
 * the path as given shows the cache.
 */
export function inRunnerCache(path: string): boolean {
  return matchesRunner(resolve(path)) || matchesRunner(real(path));
}

/**
 * Why `init` will not connect agents when the CLI runs from `paths` (its entry, and the script
 * Node was started with), or null when it can. Hooks and MCP entries pointing into a package
 * runner's cache break as soon as the cache is cleared. When `entryMustExist`, the entry must
 * also be a regular file, which catches layouts no pattern knows (a package inside an archive).
 */
export function runnerCacheRefusal(
  paths: readonly (string | undefined)[],
  entryMustExist = false,
): string | null {
  const advice =
    'Install it for good, then connect your agents: npm i -g mindly-cli && mindly init';
  if (paths.some((p) => p !== undefined && p !== '' && inRunnerCache(p))) {
    return `Mindly is running from a temporary package cache (npx, pnpm dlx, yarn dlx or bunx) that can be deleted at any time, so hooks pointing there would break. ${advice}`;
  }
  const entry = paths[0];
  if (entryMustExist && entry !== undefined) {
    let file = false;
    try {
      file = statSync(entry).isFile();
    } catch {
      // missing, or inside something that is not a folder
    }
    if (!file) {
      return `Mindly is running from ${entry}, which is not a file Node can start, so hooks pointing there would not run. ${advice}`;
    }
  }
  return null;
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
 * the next upgrade. A well-known location that resolves to the same binary is preferred.
 *
 * PATH is deliberately not searched: it differs between a terminal, a GUI-launched agent and a
 * test harness, so the recorded command would change with it. Then `doctor`, `split` and `init`
 * itself, comparing the configs with the command they would write, would see agents connected
 * from another shell as not connected.
 */
export function stableNode(
  execPath: string = process.execPath,
  wellKnown: readonly string[] = STABLE_NODES,
): string {
  if (process.platform === 'win32') return execPath;
  const target = real(execPath);
  for (const candidate of wellKnown) {
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
