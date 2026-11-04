import type { Clock } from '@synapse/core';

/** A given `dedupeKey` is sent at most once per this window. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** Rolling window for the global rate limit. */
export const RATE_WINDOW_MS = 60 * 60 * 1000;
/** Maximum notifications per {@link RATE_WINDOW_MS}. */
export const MAX_PER_WINDOW = 30;

/** In-memory dedupe and rate limiting with an injectable clock. */
export class NotifyLimiter {
  readonly #clock: Clock;
  readonly #sent: number[] = [];
  readonly #keys = new Map<string, number>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Decides whether a notification may go out now and, if so, records it.
   * Returns `null` when allowed, otherwise the reason it was suppressed.
   */
  admit(dedupeKey: string | undefined): 'deduped' | 'rate_limited' | null {
    const now = this.#clock.now();
    while (this.#sent.length > 0 && (this.#sent[0] ?? 0) <= now - RATE_WINDOW_MS) {
      this.#sent.shift();
    }
    for (const [key, at] of this.#keys) {
      if (at <= now - DEDUPE_WINDOW_MS) this.#keys.delete(key);
    }
    if (dedupeKey !== undefined && this.#keys.has(dedupeKey)) return 'deduped';
    if (this.#sent.length >= MAX_PER_WINDOW) return 'rate_limited';
    this.#sent.push(now);
    if (dedupeKey !== undefined) this.#keys.set(dedupeKey, now);
    return null;
  }
}
