import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname, uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';

/*
 * The sentinel's per-checkout lock. A pass can run a test suite and a bisect for many minutes,
 * so unlike the checkpoint lock (30 s), its staleness is decided by whether the process that
 * took it still holds it, not by its age.
 *
 * A PID alone does not say that. After a crash or a reboot the number is soon used again, and a
 * daemon in a container comes back with the very PID its lock recorded. And a PID only means
 * something inside its PID namespace: two containers sharing `$MINDLY_HOME` both run as PID 1,
 * and a holder in a container is another process, or none, when looked up from the host.
 *
 * A PID also only means something on its machine, in its boot: a home shared between machines
 * (a network or synced folder) holds locks of processes this one cannot see, and every Linux
 * machine's first PID namespace has the same name.
 *
 * So a lock records its PID, an id of its own, when its process started, the PID namespace it is
 * in and the machine and boot it runs in, and its holder touches it every few seconds while it
 * holds it. Seen from the same machine, boot and namespace, it is held while that same process
 * lives. Where the PID cannot be judged (another machine, boot or namespace, or one of them
 * cannot be read), it is held while it keeps being touched. A lock older than `maxAgeMs` is
 * stale anyway.
 *
 * Whether a lock is still touched is not read off one clock difference: the wall clock steps
 * (suspend, a time sync, two machines that disagree). A process that cannot judge the PID notes
 * what it saw in a small file next to the lock (one per machine and boot, whatever the
 * namespace, so that one-shot containers build on each other's looks), and takes the lock over
 * only when a later attempt finds it unchanged after more than the heartbeat window on the
 * monotonic clock of the boot.
 *
 * A holder that could not touch its lock for that long (its process was suspended) can lose it
 * while it works: `held()` tells and `signal` is aborted, and the holder must stop at once.
 */

/** A lock nobody can hold longer than this (a pass is bounded far below it). */
export const SENTINEL_LOCK_MAX_AGE_MS = 24 * 60 * 60_000;
/** How often a holder touches its lock. */
export const SENTINEL_LOCK_HEARTBEAT_MS = 10_000;
/** Heartbeats a lock may miss before it counts as abandoned, where its PID cannot be judged. */
const MISSED_HEARTBEATS = 6;
/** Beats in a row at which a holder may fail to read its lock before it gives the lock up. */
const UNREADABLE_BEATS = 6;
/** A note of what was seen of a lock is not believed past this age, nor when dated in the future. */
const OBSERVATION_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * Notes of other observers are removed once untouched for this many heartbeat windows. Not after
 * one window: an observer whose attempts come further apart than that would never get to read
 * its note again, and could never take an abandoned lock over.
 */
const OTHER_NOTE_WINDOWS = 10;
/** A lock file without a readable holder is being written, or was left by a crash: stale after this. */
const UNREADABLE_MAX_AGE_MS = 60_000;
/** A takeover takes microseconds; a guard older than this was left by a crash. */
const GUARD_MAX_AGE_MS = 30_000;
/** Temp files of a lock (one being created, one being taken over) older than this were left by a crash. */
const TEMP_MAX_AGE_MS = 60_000;
/** Directory entries looked at, and temp files removed, per sweep. */
const SWEEP_MAX_ENTRIES = 500;
const SWEEP_MAX_REMOVED = 50;

export interface ProcessLock {
  release(): void;
  /**
   * False once the lock is no longer this holder's: released, or taken over while its process
   * could not touch it (suspended for longer than the heartbeat window). Reads the lock file.
   */
  held(): boolean;
  /**
   * Aborted as soon as the holder finds its lock taken over (at a heartbeat, or in `held()`):
   * whatever it runs under the lock must stop then, not when it next asks.
   */
  readonly signal: AbortSignal;
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

/** The id of the running boot of this machine, or null where the system has none (not Linux). */
export function bootIdentity(): string | null {
  if (bootId === undefined) {
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch {
      bootId = null;
    }
  }
  return bootId;
}

/**
 * What tells one process from a later one with the same PID: the boot it runs in and its start
 * time in that boot, or null where the system does not expose them (anything but Linux).
 */
export function processIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const boot = bootIdentity();
    if (boot === null) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) may hold spaces and parentheses: fields are counted after it.
    const start = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(' ')[19];
    return start && /^\d+$/.test(start) ? `${boot}:${start}` : null;
  } catch {
    return null;
  }
}

let ownHost: string | null | undefined;

/**
 * The machine and boot this process runs in: the boot id on Linux; elsewhere the host name and
 * when the machine started (to the minute). Null when it cannot be told.
 */
export function hostIdentity(): string | null {
  if (ownHost !== undefined) return ownHost;
  if (process.platform === 'linux') return (ownHost = bootIdentity());
  try {
    const booted = Math.round((Date.now() / 1000 - uptime()) / 60);
    const name = hostname().replace(/\s+/g, '');
    ownHost = name ? `${name}@${booted}` : null;
  } catch {
    ownHost = null;
  }
  return ownHost;
}

let ownNamespace: string | null | undefined;

/**
 * The PID namespace of this process (`pid:[4026531836]`), `host` on systems that have none, or
 * null when it cannot be read: PIDs of another namespace say nothing here.
 */
export function pidNamespace(): string | null {
  if (ownNamespace !== undefined) return ownNamespace;
  if (process.platform !== 'linux') return (ownNamespace = 'host');
  try {
    const ns = readlinkSync('/proc/self/ns/pid').trim();
    ownNamespace = /^[\w:[\]-]{1,64}$/.test(ns) ? ns : null;
  } catch {
    ownNamespace = null;
  }
  return ownNamespace;
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
  /** `pidNamespace` of the holder, or null. */
  namespace: string | null;
  /** `hostIdentity` of the holder, or null. */
  host: string | null;
}

/** One look at a lock file. */
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
  const [first = '', id = '', identity = '', namespace = '', host = ''] = raw
    .split('\n')
    .map((l) => l.trim());
  const pid = Number(first);
  if (!/^\d+$/.test(first) || !Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    id: id || null,
    identity: identity || null,
    namespace: namespace || null,
    host: host || null,
  };
}

function seenAt(file: string): LockSeen {
  const raw = readRaw(file);
  const st = statSync(file);
  return { ino: st.ino, mtimeMs: st.mtimeMs, raw };
}

/**
 * True when two looks saw the same lock. A lock with an id is told by its content: its time
 * moves with every heartbeat. One without (written by an older version, or not readable) is
 * told by its time as well, since inode numbers alone are reused at once on Linux.
 */
function sameLock(a: LockSeen, b: LockSeen): boolean {
  if (a.ino !== b.ino || a.raw !== b.raw) return false;
  return parseHolder(a.raw)?.id != null || a.mtimeMs === b.mtimeMs;
}

/**
 * What a process that could not judge a lock's PID saw of it: which lock, its time, and when
 * (on the wall clock, and on the monotonic clock of the boot it ran in).
 */
interface Observation {
  id: string;
  mtimeMs: number;
  wall: number;
  mono: number;
  host: string | null;
}

function readObservation(path: string): Observation | null {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (typeof o['id'] !== 'string' || !num(o['mtimeMs']) || !num(o['wall']) || !num(o['mono'])) {
      return null;
    }
    return {
      id: o['id'],
      mtimeMs: o['mtimeMs'],
      wall: o['wall'],
      mono: o['mono'],
      host: typeof o['host'] === 'string' ? o['host'] : null,
    };
  } catch {
    return null;
  }
}

/** Milliseconds on a clock that never steps, shared by the processes of one boot. */
const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

/**
 * Moves a stale lock out of the way. Takeovers are serialised by a guard file, and the lock is
 * judged again under the guard: only the lock seen is removed, only while it is still stale, and
 * never by two processes. The lock is renamed to a name of this call and looked at once more
 * before it is dropped, so a lock that changed in between (its holder touched it, or let go and
 * another took its place) is put back, not deleted.
 */
function takeOver(
  file: string,
  seen: LockSeen,
  stale: (seen: LockSeen) => boolean,
  now: () => number,
  link: Link,
): boolean {
  const guard = `${file}.takeover`;
  try {
    closeSync(openSync(guard, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process is taking the lock over right now. A guard left by a crash is cleared
      // for the next attempt: one too old, or dated in the future (the clock was set back).
      try {
        if (Math.abs(now() - statSync(guard).mtimeMs) > GUARD_MAX_AGE_MS) unlinkSync(guard);
      } catch {
        // gone meanwhile
      }
    }
    return false;
  }
  try {
    const current = seenAt(file);
    if (!sameLock(current, seen) || !stale(current)) return false;
    const aside = `${file}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
    renameSync(file, aside);
    try {
      const moved = seenAt(aside);
      if (sameLock(moved, current) && moved.mtimeMs === current.mtimeMs) return true;
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

/**
 * Removes the temp files of this lock that a killed process left: a lock it was creating
 * (`.new-`) or taking over (`.stale-`). Live ones are a few microseconds old and are left
 * alone. Notes of what was seen of an earlier lock (`.seen-`) go once they are too old to be
 * believed. Bounded, and never fails.
 */
function sweepTemp(file: string, now: () => number): void {
  try {
    const dir = dirname(file);
    const prefixes = [`${basename(file)}.new-`, `${basename(file)}.stale-`];
    const seen = `${basename(file)}.seen-`;
    let removed = 0;
    for (const name of readdirSync(dir).slice(0, SWEEP_MAX_ENTRIES)) {
      const note = name.startsWith(seen);
      if (!note && !prefixes.some((p) => name.startsWith(p))) continue;
      const path = join(dir, name);
      try {
        const max = note ? OBSERVATION_MAX_AGE_MS : TEMP_MAX_AGE_MS;
        if (Math.abs(now() - statSync(path).mtimeMs) <= max) continue;
        unlinkSync(path);
        if (++removed >= SWEEP_MAX_REMOVED) return;
      } catch {
        // gone meanwhile, or not ours to remove
      }
    }
  } catch {
    // the lock works without the cleanup
  }
}

/** Makes a hard link (`linkSync`); fails on file systems that have none. */
type Link = (existing: string, path: string) => void;

export interface ProcessLockOptions {
  maxAgeMs?: number;
  alive?: (pid: number) => boolean;
  identity?: (pid: number) => string | null;
  /** The PID namespace of this process; the default is `pidNamespace`. */
  namespace?: () => string | null;
  /** Makes a hard link; the default is `linkSync`. */
  link?: (existing: string, path: string) => void;
  /** How often the lock is touched while held (the same for every process using the lock). */
  heartbeatMs?: number;
  now?: () => number;
  /** Milliseconds on a clock that never steps, shared by the processes of one boot. */
  monotonic?: () => number;
  /** The machine and boot of this process (what `monotonic` counts in); see `hostIdentity`. */
  host?: () => string | null;
}

/**
 * Takes the lock at `file` without waiting, or returns null while a live process holds it. A
 * lock whose holder is gone (its process ended, or its PID now belongs to another process), or
 * older than `maxAgeMs`, is taken over. So is a lock whose PID cannot be judged from here once
 * its holder stopped touching it, but never at first sight: only an attempt that finds it as an
 * earlier one left it, more than the heartbeat window before.
 */
export function tryProcessLock(file: string, opts: ProcessLockOptions = {}): ProcessLock | null {
  const maxAge = opts.maxAgeMs ?? SENTINEL_LOCK_MAX_AGE_MS;
  const alive = opts.alive ?? processAlive;
  const identity = opts.identity ?? processIdentity;
  const namespace = opts.namespace ?? pidNamespace;
  const now = opts.now ?? Date.now;
  const link = opts.link ?? linkSync;
  const heartbeatMs = opts.heartbeatMs ?? SENTINEL_LOCK_HEARTBEAT_MS;
  const monotonic = opts.monotonic ?? monotonicMs;
  const hostOf = opts.host ?? hostIdentity;
  const held = heldIds();

  /**
   * Where this observer notes what it saw of a lock: one file for the processes of this
   * machine and boot, whose monotonic clocks can be compared. Not per PID namespace: a one-shot
   * container is a new namespace every time, and must build on what the last one saw.
   */
  const notePath = (): string => {
    const who = createHash('sha256')
      .update(hostOf() ?? `name:${hostname()}`)
      .digest('hex')
      .slice(0, 12);
    return `${file}.seen-${who}`;
  };

  /** Removes the notes of other observers that nobody updated for a while. Bounded. */
  const sweepNotes = (own: string): void => {
    try {
      const dir = dirname(file);
      const prefix = `${basename(file)}.seen-`;
      const max = OTHER_NOTE_WINDOWS * MISSED_HEARTBEATS * heartbeatMs;
      let removed = 0;
      for (const name of readdirSync(dir).slice(0, SWEEP_MAX_ENTRIES)) {
        const path = join(dir, name);
        if (!name.startsWith(prefix) || path === own) continue;
        try {
          if (Math.abs(now() - statSync(path).mtimeMs) <= max) continue;
          unlinkSync(path);
          if (++removed >= SWEEP_MAX_REMOVED) return;
        } catch {
          // gone meanwhile
        }
      }
    } catch {
      // the lock works without the cleanup
    }
  };

  /**
   * How long this observer has seen the lock as it is now: 0 at first sight, which is noted
   * for the attempts that follow. Counted on the monotonic clock of the boot, or on the wall
   * clock where the system names no boot; a note from the future or too old to be believed
   * starts over.
   */
  const unchangedFor = (seen: LockSeen, id: string): number => {
    const host = hostOf();
    const note = notePath();
    const wall = now();
    const mono = monotonic();
    const prev = readObservation(note);
    sweepNotes(note);
    if (prev && prev.id === id && prev.mtimeMs === seen.mtimeMs) {
      const elapsed =
        prev.host !== null && prev.host === host ? mono - prev.mono : wall - prev.wall;
      if (elapsed >= 0 && elapsed <= OBSERVATION_MAX_AGE_MS) return elapsed;
    }
    // Written aside and renamed into place: observers in other namespaces share the note, and
    // none may read half of one.
    const tmp = `${note}.${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      const o: Observation = { id, mtimeMs: seen.mtimeMs, wall, mono, host };
      writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
      renameSync(tmp, note);
    } catch {
      // not noted: the lock is held until its age cap
      unlinkQuiet(tmp);
    }
    return 0;
  };

  /** `held` or `gone` when the holder's PID says so; `unknown` when it says nothing here. */
  const byPid = (h: Holder): 'held' | 'gone' | 'unknown' => {
    if (h.id === null) {
      // Written by an older version, which records only a PID and never touches its lock: all
      // there is to go by is whether a process with that PID exists.
      return alive(h.pid) ? 'held' : 'gone';
    }
    // A PID is judged only on its own machine and boot, and in its own namespace.
    const here = namespace();
    const host = hostOf();
    if (h.namespace === null || here === null || h.namespace !== here) return 'unknown';
    if (h.host === null || host === null || h.host !== host) return 'unknown';
    if (h.pid === process.pid) {
      if (held.has(h.id)) return 'held';
      // A lock naming this PID that this process does not know of. From an earlier process
      // with the same PID when the start times differ; otherwise it cannot be told from here
      // (another thread of this process may hold it).
      const mine = identity(process.pid);
      return h.identity !== null && mine !== null && h.identity !== mine ? 'gone' : 'unknown';
    }
    if (!alive(h.pid)) return 'gone';
    if (h.identity === null) return 'held';
    const current = identity(h.pid);
    return current === null || current === h.identity ? 'held' : 'gone';
  };

  const stale = (seen: LockSeen): boolean => {
    const age = now() - seen.mtimeMs;
    if (age > maxAge) return true;
    const h = parseHolder(seen.raw);
    if (h === null) return Math.abs(age) > UNREADABLE_MAX_AGE_MS;
    const verdict = byPid(h);
    if (verdict !== 'unknown' || h.id === null) return verdict === 'gone';
    // Its holder touches it every `heartbeatMs` while it lives: abandoned once this observer
    // saw it untouched for longer than a few beats.
    return unchangedFor(seen, h.id) > MISSED_HEARTBEATS * heartbeatMs;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const id = randomBytes(12).toString('hex');
    try {
      held.add(id);
      const content = [
        process.pid,
        id,
        identity(process.pid) ?? '',
        namespace() ?? '',
        hostOf() ?? '',
      ].join('\n');
      if (create(file, content, link)) {
        sweepTemp(file, now);
        // What this observer noted about the lock that was here is of no use any more.
        try {
          unlinkQuiet(notePath());
        } catch {
          // left to the sweep
        }
        // `mine`, `other` (taken over: the file names another holder) or `unreadable` (missing
        // or without a holder, which is also what a takeover in progress looks like).
        const look = (): 'mine' | 'other' | 'unreadable' => {
          let raw: string;
          try {
            raw = readFileSync(file, 'utf8');
          } catch {
            return 'unreadable';
          }
          const h = parseHolder(raw);
          return h === null ? 'unreadable' : h.id === id ? 'mine' : 'other';
        };
        let released = false;
        let lost = false;
        let misses = 0;
        const lostSignal = new AbortController();
        const lose = (): void => {
          lost = true;
          held.delete(id);
          clearInterval(beat);
          lostSignal.abort();
        };
        const beat = setInterval(() => {
          const state = look();
          // Taken over (after `maxAgeMs`, or it looked abandoned): no longer ours to touch.
          if (state === 'other') return lose();
          if (state === 'unreadable') {
            // One failed read says little; a lock that stays away is gone.
            if (++misses >= UNREADABLE_BEATS) lose();
            return;
          }
          misses = 0;
          try {
            const t = new Date();
            utimesSync(file, t, t);
          } catch {
            // tried again at the next beat
          }
        }, heartbeatMs);
        // The lock never keeps its process alive.
        beat.unref();
        return {
          release: () => {
            if (released) return;
            released = true;
            clearInterval(beat);
            held.delete(id);
            // Only our own lock is removed (it may have been taken over).
            if (!lost && look() === 'mine') unlinkQuiet(file);
          },
          held: () => {
            if (released || lost) return false;
            const state = look();
            if (state === 'other') lose();
            return state === 'mine';
          },
          signal: lostSignal.signal,
        };
      }
      held.delete(id);
    } catch {
      held.delete(id);
      return null;
    }
    try {
      const seen = seenAt(file);
      if (!stale(seen) || !takeOver(file, seen, stale, now, link)) return null;
    } catch (err) {
      // Released between the two looks: try once more.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
  }
  return null;
}
