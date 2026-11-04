import { describeError, type Logger, type MindlyEvent } from '@mindly/core';
import type { Store } from '@mindly/store';
import type { WebSocket } from 'ws';
import { LiveClientMessage } from './routes/schemas.js';

/** Maximum concurrent live-feed sockets. */
export const MAX_LIVE_SOCKETS = 16;
/** How often the event log is polled. */
export const POLL_INTERVAL_MS = 500;
/** How often idle sockets are pinged; a socket that did not answer the previous ping is closed. */
export const PING_INTERVAL_MS = 25_000;
/** Events pushed per project per poll (the client catches up over several polls). */
const BATCH_LIMIT = 500;

interface Client {
  socket: WebSocket;
  projectId: string | null;
  afterSeq: number;
  alive: boolean;
}

/**
 * The live feed behind `GET /api/live`: polls `events.maxSeq()` and pushes new events of each
 * client's subscribed project, in seq order, batched per project.
 */
export class LiveFeed {
  private readonly clients = new Set<Client>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastSeq = 0;

  constructor(
    private readonly store: Store,
    private readonly logger: Logger,
    private readonly options: { pollMs?: number; pingMs?: number } = {},
  ) {}

  get size(): number {
    return this.clients.size;
  }

  /** Accepts a socket (or closes it with 1013 when the limit is reached). */
  accept(socket: WebSocket): void {
    if (this.clients.size >= MAX_LIVE_SOCKETS) {
      socket.close(1013, 'too many connections');
      return;
    }
    const client: Client = { socket, projectId: null, afterSeq: 0, alive: true };
    this.clients.add(client);
    this.ensureTimers();
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) return;
      this.onMessage(client, data.toString());
    });
    socket.on('close', () => this.drop(client));
    socket.on('error', () => this.drop(client));
    this.lastSeq = Math.max(this.lastSeq, this.store.events.maxSeq());
    this.send(client, { type: 'hello', lastSeq: this.lastSeq });
  }

  private onMessage(client: Client, text: string): void {
    if (text.length > 4096) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const msg = LiveClientMessage.safeParse(json);
    if (!msg.success || msg.data.type !== 'subscribe') return;
    const sub = msg.data;
    const project = this.store.projects.list().find((p) => p.id === sub.projectId);
    if (!project) return;
    client.projectId = project.id;
    client.afterSeq = sub.afterSeq ?? this.store.events.maxSeq();
    // Catch up immediately when the client asked for older events.
    this.pushTo([client], project.id);
  }

  private ensureTimers(): void {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), this.options.pollMs ?? POLL_INTERVAL_MS);
      this.pollTimer.unref();
    }
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => this.ping(), this.options.pingMs ?? PING_INTERVAL_MS);
      this.pingTimer.unref();
    }
  }

  /** One poll: cheap `maxSeq` check, then one query per subscribed project. */
  poll(): void {
    try {
      const max = this.store.events.maxSeq();
      const behind = [...this.clients].filter((c) => c.projectId !== null && c.afterSeq < max);
      this.lastSeq = Math.max(this.lastSeq, max);
      if (behind.length === 0) return;
      const byProject = new Map<string, Client[]>();
      for (const c of behind) {
        const list = byProject.get(c.projectId as string) ?? [];
        list.push(c);
        byProject.set(c.projectId as string, list);
      }
      for (const [projectId, list] of byProject) this.pushTo(list, projectId, max);
    } catch (err) {
      this.logger.error('live feed poll failed', { error: describeError(err) });
    }
  }

  private pushTo(
    clients: Client[],
    projectId: string,
    maxAtStart = this.store.events.maxSeq(),
  ): void {
    const from = Math.min(...clients.map((c) => c.afterSeq));
    const events = this.store.events.query(projectId, {
      afterSeq: from,
      order: 'asc',
      limit: BATCH_LIMIT,
    });
    // Everything up to `maxAtStart` was seen unless the batch was cut off; later events in the
    // batch move the cursor further.
    const caughtUp = events.length < BATCH_LIMIT ? maxAtStart : 0;
    const cursor = Math.max(events.at(-1)?.seq ?? 0, caughtUp);
    for (const c of clients) {
      const mine: MindlyEvent[] = events.filter((e) => e.seq > c.afterSeq);
      if (mine.length > 0) this.send(c, { type: 'events', projectId, events: mine });
      c.afterSeq = Math.max(c.afterSeq, cursor);
    }
  }

  private ping(): void {
    for (const c of [...this.clients]) {
      if (!c.alive) {
        c.socket.terminate();
        this.drop(c);
        continue;
      }
      c.alive = false;
      this.send(c, { type: 'ping' });
      try {
        c.socket.ping();
      } catch {
        this.drop(c);
      }
    }
  }

  private send(c: Client, msg: unknown): void {
    if (c.socket.readyState !== c.socket.OPEN) return;
    c.socket.send(JSON.stringify(msg), (err) => {
      if (err) this.drop(c);
    });
  }

  private drop(c: Client): void {
    this.clients.delete(c);
    if (this.clients.size === 0) this.stopTimers();
  }

  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pollTimer = null;
    this.pingTimer = null;
  }

  /** Closes every socket (shutdown). */
  close(): void {
    for (const c of [...this.clients]) {
      try {
        c.socket.close(1001, 'daemon shutting down');
      } catch {
        // already closed
      }
      this.clients.delete(c);
    }
    this.stopTimers();
  }
}
