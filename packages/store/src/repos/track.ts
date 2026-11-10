import type { Clock, ConflictKind, SaveKind } from '@mindly/core';
import { json, num, numOrNull, str, strOrNull, type Db, type Row } from '../db.js';

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

/** Line survival of the edits of one session to one path (only edits with tracked lines). */
export interface TrackSurvivalGroup {
  path: string;
  sessionId: string;
  agentKind: string;
  /** Edits with at least one tracked line whose survival was checked. */
  edits: number;
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
  /** The branch the session worked on, when known. */
  branch: string | null;
  createdAt: number;
}

/** A bisect run that finished with a result. */
export interface TrackBisectRun {
  id: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: number;
}

/**
 * One time a conflict was opened (or reopened), from its `conflict.opened` event: the sessions
 * and paths as they were at that moment.
 */
export interface TrackConflictOpening {
  conflictId: string;
  kind: ConflictKind;
  /** Null when the event predates sessions being recorded on it. */
  sessionIds: string[] | null;
  paths: string[];
  /** Contracts only: whether the edit that broke it was made in the project's own checkout. */
  actorInRoot: boolean | null;
  at: number;
}

/** A confirmed save, as far as attribution needs it. */
export interface TrackSave {
  sessionIds: string[];
  paths: string[];
  /** The enforced rule of a `rule_enforced` save. */
  ruleId: string | null;
  createdAt: number;
}

/** One write an enforced rule blocked, from the `tool.before` event of the denial. */
export interface TrackRuleDenial {
  sessionId: string;
  ruleId: string;
  paths: string[];
  at: number;
}

/** A session seen in the window. */
export interface TrackSession {
  id: string;
  agentKind: string;
  status: string;
}

/** Rows any one query of the track record reads; reaching it means the report is partial. */
export const TRACK_MAX_ROWS = 100_000;
const MAX_ROWS = TRACK_MAX_ROWS;

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

  /** Computed line survival of edits made between `from` and `before`, by path and session. */
  survivalGroups(projectId: string, from: number, before: number): TrackSurvivalGroup[] {
    const rows = this.db
      .prepare(
        `SELECT c.path AS path, c.session_id AS session_id, s.agent_kind AS agent_kind,
           COUNT(*) AS edits, SUM(l.total_hashes) AS total, SUM(l.kept_hashes) AS kept
         FROM line_survival l
           JOIN file_changes c ON c.id = l.change_id
           JOIN sessions s ON s.id = c.session_id
         WHERE l.project_id = ? AND l.total_hashes > 0 AND c.created_at >= ? AND c.created_at <= ?
         GROUP BY c.path, c.session_id LIMIT ?`,
      )
      .all(projectId, from, before, MAX_ROWS) as Row[];
    return rows.map((r) => ({
      path: str(r, 'path'),
      sessionId: str(r, 'session_id'),
      agentKind: str(r, 'agent_kind'),
      edits: num(r, 'edits'),
      totalHashes: num(r, 'total'),
      keptHashes: num(r, 'kept'),
    }));
  }

  /**
   * Edits made at or before `before` (and at or after `from`) without a survival row, oldest
   * first, after `after` when given. `projectId` null covers every project (the daemon).
   */
  pendingSurvival(
    projectId: string | null,
    before: number,
    max: number,
    from = 0,
    after: { createdAt: number; id: string } | null = null,
  ): PendingSurvival[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.project_id AS project_id, c.session_id AS session_id, c.path AS path,
           c.created_at AS created_at, s.worktree AS worktree, s.branch AS branch
         FROM file_changes c
           JOIN sessions s ON s.id = c.session_id
           LEFT JOIN line_survival l ON l.change_id = c.id
         WHERE l.change_id IS NULL AND (? IS NULL OR c.project_id = ?)
           AND c.created_at <= ? AND c.created_at >= ?
           AND (c.created_at, c.id) > (?, ?)
         ORDER BY c.created_at ASC, c.id ASC LIMIT ?`,
      )
      .all(
        projectId,
        projectId,
        before,
        from,
        after?.createdAt ?? -1,
        after?.id ?? '',
        Math.max(1, Math.min(10_000, Math.trunc(max))),
      ) as Row[];
    return rows.map((r) => ({
      changeId: str(r, 'id'),
      projectId: str(r, 'project_id'),
      sessionId: str(r, 'session_id'),
      path: str(r, 'path'),
      worktree: str(r, 'worktree'),
      branch: strOrNull(r, 'branch'),
      createdAt: num(r, 'created_at'),
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

  /** The hashes of the whole lines an edit added. */
  hashes(changeId: string): string[] {
    return (
      this.db
        .prepare('SELECT hash FROM file_change_lines WHERE change_id = ? LIMIT 5000')
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
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, from, MAX_ROWS) as Row[];
    return rows.map((r) => ({
      id: str(r, 'id'),
      input: json<Record<string, unknown>>(r, 'input', {}),
      result: json<Record<string, unknown>>(r, 'result', {}),
      createdAt: num(r, 'created_at'),
    }));
  }

  /** Every opening of a conflict of `kinds` at or after `from`, from `conflict.opened` events. */
  conflictOpenings(
    projectId: string,
    kinds: readonly ConflictKind[],
    from: number,
  ): TrackConflictOpening[] {
    if (kinds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT payload, created_at FROM events
         WHERE project_id = ? AND type = 'conflict.opened' AND created_at >= ?
           AND json_extract(payload, '$.kind') IN (${kinds.map(() => '?').join(', ')})
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(projectId, from, ...kinds, MAX_ROWS) as Row[];
    const out: TrackConflictOpening[] = [];
    for (const r of rows) {
      const p = json<Record<string, unknown>>(r, 'payload', {});
      if (typeof p['conflictId'] !== 'string') continue;
      const strings = (v: unknown): string[] | null =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
      out.push({
        conflictId: p['conflictId'],
        kind: p['kind'] as ConflictKind,
        sessionIds: strings(p['sessionIds']),
        paths: strings(p['paths']) ?? [],
        actorInRoot: typeof p['actorInRoot'] === 'boolean' ? p['actorInRoot'] : null,
        at: num(r, 'created_at'),
      });
    }
    return out;
  }

  /** Ids of the conflicts of a project the user dismissed. */
  dismissedConflicts(projectId: string): Set<string> {
    return new Set(
      (
        this.db
          .prepare(`SELECT id FROM conflicts WHERE project_id = ? AND status = 'dismissed' LIMIT ?`)
          .all(projectId, MAX_ROWS) as Row[]
      ).map((r) => str(r, 'id')),
    );
  }

  /** Confirmed saves of `kind` created at or after `from`. */
  confirmedSaves(projectId: string, kind: SaveKind, from: number): TrackSave[] {
    const rows = this.db
      .prepare(
        `SELECT session_ids, paths, refs, created_at FROM saves
         WHERE project_id = ? AND kind = ? AND status = 'confirmed' AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, kind, from, MAX_ROWS) as Row[];
    return rows.map((r) => {
      const ruleId = json<Record<string, unknown>>(r, 'refs', {})['ruleId'];
      return {
        sessionIds: json<string[]>(r, 'session_ids', []),
        paths: json<string[]>(r, 'paths', []),
        ruleId: typeof ruleId === 'string' ? ruleId : null,
        createdAt: num(r, 'created_at'),
      };
    });
  }

  /**
   * The writes an enforced rule blocked at or after `from`, newest first: one per `tool.before`
   * event that names the rule. A save is recorded once per problem, whoever runs into it again;
   * these events are what says which sessions did.
   */
  ruleDenials(projectId: string, from: number): TrackRuleDenial[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, payload, created_at FROM events
         WHERE project_id = ? AND type = 'tool.before' AND created_at >= ?
           AND session_id IS NOT NULL
           AND json_type(payload, '$.deniedBy') = 'text'
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(projectId, from, MAX_ROWS) as Row[];
    const out: TrackRuleDenial[] = [];
    for (const r of rows) {
      const p = json<Record<string, unknown>>(r, 'payload', {});
      const sessionId = strOrNull(r, 'session_id');
      const ruleId = p['deniedBy'];
      if (!sessionId || typeof ruleId !== 'string') continue;
      const paths = Array.isArray(p['paths'])
        ? p['paths'].filter((x): x is string => typeof x === 'string')
        : [];
      out.push({ sessionId, ruleId, paths, at: num(r, 'created_at') });
    }
    return out;
  }

  /**
   * When the kept event log of a project starts, if that is later than its first recorded edit at
   * or after `from`; otherwise null. Events are deleted after `retention.eventsDays` while edits
   * are kept, so a window can reach back further than the events that outcomes are read from.
   */
  eventsStartAfter(projectId: string, from: number): number | null {
    const edit = this.db
      .prepare(
        'SELECT MIN(created_at) AS at FROM file_changes WHERE project_id = ? AND created_at >= ?',
      )
      .get(projectId, from) as Row;
    const firstEdit = numOrNull(edit, 'at');
    if (firstEdit === null) return null;
    // The oldest event by sequence (indexed); events are appended in time order.
    const event = this.db
      .prepare('SELECT created_at AS at FROM events WHERE project_id = ? ORDER BY seq ASC LIMIT 1')
      .get(projectId) as Row | undefined;
    const firstEvent = event ? numOrNull(event, 'at') : null;
    if (firstEvent === null) return null;
    return firstEvent > firstEdit ? firstEvent : null;
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
