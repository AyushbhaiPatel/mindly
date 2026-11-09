import { randomBytes } from 'node:crypto';
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

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

/** What identifies one lock file: inode numbers alone are reused at once on Linux. */
interface LockSeen {
  ino: number;
  mtimeMs: number;
  pid: number | null;
}

/**
 * Moves a stale lock out of the way, atomically: the file is renamed to a name only this call
 * uses, and dropped only when it is still the stale one seen (same inode, time and PID). When
 * another process took the lock over in between, its fresh lock is put back (unless yet another
 * one exists) and this call gives up, so two processes never both believe they hold the lock.
 */
function takeOver(file: string, seen: LockSeen): boolean {
  const aside = `${file}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  renameSync(file, aside);
  const now = statSync(aside);
  if (now.ino === seen.ino && now.mtimeMs === seen.mtimeMs && holder(aside) === seen.pid) {
    unlinkSync(aside);
    return true;
  }
  try {
    linkSync(aside, file);
  } catch {
    // a newer lock exists already: it wins
  }
  unlinkSync(aside);
  return false;
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
        const st = statSync(file);
        const old = now() - st.mtimeMs > maxAge;
        // A lock being written right now has no PID yet: treat it as held.
        if (!old && (pid === null || alive(pid))) return null;
        if (!takeOver(file, { ino: st.ino, mtimeMs: st.mtimeMs, pid })) return null;
      } catch {
        return null;
      }
    }
  }
  return null;
}
