import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';

/*
 * The sentinel's per-checkout lock. A pass can run a test suite and a bisect for many minutes,
 * so unlike the checkpoint lock (30 s), its staleness is decided by whether the process that
 * holds it is still alive, not by its age. A lock older than `maxAgeMs` is stale anyway, so a
 * reused PID cannot keep a checkout locked forever.
 */

/** A lock nobody can hold longer than this (a pass is bounded far below it). */
export const SENTINEL_LOCK_MAX_AGE_MS = 24 * 60 * 60_000;

export interface ProcessLock {
  release(): void;
}

/** True when a process with this PID exists (EPERM: it exists, owned by someone else). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The PID written in a lock file, or null when it cannot be read. */
function holder(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock at `file` without waiting (create-exclusive), or returns null while a live
 * process holds it. A lock whose holder is gone, or older than `maxAgeMs`, is taken over.
 */
export function tryProcessLock(
  file: string,
  opts: { maxAgeMs?: number; alive?: (pid: number) => boolean; now?: () => number } = {},
): ProcessLock | null {
  const maxAge = opts.maxAgeMs ?? SENTINEL_LOCK_MAX_AGE_MS;
  const alive = opts.alive ?? processAlive;
  const now = opts.now ?? Date.now;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          // Only our own lock is removed (it may have been taken over after `maxAgeMs`).
          if (holder(file) !== process.pid) return;
          try {
            unlinkSync(file);
          } catch {
            // already gone
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const pid = holder(file);
        const old = now() - statSync(file).mtimeMs > maxAge;
        // A lock being written right now has no PID yet: treat it as held.
        if (!old && (pid === null || alive(pid))) return null;
        unlinkSync(file);
      } catch {
        return null;
      }
    }
  }
  return null;
}
