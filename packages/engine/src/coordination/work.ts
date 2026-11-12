import {
  fingerprint,
  hasUnsafeChars,
  redactText,
  sanitizeLine,
  shortId,
  type Conflict,
  type Intent,
  type Session,
  type Task,
  type TaskPlanStep,
  type TaskStatus,
} from '@mindly/core';
import type { TaskPatch } from '@mindly/store';
import { INTENT_TTL_MS, OVERLAP_WINDOW_MS, type Kernel } from '../kernel.js';
import type { TelepathyService } from './telepathy.js';

/** Short human label for a session; a stored label is sanitised so it cannot forge delimiters. */
export function sessionLabel(s: Session): string {
  const label = s.label ? sanitizeLine(s.label, 60) : '';
  return label ? `${s.agentKind} "${label}"` : `${s.agentKind} #${shortId(s.id)}`;
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export class TaskService {
  constructor(private readonly k: Kernel) {}

  /**
   * Task text is shown to every other agent (the "working on" line, handoffs), so it is redacted
   * like any other stored agent text.
   */
  private redact(text: string): string {
    return redactText(text, { extraPatterns: this.k.config.redaction.extraPatterns });
  }

  private line(text: string, max: number): string {
    return sanitizeLine(this.redact(text), max);
  }

  create(input: {
    projectId: string;
    title: string;
    description?: string;
    owner?: Session | null;
    plan?: string[];
    parentId?: string | null;
  }): Task {
    const task = this.k.store.tasks.create({
      projectId: input.projectId,
      title: this.line(input.title, 200),
      description: this.redact(input.description ?? '').slice(0, 4000),
      status: input.owner ? 'in_progress' : 'open',
      ownerSessionId: input.owner?.id ?? null,
      parentId: input.parentId ?? null,
      plan: (input.plan ?? []).slice(0, 50).map((t) => ({ text: this.line(t, 300), done: false })),
    });
    if (input.owner) this.k.store.sessions.setCurrentTask(input.owner.id, task.id);
    this.k.store.events.append({
      projectId: input.projectId,
      sessionId: input.owner?.id ?? null,
      type: 'task.created',
      payload: { taskId: task.id, title: task.title },
    });
    return task;
  }

  update(
    id: string,
    patch: {
      status?: TaskStatus;
      plan?: TaskPlanStep[];
      blockers?: string[];
      title?: string;
      description?: string;
    },
    by: Session | null,
  ): Task {
    const clean: TaskPatch = {};
    if (patch.status) clean.status = patch.status;
    if (patch.title) clean.title = this.line(patch.title, 200);
    if (patch.description !== undefined)
      clean.description = this.redact(patch.description).slice(0, 4000);
    if (patch.plan)
      clean.plan = patch.plan
        .slice(0, 50)
        .map((s) => ({ text: this.line(s.text, 300), done: !!s.done }));
    if (patch.blockers) clean.blockers = patch.blockers.slice(0, 20).map((b) => this.line(b, 300));
    const task = this.k.store.tasks.update(id, clean);
    this.k.store.events.append({
      projectId: task.projectId,
      sessionId: by?.id ?? null,
      type: 'task.updated',
      payload: { taskId: task.id, status: task.status, blockers: task.blockers.length },
    });
    return task;
  }

  claim(id: string, session: Session): Task {
    const task = this.k.store.tasks.update(id, {
      ownerSessionId: session.id,
      status: 'in_progress',
    });
    this.k.store.sessions.setCurrentTask(session.id, task.id);
    this.k.store.events.append({
      projectId: task.projectId,
      sessionId: session.id,
      type: 'task.updated',
      payload: { taskId: task.id, status: task.status, claimedBy: session.id },
    });
    return task;
  }

  list(projectId: string, statuses?: readonly TaskStatus[]): Task[] {
    return this.k.store.tasks.list(projectId, statuses ? { statuses } : {});
  }
}

// ---------------------------------------------------------------------------------------------
// Intents and overlap detection
// ---------------------------------------------------------------------------------------------

/** Prefix of the keys that mark an intent as declared explicitly (not the hooks' rolling one). */
export const DECLARED_INTENT_PREFIX = 'intent:declared:';

export interface OverlapReport {
  conflicts: Conflict[];
  /** Human-readable warnings for the acting agent. */
  warnings: string[];
  /** Which active intent of which other session each warning is about. */
  overlaps: { intentId: string; sessionId: string; conflictId: string; files: string[] }[];
}

export class IntentService {
  constructor(
    private readonly k: Kernel,
    private readonly telepathy: TelepathyService,
  ) {}

  /** Explicit declaration (MCP `mindly_declare_intent`). */
  declare(
    session: Session,
    summary: string,
    files: string[],
    symbols: string[] = [],
  ): { intent: Intent; overlap: OverlapReport } {
    // What an agent says it is about to do is stored, shown to other agents and written to the
    // event log, so it goes through the redactor like any other agent text.
    const redaction = { extraPatterns: this.k.config.redaction.extraPatterns };
    const intent = this.k.store.intents.declare({
      projectId: session.projectId,
      sessionId: session.id,
      taskId: session.currentTaskId,
      summary: sanitizeLine(redactText(summary, redaction), 300),
      targets: {
        files: files.filter((f) => !hasUnsafeChars(f) && f.length <= 1024).slice(0, 100),
        symbols: symbols.slice(0, 100).map((s) => sanitizeLine(redactText(s, redaction), 120)),
      },
      ttlMs: INTENT_TTL_MS,
    });
    // Declared in so many words: never the rolling "Editing …" intent that hooks add the files a
    // session writes to, whatever its summary says. (An MCP server that guessed which session it
    // speaks for may have declared it on another window's session.)
    this.k.store.kv.set(`${DECLARED_INTENT_PREFIX}${intent.id}`, true);
    this.k.store.events.append({
      projectId: session.projectId,
      sessionId: session.id,
      type: 'intent.declared',
      payload: {
        intentId: intent.id,
        summary: intent.summary,
        files: intent.targets.files.slice(0, 20),
      },
    });
    return { intent, overlap: this.checkOverlap(session, intent.targets.files) };
  }

  /**
   * Implicit intent from a file-writing tool call: the session's rolling "editing" intent gains
   * these files. Then checks for overlap with other sessions.
   */
  noteEditing(session: Session, files: string[]): OverlapReport {
    if (files.length === 0) return { conflicts: [], warnings: [], overlaps: [] };
    const existing = this.k.store.intents
      .activeForSession(session.id)
      .find(
        (i) =>
          i.summary.startsWith('Editing') &&
          this.k.store.kv.get<boolean>(`${DECLARED_INTENT_PREFIX}${i.id}`) === null,
      );
    if (existing) {
      this.k.store.intents.addTargets(existing.id, { files });
      this.k.store.intents.refresh(existing.id, INTENT_TTL_MS);
    } else {
      this.k.store.intents.declare({
        projectId: session.projectId,
        sessionId: session.id,
        taskId: session.currentTaskId,
        summary: `Editing ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}`,
        targets: { files, symbols: [] },
        ttlMs: INTENT_TTL_MS,
      });
    }
    return this.checkOverlap(session, files);
  }

  private checkOverlap(session: Session, files: string[]): OverlapReport {
    const report: OverlapReport = { conflicts: [], warnings: [], overlaps: [] };
    const others = this.k.store.intents.othersTargetingFiles(session.projectId, session.id, files);
    for (const other of others) {
      const otherSession = this.k.store.sessions.find(other.sessionId);
      if (!otherSession || otherSession.status === 'ended') continue;
      const shared = other.targets.files.filter((f) => files.includes(f));
      const pair = [session.id, otherSession.id].sort();
      const { conflict, isNew } = this.k.store.conflicts.report({
        projectId: session.projectId,
        kind: 'intent_overlap',
        severity: 'warning',
        title: `${sessionLabel(session)} and ${sessionLabel(otherSession)} are both changing ${shared[0] ?? 'the same files'}`,
        detail: `${sessionLabel(otherSession)} is working on: ${other.summary}. Shared files: ${shared.join(', ')}.`,
        sessionIds: pair,
        paths: shared,
        fingerprint: fingerprint('intent_overlap', ...pair, ...shared.sort()),
      });
      report.conflicts.push(conflict);
      report.overlaps.push({
        intentId: other.id,
        sessionId: otherSession.id,
        conflictId: conflict.id,
        files: shared,
      });
      report.warnings.push(
        `${sessionLabel(otherSession)} is also working on ${shared.join(', ')} ("${other.summary}"). Coordinate before overwriting its changes.`,
      );
      if (isNew) {
        this.k.store.events.append({
          projectId: session.projectId,
          sessionId: session.id,
          type: 'conflict.opened',
          payload: { conflictId: conflict.id, kind: conflict.kind, title: conflict.title },
        });
        this.telepathy.send({
          projectId: session.projectId,
          from: session,
          to: { sessionIds: [otherSession.id] },
          kind: 'conflict',
          priority: 6,
          title: `${sessionLabel(session)} started editing ${shared.join(', ')}`,
          body: `You declared work on these files ("${other.summary}"). Check for overlapping changes before continuing.`,
          dedupeKey: `overlap:${conflict.id}`,
        });
      }
    }
    return report;
  }

  /** After a write lands: other sessions that recently changed the same file. */
  checkRecentEditors(session: Session, path: string): Conflict | null {
    const since = this.k.clock.now() - OVERLAP_WINDOW_MS;
    const editors = this.k.store.fileChanges
      .otherEditors(session.projectId, session.id, path, since)
      .map((id) => this.k.store.sessions.find(id))
      .filter(
        (s): s is Session => s !== null && s.status !== 'ended' && s.worktree === session.worktree,
      );
    if (editors.length === 0) return null;
    const ids = [session.id, ...editors.map((e) => e.id)].sort();
    const { conflict, isNew } = this.k.store.conflicts.report({
      projectId: session.projectId,
      kind: 'file_overlap',
      severity: 'warning',
      title: `${path} was changed by ${editors.length + 1} agents in the last 30 minutes`,
      detail: `Agents: ${[session, ...editors].map(sessionLabel).join(', ')}. Review the file for lost or conflicting edits.`,
      sessionIds: ids,
      paths: [path],
      fingerprint: fingerprint('file_overlap', path, ...ids),
    });
    if (isNew) {
      this.telepathy.send({
        projectId: session.projectId,
        from: session,
        to: { sessionIds: editors.map((e) => e.id) },
        kind: 'conflict',
        priority: 5,
        title: `${sessionLabel(session)} just modified ${path}, which you also changed`,
        body: 'Re-read the file before your next edit to avoid overwriting its changes.',
        dedupeKey: `file_overlap:${conflict.id}`,
      });
    }
    return conflict;
  }

  closeSession(session: Session): void {
    const n = this.k.store.intents.closeForSession(session.id);
    if (n > 0) {
      this.k.store.events.append({
        projectId: session.projectId,
        sessionId: session.id,
        type: 'intent.closed',
        payload: { count: n },
      });
    }
  }
}
