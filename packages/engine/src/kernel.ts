import type { Clock, Logger, Session, UserConfig } from '@mindly/core';
import type { Store } from '@mindly/store';
import type { Ports } from './ports.js';

/** Timing constants shared by services. */
export const LIVE_WINDOW_MS = 30 * 60_000;
export const INTENT_TTL_MS = 20 * 60_000;
export const DELIVERY_TTL_MS = 24 * 60 * 60_000;
export const OVERLAP_WINDOW_MS = 30 * 60_000;

/** Everything a service needs; passed explicitly so services stay easy to construct in tests. */
export interface Kernel {
  store: Store;
  config: UserConfig;
  clock: Clock;
  logger: Logger;
  ports: Ports;
  /**
   * True when this process serves an agent that Mindly itself launched headlessly (review, replay,
   * failover). Prompts in such sessions were written by Mindly, not the user, so they must never
   * become user-sourced rules.
   */
  headless: boolean;
  /**
   * When this instance began to open (wall-clock ms). A hook process opens one instance per hook
   * right after it starts its deadline, so the time since then is time the hook has used. Unset
   * for a kernel built by hand.
   */
  openedAt?: number;
}

// ---------------------------------------------------------------------------------------------
// Internal event bus. Feature modules (impact radar, self-healing, contracts, failover, …)
// subscribe here instead of being hard-wired into the hook handler.
// ---------------------------------------------------------------------------------------------

export interface ChangedFile {
  /** Project-relative POSIX path. */
  path: string;
  abs: string;
  addedText: string;
  removedText: string;
  wholeFile: boolean;
}

export interface BusEvents {
  'files.changed': {
    projectId: string;
    projectRoot: string;
    session: Session;
    files: ChangedFile[];
  };
  'turn.stopped': {
    projectId: string;
    projectRoot: string;
    session: Session;
    lastMessage: string | null;
    transcriptPath: string | null;
  };
  'session.started': {
    projectId: string;
    projectRoot: string;
    session: Session;
    source: string | null;
  };
  'session.ended': { projectId: string; projectRoot: string; session: Session };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => Promise<void> | void;

export class EngineBus {
  private readonly handlers = new Map<keyof BusEvents, { name: string; fn: Handler<never> }[]>();

  constructor(private readonly logger: Logger) {}

  on<K extends keyof BusEvents>(event: K, name: string, fn: Handler<K>): void {
    const list = this.handlers.get(event) ?? [];
    list.push({ name, fn: fn as Handler<never> });
    this.handlers.set(event, list);
  }

  /**
   * Runs every handler for `event` concurrently. Each handler is isolated: an error or a handler
   * exceeding `budgetMs` is logged and never propagates to the caller (hooks must not fail).
   */
  async emit<K extends keyof BusEvents>(
    event: K,
    payload: BusEvents[K],
    budgetMs = 800,
  ): Promise<void> {
    const list = this.handlers.get(event) ?? [];
    await Promise.all(
      list.map(async ({ name, fn }) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.resolve((fn as Handler<K>)(payload)),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                this.logger.warn('bus handler exceeded budget', { event, handler: name, budgetMs });
                resolve();
              }, budgetMs);
              timer.unref();
            }),
          ]);
        } catch (err) {
          this.logger.error('bus handler failed', {
            event,
            handler: name,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }
}
