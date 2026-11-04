import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { InstallStep } from '@mindly/core';
import { MindlyError, resolveInsideRoot } from '@mindly/core';

/** Result of applying one install step. */
export interface AppliedStep {
  file: string;
  /** Path of the backup of the previous content, or null when the file was new. */
  backup: string | null;
  /** File actually written when `file` is a symlink (followed to the end of the chain), else null. */
  target: string | null;
  /** True when `file` was a symlink to a missing file and that file was created. */
  createdTarget: boolean;
}

/** Options for `applyInstallSteps`. */
export interface ApplyOptions {
  /** Timestamp used in backup names. */
  now?: Date;
  /** Project root of a project-level install: files inside it must not link outside it. */
  projectRoot?: string | null;
}

const MAX_LINK_HOPS = 40;

/**
 * Follows `file` through any chain of symlinks and returns the path that should be written, so
 * links kept by dotfile managers (stow, chezmoi, yadm, …) survive. A link to a missing file
 * resolves to that missing path.
 */
function resolveLinkTarget(file: string): { target: string; dangling: boolean } {
  let current = file;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return { target: current, dangling: current !== file };
    }
    if (!isLink) return { target: current, dangling: false };
    current = resolve(realpathSync(dirname(current)), readlinkSync(current));
  }
  throw new MindlyError('invalid_input', `${file} is a symlink loop or too long a symlink chain`);
}

function timestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Creates missing parent directories with mode 0700; existing directories are left as-is. */
function ensureParentDirs(file: string): void {
  const missing: string[] = [];
  let dir = dirname(file);
  while (!existsSync(dir)) {
    missing.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of missing.reverse()) {
    mkdirSync(d, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(d, 0o700);
  }
}

function isInside(root: string, file: string): boolean {
  const rel = relative(resolve(root), file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function uniqueBackupPath(file: string, stamp: string): string {
  let candidate = `${file}.${stamp}.bak`;
  for (let i = 1; existsSync(candidate); i++) candidate = `${file}.${stamp}-${i}.bak`;
  return candidate;
}

function writeAtomic(file: string, content: string, mode: number): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode, flag: 'wx' });
    if (process.platform !== 'win32') chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}

/**
 * Applies install steps produced by `planInstall` / `planUninstall`.
 *
 * Each file is written atomically (temp file + rename), keeping its existing permission bits (new
 * files get 0600). A file that is a symlink stays a symlink: the file at the end of the link chain
 * is written instead (through a temp file next to it), and a link to a missing file creates it. When a file existed, its previous content is first saved next to it as
 * `<file>.<UTC timestamp>.bak`. Missing parent directories are created with mode 0700.
 *
 * Before writing, the current on-disk content must still equal `step.previous`; otherwise the
 * step is refused with a `conflict` error so concurrent edits (e.g. the agent rewriting its own
 * config) are never clobbered. Steps already applied stay applied.
 */
export function applyInstallSteps(
  steps: readonly InstallStep[],
  options: ApplyOptions = {},
): AppliedStep[] {
  const stamp = timestamp(options.now ?? new Date());
  const projectRoot = options.projectRoot ?? null;
  const applied: AppliedStep[] = [];
  for (const step of steps) {
    if (!isAbsolute(step.file) || step.file.includes('\0')) {
      throw new MindlyError('invalid_input', 'install step path must be absolute');
    }
    const file = resolve(step.file);
    if (file.endsWith(sep))
      throw new MindlyError('invalid_input', 'install step path is a directory');
    const exists = existsSync(file);
    const current = exists ? readFileSync(file, 'utf8') : null;
    if (current !== step.previous) {
      throw new MindlyError(
        'conflict',
        `${file} changed since the install plan was made; re-run the command`,
      );
    }
    const { target, dangling } = resolveLinkTarget(file);
    if (projectRoot !== null && target !== file && isInside(projectRoot, file)) {
      try {
        resolveInsideRoot(projectRoot, target);
      } catch {
        throw new MindlyError(
          'path_outside_project',
          `${file} links outside the project; edit ${target} directly instead`,
        );
      }
    }
    ensureParentDirs(target);
    let backup: string | null = null;
    let mode = 0o600;
    if (exists && current !== null) {
      mode = statSync(target).mode & 0o777;
      backup = uniqueBackupPath(file, stamp);
      writeFileSync(backup, current, { mode: 0o600, flag: 'wx' });
    }
    writeAtomic(target, step.content, mode);
    applied.push({
      file,
      backup,
      target: target === file ? null : target,
      createdTarget: dangling,
    });
  }
  return applied;
}
