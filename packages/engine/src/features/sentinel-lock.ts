import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';

/*
 * The sentinel's per-checkout lock. A pass can run a test suite and a bisect for many minutes,
 * so unlike the checkpoint lock (30 s), its staleness is decided by whether the process that
 * took it still holds it, not by its age.
 *
 * A PID alone does not say that: after a crash or a reboot the number is soon used again, and a
 * daemon in a container comes back with the very PID its lock recorded. So a lock also records
 * an id of its own and, where the system tells (Linux), when its process started. It is held
 * while that same process lives; for this process, while this process knows it holds that id. A
 * lock older than `maxAgeMs` is stale anyway.
 */

/** A lock nobody can hold longer than this (a pass is bounded far below it). */
export const SENTINEL_LOCK_MAX_AGE_MS = 24 * 60 * 60_000;
/** A lock file without a readable holder is being written, or was left by a crash: stale after this. */
const UNREADABLE_MAX_AGE_MS = 60_000;
/** A takeover takes microseconds; a guard older than this was left by a crash. */
const GUARD_MAX_AGE_MS = 30_000;

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

let bootId: string | null | undefined;

/**
 * What tells one process from a later one with the same PID: the boot it runs in and its start
 * time in that boot, or null where the system does not expose them (anything but Linux).
 */
export function processIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (bootId === undefined) {
      try {
        bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
      } catch {
        bootId = null;
      }
    }
    if (bootId === null) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) may hold spaces and parentheses: fields are counted after it.
    const start = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(' ')[19];
    return start && /^\d+$/.test(start) ? `${bootId}:${start}` : null;
  } catch {
    return null;
  }
}

/** The lock ids this process holds now, shared by every copy of this module in the process. */
const HELD = Symbol.for('mindly.sentinel.locks');
function heldIds(): Set<string> {
  const g = globalThis as { [HELD]?: Set<string> };
  return (g[HELD] ??= new Set<string>());
}

/** What a lock file records. */
interface Holder {
  pid: number;
  /** The id of this one acquisition, or null in a lock written by an older version. */
  id: string | null;
  /** `processIdentity` of the holder when it took the lock, or null. */
  identity: string | null;
}

/** What identifies one lock file: inode numbers alone are reused at once on Linux. */
interface LockSeen {
  ino: number;
  mtimeMs: number;
  raw: string | null;
}

function readRaw(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The holder written in a lock file, or null when there is none to read. */
function parseHolder(raw: string | null): Holder | null {
  if (raw === null) return null;
  const [first = '', id = '', identity = ''] = raw.split('\n').map((l) => l.trim());
  const pid = Number(first);
  if (!/^\d+$/.test(first) || !Number.isInteger(pid) || pid <= 0) return null;
  return { pid, id: id || null, identity: identity || null };
}

function seenAt(file: string): LockSeen {
  const raw = readRaw(file);
  const st = statSync(file);
  return { ino: st.ino, mtimeMs: st.mtimeMs, raw };
}

const sameLock = (a: LockSeen, b: LockSeen): boolean =>
  a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.raw === b.raw;

function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

/**
 * Moves a stale lock out of the way. Takeovers are serialised by a guard file, and the lock is
 * looked at again under the guard: only the stale lock seen is removed, and never by two
 * processes. The lock is still renamed to a name of this call and compared before it is dropped,
 * so a lock that is not the stale one (its holder outlived `maxAgeMs` and let go just now) is
 * put back, not deleted.
 */
function takeOver(file: string, seen: LockSeen, now: () => number, link: Link): boolean {
  const guard = `${file}.takeover`;
  try {
    closeSync(openSync(guard, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process is taking the lock over right now; a guard left by a crash is cleared
      // for the next attempt.
      try {
        if (now() - statSync(guard).mtimeMs > GUARD_MAX_AGE_MS) unlinkSync(guard);
      } catch {
        // gone meanwhile
      }
    }
    return false;
  }
  try {
    if (!sameLock(seenAt(file), seen)) return false;
    const aside = `${file}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
    renameSync(file, aside);
    try {
      if (sameLock(seenAt(aside), seen)) return true;
      try {
        link(aside, file);
      } catch (err) {
        // EEXIST: a newer lock exists already, and it wins. Anything else: no hard links here,
        // so the lock is moved back instead, unless a newer one took its place.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' && !existsSync(file)) {
          renameSync(aside, file);
        }
      }
      return false;
    } finally {
      unlinkQuiet(aside);
    }
  } catch {
    return false;
  } finally {
    unlinkQuiet(guard);
  }
}

/**
 * Creates the lock file with its content already in it, so no other process ever reads a lock
 * without a holder. False when a lock exists.
 */
function create(file: string, content: string, link: Link): boolean {
  const tmp = `${file}.new-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    try {
      link(tmp, file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      // No hard links here (some network and removable file systems): create it in place.
    }
  } finally {
    unlinkQuiet(tmp);
  }
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (err) {
    // A lock exists: the caller looks at whether it is stale, as on any other file system.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Makes a hard link (`linkSync`); fails on file systems that have none. */
type Link = (existing: string, path: string) => void;

export interface ProcessLockOptions {
  maxAgeMs?: number;
  alive?: (pid: number) => boolean;
  identity?: (pid: number) => string | null;
  /** Makes a hard link; the default is `linkSync`. */
  link?: (existing: string, path: string) => void;
  now?: () => number;
}

/**
 * Takes the lock at `file` without waiting, or returns null while a live process holds it. A
 * lock whose holder is gone (its process ended, or its PID now belongs to another process), or
 * older than `maxAgeMs`, is taken over.
 */
export function tryProcessLock(file: string, opts: ProcessLockOptions = {}): ProcessLock | null {
  const maxAge = opts.maxAgeMs ?? SENTINEL_LOCK_MAX_AGE_MS;
  const alive = opts.alive ?? processAlive;
  const identity = opts.identity ?? processIdentity;
  const now = opts.now ?? Date.now;
  const link = opts.link ?? linkSync;
  const held = heldIds();

  const stillHeld = (h: Holder): boolean => {
    // A lock naming this process that it does not know of was written by an earlier process
    // with the same PID (or by an older version, which this process never is).
    if (h.pid === process.pid) return h.id !== null && held.has(h.id);
    if (!alive(h.pid)) return false;
    if (h.identity === null) return true;
    const current = identity(h.pid);
    return current === null || current === h.identity;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const id = randomBytes(12).toString('hex');
    try {
      held.add(id);
      if (create(file, [process.pid, id, identity(process.pid) ?? ''].join('\n'), link)) {
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            held.delete(id);
            // Only our own lock is removed (it may have been taken over after `maxAgeMs`).
            if (parseHolder(readRaw(file))?.id !== id) return;
            unlinkQuiet(file);
          },
        };
      }
      held.delete(id);
    } catch {
      held.delete(id);
      return null;
    }
    try {
      const seen = seenAt(file);
      const age = now() - seen.mtimeMs;
      const h = parseHolder(seen.raw);
      const stale = age > maxAge || (h === null ? age > UNREADABLE_MAX_AGE_MS : !stillHeld(h));
      if (!stale || !takeOver(file, seen, now, link)) return null;
    } catch (err) {
      // Released between the two looks: try once more.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return null;
}
