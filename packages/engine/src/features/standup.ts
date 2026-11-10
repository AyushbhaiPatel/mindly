import { sanitizeLine } from '@mindly/core';
import type { Kernel } from '../kernel.js';
import { notifySettled } from '../ports.js';
import type { Mindly, MindlyModule } from '../mindly.js';

/*
 * Morning standup: a digest of what every agent did since the last standup, built from the event
 * log and current state. It carries titles, counts and file paths only, never prompt text or code,
 * so it is safe to push through the pager.
 */

const DAY_MS = 24 * 60 * 60_000;
const MAX_RENDER_LINES = 25;
const MAX_LISTED = 3;

/** Per-agent activity in the digest window. */
export interface StandupAgent {
  agentKind: string;
  sessions: number;
  turns: number;
  filesChanged: number;
  topFiles: string[];
  rateLimits: number;
}

/** An item shown by title only. */
export interface StandupItem {
  id: string;
  title: string;
}

/** A handoff summarised without its (possibly prompt-derived) summary text. */
export interface StandupHandoff {
  id: string;
  fromAgentKind: string | null;
  toAgentKind: string | null;
  reason: string;
  status: string;
  createdAt: number;
}

/** The structured standup digest. */
export interface StandupDigest {
  projectId: string;
  projectName: string;
  since: number;
  until: number;
  agents: StandupAgent[];
  memories: { decisions: StandupItem[]; facts: StandupItem[]; rules: StandupItem[] };
  conflicts: { opened: number; resolved: number; open: number };
  handoffs: StandupHandoff[];
  rateLimits: number;
  blockedTasks: StandupItem[];
  needsYou: {
    proposedRules: StandupItem[];
    proposedMemories: StandupItem[];
    criticalConflicts: StandupItem[];
    unclaimedHandoffs: StandupHandoff[];
  };
}

/** Total number of "needs you" items in a digest. */
export function needsYouCount(d: StandupDigest): number {
  const n = d.needsYou;
  return (
    n.proposedRules.length +
    n.proposedMemories.length +
    n.criticalConflicts.length +
    n.unclaimedHandoffs.length
  );
}

/**
 * Most recent occurrence (local time) of `HH:MM` at or before `now`, in ms. The daemon sends the
 * standup when this is newer than the last delivery.
 */
export function standupDueAt(time: string, now: number): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) return null;
  const base = new Date(now);
  // Each day's time is built on its own. On the day clocks go forward a time in the skipped
  // hour does not exist and lands an hour later; moving that result back a day would give the
  // later time on the day before as well, after that day's standup, and send a second one.
  const on = (dayOffset: number): number =>
    new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + dayOffset,
      Number(m[1]),
      Number(m[2]),
      0,
      0,
    ).getTime();
  const today = on(0);
  return today > now ? on(-1) : today;
}

function titles(items: readonly StandupItem[]): string {
  const shown = items.slice(0, MAX_LISTED).map((i) => sanitizeLine(i.title, 60));
  const more = items.length > MAX_LISTED ? ` (+${items.length - MAX_LISTED} more)` : '';
  return `${shown.join('; ')}${more}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Renders a digest as short plain markdown (at most ~25 lines). Only titles, counts, agent kinds
 * and file paths appear; never prompt text, handoff summaries or code.
 */
export function renderStandup(d: StandupDigest): string {
  const hours = Math.max(1, Math.round((d.until - d.since) / 3_600_000));
  const lines: string[] = [
    `# Mindly standup: ${sanitizeLine(d.projectName, 80)}`,
    `Last ${hours}h (since ${new Date(d.since).toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
    '',
    '## Agents',
  ];
  if (d.agents.length === 0) lines.push('- No agent activity.');
  for (const a of d.agents) {
    const top = a.topFiles.length
      ? ` (top: ${a.topFiles.map((f) => sanitizeLine(f, 60)).join(', ')})`
      : '';
    const limits = a.rateLimits ? `; ${plural(a.rateLimits, 'rate limit')}` : '';
    lines.push(
      `- ${a.agentKind}: ${plural(a.sessions, 'session')}, ${plural(a.turns, 'turn')}, ${plural(a.filesChanged, 'file')} changed${top}${limits}`,
    );
  }
  const mem = d.memories;
  if (mem.decisions.length || mem.facts.length || mem.rules.length) {
    lines.push('', '## Memory');
    if (mem.decisions.length)
      lines.push(`- Decisions (${mem.decisions.length}): ${titles(mem.decisions)}`);
    if (mem.facts.length) lines.push(`- Facts (${mem.facts.length}): ${titles(mem.facts)}`);
    if (mem.rules.length)
      lines.push(`- Rules captured (${mem.rules.length}): ${titles(mem.rules)}`);
  }
  lines.push('', '## Coordination');
  lines.push(
    `- Conflicts: ${d.conflicts.opened} opened, ${d.conflicts.resolved} resolved, ${d.conflicts.open} open`,
  );
  const claimed = d.handoffs.filter((h) => h.status === 'claimed' || h.status === 'completed');
  lines.push(
    `- Handoffs: ${d.handoffs.length} created, ${claimed.length} claimed; rate limits: ${d.rateLimits}`,
  );
  if (d.blockedTasks.length)
    lines.push(`- Blocked tasks (${d.blockedTasks.length}): ${titles(d.blockedTasks)}`);
  const n = d.needsYou;
  lines.push('', '## Needs you');
  if (needsYouCount(d) === 0) lines.push('- Nothing waiting.');
  if (n.proposedRules.length)
    lines.push(`- ${plural(n.proposedRules.length, 'proposed rule')}: ${titles(n.proposedRules)}`);
  if (n.proposedMemories.length)
    lines.push(
      `- ${n.proposedMemories.length} proposed ${n.proposedMemories.length === 1 ? 'memory' : 'memories'} awaiting approval: ${titles(n.proposedMemories)}`,
    );
  if (n.criticalConflicts.length)
    lines.push(
      `- ${plural(n.criticalConflicts.length, 'critical conflict')}: ${titles(n.criticalConflicts)}`,
    );
  if (n.unclaimedHandoffs.length) {
    const desc = n.unclaimedHandoffs
      .slice(0, MAX_LISTED)
      .map((h) => `${h.fromAgentKind ?? 'agent'} -> ${h.toAgentKind ?? 'any'} (${h.reason})`)
      .join('; ');
    lines.push(`- ${plural(n.unclaimedHandoffs.length, 'unclaimed handoff')}: ${desc}`);
  }
  if (lines.length > MAX_RENDER_LINES) {
    return [...lines.slice(0, MAX_RENDER_LINES - 1), '- ...'].join('\n');
  }
  return lines.join('\n');
}

/** Builds, renders and delivers standup digests. */
export class StandupService {
  constructor(private readonly k: Kernel) {}

  private lastKey(projectId: string): string {
    return `standup.last:${projectId}`;
  }

  /** When the last standup for the project was delivered, or null. */
  lastDelivered(projectId: string): number | null {
    const v = this.k.store.kv.get<number>(this.lastKey(projectId));
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  /**
   * Builds the digest for activity since `sinceMs` (default: the last delivered standup, else the
   * last 24 hours).
   */
  build(projectId: string, sinceMs?: number): StandupDigest {
    const s = this.k.store;
    const now = this.k.clock.now();
    const since = sinceMs ?? this.lastDelivered(projectId) ?? now - DAY_MS;
    const project = s.projects.get(projectId);

    const sessions = s.sessions.list(projectId, 500).filter((x) => x.lastSeenAt >= since);
    const kindOf = new Map(sessions.map((x) => [x.id, x.agentKind]));
    const agents = new Map<string, StandupAgent & { files: Map<string, number> }>();
    const agent = (kind: string) => {
      let a = agents.get(kind);
      if (!a) {
        a = {
          agentKind: kind,
          sessions: 0,
          turns: 0,
          filesChanged: 0,
          topFiles: [],
          rateLimits: 0,
          files: new Map(),
        };
        agents.set(kind, a);
      }
      return a;
    };
    for (const x of sessions) {
      const a = agent(x.agentKind);
      a.sessions++;
      for (const c of s.fileChanges.forSession(x.id, since)) {
        a.files.set(c.path, (a.files.get(c.path) ?? 0) + 1);
      }
    }
    const events = s.events.query(projectId, {
      since,
      types: ['turn.completed', 'session.rate_limited'],
      limit: 5000,
    });
    let rateLimits = 0;
    for (const e of events) {
      const kind =
        (e.sessionId ? kindOf.get(e.sessionId) : undefined) ??
        (e.sessionId ? s.sessions.find(e.sessionId)?.agentKind : undefined);
      if (!kind) continue;
      if (e.type === 'turn.completed') agent(kind).turns++;
      else {
        agent(kind).rateLimits++;
        rateLimits++;
      }
    }
    const agentList: StandupAgent[] = [...agents.values()]
      .map(({ files, ...a }) => ({
        ...a,
        filesChanged: files.size,
        topFiles: [...files.entries()]
          .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
          .slice(0, 3)
          .map(([p]) => p),
      }))
      .sort((x, y) => y.turns - x.turns || x.agentKind.localeCompare(y.agentKind));

    const created = s.memories
      .list(projectId, { updatedSince: since, limit: 500 })
      .filter((m) => m.createdAt >= since && m.trust !== 'rejected');
    const item = (m: { id: string; title: string }): StandupItem => ({ id: m.id, title: m.title });

    const conflicts = s.conflicts.list(projectId, {
      statuses: ['open', 'acknowledged', 'resolved', 'dismissed'],
      limit: 500,
    });
    const openConflicts = conflicts.filter(
      (c) => c.status === 'open' || c.status === 'acknowledged',
    );

    const handoffs = s.handoffs.list(projectId, 100);
    const toStandupHandoff = (h: (typeof handoffs)[number]): StandupHandoff => ({
      id: h.id,
      fromAgentKind: s.sessions.find(h.fromSessionId)?.agentKind ?? null,
      toAgentKind: h.toAgentKind,
      reason: h.reason,
      status: h.status,
      createdAt: h.createdAt,
    });

    const proposed = s.memories.list(projectId, { trust: ['proposed'], limit: 100 });
    return {
      projectId,
      projectName: project.name,
      since,
      until: now,
      agents: agentList,
      memories: {
        decisions: created.filter((m) => m.kind === 'decision').map(item),
        facts: created.filter((m) => m.kind === 'fact').map(item),
        rules: created.filter((m) => m.kind === 'rule').map(item),
      },
      conflicts: {
        opened: conflicts.filter((c) => c.createdAt >= since).length,
        resolved: conflicts.filter(
          (c) => c.status === 'resolved' && c.resolvedAt !== null && c.resolvedAt >= since,
        ).length,
        open: openConflicts.length,
      },
      handoffs: handoffs.filter((h) => h.createdAt >= since).map(toStandupHandoff),
      rateLimits,
      blockedTasks: s.tasks.list(projectId, { statuses: ['blocked'], limit: 50 }).map(item),
      needsYou: {
        proposedRules: proposed.filter((m) => m.kind === 'rule').map(item),
        proposedMemories: proposed.filter((m) => m.kind !== 'rule').map(item),
        criticalConflicts: openConflicts.filter((c) => c.severity === 'critical').map(item),
        unclaimedHandoffs: handoffs.filter((h) => h.status === 'pending').map(toStandupHandoff),
      },
    };
  }

  /** Plain-markdown rendering (see `renderStandup`). */
  render(digest: StandupDigest): string {
    return renderStandup(digest);
  }

  /** Records that a standup was delivered at `at` (default now); the next one starts there. */
  markDelivered(projectId: string, at: number = this.k.clock.now()): void {
    this.k.store.kv.set(this.lastKey(projectId), at);
  }

  /**
   * The scheduled time (ms) of the most recent `config.standup.time` occurrence at or before
   * `now`, or null when no standup time is configured.
   */
  dueAt(now: number = this.k.clock.now()): number | null {
    const time = this.k.config.standup.time;
    return time ? standupDueAt(time, now) : null;
  }

  /** Whether the project's scheduled standup is due and has not been delivered yet. */
  isDue(projectId: string, now: number = this.k.clock.now()): boolean {
    const due = this.dueAt(now);
    return due !== null && (this.lastDelivered(projectId) ?? 0) < due;
  }

  /**
   * Sends a short pager summary (counts only). The caller (daemon) decides when, typically via
   * `isDue`, and calls `markDelivered` once this returns true. Never throws.
   *
   * True when the summary reached a channel or there is nothing to send it to; false when the
   * channels that were tried all failed, so the caller can try again. A scheduled standup is
   * something the user asked for by setting its time, so it does not depend on
   * `notify.triggers`.
   */
  async notify(projectId: string, digest: StandupDigest = this.build(projectId)): Promise<boolean> {
    try {
      const name = sanitizeLine(digest.projectName, 80);
      const sessions = digest.agents.reduce((n, a) => n + a.sessions, 0);
      const turns = digest.agents.reduce((n, a) => n + a.turns, 0);
      const files = digest.agents.reduce((n, a) => n + a.filesChanged, 0);
      const waiting = needsYouCount(digest);
      const results = await this.k.ports.notifier.send(
        {
          trigger: 'standup',
          title: `Mindly standup: ${name}`,
          body: `${plural(sessions, 'session')}, ${plural(turns, 'turn')}, ${plural(files, 'file')} changed; ${waiting} item${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you.`,
          projectName: name,
          priority: waiting > 0 ? 'default' : 'low',
          dedupeKey: `standup:${projectId}:${new Date(digest.until).toISOString().slice(0, 10)}`,
        },
        { ignoreTriggers: true },
      );
      return notifySettled(results);
    } catch (err) {
      this.k.logger.warn('standup notification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

const services = new WeakMap<Mindly, StandupService>();

/** The standup service attached to `mindly` (created on first use). */
export function standupService(mindly: Mindly): StandupService {
  let svc = services.get(mindly);
  if (!svc) {
    svc = new StandupService(mindly.kernel);
    services.set(mindly, svc);
  }
  return svc;
}

/** Standup module: attaches the service (no hook-time work; the daemon drives scheduling). */
export const standupModule: MindlyModule = (mindly) => {
  standupService(mindly);
};
