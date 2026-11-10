import { randomUUID } from 'node:crypto';
import { redactText, sanitizeForContext, sanitizeLine, uuidv7 } from '@mindly/core';
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
 * Entries live in the kv store (no table of their own). A flush holds a lease, so only one
 * process sends at a time, and claims each attempt before it is made. An entry is given up after
 * `OUTBOX_MAX_ATTEMPTS` attempts or `OUTBOX_MAX_AGE_MS`.
 */

const PREFIX = 'notify.outbox:';
const LEASE_KEY = 'notify.outbox-lease';
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
/** No flush holds the outbox longer than this. */
const MAX_LEASE_MS = 10 * 60_000;
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
  /** True when another process was flushing, so this one did nothing. */
  busy?: boolean;
}

/** Kernels of this process that raised a notification into the outbox. */
const raised = new WeakSet<Kernel>();

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
      const id = uuidv7();
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
      this.k.store.kv.set(`${PREFIX}${id}`, entry);
      raised.add(this.k);
    } catch (err) {
      this.k.logger.warn('notification could not be queued', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Whether this process wrote a notification here (the hook then starts a sender). */
  raisedHere(): boolean {
    return raised.has(this.k);
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
   * otherwise. Only one process flushes at a time; another one returns at once with `busy`.
   * Never throws.
   */
  async flush(opts: { budgetMs?: number; attemptMs?: number } = {}): Promise<OutboxFlush> {
    const out: OutboxFlush = { delivered: 0, waiting: 0, dropped: 0 };
    const started = Date.now();
    const budget = opts.budgetMs ?? 30_000;
    const attemptMs = opts.attemptMs ?? OUTBOX_ATTEMPT_MS;
    const owner = randomUUID();
    if (!this.takeLease(owner, budget + attemptMs + 5_000)) return { ...out, busy: true };
    try {
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
          tried++;
          // Claimed before it is made: an attempt cut short by this process ending still counts.
          const claimed = this.claim(row.key, entry, now);
          if (!claimed) {
            out.waiting++;
            continue;
          }
          const results = await withTimeout(this.k.ports.notifier.send(claimed.n), attemptMs);
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
    } finally {
      this.dropLease(owner);
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
