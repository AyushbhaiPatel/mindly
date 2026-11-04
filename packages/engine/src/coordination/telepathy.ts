import {
  redactText,
  sanitizeForContext,
  sanitizeLine,
  type Delivery,
  type DeliveryKind,
  type Session,
} from '@mindly/core';
import { DELIVERY_TTL_MS, LIVE_WINDOW_MS, type Kernel } from '../kernel.js';

export type Recipients =
  | { sessionIds: string[] }
  | { agentKind: string }
  /** Every live session in the project except the sender. */
  | { allOthers: true };

export interface SendInput {
  projectId: string;
  from: Session | null;
  to: Recipients;
  kind: DeliveryKind;
  title: string;
  body: string;
  priority?: number;
  /** Deduplicates per recipient: the recipient id is appended automatically. */
  dedupeKey?: string;
  ttlMs?: number;
}

/**
 * Agent telepathy: queues messages for other agents that are delivered at their next hook
 * boundary (prompt, tool call) and acknowledged when the next turn starts or via MCP.
 */
export class TelepathyService {
  constructor(private readonly k: Kernel) {}

  send(input: SendInput): Delivery[] {
    const title = sanitizeLine(redactText(input.title), 200);
    const body = sanitizeForContext(redactText(input.body), 1500);
    const base = {
      projectId: input.projectId,
      kind: input.kind,
      priority: Math.max(0, Math.min(10, Math.trunc(input.priority ?? 0))),
      title,
      body,
      sourceSessionId: input.from?.id ?? null,
      ttlMs: input.ttlMs ?? DELIVERY_TTL_MS,
    };
    const out: Delivery[] = [];
    if ('agentKind' in input.to) {
      out.push(
        this.k.store.deliveries.enqueue({
          ...base,
          targetSessionId: null,
          targetAgentKind: input.to.agentKind,
          dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${input.to.agentKind}` : null,
        }),
      );
    } else {
      const ids =
        'sessionIds' in input.to
          ? input.to.sessionIds
          : this.k.store.sessions
              .listLive(input.projectId, LIVE_WINDOW_MS)
              .map((s) => s.id)
              .filter((id) => id !== input.from?.id);
      for (const id of [...new Set(ids)].slice(0, 50)) {
        if (id === input.from?.id) continue;
        out.push(
          this.k.store.deliveries.enqueue({
            ...base,
            targetSessionId: id,
            targetAgentKind: null,
            dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${id}` : null,
          }),
        );
      }
    }
    for (const d of out) {
      this.k.store.events.append({
        projectId: input.projectId,
        sessionId: input.from?.id ?? null,
        type: 'delivery.queued',
        payload: {
          deliveryId: d.id,
          kind: d.kind,
          title: d.title,
          to: d.targetSessionId ?? d.targetAgentKind,
        },
      });
    }
    return out;
  }

  pending(session: Session, max = 10): Delivery[] {
    return this.k.store.deliveries.pendingFor(
      session.projectId,
      session.id,
      session.agentKind,
      max,
    );
  }

  markDelivered(session: Session, deliveries: readonly Delivery[]): void {
    if (deliveries.length === 0) return;
    this.k.store.deliveries.markDelivered(
      deliveries.map((d) => d.id),
      session.id,
    );
    this.k.store.events.append({
      projectId: session.projectId,
      sessionId: session.id,
      type: 'delivery.delivered',
      payload: { ids: deliveries.map((d) => d.id) },
    });
  }

  ack(session: Session, ids: readonly string[]): number {
    const n = this.k.store.deliveries.ack(ids, session.id);
    if (n > 0) {
      this.k.store.events.append({
        projectId: session.projectId,
        sessionId: session.id,
        type: 'delivery.acked',
        payload: { ids },
      });
    }
    return n;
  }

  /** Implicit acknowledgement: anything delivered before this new turn was seen by the agent. */
  ackPreviousTurn(session: Session): number {
    return this.k.store.deliveries.ackDeliveredBefore(session.id, this.k.clock.now());
  }
}
