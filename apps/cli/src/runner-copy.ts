/*
 * `npx mindly-cli init` (or `pnpm dlx`, `bunx`) runs Mindly from a package runner's cache. Hooks
 * and MCP entries must not point there: the cache is disposable, and asking the runner to start
 * Mindly on every hook would make each one wait for the npm registry. Instead `init` copies the
 * runner's package tree (Mindly and its dependencies) into the Mindly home, once per version, and
 * agents run `node <copy>/node_modules/mindly-cli/dist/main.js`: no network, no shell, and it
 * survives `npm cache clean`.
 */
import { existsSync, realpathSync } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

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

/**
 * The folder under `<home>/lib` that holds (or will hold) the copy of `tree` for `version`:
 * `<version>`, or `<version>-<n>` when that name is taken by a copy with another layout (the same
 * version copied from `npx` and from `pnpm dlx`).
 */
export function copyDir(home: string, version: string, tree: RunnerTree): string {
  for (let n = 1; n <= 20; n++) {
    const dir = join(home, 'lib', n === 1 ? version : `${version}-${n}`);
    if (!existsSync(dir) || existsSync(join(dir, 'node_modules', tree.entry))) return dir;
  }
  return join(home, 'lib', `${version}-${process.pid}`);
}

/** The CLI entry inside the copy of `tree`. */
export function copiedEntry(home: string, version: string, tree: RunnerTree): string {
  return join(copyDir(home, version, tree), 'node_modules', tree.entry);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Copies the tree at `src` to `dest` with plain file operations. A symlink inside the tree
 * becomes a link to the same place in the copy (relative on POSIX; a junction to `finalRoot`,
 * where the copy ends up, on Windows); one pointing outside it is copied as files.
 */
async function copyTree(
  src: string,
  dest: string,
  srcRoot: string,
  finalRoot: string,
  destRoot: string,
): Promise<void> {
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
      const isDir = (await stat(target)).isDirectory();
      if (!inside(srcRoot, target)) {
        await cp(target, d, { recursive: true, dereference: true });
      } else if (process.platform === 'win32') {
        if (isDir) await symlink(join(finalRoot, relative(srcRoot, target)), d, 'junction');
        else await copyFile(target, d);
      } else {
        await symlink(relative(dirname(d), join(destRoot, relative(srcRoot, target))), d);
      }
    } else if (e.isDirectory()) {
      await copyTree(s, d, srcRoot, finalRoot, destRoot);
    } else if (e.isFile()) {
      await copyFile(s, d);
    }
  }
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
 * Makes sure the copy of `tree` for `version` exists under `<home>/lib` and returns its CLI entry.
 * The copy is made in a temporary folder and renamed into place, so a folder under `lib` is either
 * complete or absent; when another init finished the same copy first, that one is used.
 */
export async function ensureCopy(home: string, version: string, tree: RunnerTree): Promise<string> {
  const dir = copyDir(home, version, tree);
  const entry = join(dir, 'node_modules', tree.entry);
  if (existsSync(entry)) return entry;
  const lib = join(home, 'lib');
  await mkdir(lib, { recursive: true, mode: 0o700 });
  await removeStaleTemps(lib);
  const tmp = await mkdtemp(join(lib, `.tmp-${version}-`));
  try {
    const srcRoot = await realpath(tree.root);
    const destRoot = join(tmp, 'node_modules');
    await copyTree(srcRoot, destRoot, srcRoot, join(dir, 'node_modules'), destRoot);
    if (!existsSync(join(destRoot, tree.entry))) {
      throw new Error(`the copy has no ${tree.entry}`);
    }
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    if (existsSync(entry)) return entry;
    throw err;
  }
  return entry;
}
