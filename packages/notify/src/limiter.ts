import type { Clock } from '@mindly/core';

/** A given `dedupeKey` is sent at most once per this window. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** Rolling window for the global rate limit. */
export const RATE_WINDOW_MS = 60 * 60 * 1000;
/** Maximum notifications per {@link RATE_WINDOW_MS}. */
export const MAX_PER_WINDOW = 30;

/**
 * In-memory dedupe and rate limiting with an injectable clock. A notification uses up its dedupe
 * key and a place in the hourly budget only once it has reached a channel: `check` asks whether
 * it may go out, and the caller reports back with `delivered` or `failed`. A send that reached
 * nobody can be tried again, and earlier failures never hold a new notification back: how often
 * a failed one is tried again is up to the caller (the outbox backs off).
 */
export class NotifyLimiter {
  readonly #clock: Clock;
  readonly #sent: number[] = [];
  readonly #keys = new Map<string, number>();
  /** Keys of sends that are on their way: a second one with the same key is a duplicate. */
  readonly #pending = new Set<string>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  #prune(now: number): void {
    const list = this.#sent;
    // `at > now` is a clock that was set back: such an entry would never age out.
    while (list.length > 0 && ((list[0] ?? 0) <= now - RATE_WINDOW_MS || (list[0] ?? 0) > now)) {
      list.shift();
    }
    for (const [key, at] of this.#keys) {
      if (at <= now - DEDUPE_WINDOW_MS || at > now) this.#keys.delete(key);
    }
  }

  /**
   * Whether a notification may go out now. Returns `null` when allowed, otherwise the reason it
   * is held back. An allowed send must be followed by `delivered`, `failed` or `released`.
   */
  check(dedupeKey: string | undefined): 'deduped' | 'rate_limited' | null {
    const now = this.#clock.now();
    this.#prune(now);
    if (dedupeKey !== undefined && (this.#keys.has(dedupeKey) || this.#pending.has(dedupeKey))) {
      return 'deduped';
    }
    if (this.#sent.length >= MAX_PER_WINDOW) return 'rate_limited';
    if (dedupeKey !== undefined) this.#pending.add(dedupeKey);
    return null;
  }

  /** The send reached at least one channel: its key and its place in the budget are used. */
  delivered(dedupeKey: string | undefined): void {
    const now = this.#clock.now();
    this.#sent.push(now);
    if (dedupeKey !== undefined) {
      this.#pending.delete(dedupeKey);
      this.#keys.set(dedupeKey, now);
    }
  }

  /** The send reached no channel: its key is free again and nothing is counted. */
  failed(dedupeKey: string | undefined): void {
    if (dedupeKey !== undefined) this.#pending.delete(dedupeKey);
  }

  /** The send was not attempted after all (nothing to send it to). */
  released(dedupeKey: string | undefined): void {
    if (dedupeKey !== undefined) this.#pending.delete(dedupeKey);
  }
}
