/*
 * `npx mindly-cli init` (or `pnpm dlx`, `bunx`) runs Mindly from a package runner's cache. Hooks
 * and MCP entries must not point there: the cache is disposable, and asking the runner to start
 * Mindly on every hook would make each one wait for the npm registry. Instead `init` copies the
 * runner's package tree (Mindly and its dependencies) into the Mindly home and agents run a small
 * launcher there:
 *
 *   $MINDLY_HOME/bin/mindly.cjs         the launcher every agent config names; never moves
 *   $MINDLY_HOME/runtime/.mindly        written when Mindly creates `runtime`; nothing else is
 *                                       ever deleted
 *   $MINDLY_HOME/runtime/current        the CLI entry the launcher starts, relative to `runtime`
 *   $MINDLY_HOME/runtime/<version>/     a copy of the runner's `node_modules`, stamped complete
 *
 * No network, no shell, and it survives `npm cache clean`. When the copy is gone (deleted by
 * hand, or by `mindly uninstall` while another project still has hooks), the launcher ends hooks
 * and the status line quietly with success, like any other hook failure.
 */
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  rmSync,
} from 'node:fs';
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

/** The folder holding Mindly's copies: only Mindly creates it, and only it is ever cleared. */
export function runtimeDir(home: string): string {
  return join(home, 'runtime');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** True when `entry` is a copy kept in the Mindly home. */
export function isKeptCopy(home: string, entry: string): boolean {
  return inside(real(runtimeDir(home)), real(entry));
}

/** Written when Mindly creates the runtime folder; without it the folder is not Mindly's. */
const MARKER = '.mindly';
/** Written into a copy last, once everything else is in place: the files it holds and their sizes. */
const COMPLETE = '.complete';
/** Names Mindly gives the entries of the runtime folder. */
const VERSION_NAME_RE = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/;

/**
 * The runtime folder when it is a real folder Mindly created (it carries the marker), else null.
 * A link, or a folder someone else made, is never touched.
 */
export function ownedRuntime(home: string): string | null {
  const dir = runtimeDir(home);
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    return lstatSync(join(dir, MARKER)).isFile() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Creates the runtime folder with its marker, or checks that the existing one is Mindly's.
 * Throws when the name is taken by anything else.
 */
async function claimRuntime(home: string): Promise<string> {
  const dir = runtimeDir(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, MARKER), 'Copies of Mindly kept by `mindly init`.\n', {
      mode: 0o600,
    });
    return dir;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Another init may have created it a moment ago and not written the marker yet.
  for (let i = 0; i < 20 && ownedRuntime(home) === null; i++) {
    await new Promise((done) => setTimeout(done, 50));
  }
  if (ownedRuntime(home) === null) {
    throw new Error(`${dir} already exists and was not made by Mindly`);
  }
  return dir;
}

/**
 * Removes what Mindly put in its runtime folder (version folders, unfinished copies, the pointer
 * and the marker), then the folder itself if nothing else is left in it. Returns the folder when
 * it was Mindly's, else null without touching anything.
 */
export function removeRuntime(home: string): string | null {
  const dir = ownedRuntime(home);
  if (dir === null) return null;
  for (const name of readdirSync(dir)) {
    const known =
      name === 'current' || name.startsWith('.tmp-') || name.startsWith('current.')
        ? true
        : VERSION_NAME_RE.test(name) && existsSync(join(dir, name, 'node_modules'));
    if (known) rmSync(join(dir, name), { recursive: true, force: true });
  }
  rmSync(join(dir, MARKER), { force: true });
  try {
    rmdirSync(dir);
  } catch {
    // something else is in it: leave it
  }
  return dir;
}

/**
 * The launcher. CommonJS without dependencies, so it loads on any Node. It starts the copy named
 * in `runtime/current` after checking the name stays inside `runtime` and leads to Mindly's
 * `mindly-cli/dist/main.js`. When anything is wrong, `hook` and `statusline` end with exit 0 and
 * no output, and any other command prints one line and exits 1.
 */
const LAUNCHER = `#!/usr/bin/env node
// Written by \`mindly init\`. Starts the copy of Mindly named in ../runtime/current.
'use strict';
const quiet = process.argv[2] === 'hook' || process.argv[2] === 'statusline';
if (quiet) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}
function fail(why) {
  if (!quiet) {
    process.stderr.write(
      'Mindly could not start (' + why + '). Run npx mindly-cli init again, or install it with npm i -g mindly-cli.\\n',
    );
  }
  process.exit(quiet ? 0 : 1);
}
let entry;
try {
  const { readFileSync, realpathSync, statSync } = require('node:fs');
  const { join, relative, isAbsolute, resolve } = require('node:path');
  const runtime = realpathSync(join(__dirname, '..', 'runtime'));
  const named = readFileSync(join(runtime, 'current'), 'utf8').trim();
  entry = realpathSync(resolve(runtime, named));
  const rel = relative(runtime, entry);
  if (named === '' || rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error();
  if (!/[\\\\/]mindly-cli[\\\\/]dist[\\\\/]main\\.js$/.test(entry)) throw new Error();
  if (!statSync(entry).isFile()) throw new Error();
} catch {
  fail('its files are missing or damaged');
}
import(require('node:url').pathToFileURL(entry).href).catch((err) =>
  fail((err && err.code) || 'it did not load'),
);
`;

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

/** Writes the launcher and points it at `entry`, a copy in the runtime folder. */
export async function pointLauncherAt(home: string, entry: string): Promise<void> {
  const dir = await claimRuntime(home);
  await writeAtomic(join(dir, 'current'), `${relative(dir, entry).replace(/\\/g, '/')}\n`);
  await writeAtomic(launcherPath(home), LAUNCHER);
}

/**
 * The folders a copy of `version` may use, in order: `<version>`, then `<version>-<n>` for when a
 * name is taken by a copy with another layout (the same version copied from `npx` and from
 * `pnpm dlx`) or by a damaged copy.
 */
function copyDirs(home: string, version: string): string[] {
  return Array.from({ length: 20 }, (_, i) =>
    join(runtimeDir(home), i === 0 ? version : `${version}-${i + 1}`),
  );
}

/**
 * True when the copy in `dir` is complete: it was finished, and every file listed in its stamp
 * (written last, after the copy) is still there with the same size. Catches a copy that lost or
 * truncated files after it was made.
 */
export function copyIntact(dir: string, tree: RunnerTree): boolean {
  if (!existsSync(join(dir, 'node_modules', tree.entry))) return false;
  let listed: string[];
  try {
    listed = readFileSync(join(dir, COMPLETE), 'utf8').split('\n');
  } catch {
    return false;
  }
  for (const line of listed) {
    if (line === '') continue;
    const tab = line.lastIndexOf('\t');
    const path = join(dir, line.slice(0, tab));
    const size = line.slice(tab + 1);
    try {
      const st = size === 'link' ? lstatSync(path) : statSync(path);
      if (size === 'link' ? !st.isSymbolicLink() : !st.isFile() || String(st.size) !== size) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return listed.length > 1;
}

/**
 * Where the copy of `tree` for `version` is or would go: the first folder holding an intact copy
 * of the same layout, or else the first free name. The one place that decides it.
 */
export function copyDir(home: string, version: string, tree: RunnerTree): string | null {
  for (const dir of copyDirs(home, version)) {
    if (!existsSync(dir) || copyIntact(dir, tree)) return dir;
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
  files: string[],
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
        files.push(`${relative(dirname(destRoot), d)}\tlink`);
      } else if ((await stat(target)).isDirectory()) {
        await copyTree(target, d, srcRoot, destRoot, copying, files);
      } else {
        await copyFile(target, d);
        files.push(`${relative(dirname(destRoot), d)}\t${(await stat(d)).size}`);
      }
    } else if (e.isDirectory()) {
      await copyTree(s, d, srcRoot, destRoot, copying, files);
    } else if (e.isFile()) {
      await copyFile(s, d);
      files.push(`${relative(dirname(destRoot), d)}\t${(await stat(d)).size}`);
    }
  }
  copying.delete(here);
}

/** Leftovers of copies that were interrupted, old enough not to be another init at work. */
async function removeStaleTemps(dir: string): Promise<void> {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith('.tmp-')) continue;
    const path = join(dir, name);
    try {
      if ((await stat(path)).mtimeMs < hourAgo) await rm(path, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Makes sure an intact copy of `tree` for `version` exists in the runtime folder, points the
 * launcher at it and returns its CLI entry. The copy is made in a temporary folder, stamped
 * complete and renamed into place. A damaged copy is not reused: a fresh one goes to the next
 * free name. When another init renamed a folder into place first, that folder is checked again
 * and used if it holds an intact copy of the same layout.
 */
export async function ensureCopy(home: string, version: string, tree: RunnerTree): Promise<string> {
  const existing = copyDir(home, version, tree);
  if (existing !== null && existsSync(existing)) {
    const entry = join(existing, 'node_modules', tree.entry);
    await pointLauncherAt(home, entry);
    return entry;
  }
  const dir = await claimRuntime(home);
  await removeStaleTemps(dir);
  const tmp = await mkdtemp(join(dir, `.tmp-${version}-`));
  try {
    const srcRoot = await realpath(tree.root);
    const destRoot = join(tmp, 'node_modules');
    const files: string[] = [];
    await copyTree(srcRoot, destRoot, srcRoot, destRoot, new Set(), files);
    await writeFile(join(tmp, COMPLETE), `${files.join('\n')}\n`);
    if (!copyIntact(tmp, tree)) throw new Error(`the copy of ${tree.entry} is incomplete`);
    for (const target of copyDirs(home, version)) {
      if (!existsSync(target)) {
        try {
          await rename(tmp, target);
        } catch {
          // another init got there first: look at what it left
        }
      }
      if (copyIntact(target, tree)) {
        const entry = join(target, 'node_modules', tree.entry);
        await pointLauncherAt(home, entry);
        return entry;
      }
    }
    throw new Error(`no free folder for version ${version} in ${dir}`);
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
