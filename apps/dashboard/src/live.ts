import type { EventType, MindlyEvent } from './types';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface LiveHandlers {
  onEvents(projectId: string, events: MindlyEvent[]): void;
  onStatus(status: LiveStatus): void;
}

export interface LiveFeed {
  /** Subscribe to one project; replaces any previous subscription. */
  subscribe(projectId: string, afterSeq?: number): void;
  close(): void;
}

export type LiveFactory = (handlers: LiveHandlers) => LiveFeed;

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

function isEvent(v: unknown): v is MindlyEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<MindlyEvent>;
  return (
    typeof e.seq === 'number' &&
    typeof e.id === 'string' &&
    typeof e.type === 'string' &&
    typeof e.createdAt === 'number'
  );
}

/** WebSocket client for `/api/live` (same origin, cookie auth) with exponential backoff. */
export const createLiveFeed: LiveFactory = (handlers) => {
  let ws: WebSocket | null = null;
  let projectId: string | null = null;
  let lastSeq: number | undefined;
  let attempt = 0;
  let timer: number | undefined;
  let closed = false;

  const sendSubscribe = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !projectId) return;
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        projectId,
        ...(lastSeq !== undefined ? { afterSeq: lastSeq } : {}),
      }),
    );
  };

  const scheduleReconnect = () => {
    if (closed) return;
    handlers.onStatus(attempt > 4 ? 'offline' : 'reconnecting');
    const base = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2);
    attempt += 1;
    window.clearTimeout(timer);
    timer = window.setTimeout(connect, delay);
  };

  function connect() {
    if (closed) return;
    handlers.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let sock: WebSocket;
    try {
      sock = new WebSocket(`${proto}//${location.host}/api/live`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      handlers.onStatus('live');
      sendSubscribe();
    };
    sock.onmessage = (msg) => {
      if (typeof msg.data !== 'string' || msg.data.length > 4_000_000) return;
      let data: unknown;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;
      const m = data as { type?: unknown; projectId?: unknown; events?: unknown };
      if (m.type === 'events' && typeof m.projectId === 'string' && Array.isArray(m.events)) {
        if (m.projectId !== projectId) return;
        const events = m.events.filter(isEvent);
        if (events.length === 0) return;
        lastSeq = Math.max(lastSeq ?? 0, ...events.map((e) => e.seq));
        handlers.onEvents(m.projectId, events);
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      scheduleReconnect();
    };
    sock.onerror = () => {
      sock.close();
    };
  }

  connect();

  return {
    subscribe(id, afterSeq) {
      projectId = id;
      lastSeq = afterSeq;
      sendSubscribe();
    },
    close() {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
      ws = null;
    },
  };
};

/** Which data each event type invalidates, so panels refetch only what changed. */
export type Topic =
  | 'sessions'
  | 'memories'
  | 'conflicts'
  | 'tasks'
  | 'intents'
  | 'deliveries'
  | 'handoffs'
  | 'runs'
  | 'snapshots'
  | 'xray'
  | 'saves'
  | 'overview';

export function topicsFor(type: EventType | string): Topic[] {
  const [head] = type.split('.');
  switch (head) {
    case 'session':
    case 'turn':
    case 'prompt':
      return ['sessions', 'overview'];
    case 'memory':
    case 'rule':
      return ['memories', 'overview'];
    case 'contract':
      return ['memories'];
    case 'conflict':
      return ['conflicts', 'overview'];
    case 'task':
      return ['tasks', 'overview'];
    case 'intent':
      return ['intents', 'overview'];
    case 'delivery':
      return ['deliveries', 'overview'];
    case 'handoff':
      return ['handoffs', 'overview'];
    case 'run':
      return ['runs', 'overview'];
    case 'snapshot':
      return ['snapshots'];
    case 'context':
      return ['xray'];
    case 'save':
      return ['saves'];
    default:
      return [];
  }
}
