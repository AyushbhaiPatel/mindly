import type { Clock, ConflictKind, ConflictStatus } from '@mindly/core';
import { json, num, str, strOrNull, type Db, type Row } from '../db.js';

/*
 * Read models of `mindly track`: grouped edit counts, line survival and the stored outcomes an
 * agent can be blamed for. Every query is scoped to one project and bounded by a time window.
 */

/** Edits of one session to one path in the window. */
export interface TrackEditGroup {
  path: string;
  sessionId: string;
  agentKind: string;
  edits: number;
  addedLines: number;
  removedLines: number;
}

/** Line survival of the edits of one agent to one path. */
export interface TrackSurvivalGroup {
  path: string;
  agentKind: string;
  totalHashes: number;
  keptHashes: number;
}

/** An agent edit whose line survival is not computed yet. */
export interface PendingSurvival {
  changeId: string;
  projectId: string;
  sessionId: string;
  path: string;
  /** The session's working directory (its tree root or a folder inside it). */
  worktree: string;
}

/** A bisect run that finished with a result. */
export interface TrackBisectRun {
  id: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: number;
}

/** A conflict as far as attribution needs it. */
export interface TrackConflict {
  id: string;
  kind: ConflictKind;
  status: ConflictStatus;
  sessionIds: string[];
  paths: string[];
}

/** A session seen in the window. */
export interface TrackSession {
  id: string;
  agentKind: string;
  status: string;
}

const MAX_ROWS = 100_000;

export class TrackRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Edits made at or after `from`, grouped by path and session. */
  editGroups(projectId: string, from: number): TrackEditGroup[] {
    const rows = this.db
      .prepare(
        `SELECT c.path AS path, c.session_id AS session_id, s.agent_kind AS agent_kind,
           COUNT(*) AS edits, SUM(c.added_lines) AS added, SUM(c.removed_lines) AS removed
         FROM file_changes c JOIN sessions s ON s.id = c.session_id
         WHERE c.project_id = ? AND c.created_at >= ?
         GROUP BY c.path, c.session_id LIMIT ?`,
      )
      .all(projectId, from, MAX_ROWS) as Row[];
    return rows.map((r) => ({
      path: str(r, 'path'),
      sessionId: str(r, 'session_id'),
      agentKind: str(r, 'agent_kind'),
      edits: num(r, 'edits'),
      addedLines: num(r, 'added'),
      removedLines: num(r, 'removed'),
    }));
  }

  /** Computed line survival of edits made between `from` and `before`, by path and agent. */
  survivalGroups(projectId: string, from: number, before: number): TrackSurvivalGroup[] {
    const rows = this.db
      .prepare(
        `SELECT c.path AS path, s.agent_kind AS agent_kind,
           SUM(l.total_hashes) AS total, SUM(l.kept_hashes) AS kept
         FROM line_survival l
           JOIN file_changes c ON c.id = l.change_id
           JOIN sessions s ON s.id = c.session_id
         WHERE l.project_id = ? AND c.created_at >= ? AND c.created_at <= ?
         GROUP BY c.path, s.agent_kind LIMIT ?`,
      )
      .all(projectId, from, before, MAX_ROWS) as Row[];
    return rows.map((r) => ({
      path: str(r, 'path'),
      agentKind: str(r, 'agent_kind'),
      totalHashes: num(r, 'total'),
      keptHashes: num(r, 'kept'),
    }));
  }

  /**
   * Edits made at or before `before` (and at or after `from`) without a survival row, oldest
   * first. `projectId` null covers every project (the daemon).
   */
  pendingSurvival(
    projectId: string | null,
    before: number,
    max: number,
    from = 0,
  ): PendingSurvival[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.project_id AS project_id, c.session_id AS session_id, c.path AS path,
           s.worktree AS worktree
         FROM file_changes c
           JOIN sessions s ON s.id = c.session_id
           LEFT JOIN line_survival l ON l.change_id = c.id
         WHERE l.change_id IS NULL AND (? IS NULL OR c.project_id = ?)
           AND c.created_at <= ? AND c.created_at >= ?
         ORDER BY c.created_at ASC LIMIT ?`,
      )
      .all(
        projectId,
        projectId,
        before,
        from,
        Math.max(1, Math.min(10_000, Math.trunc(max))),
      ) as Row[];
    return rows.map((r) => ({
      changeId: str(r, 'id'),
      projectId: str(r, 'project_id'),
      sessionId: str(r, 'session_id'),
      path: str(r, 'path'),
      worktree: str(r, 'worktree'),
    }));
  }

  /** How many edits made between `from` and `before` still have no survival row. */
  countPendingSurvival(projectId: string, before: number, from = 0): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM file_changes c LEFT JOIN line_survival l ON l.change_id = c.id
         WHERE l.change_id IS NULL AND c.project_id = ? AND c.created_at <= ? AND c.created_at >= ?`,
      )
      .get(projectId, before, from) as Row;
    return num(r, 'n');
  }

  /** The line hashes an edit added. */
  hashes(changeId: string): string[] {
    return (
      this.db
        .prepare('SELECT hash FROM file_change_hunks WHERE change_id = ? LIMIT 5000')
        .all(changeId) as Row[]
    ).map((r) => str(r, 'hash'));
  }

  /** Stores the survival of one edit. Computed once: an existing row is kept. */
  recordSurvival(input: {
    changeId: string;
    projectId: string;
    totalHashes: number;
    keptHashes: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO line_survival (change_id, project_id, checked_at, total_hashes, kept_hashes)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (change_id) DO NOTHING`,
      )
      .run(
        input.changeId,
        input.projectId,
        this.clock.now(),
        Math.max(0, Math.trunc(input.totalHashes)),
        Math.max(0, Math.min(Math.trunc(input.keptHashes), Math.trunc(input.totalHashes))),
      );
  }

  /** Bisect runs created at or after `from` that finished with a result (status `passed`). */
  bisectRuns(projectId: string, from: number): TrackBisectRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, input, result, created_at FROM runs
         WHERE project_id = ? AND kind = 'bisect' AND status = 'passed' AND created_at >= ?
         ORDER BY created_at DESC LIMIT 5000`,
      )
      .all(projectId, from) as Row[];
    return rows.map((r) => ({
      id: str(r, 'id'),
      input: json<Record<string, unknown>>(r, 'input', {}),
      result: json<Record<string, unknown>>(r, 'result', {}),
      createdAt: num(r, 'created_at'),
    }));
  }

  /** Conflicts of `kinds` opened at or after `from`, any status. */
  conflicts(projectId: string, kinds: readonly ConflictKind[], from: number): TrackConflict[] {
    if (kinds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id, kind, status, session_ids, paths FROM conflicts
         WHERE project_id = ? AND kind IN (${kinds.map(() => '?').join(', ')}) AND created_at >= ?
         ORDER BY created_at DESC LIMIT 10000`,
      )
      .all(projectId, ...kinds, from) as Row[];
    return rows.map((r) => ({
      id: str(r, 'id'),
      kind: str(r, 'kind') as ConflictKind,
      status: str(r, 'status') as ConflictStatus,
      sessionIds: json<string[]>(r, 'session_ids', []),
      paths: json<string[]>(r, 'paths', []),
    }));
  }

  /** Agent kind of every session of a project, by session id. */
  agentKinds(projectId: string): Map<string, string> {
    const rows = this.db
      .prepare('SELECT id, agent_kind FROM sessions WHERE project_id = ? LIMIT ?')
      .all(projectId, MAX_ROWS) as Row[];
    return new Map(rows.map((r) => [str(r, 'id'), str(r, 'agent_kind')]));
  }

  /** Sessions last seen at or after `from`. */
  sessionsSeen(projectId: string, from: number): TrackSession[] {
    return (
      this.db
        .prepare(
          `SELECT id, agent_kind, status FROM sessions WHERE project_id = ? AND last_seen_at >= ?
           LIMIT ?`,
        )
        .all(projectId, from, MAX_ROWS) as Row[]
    ).map((r) => ({
      id: str(r, 'id'),
      agentKind: str(r, 'agent_kind'),
      status: str(r, 'status'),
    }));
  }

  /**
   * Sessions that hit a usage limit at or after `from`: a `session.rate_limited` event, or a
   * handoff made because of a rate limit (what a `limit_handoff` save is about).
   */
  limitedSessionIds(projectId: string, from: number): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT session_id AS id FROM events
           WHERE project_id = ? AND type = 'session.rate_limited' AND created_at >= ?
         UNION
         SELECT from_session_id AS id FROM handoffs
           WHERE project_id = ? AND reason = 'rate_limit' AND created_at >= ?`,
      )
      .all(projectId, from, projectId, from) as Row[];
    const out = new Set<string>();
    for (const r of rows) {
      const id = strOrNull(r, 'id');
      if (id) out.add(id);
    }
    return out;
  }
}
