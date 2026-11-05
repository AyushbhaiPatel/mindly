import { realpathSync } from 'node:fs';
import {
  estimateTokens,
  matchesAnyGlob,
  sanitizeForContext,
  sanitizeLine,
  type ContextItem,
  type ContextPacket,
  type Delivery,
  type Handoff,
  type HandoffSplitBrief,
  type Memory,
  type Session,
} from '@mindly/core';
import { LIVE_WINDOW_MS, type Kernel } from '../kernel.js';
import type { ProjectContext } from '../projects.js';
import type { MistakeService } from '../memory/mistakes.js';
import { rankTrust } from '../memory/service.js';
import { sessionLabel } from '../coordination/work.js';
import type { TelepathyService } from '../coordination/telepathy.js';
import { memoryLine, relativeTime, renderSections, type Section } from './render.js';

interface Candidate {
  item: ContextItem;
  section: string;
  /** Lower sections are filled first. */
  order: number;
  line: string;
  /** Mandatory items are included even if they exceed the budget (bounded by their own size). */
  mandatory?: boolean;
  delivery?: Delivery;
}

export interface BuiltContext {
  text: string | null;
  packet: ContextPacket | null;
  /** Deliveries included (already marked delivered). */
  deliveries: Delivery[];
}

const RESERVE_TOKENS = 120; // preamble + headings
const RECENT_SERVE_WINDOW_MS = 2 * 60 * 60_000;

export class ContextBuilder {
  constructor(
    private readonly k: Kernel,
    private readonly telepathy: TelepathyService,
    private readonly mistakes: MistakeService,
  ) {}

  // ------------------------------------------------------------------ session start

  sessionStart(project: ProjectContext, session: Session): BuiltContext {
    const now = this.k.clock.now();
    const pid = project.project.id;
    const cands: Candidate[] = [];

    const handoff = this.claimHandoff(session);
    if (handoff) cands.push(...this.handoffCandidates(handoff));

    cands.push(...this.deliveryCandidates(session, 1));

    const branchFilter = session.branch ?? undefined;
    const rules = this.k.store.memories.list(pid, {
      kinds: ['rule'],
      trust: ['approved', 'verified'],
      ...(branchFilter !== undefined ? { branch: branchFilter } : {}),
      limit: 40,
    });
    for (const m of rules) {
      cands.push(
        this.memoryCandidate(m, 'Project rules (from the user)', 2, 1 + (m.pinned ? 1 : 0)),
      );
    }

    for (const other of this.k.store.sessions.listLive(pid, LIVE_WINDOW_MS)) {
      if (other.id === session.id || other.status === 'ended') continue;
      const task = other.currentTaskId ? this.k.store.tasks.find(other.currentTaskId) : null;
      const intents = this.k.store.intents.activeForSession(other.id);
      const files = [...new Set(intents.flatMap((i) => i.targets.files))].slice(0, 6);
      const parts = [
        `- ${sessionLabel(other)} (${other.status}, active ${relativeTime(other.lastSeenAt, now)})`,
      ];
      if (task) parts.push(`task: ${sanitizeLine(task.title, 120)}`);
      if (files.length) parts.push(`editing: ${files.map((f) => sanitizeLine(f, 160)).join(', ')}`);
      cands.push({
        item: {
          ref: other.id,
          kind: 'session',
          title: sessionLabel(other),
          score: 1,
          tokens: 0,
          reason: 'live agent',
        },
        section: 'Other agents working on this project now',
        order: 3,
        line: parts.join('; '),
      });
    }

    for (const c of this.k.store.conflicts.list(pid, { limit: 10 })) {
      cands.push({
        item: {
          ref: c.id,
          kind: 'conflict',
          title: c.title,
          score: c.severity === 'critical' ? 1 : 0.6,
          tokens: 0,
          reason: `${c.kind} conflict`,
        },
        section: 'Open conflicts',
        order: 4,
        line: `- [${c.severity}] ${sanitizeLine(c.title, 200)} — ${sanitizeForContext(c.detail, 240).replace(/\n/g, ' ')}`,
      });
    }

    const decisions = this.k.store.memories.list(pid, {
      kinds: ['decision', 'fact'],
      trust: ['approved', 'verified'],
      ...(branchFilter !== undefined ? { branch: branchFilter } : {}),
      updatedSince: now - 30 * 24 * 60 * 60_000,
      limit: 30,
    });
    for (const m of decisions) {
      cands.push(this.memoryCandidate(m, 'Key decisions and facts', 5, recency(m.updatedAt, now)));
    }

    const mistakes = this.k.store.memories.list(pid, {
      kinds: ['mistake'],
      trust: ['proposed', 'approved', 'verified'],
      limit: 10,
    });
    for (const m of mistakes)
      cands.push(this.memoryCandidate(m, 'Known pitfalls', 6, recency(m.updatedAt, now)));

    const proposedRules = this.k.store.memories.list(pid, {
      kinds: ['rule'],
      trust: ['proposed'],
      limit: 8,
    });
    for (const m of proposedRules)
      cands.push(
        this.memoryCandidate(m, 'Unconfirmed rules (not yet approved by the user)', 7, 0.5),
      );

    if (project.trusted && project.config.notes) {
      cands.push({
        item: {
          ref: 'project-notes',
          kind: 'memory',
          title: 'project notes',
          score: 1,
          tokens: 0,
          reason: 'trusted project config',
        },
        section: 'Project notes (.mindly/config.json)',
        order: 8,
        line: sanitizeForContext(project.config.notes, 2000),
      });
    }

    for (const t of this.k.store.tasks.ownedBy(session.id)) {
      cands.push({
        item: {
          ref: t.id,
          kind: 'task',
          title: t.title,
          score: 1,
          tokens: 0,
          reason: 'owned task',
        },
        section: 'Your open tasks',
        order: 9,
        line: `- ${sanitizeLine(t.title, 160)} (${t.status})`,
      });
    }

    return this.finish(
      project,
      session,
      'session_start',
      null,
      cands,
      this.k.config.context.sessionStartTokens,
      `Project: ${project.project.name}`,
    );
  }

  // ------------------------------------------------------------------ prompt

  prompt(project: ProjectContext, session: Session, prompt: string): BuiltContext {
    const now = this.k.clock.now();
    const pid = project.project.id;
    const cands: Candidate[] = [...this.deliveryCandidates(session, 0)];

    const served = this.recentlyServed(session);
    const hits = this.k.store.memories.search(pid, prompt, {
      trust: ['approved', 'verified', 'proposed'],
      ...(session.branch ? { branch: session.branch } : {}),
      limit: 25,
    });
    hits.forEach((h, i) => {
      const m = h.memory;
      const servedAt = served.get(m.id);
      if (servedAt !== undefined && m.updatedAt <= servedAt) return;
      const relevance = 1 - i / Math.max(hits.length, 1);
      const score =
        relevance * 0.6 +
        (rankTrust(m.trust) / 4) * 0.25 +
        recency(m.updatedAt, now) * 0.1 +
        (m.pinned ? 0.05 : 0);
      cands.push(this.memoryCandidate(m, 'Relevant project memory', 2, score));
    });

    return this.finish(
      project,
      session,
      'prompt',
      prompt.slice(0, 500),
      cands,
      this.k.config.context.promptTokens,
    );
  }

  // ------------------------------------------------------------------ before a write

  preWrite(
    project: ProjectContext,
    session: Session,
    paths: string[],
    warnings: string[],
  ): BuiltContext & { deny: Memory | null } {
    const pid = project.project.id;
    const cands: Candidate[] = [];
    warnings.forEach((w, i) =>
      cands.push({
        item: {
          ref: `warning-${i}`,
          kind: 'intent',
          title: w.slice(0, 80),
          score: 1,
          tokens: 0,
          reason: 'overlap',
        },
        section: 'Coordination warning',
        order: 0,
        line: `- ${sanitizeLine(w, 300)}`,
        mandatory: true,
      }),
    );

    let deny: Memory | null = null;
    const scopedRules = this.k.store.memories
      .list(pid, { kinds: ['rule'], trust: ['approved', 'verified'], limit: 300 })
      .filter(
        (m) => m.scope.paths.length > 0 && paths.some((p) => matchesAnyGlob(p, m.scope.paths)),
      );
    for (const m of scopedRules) {
      if (m.enforce && m.source.type === 'user' && !deny) deny = m;
      cands.push(
        this.memoryCandidate(
          m,
          `Rules for ${paths
            .slice(0, 2)
            .map((p) => sanitizeLine(p, 80))
            .join(', ')}`,
          1,
          1,
        ),
      );
    }

    for (const p of paths.slice(0, 5)) {
      for (const m of this.mistakes.forPath(pid, p))
        cands.push(this.memoryCandidate(m, 'Known pitfalls for this file', 2, 0.8));
      for (const e of this.k.store.memories.evidenceForFile(pid, p).slice(0, 5)) {
        const m = this.k.store.memories.find(e.memoryId);
        if (m && m.status === 'active' && m.trust !== 'rejected') {
          cands.push(this.memoryCandidate(m, 'Project knowledge tied to this file', 3, 0.6));
        }
      }
    }
    const built = this.finish(
      project,
      session,
      'pre_tool',
      paths.join(', ').slice(0, 300),
      dedupe(cands),
      this.k.config.context.preToolTokens,
    );
    return { ...built, deny };
  }

  // ------------------------------------------------------------------ helpers

  private memoryCandidate(m: Memory, section: string, order: number, score: number): Candidate {
    const line = memoryLine(m);
    return {
      item: {
        ref: m.id,
        kind: 'memory',
        title: m.title,
        score: round(score),
        tokens: 0,
        reason: `${m.kind}/${m.trust}`,
      },
      section,
      order,
      line,
    };
  }

  private deliveryCandidates(session: Session, order: number): Candidate[] {
    const now = this.k.clock.now();
    return this.telepathy.pending(session, 15).map((d) => {
      const from = d.sourceSessionId ? this.k.store.sessions.find(d.sourceSessionId) : null;
      const who = from ? sessionLabel(from) : 'Mindly';
      const body = d.body ? ` — ${sanitizeForContext(d.body, 600).replace(/\n/g, ' ')}` : '';
      return {
        item: {
          ref: d.id,
          kind: 'delivery',
          title: d.title,
          score: 1 + d.priority / 10,
          tokens: 0,
          reason: `${d.kind} from ${who}`,
        },
        section: 'Updates from other agents since your last turn',
        order,
        line: `- [${d.kind} · from ${who} · ${relativeTime(d.createdAt, now)}] ${sanitizeLine(d.title, 200)}${body}`,
        mandatory: d.priority >= 5,
        delivery: d,
      };
    });
  }

  private claimHandoff(session: Session): Handoff | null {
    for (const h of this.k.store.handoffs.pendingFor(
      session.projectId,
      session.agentKind,
      session.id,
      safeRealpath(session.worktree),
    )) {
      if (this.k.store.handoffs.claim(h.id, session.id)) {
        this.k.store.events.append({
          projectId: session.projectId,
          sessionId: session.id,
          type: 'handoff.claimed',
          payload: { handoffId: h.id, from: h.fromSessionId, reason: h.reason },
        });
        if (h.taskId) {
          this.k.store.tasks.update(h.taskId, {
            ownerSessionId: session.id,
            status: 'in_progress',
          });
          this.k.store.sessions.setCurrentTask(session.id, h.taskId);
        }
        return h;
      }
    }
    return null;
  }

  private handoffCandidates(h: Handoff): Candidate[] {
    if (h.packet.split) return [splitBriefCandidate(h, h.packet.split)];
    const from = this.k.store.sessions.find(h.fromSessionId);
    const who = from ? sessionLabel(from) : 'another agent';
    const p = h.packet;
    const lines = [
      `You are continuing work handed off by ${who} (${h.reason === 'rate_limit' ? 'it hit its usage limit' : h.reason}).`,
      `Goal: ${sanitizeLine(p.goal || h.summary, 400)}`,
    ];
    if (p.plan.length)
      lines.push(
        `Plan: ${p.plan.map((s) => `${s.done ? '[x]' : '[ ]'} ${sanitizeLine(s.text, 120)}`).join('; ')}`,
      );
    if (p.filesChanged.length)
      lines.push(
        `Files changed so far: ${p.filesChanged
          .slice(0, 20)
          .map((f) => sanitizeLine(f, 160))
          .join(', ')}`,
      );
    if (p.decisions.length)
      lines.push(
        `Decisions: ${p.decisions
          .slice(0, 8)
          .map((d) => sanitizeLine(d, 160))
          .join('; ')}`,
      );
    if (p.blockers.length)
      lines.push(
        `Blockers: ${p.blockers
          .slice(0, 5)
          .map((b) => sanitizeLine(b, 160))
          .join('; ')}`,
      );
    if (p.nextSteps.length)
      lines.push(
        `Next steps: ${p.nextSteps
          .slice(0, 8)
          .map((s) => sanitizeLine(s, 160))
          .join('; ')}`,
      );
    if (p.recentPrompts.length)
      lines.push(
        `Recent user requests: ${p.recentPrompts
          .slice(0, 3)
          .map((s) => `"${sanitizeLine(s, 200)}"`)
          .join(' / ')}`,
      );
    if (p.branch)
      lines.push(
        `Branch: ${sanitizeLine(p.branch, 100)}${p.headCommit ? ` at ${p.headCommit.slice(0, 12)}` : ''}`,
      );
    lines.push(
      'Verify the current state of the files before continuing; the summary may be incomplete.',
    );
    return [
      {
        item: {
          ref: h.id,
          kind: 'handoff',
          title: h.summary,
          score: 2,
          tokens: 0,
          reason: 'claimed handoff',
        },
        section: 'Handoff for you',
        order: 0,
        line: lines.join('\n'),
        mandatory: true,
      },
    ];
  }

  /** Memory ids already shown to this session recently, with when they were shown. */
  private recentlyServed(session: Session): Map<string, number> {
    const since = this.k.clock.now() - RECENT_SERVE_WINDOW_MS;
    const out = new Map<string, number>();
    for (const p of this.k.store.contextPackets.forSession(session.id, 30)) {
      if (p.createdAt < since) continue;
      for (const i of p.included) if (!out.has(i.ref)) out.set(i.ref, p.createdAt);
    }
    return out;
  }

  private finish(
    project: ProjectContext,
    session: Session,
    trigger: ContextPacket['trigger'],
    query: string | null,
    cands: Candidate[],
    budget: number,
    intro?: string,
  ): BuiltContext {
    for (const c of cands) c.item.tokens = estimateTokens(c.line) + 2;
    const sorted = [...cands].sort((a, b) => a.order - b.order || b.item.score - a.item.score);
    let used = RESERVE_TOKENS;
    const included: Candidate[] = [];
    const omitted: ContextItem[] = [];
    for (const c of sorted) {
      if (c.mandatory || used + c.item.tokens <= budget) {
        included.push(c);
        used += c.item.tokens;
      } else {
        omitted.push({ ...c.item, reason: `${c.item.reason}; over token budget` });
      }
    }

    const sections: Section[] = [];
    for (const c of included) {
      let s = sections.find((x) => x.heading === c.section);
      if (!s) {
        s = { heading: c.section, lines: [] };
        sections.push(s);
      }
      s.lines.push(c.line);
    }
    const text = renderSections(sections, intro);
    const deliveries = included.flatMap((c) => (c.delivery ? [c.delivery] : []));
    if (!text) {
      return { text: null, packet: null, deliveries: [] };
    }
    this.telepathy.markDelivered(session, deliveries);
    const packet = this.k.store.contextPackets.record({
      projectId: project.project.id,
      sessionId: session.id,
      trigger,
      query,
      included: included.map((c) => c.item),
      omitted,
      tokenBudget: budget,
      tokensUsed: used,
    });
    this.k.store.events.append({
      projectId: project.project.id,
      sessionId: session.id,
      type: 'context.served',
      payload: {
        packetId: packet.id,
        trigger,
        items: included.length,
        omitted: omitted.length,
        tokens: used,
      },
    });
    return { text, packet, deliveries };
  }
}

/** The brief of a split part, rendered as the first section of the session. */
function splitBriefCandidate(h: Handoff, brief: HandoffSplitBrief): Candidate {
  const globs = (g: readonly string[]): string => g.map((x) => sanitizeLine(x, 160)).join(', ');
  const lines = [
    `You are working on part "${sanitizeLine(brief.title, 120)}" of the split "${sanitizeLine(brief.goal, 300)}" in this worktree (branch ${sanitizeLine(h.packet.branch ?? '', 120)}). Other agents work on the other parts in their own worktrees.`,
    `Your part: ${sanitizeForContext(h.packet.goal, 3000).replace(/\n/g, ' ')}`,
    `Files you own (edit only these): ${globs(brief.owns)}`,
  ];
  if (brief.reads.length) lines.push(`Files you may read for context: ${globs(brief.reads)}`);
  if (brief.dependsOn.length) {
    lines.push(
      `Your part depends on part(s): ${globs(brief.dependsOn)}; build against the shared contract, not against their unfinished code.`,
    );
  }
  lines.push(
    brief.strict
      ? 'Writes to files owned by another part are blocked (strict mode): ask the user instead.'
      : 'Writing to files owned by another part raises a coordination warning: coordinate first.',
  );
  if (brief.contract.length) {
    lines.push(
      `Shared contract (approved decisions): ${brief.contract.map((c) => sanitizeLine(c, 300)).join('; ')}`,
    );
  }
  lines.push('When your part is finished, mark its task done (mindly_update_task).');
  return {
    item: {
      ref: h.id,
      kind: 'handoff',
      title: h.summary,
      score: 2,
      tokens: 0,
      reason: 'split brief',
    },
    section: 'Your part of the split',
    order: 0,
    line: lines.join('\n'),
    mandatory: true,
  };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function recency(t: number, now: number): number {
  const days = Math.max(0, (now - t) / 86_400_000);
  return 1 / (1 + days / 7);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function dedupe(cands: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return cands.filter((c) => {
    if (seen.has(c.item.ref)) return false;
    seen.add(c.item.ref);
    return true;
  });
}
