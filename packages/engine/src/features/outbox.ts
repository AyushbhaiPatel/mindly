import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { redactText, sanitizeForContext, sanitizeLine, sha256, uuidv7 } from '@mindly/core';
import type { Kernel } from '../kernel.js';
import type { Mindly } from '../mindly.js';
import { notifySettled, type NotifyResult, type PagerNotification } from '../ports.js';
import { serviceOf } from './shared.js';

/*
 * The pager outbox: notifications that are written down first and sent by a process that can
 * wait for the pager.
 *
 * A hook has to answer its agent within a fraction of a second, and a request to a pager can take
 * seconds. A hook therefore never sends: a notification it raises is written here, and the hook
 * process starts one detached sender (`mindly notify flush`) that has the time to wait for the
 * answer and record it. The daemon flushes on a tick as well. A notification whose channels all
 * failed waits here for another attempt instead of being lost.
 *
 * Entries live in the kv store (no table of their own). Each attempt is made under a short lease
 * (claim, send, record), so only one process sends at a time and a sender that dies holds nothing
 * for long; the attempt is claimed before it is made. A running sender keeps a presence mark
 * fresh, and a hook that raises a page starts a new sender only when no mark is fresh. An entry is
 * given up after `OUTBOX_MAX_ATTEMPTS` attempts or `OUTBOX_MAX_AGE_MS`.
 */

const PREFIX = 'notify.outbox:';
/** This process's start time, for its presence mark; read when first needed (a sender only). */
let ownStart: string | null | undefined;
function ownStartTime(): string | null {
  if (ownStart === undefined) ownStart = processStartTime(process.pid);
  return ownStart;
}
const LEASE_KEY = 'notify.outbox-lease';
const SENDER_KEY = 'notify.outbox-sender';
/** Attempts per entry, the first one included. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** An entry older than this is no longer news. */
export const OUTBOX_MAX_AGE_MS = 6 * 60 * 60_000;
/**
 * Longest one attempt is waited for: more than a channel's own timeout (5 s), so an attempt is
 * not abandoned while its request may still reach the pager.
 */
export const OUTBOX_ATTEMPT_MS = 8_000;
/** Wait before attempt n+1, by attempts made so far. */
const BACKOFF_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** Wait after an attempt the hourly budget held back (it does not count as an attempt). */
const HELD_BACK_MS = 60_000;
/** No lease or presence mark is honoured for longer than this (a clock set back). */
const MAX_LEASE_MS = 10 * 60_000;
/** A sender's presence mark is fresh for this long; the sender renews it every second. */
const SENDER_FRESH_MS = 15_000;
/** How often a sender looks at the outbox. */
const SENDER_SLICE_MS = 1_000;
/** A sender stays this long after the newest entry it has seen (for the first retries). */
export const SENDER_WINDOW_MS = 3 * 60_000;
/** A sender never stays longer than this. */
const SENDER_MAX_LIFE_MS = 10 * 60_000;
/** Attempts per flush. */
const MAX_PER_FLUSH = 20;
/** Entries kept at most; beyond it new ones are dropped (a pager that never works). */
export const OUTBOX_MAX_ENTRIES = 100;

interface OutboxEntry {
  n: PagerNotification;
  attempts: number;
  createdAt: number;
  /** Not before this time (ms). */
  nextAt: number;
}

interface Lease {
  owner: string;
  until: number;
  /** The sender's process, for its presence mark: a mark whose process is gone is no sender. */
  pid?: number;
  /** When that process started, so a process that took over the pid is not the sender. */
  start?: string;
}

/**
 * When the process `pid` started, as an opaque string to compare; null where it cannot be told.
 * Linux reads `/proc/<pid>/stat` (clock ticks since boot). Elsewhere `ps -o lstart= -p <pid>` is
 * run directly (no shell) with a short timeout: macOS and the BSDs have it, Windows does not and
 * gets null. Both sides of a comparison come from the same machine, so from the same source.
 */
export function processStartTime(
  pid: number,
  source: 'auto' | 'ps' = existsSync('/proc/self/stat') ? 'auto' : 'ps',
): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (source === 'auto') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Fields after the command name (which may hold spaces): state is field 3, starttime 22.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] ?? null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : `ps:${out}`;
  } catch {
    // No such process (ps exits 1), no `ps`, or it did not answer in time.
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  // A process that ended but was not reaped yet (its parent, often a container's init, has not
  // waited for it) still answers the signal check. On Linux its state says so.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    return true;
  }
}

function isEntry(v: unknown): v is OutboxEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<OutboxEntry>;
  return (
    typeof e.attempts === 'number' &&
    typeof e.createdAt === 'number' &&
    typeof e.nextAt === 'number' &&
    typeof e.n === 'object' &&
    e.n !== null &&
    typeof e.n.trigger === 'string' &&
    typeof e.n.title === 'string' &&
    typeof e.n.body === 'string'
  );
}

/** Held back by the hourly budget: nothing was tried. */
function heldBack(results: readonly NotifyResult[] | undefined): boolean {
  return (
    !!results &&
    results.length > 0 &&
    results.every((r) => r.status === 'skipped') &&
    results.some((r) => r.reason === 'rate_limited')
  );
}

export interface OutboxFlush {
  /** Entries that reached a channel (or needed no further attempt). */
  delivered: number;
  /** Entries still waiting, due or not. */
  waiting: number;
  /** Entries given up: too many attempts or too old. */
  dropped: number;
  /** True when another process held the outbox, so a due entry was left for later. */
  busy?: boolean;
}

/** Kernels of this process that wrote a notification no running sender will see to. */
const unattended = new WeakSet<Kernel>();

/**
 * The id a notification keeps on every attempt: its own when it has a valid one, else a new one.
 * Assign it once, when the alert is raised, and pass the result to the first send and to the
 * outbox. A dedupe key is not enough: a check that fails, is fixed and fails again a day later
 * raises a new alert under the same key, and a receiver dropping repeats by id must not drop it.
 * `occurrence` is for an alert whose dedupe key already names one occurrence and that is raised
 * afresh on each try (the scheduled standup: one per day); the id then follows the key.
 */
export function withNotificationId<T extends PagerNotification>(
  n: T,
  occurrence: 'new' | 'key' = 'new',
): T & { id: string } {
  if (n.id !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(n.id)) return { ...n, id: n.id };
  const id =
    occurrence === 'key' && n.dedupeKey !== undefined
      ? `k${sha256(n.dedupeKey).slice(0, 32)}`
      : uuidv7();
  return { ...n, id };
}

export class NotifyOutbox {
  constructor(private readonly k: Kernel) {}

  /**
   * Writes a notification down for delivery. The text is cleaned and redacted (with the user's
   * patterns) before it is shortened and stored: the store never holds what the pager must not
   * see. Never throws.
   */
  enqueue(n: PagerNotification): void {
    try {
      const count = this.k.store.kv.list(PREFIX, OUTBOX_MAX_ENTRIES).length;
      if (count >= OUTBOX_MAX_ENTRIES) {
        this.k.logger.warn('notification dropped: the outbox is full', {
          trigger: n.trigger,
          entries: count,
        });
        return;
      }
      const now = this.k.clock.now();
      const key = uuidv7();
      // The id the first attempt had, when there was one: a receiver sees one id per alert.
      const { id } = withNotificationId(n);
      const entry: OutboxEntry = {
        n: {
          trigger: n.trigger,
          title: this.clean(n.title, 200),
          body: this.clean(n.body, 400),
          ...(n.projectName !== undefined ? { projectName: this.clean(n.projectName, 100) } : {}),
          ...(n.priority !== undefined ? { priority: n.priority } : {}),
          ...(n.dedupeKey !== undefined ? { dedupeKey: n.dedupeKey.slice(0, 200) } : {}),
          // The same on every attempt, so a receiver can drop a repeat.
          id,
        },
        attempts: 0,
        createdAt: now,
        nextAt: now,
      };
      this.k.store.kv.set(`${PREFIX}${key}`, entry);
      // Read after the entry is written: a sender that stops clears its mark before its last look
      // at the outbox, so either it sees this entry or no fresh mark is found here.
      if (!this.senderAlive()) unattended.add(this.k);
    } catch (err) {
      this.k.logger.warn('notification could not be queued', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Whether this process wrote a notification here that needs a sender to be started. */
  needsSender(): boolean {
    return unattended.has(this.k);
  }

  /** Whether a sender is running (its presence mark is fresh). */
  senderAlive(now: number = this.k.clock.now()): boolean {
    try {
      const mark = this.k.store.kv.get<Lease>(SENDER_KEY);
      if (!mark || mark.until <= now || mark.until - now > MAX_LEASE_MS) return false;
      // A sender that was killed leaves a fresh mark behind: it is not running, and neither is a
      // process that was given its pid since.
      if (mark.pid === undefined) return true;
      if (!processAlive(mark.pid)) return false;
      if (mark.start === undefined) return true;
      const start = processStartTime(mark.pid);
      return start === null || start === mark.start;
    } catch {
      return false;
    }
  }

  /**
   * Renews this sender's presence mark, or returns false when another running sender holds it:
   * that one looks at the outbox every second, so this one is not needed.
   */
  private markSender(owner: string): boolean {
    return this.k.store.transaction(() => {
      const now = this.k.clock.now();
      const mark = this.k.store.kv.get<Lease>(SENDER_KEY);
      if (mark && mark.owner !== owner && this.senderAlive(now)) return false;
      const start = ownStartTime();
      this.k.store.kv.set(SENDER_KEY, {
        owner,
        until: now + SENDER_FRESH_MS,
        pid: process.pid,
        ...(start !== null ? { start } : {}),
      } satisfies Lease);
      return true;
    });
  }

  private clearSender(owner: string): void {
    this.k.store.transaction(() => {
      if (this.k.store.kv.get<Lease>(SENDER_KEY)?.owner === owner) {
        this.k.store.kv.delete(SENDER_KEY);
      }
    });
  }

  /**
   * Runs as the outbox's sender (`mindly notify flush`): sends what is due, looks again every
   * second for new entries and for retries, and waits when another process holds the outbox.
   * Stays `windowMs` after the newest entry it has seen, at most ten minutes in all. Before it
   * stops it clears its presence mark and looks one last time, so a page written meanwhile is
   * either sent by it or finds no mark and starts a new sender. Never throws.
   */
  async runSender(opts: { windowMs?: number; sliceMs?: number; attemptMs?: number } = {}): Promise<{
    delivered: number;
    dropped: number;
  }> {
    const window = opts.windowMs ?? SENDER_WINDOW_MS;
    const slice = opts.sliceMs ?? SENDER_SLICE_MS;
    const attemptMs = opts.attemptMs ?? OUTBOX_ATTEMPT_MS;
    const owner = randomUUID();
    const started = Date.now();
    let until = started + window;
    const total = { delivered: 0, dropped: 0 };
    for (;;) {
      try {
        // Between attempts only, so stepping aside never leaves an attempt half made.
        if (!this.markSender(owner)) return total;
        const newest = this.newestCreatedAt();
        if (newest !== null) {
          // Entry times are on the store's clock; the window is kept in this process's time.
          const age = Math.max(0, this.k.clock.now() - newest);
          until = Math.max(until, Date.now() - age + window);
        }
        until = Math.min(until, started + SENDER_MAX_LIFE_MS);
        if (this.hasDue()) {
          const r = await this.flush({
            budgetMs: Math.max(until - Date.now(), attemptMs) + 1,
            attemptMs,
          });
          total.delivered += r.delivered;
          total.dropped += r.dropped;
          // Something went out: look again at once, entries may have come in meanwhile.
          if (r.delivered + r.dropped > 0 && !r.busy) continue;
        }
        if (Date.now() >= until || this.nextDueAt() === null) {
          this.clearSender(owner);
          // The last look, after the mark is gone: an entry written before that was written by a
          // hook that saw the mark, so this sender sends it.
          if (!this.hasDue()) return total;
          if (Date.now() >= started + SENDER_MAX_LIFE_MS + 60_000) return total;
        }
      } catch (err) {
        // The outbox is kept; the daemon or the next sender takes over.
        this.k.logger.warn('pager sender stopped', {
          error: err instanceof Error ? err.message : String(err),
        });
        return total;
      }
      await new Promise((resolve) => setTimeout(resolve, slice));
    }
  }

  private newestCreatedAt(): number | null {
    let newest: number | null = null;
    for (const e of this.k.store.kv.list<unknown>(PREFIX, OUTBOX_MAX_ENTRIES)) {
      if (isEntry(e.value) && (newest === null || e.value.createdAt > newest)) {
        newest = e.value.createdAt;
      }
    }
    return newest;
  }

  private clean(text: string, max: number): string {
    // Invisible characters first (they can split a token), then redaction, then the cut: a
    // secret cut in half would no longer be recognised.
    const visible = sanitizeForContext(text, 8000);
    const redacted = redactText(visible, {
      extraPatterns: this.k.config.redaction.extraPatterns,
    });
    return sanitizeLine(redacted, max);
  }

  /** Entries in the order they are due. */
  private entries(): { key: string; value: unknown; nextAt: number }[] {
    return this.k.store.kv
      .list<unknown>(PREFIX, OUTBOX_MAX_ENTRIES)
      .map((e) => ({ ...e, nextAt: isEntry(e.value) ? e.value.nextAt : 0 }))
      .sort((a, b) => a.nextAt - b.nextAt);
  }

  /** When the earliest entry is due (ms), or null when the outbox is empty. */
  nextDueAt(): number | null {
    try {
      return this.entries()[0]?.nextAt ?? null;
    } catch {
      return null;
    }
  }

  /** Whether an entry is due now. */
  hasDue(now: number = this.k.clock.now()): boolean {
    try {
      return this.entries().some((e) => e.nextAt <= now);
    } catch {
      return false;
    }
  }

  /**
   * Sends the entries that are due, earliest first, while `budgetMs` leaves room for a whole
   * attempt. An entry is removed once it needs no further attempt, and kept for a later one
   * otherwise. Each attempt holds a lease for at most twice its time limit, so only one process
   * sends at a time; when another one holds it, the pass stops with `busy`. Never throws.
   */
  async flush(opts: { budgetMs?: number; attemptMs?: number } = {}): Promise<OutboxFlush> {
    const out: OutboxFlush = { delivered: 0, waiting: 0, dropped: 0 };
    const started = Date.now();
    const budget = opts.budgetMs ?? 30_000;
    const attemptMs = opts.attemptMs ?? OUTBOX_ATTEMPT_MS;
    const owner = randomUUID();
    {
      let rows: { key: string; value: unknown; nextAt: number }[];
      try {
        rows = this.entries();
      } catch {
        return out;
      }
      let tried = 0;
      for (const row of rows) {
        const now = this.k.clock.now();
        try {
          const entry = row.value;
          if (!isEntry(entry)) {
            this.k.store.kv.delete(row.key);
            out.dropped++;
            continue;
          }
          if (entry.attempts >= OUTBOX_MAX_ATTEMPTS || now - entry.createdAt > OUTBOX_MAX_AGE_MS) {
            this.k.store.kv.delete(row.key);
            out.dropped++;
            this.k.logger.warn('notification given up', {
              trigger: entry.n.trigger,
              attempts: entry.attempts,
            });
            continue;
          }
          const roomLeft = budget - (Date.now() - started) >= attemptMs;
          if (entry.nextAt > now || !roomLeft || tried >= MAX_PER_FLUSH) {
            out.waiting++;
            continue;
          }
          if (out.busy) {
            out.waiting++;
            continue;
          }
          if (!this.takeLease(owner, 2 * attemptMs)) {
            out.busy = true;
            out.waiting++;
            continue;
          }
          tried++;
          let results: Awaited<ReturnType<typeof this.k.ports.notifier.send>> | typeof TIMED_OUT;
          let claimed: OutboxEntry | null;
          try {
            // Claimed before it is made: an attempt cut short by this process ending counts.
            claimed = this.claim(row.key, entry, now);
            if (!claimed) {
              out.waiting++;
              continue;
            }
            results = await withTimeout(this.k.ports.notifier.send(claimed.n), attemptMs);
          } finally {
            this.dropLease(owner);
          }
          if (results !== TIMED_OUT && heldBack(results)) {
            // The hourly budget held it back: nothing was tried, so no attempt is used up.
            this.release(row.key, claimed, entry.attempts, now + HELD_BACK_MS);
            out.waiting++;
          } else if (results !== TIMED_OUT && notifySettled(results)) {
            this.k.store.kv.delete(row.key);
            out.delivered++;
          } else {
            out.waiting++;
          }
        } catch (err) {
          out.waiting++;
          this.k.logger.warn('notification attempt failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return out;
    }
  }

  /** Takes the outbox for `ttlMs` unless another process holds it. */
  private takeLease(owner: string, ttlMs: number): boolean {
    try {
      return this.k.store.transaction(() => {
        const now = this.k.clock.now();
        const held = this.k.store.kv.get<Lease>(LEASE_KEY);
        // A lease dated far in the future comes from a clock that was set back: it is stale.
        if (held && held.until > now && held.until - now <= MAX_LEASE_MS) return false;
        this.k.store.kv.set(LEASE_KEY, { owner, until: now + ttlMs } satisfies Lease);
        return true;
      });
    } catch {
      return false;
    }
  }

  private dropLease(owner: string): void {
    try {
      this.k.store.transaction(() => {
        if (this.k.store.kv.get<Lease>(LEASE_KEY)?.owner === owner) {
          this.k.store.kv.delete(LEASE_KEY);
        }
      });
    } catch {
      // Expires on its own.
    }
  }

  /** Records one more attempt on the entry, unless another process took it meanwhile. */
  private claim(key: string, seen: OutboxEntry, now: number): OutboxEntry | null {
    return this.k.store.transaction(() => {
      const current = this.k.store.kv.get<unknown>(key);
      if (!isEntry(current) || current.attempts !== seen.attempts || current.nextAt > now) {
        return null;
      }
      const attempts = current.attempts + 1;
      const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 30 * 60_000;
      const next: OutboxEntry = { ...current, attempts, nextAt: now + wait };
      this.k.store.kv.set(key, next);
      return next;
    });
  }

  /** Gives back an attempt that was not made. */
  private release(key: string, claimed: OutboxEntry, attempts: number, nextAt: number): void {
    this.k.store.transaction(() => {
      const current = this.k.store.kv.get<unknown>(key);
      if (!isEntry(current) || current.attempts !== claimed.attempts) return;
      this.k.store.kv.set(key, { ...current, attempts, nextAt } satisfies OutboxEntry);
    });
  }
}

const TIMED_OUT = Symbol('timed out');

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The pager outbox of a Mindly instance. */
export function notifyOutbox(mindly: Mindly): NotifyOutbox {
  return serviceOf(mindly, 'notify-outbox', () => new NotifyOutbox(mindly.kernel));
}
