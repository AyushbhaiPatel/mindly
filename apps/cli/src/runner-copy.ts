/*
 * `npx mindly-cli init` (or `pnpm dlx`, `bunx`) runs Mindly from a package runner's cache. Hooks
 * and MCP entries must not point there: the cache is disposable, and asking the runner to start
 * Mindly on every hook would make each one wait for the npm registry. Instead `init` copies the
 * runner's package tree (Mindly and its dependencies) into the Mindly home and agents run a small
 * launcher there:
 *
 *   $MINDLY_HOME/bin/mindly.cjs     the launcher every agent config names; never moves
 *   $MINDLY_HOME/lib/.mindly        marks `lib` as Mindly's, so only it is ever deleted
 *   $MINDLY_HOME/lib/current        the CLI entry the launcher starts, relative to `lib`
 *   $MINDLY_HOME/lib/<version>/     a copy of the runner's `node_modules`
 *
 * No network, no shell, and it survives `npm cache clean`. When the copy is gone (deleted by
 * hand, or by `mindly uninstall` while another project still has hooks), the launcher ends hooks
 * and the status line quietly with success, like any other hook failure.
 */
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';

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

/** A package tree in a runner's cache: its outermost `node_modules` and the CLI entry inside it. */
export interface RunnerTree {
  /** The cache entry's `node_modules` directory. */
  root: string;
  /** The CLI entry point, relative to {@link root}. */
  entry: string;
}

/**
 * The package tree `entry` runs from when it is in a runner's cache, else null (installed
 * package, monorepo checkout, or a cache without a `node_modules` tree to copy).
 */
export function runnerTree(entry: string): RunnerTree | null {
  const file = real(entry);
  // Backslashes become slashes one for one, so indexes into `p` are indexes into `file`.
  const p = file.replace(/\\/g, '/');
  let from = -1;
  for (const re of RUNNER_CACHES) {
    const m = re.exec(p);
    if (m && (from === -1 || m.index < from)) from = m.index;
  }
  if (from === -1) return null;
  const at = p.indexOf('/node_modules/', from);
  if (at === -1) return null;
  const root = file.slice(0, at + '/node_modules'.length);
  return { root, entry: relative(root, file) };
}

/** The launcher agents run: `node <this> <args>`. */
export function launcherPath(home: string): string {
  return join(home, 'bin', 'mindly.cjs');
}

function libDir(home: string): string {
  return join(home, 'lib');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** True when `entry` is a copy kept under `<home>/lib`. */
export function isKeptCopy(home: string, entry: string): boolean {
  return inside(real(libDir(home)), real(entry));
}

/** Marker naming `lib` as Mindly's: uninstall deletes `lib` only when it carries it. */
const MARKER = '.mindly';

/**
 * `<home>/lib` when it is a real folder Mindly created (it carries the marker), else null. A link
 * or a folder Mindly did not create (`MINDLY_HOME=~/.local`) is never deleted.
 */
export function ownedLib(home: string): string | null {
  const lib = libDir(home);
  try {
    if (!lstatSync(lib).isDirectory()) return null;
    return lstatSync(join(lib, MARKER)).isFile() ? lib : null;
  } catch {
    return null;
  }
}

/**
 * The launcher. CommonJS without dependencies, so it loads on any Node. It starts the entry named
 * in `lib/current`; when that fails to load, `hook` and `statusline` end with exit 0 and no
 * output, and any other command prints one line and exits 1.
 */
const LAUNCHER = `#!/usr/bin/env node
// Written by \`mindly init\`. Starts the copy of Mindly named in ../lib/current.
'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const quiet = process.argv[2] === 'hook' || process.argv[2] === 'statusline';
function fail(why) {
  if (!quiet) {
    process.stderr.write(
      'Mindly could not start (' + why + '). Run npx mindly-cli init again, or install it with npm i -g mindly-cli.\\n',
    );
  }
  process.exit(quiet ? 0 : 1);
}
if (quiet) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}
let entry;
try {
  const lib = join(__dirname, '..', 'lib');
  entry = join(lib, readFileSync(join(lib, 'current'), 'utf8').trim());
} catch {
  fail('its files are gone');
}
import(pathToFileURL(entry).href).catch((err) => fail((err && err.code) || 'it did not load'));
`;

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

/** Writes the launcher and points it at `entry` (a copy under `<home>/lib`). */
export async function pointLauncherAt(home: string, entry: string): Promise<void> {
  const lib = libDir(home);
  await writeAtomic(join(lib, MARKER), 'Copies of Mindly kept by `mindly init`.\n');
  await writeAtomic(join(lib, 'current'), `${relative(lib, entry).replace(/\\/g, '/')}\n`);
  await writeAtomic(launcherPath(home), LAUNCHER);
}

/**
 * The folders under `<home>/lib` a copy of `tree` for `version` may use, in order: `<version>`,
 * then `<version>-<n>` for when a name is taken by a copy with another layout (the same version
 * copied from `npx` and from `pnpm dlx`).
 */
function copyDirs(home: string, version: string): string[] {
  return Array.from({ length: 20 }, (_, i) =>
    join(libDir(home), i === 0 ? version : `${version}-${i + 1}`),
  );
}

/** Where the copy of `tree` for `version` is or would go: the one place that decides it. */
export function copyDir(home: string, version: string, tree: RunnerTree): string | null {
  for (const dir of copyDirs(home, version)) {
    if (!existsSync(dir) || existsSync(join(dir, 'node_modules', tree.entry))) return dir;
  }
  return null;
}

/**
 * Copies the tree at `src` to `dest` with plain file operations. A symlink to a place inside the
 * tree stays a relative link on POSIX; anything else behind a link (outside the tree, or any link
 * on Windows, where links need privileges) is copied as files. A link back to a folder being
 * copied is skipped, so cycles end.
 */
async function copyTree(
  src: string,
  dest: string,
  srcRoot: string,
  destRoot: string,
  copying: Set<string>,
): Promise<void> {
  const here = await realpath(src);
  if (copying.has(here)) return;
  copying.add(here);
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(s);
      } catch {
        continue; // dangling link: nothing to copy
      }
      if (process.platform !== 'win32' && inside(srcRoot, target)) {
        await symlink(relative(dirname(d), join(destRoot, relative(srcRoot, target))), d);
      } else if ((await stat(target)).isDirectory()) {
        await copyTree(target, d, srcRoot, destRoot, copying);
      } else {
        await copyFile(target, d);
      }
    } else if (e.isDirectory()) {
      await copyTree(s, d, srcRoot, destRoot, copying);
    } else if (e.isFile()) {
      await copyFile(s, d);
    }
  }
  copying.delete(here);
}

/** Leftovers of copies that were interrupted, old enough not to be another init at work. */
async function removeStaleTemps(lib: string): Promise<void> {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  for (const name of await readdir(lib).catch(() => [] as string[])) {
    if (!name.startsWith('.tmp-')) continue;
    const path = join(lib, name);
    try {
      if ((await stat(path)).mtimeMs < hourAgo) await rm(path, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Makes sure a copy of `tree` for `version` exists under `<home>/lib`, points the launcher at it
 * and returns its CLI entry. The copy is made in a temporary folder and renamed into place, so a
 * folder under `lib` is either complete or absent. When another init renamed a folder into place
 * first, its copy is used if it has the same layout, else the next free name.
 */
export async function ensureCopy(home: string, version: string, tree: RunnerTree): Promise<string> {
  const existing = copyDir(home, version, tree);
  if (existing !== null && existsSync(join(existing, 'node_modules', tree.entry))) {
    const entry = join(existing, 'node_modules', tree.entry);
    await pointLauncherAt(home, entry);
    return entry;
  }
  const lib = libDir(home);
  await mkdir(lib, { recursive: true, mode: 0o700 });
  await removeStaleTemps(lib);
  const tmp = await mkdtemp(join(lib, `.tmp-${version}-`));
  try {
    const srcRoot = await realpath(tree.root);
    const destRoot = join(tmp, 'node_modules');
    await copyTree(srcRoot, destRoot, srcRoot, destRoot, new Set());
    if (!existsSync(join(destRoot, tree.entry))) {
      throw new Error(`the copy has no ${tree.entry}`);
    }
    for (const dir of copyDirs(home, version)) {
      const entry = join(dir, 'node_modules', tree.entry);
      if (existsSync(entry)) {
        await pointLauncherAt(home, entry);
        return entry;
      }
      if (existsSync(dir)) continue; // another layout
      try {
        await rename(tmp, dir);
      } catch {
        continue; // another init got there first: look at what it left
      }
      await pointLauncherAt(home, entry);
      return entry;
    }
    throw new Error(`no free folder for version ${version} in ${lib}`);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
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
