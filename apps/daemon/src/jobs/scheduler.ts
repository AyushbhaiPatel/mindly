import { describeError, type Logger } from '@mindly/core';

/** A periodic job: `run` is called every `intervalMs` (plus jitter) until the scheduler stops. */
export interface JobSpec {
  name: string;
  intervalMs: number;
  /** Delay before the first run (default: one interval). */
  initialDelayMs?: number;
  /** Random extra delay added to every run, as a fraction of the interval (default 0.1). */
  jitter?: number;
  run(): Promise<void> | void;
}

/**
 * Small job scheduler with per-key serial execution. Every job and every keyed task is isolated:
 * failures are logged and never propagate, and the same key never runs twice at the same time.
 */
export class Scheduler {
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly aborter = new AbortController();
  private stopped = false;

  constructor(private readonly logger: Logger) {}

  /** Aborted when the scheduler stops, so long jobs can end their child processes. */
  get signal(): AbortSignal {
    return this.aborter.signal;
  }

  /** True while a task for `key` is running or queued. */
  busy(key: string): boolean {
    return this.chains.has(key);
  }

  /**
   * Runs `fn` after every task already queued for `key` (serial per key). The returned promise
   * resolves when `fn` finished; it never rejects.
   */
  enqueue(key: string, fn: () => Promise<void> | void): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (err) {
        this.logger.error('job failed', { job: key, error: describeError(err) });
      }
    });
    this.chains.set(key, next);
    this.inFlight.add(next);
    void next.finally(() => {
      this.inFlight.delete(next);
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  /** Runs `fn` for `key` unless a task for that key is already running or queued. */
  runExclusive(key: string, fn: () => Promise<void> | void): Promise<void> | null {
    if (this.busy(key)) return null;
    return this.enqueue(key, fn);
  }

  /** Registers a periodic job. Its runs never overlap. */
  every(spec: JobSpec): void {
    const jitter = Math.max(0, spec.jitter ?? 0.1);
    const schedule = (delay: number): void => {
      if (this.stopped) return;
      const t = setTimeout(() => {
        this.timers.delete(t);
        const p = this.runExclusive(`job:${spec.name}`, spec.run);
        const after = (): void =>
          schedule(spec.intervalMs + Math.random() * spec.intervalMs * jitter);
        if (p) void p.then(after);
        else after();
      }, delay);
      t.unref();
      this.timers.add(t);
    };
    schedule((spec.initialDelayMs ?? spec.intervalMs) + Math.random() * spec.intervalMs * jitter);
  }

  /**
   * Stops scheduling and waits up to `graceMs` for running tasks. Returns true when everything
   * finished in time.
   */
  async stop(graceMs = 10_000): Promise<boolean> {
    this.stopped = true;
    this.aborter.abort();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.inFlight.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      Promise.allSettled([...this.inFlight]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return done;
  }

  /** Resolves when every task currently queued has finished (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}
