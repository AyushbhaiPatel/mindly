import {
  estimateTokens,
  notFound,
  type ContextItem,
  type ContextPacket,
  type Memory,
  type MemoryKind,
  type Trust,
} from '@mindly/core';
import { memoryLine } from '../context/render.js';
import { sessionLabel } from '../coordination/work.js';
import type { Kernel } from '../kernel.js';
import { rankTrust } from '../memory/service.js';
import type { Mindly } from '../mindly.js';
import { attachService } from './shared.js';

/*
 * Context X-Ray: explains what context Mindly gave a session and why items were left out.
 * The constants and scoring below mirror `context/builder.ts` (prompt retrieval); keep in sync.
 */
const RECENT_SERVE_WINDOW_MS = 2 * 60 * 60_000;
const RESERVE_TOKENS = 120;
const PROMPT_SEARCH_LIMIT = 25;
const PROMPT_TRUST: Trust[] = ['approved', 'verified', 'proposed'];

/** A recorded context packet with a readable session label. */
export interface XRayPacket {
  id: string;
  trigger: ContextPacket['trigger'];
  query: string | null;
  at: number;
  tokenBudget: number;
  tokensUsed: number;
  included: ContextItem[];
  omitted: ContextItem[];
}

/** Recent packets served to one session. */
export interface XRaySession {
  sessionId: string;
  label: string;
  packets: XRayPacket[];
}

/** One packet in which a memory was included or omitted. */
export interface XRayMemoryAppearance {
  packetId: string;
  sessionId: string;
  label: string | null;
  trigger: ContextPacket['trigger'];
  at: number;
  status: 'included' | 'omitted';
  score: number;
  reason: string;
}

/** Where a memory was served or omitted. */
export interface XRayMemory {
  memoryId: string;
  title: string;
  kind: MemoryKind;
  trust: Trust;
  status: Memory['status'];
  includedCount: number;
  omittedCount: number;
  appearances: XRayMemoryAppearance[];
}

/** Why a memory matching a query would or would not reach the session. */
export type MissingReason =
  'included' | 'budget' | 'already_served' | 'trust_filter' | 'branch_filter' | 'rank_limit';

export interface XRayMissingItem {
  memoryId: string;
  title: string;
  kind: MemoryKind;
  trust: Trust;
  /** What would happen for this query right now. */
  reason: MissingReason;
  detail: string;
  /** The most recent recorded packet of this session that mentioned the memory, if any. */
  lastSeen: { packetId: string; at: number; status: 'included' | 'omitted'; reason: string } | null;
}

export interface XRayMissing {
  sessionId: string;
  query: string;
  tokenBudget: number;
  items: XRayMissingItem[];
}

export class XRayService {
  constructor(private readonly k: Kernel) {}

  /** Most recent context packets for a session (newest first) with included/omitted items. */
  session(sessionId: string, limit = 10): XRaySession {
    const s = this.k.store.sessions.get(sessionId);
    const packets = this.k.store.contextPackets
      .forSession(sessionId, Math.max(1, Math.min(100, Math.trunc(limit))))
      .map((p) => ({
        id: p.id,
        trigger: p.trigger,
        query: p.query,
        at: p.createdAt,
        tokenBudget: p.tokenBudget,
        tokensUsed: p.tokensUsed,
        included: p.included,
        omitted: p.omitted,
      }));
    return { sessionId, label: sessionLabel(s), packets };
  }

  /** Every recent packet (bounded) in which a memory was included or omitted, and why. */
  memory(projectId: string, memoryId: string): XRayMemory {
    const m = this.k.store.memories.get(memoryId);
    if (m.projectId !== projectId) throw notFound('memory', memoryId);
    const appearances: XRayMemoryAppearance[] = [];
    for (const p of this.k.store.contextPackets.mentioning(projectId, memoryId, 50)) {
      const session = this.k.store.sessions.find(p.sessionId);
      const inc = p.included.find((i) => i.ref === memoryId);
      const om = inc ? undefined : p.omitted.find((i) => i.ref === memoryId);
      const item = inc ?? om;
      if (!item) continue;
      appearances.push({
        packetId: p.id,
        sessionId: p.sessionId,
        label: session ? sessionLabel(session) : null,
        trigger: p.trigger,
        at: p.createdAt,
        status: inc ? 'included' : 'omitted',
        score: item.score,
        reason: item.reason,
      });
    }
    return {
      memoryId,
      title: m.title,
      kind: m.kind,
      trust: m.trust,
      status: m.status,
      includedCount: appearances.filter((a) => a.status === 'included').length,
      omittedCount: appearances.filter((a) => a.status === 'omitted').length,
      appearances,
    };
  }

  /**
   * Runs the same memory search the prompt context builder uses for `query` and explains, for
   * each hit, whether it would be included or why it would be omitted: token budget, already
   * served recently, trust filter (stale/rejected), branch filter, or beyond the search limit.
   * `lastSeen` adds what actually happened in the most recent recorded packet.
   * Read-only: nothing is recorded or delivered. Budget simulation ignores pending deliveries
   * other than their token cost, so it is an estimate.
   */
  explainMissing(sessionId: string, query: string): XRayMissing {
    const session = this.k.store.sessions.get(sessionId);
    const pid = session.projectId;
    const now = this.k.clock.now();
    const budget = this.k.config.context.promptTokens;
    const q = query.slice(0, 500);

    const hits = this.k.store.memories.search(pid, q, {
      trust: PROMPT_TRUST,
      ...(session.branch ? { branch: session.branch } : {}),
      limit: PROMPT_SEARCH_LIMIT,
    });
    const served = this.recentlyServed(sessionId, now);
    const items: XRayMissingItem[] = [];
    const scored: { m: Memory; score: number; tokens: number }[] = [];
    hits.forEach((h, i) => {
      const m = h.memory;
      const servedAt = served.get(m.id);
      if (servedAt !== undefined && m.updatedAt <= servedAt) {
        items.push(item(m, 'already_served', 'shown to this session in the last 2 hours'));
        return;
      }
      const relevance = 1 - i / Math.max(hits.length, 1);
      const score =
        relevance * 0.6 +
        (rankTrust(m.trust) / 4) * 0.25 +
        recency(m.updatedAt, now) * 0.1 +
        (m.pinned ? 0.05 : 0);
      scored.push({ m, score, tokens: estimateTokens(memoryLine(m)) + 2 });
    });

    let used = RESERVE_TOKENS;
    for (const d of this.k.store.deliveries.pendingFor(pid, session.id, session.agentKind, 15)) {
      used += estimateTokens(`- [${d.kind}] ${d.title} ${d.body.slice(0, 600)}`) + 2;
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored) {
      if (used + s.tokens <= budget) {
        used += s.tokens;
        items.push(item(s.m, 'included', `score ${round(s.score)}, ${s.tokens} tokens`));
      } else {
        items.push(
          item(s.m, 'budget', `needs ${s.tokens} tokens; ${Math.max(0, budget - used)} left`),
        );
      }
    }

    // Hits the builder's filters exclude: search again without trust/branch filters.
    const seen = new Set(items.map((x) => x.memoryId));
    for (const h of this.k.store.memories.search(pid, q, { limit: 60 })) {
      const m = h.memory;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (!PROMPT_TRUST.includes(m.trust)) {
        items.push(item(m, 'trust_filter', `trust is ${m.trust}; never injected automatically`));
      } else if (session.branch && m.scope.branch !== null && m.scope.branch !== session.branch) {
        items.push(
          item(m, 'branch_filter', `scoped to branch ${m.scope.branch}, session is on another`),
        );
      } else {
        items.push(item(m, 'rank_limit', `ranked below the top ${PROMPT_SEARCH_LIMIT} matches`));
      }
    }
    const lastSeen = this.lastSeen(sessionId);
    for (const x of items) x.lastSeen = lastSeen.get(x.memoryId) ?? null;
    return { sessionId, query: q, tokenBudget: budget, items };
  }

  private lastSeen(sessionId: string): Map<string, NonNullable<XRayMissingItem['lastSeen']>> {
    const out = new Map<string, NonNullable<XRayMissingItem['lastSeen']>>();
    for (const p of this.k.store.contextPackets.forSession(sessionId, 30)) {
      for (const [status, list] of [
        ['included', p.included],
        ['omitted', p.omitted],
      ] as const) {
        for (const i of list) {
          if (i.kind !== 'memory' || out.has(i.ref)) continue;
          out.set(i.ref, { packetId: p.id, at: p.createdAt, status, reason: i.reason });
        }
      }
    }
    return out;
  }

  private recentlyServed(sessionId: string, now: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of this.k.store.contextPackets.forSession(sessionId, 30)) {
      if (p.createdAt < now - RECENT_SERVE_WINDOW_MS) continue;
      for (const i of p.included) if (!out.has(i.ref)) out.set(i.ref, p.createdAt);
    }
    return out;
  }
}

function item(m: Memory, reason: MissingReason, detail: string): XRayMissingItem {
  return {
    memoryId: m.id,
    title: m.title,
    kind: m.kind,
    trust: m.trust,
    reason,
    detail,
    lastSeen: null,
  };
}

function recency(t: number, now: number): number {
  const days = Math.max(0, (now - t) / 86_400_000);
  return 1 / (1 + days / 7);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Feature module: attaches the Context X-Ray service (no bus handlers). */
export const xrayModule = (mindly: Mindly): void => {
  attachService(mindly, 'xray', new XRayService(mindly.kernel));
};
