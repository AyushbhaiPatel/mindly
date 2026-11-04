import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { InstallStep } from '@synapse/core';
import { SynapseError } from '@synapse/core';

/** Result of applying one install step. */
export interface AppliedStep {
  file: string;
  /** Path of the backup of the previous content, or null when the file was new. */
  backup: string | null;
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
 * files get 0600). When a file existed, its previous content is first saved next to it as
 * `<file>.<UTC timestamp>.bak`. Missing parent directories are created with mode 0700.
 *
 * Before writing, the current on-disk content must still equal `step.previous`; otherwise the
 * step is refused with a `conflict` error so concurrent edits (e.g. the agent rewriting its own
 * config) are never clobbered. Steps already applied stay applied.
 */
export function applyInstallSteps(
  steps: readonly InstallStep[],
  now: Date = new Date(),
): AppliedStep[] {
  const stamp = timestamp(now);
  const applied: AppliedStep[] = [];
  for (const step of steps) {
    if (!isAbsolute(step.file) || step.file.includes('\0')) {
      throw new SynapseError('invalid_input', 'install step path must be absolute');
    }
    const file = resolve(step.file);
    if (file.endsWith(sep))
      throw new SynapseError('invalid_input', 'install step path is a directory');
    const exists = existsSync(file);
    const current = exists ? readFileSync(file, 'utf8') : null;
    if (current !== step.previous) {
      throw new SynapseError(
        'conflict',
        `${file} changed since the install plan was made; re-run the command`,
      );
    }
    ensureParentDirs(file);
    let backup: string | null = null;
    let mode = 0o600;
    if (exists && current !== null) {
      mode = statSync(file).mode & 0o777;
      backup = uniqueBackupPath(file, stamp);
      writeFileSync(backup, current, { mode: 0o600, flag: 'wx' });
    }
    writeAtomic(file, step.content, mode);
    applied.push({ file, backup });
  }
  return applied;
}
