import { sanitizeLine, uuidv7 } from '@mindly/core';
import type { Kernel } from '../kernel.js';
import type { Mindly } from '../mindly.js';
import { notifySettled, type PagerNotification } from '../ports.js';
import { serviceOf } from './shared.js';

/*
 * The pager outbox: notifications that are written down first and sent by whoever has the time.
 *
 * A hook has to answer its agent within a fraction of a second, and a request to a pager can take
 * longer than that. A notification raised in a hook is therefore not awaited there: it is put
 * here and its first attempt is started without waiting for it (`kick`). The hook process gives
 * that attempt the time it has left once the agent has its answer (`drain`); what is not out by
 * then stays here for the daemon's tick or the next hook. The same goes for a notification
 * whose channels all failed: it waits here for another attempt instead of being lost.
 *
 * Entries live in the kv store (no table of their own). Each attempt is claimed before it is
 * made, so two processes do not send the same entry, and an entry is given up after
 * `MAX_ATTEMPTS` attempts or `MAX_AGE_MS`.
 */

const PREFIX = 'notify.outbox:';
/** Attempts per entry, the first one included. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** An entry older than this is no longer news. */
export const OUTBOX_MAX_AGE_MS = 6 * 60 * 60_000;
/** Wait before attempt n+1, by attempts made so far. */
const BACKOFF_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** Entries looked at per flush. */
const MAX_PER_FLUSH = 20;
/** Entries kept at most; beyond it new ones are dropped (a pager that never works). */
const MAX_ENTRIES = 100;

interface OutboxEntry {
  n: PagerNotification;
  attempts: number;
  createdAt: number;
  /** Not before this time (ms). */
  nextAt: number;
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

export interface OutboxFlush {
  /** Entries that reached a channel (or needed no further attempt). */
  delivered: number;
  /** Entries still waiting, due or not. */
  waiting: number;
  /** Entries given up: too many attempts or too old. */
  dropped: number;
}

/** Attempts under way in this process, by kernel: `drain` waits for them. */
const underway = new WeakMap<Kernel, Set<Promise<unknown>>>();

export class NotifyOutbox {
  constructor(private readonly k: Kernel) {}

  /**
   * Starts sending what is due without waiting for it. For callers that must return at once (a
   * hook); `drain` gives the attempt time later. Never throws.
   */
  kick(): void {
    let set = underway.get(this.k);
    if (!set) {
      set = new Set();
      underway.set(this.k, set);
    }
    const running = set;
    const attempt: Promise<unknown> = this.flush()
      .catch(() => undefined)
      .finally(() => running.delete(attempt));
    running.add(attempt);
  }

  /**
   * Waits up to `budgetMs` for the attempts `kick` started, then sends what else is due in the
   * time that is left. Returns at once when there is nothing to wait for. Never throws.
   */
  async drain(budgetMs: number): Promise<void> {
    const started = Date.now();
    const running = [...(underway.get(this.k) ?? [])];
    if (running.length > 0) await withTimeout(Promise.all(running), Math.max(1, budgetMs));
    const left = budgetMs - (Date.now() - started);
    if (left > 50 && this.hasDue()) await this.flush({ budgetMs: left });
  }

  /** Writes a notification down for delivery. Never throws. */
  enqueue(n: PagerNotification): void {
    try {
      if (this.k.store.kv.list(PREFIX, MAX_ENTRIES).length >= MAX_ENTRIES) return;
      const now = this.k.clock.now();
      const entry: OutboxEntry = {
        n: {
          trigger: n.trigger,
          // Titles and counts only reach the pager; they are cleaned again when sent.
          title: sanitizeLine(n.title, 200),
          body: sanitizeLine(n.body, 400),
          ...(n.projectName !== undefined ? { projectName: sanitizeLine(n.projectName, 100) } : {}),
          ...(n.priority !== undefined ? { priority: n.priority } : {}),
          ...(n.dedupeKey !== undefined ? { dedupeKey: n.dedupeKey.slice(0, 200) } : {}),
        },
        attempts: 0,
        createdAt: now,
        nextAt: now,
      };
      this.k.store.kv.set(`${PREFIX}${uuidv7()}`, entry);
    } catch (err) {
      this.k.logger.warn('notification could not be queued', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Whether an entry is due now (a cheap look, for callers on a budget). */
  hasDue(now: number = this.k.clock.now()): boolean {
    try {
      return this.k.store.kv
        .list<unknown>(PREFIX, MAX_PER_FLUSH)
        .some((e) => !isEntry(e.value) || e.value.nextAt <= now);
    } catch {
      return false;
    }
  }

  /**
   * Sends the entries that are due, oldest first, until `budgetMs` has passed. An entry is
   * removed once it needs no further attempt, and kept for a later one otherwise. Never throws.
   */
  async flush(opts: { budgetMs?: number } = {}): Promise<OutboxFlush> {
    const out: OutboxFlush = { delivered: 0, waiting: 0, dropped: 0 };
    const started = Date.now();
    const budget = opts.budgetMs ?? 30_000;
    let rows: { key: string; value: unknown }[];
    try {
      rows = this.k.store.kv.list<unknown>(PREFIX, MAX_PER_FLUSH);
    } catch {
      return out;
    }
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
        if (entry.nextAt > now || Date.now() - started >= budget) {
          out.waiting++;
          continue;
        }
        // Claim the attempt before making it: another process flushing now sees it as not due,
        // and an attempt cut short by this process ending still counts.
        const claimed = this.claim(row.key, entry, now);
        if (!claimed) {
          out.waiting++;
          continue;
        }
        const left = Math.max(1, budget - (Date.now() - started));
        const results = await withTimeout(this.k.ports.notifier.send(claimed.n), left);
        if (results !== TIMED_OUT && notifySettled(results)) {
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
