import {
  fingerprint,
  notFound,
  uuidv7,
  type Clock,
  type EventType,
  type Project,
  type Session,
  type SessionStatus,
  type MindlyEvent,
} from '@mindly/core';
import {
  json,
  limit,
  num,
  numOrNull,
  str,
  strOrNull,
  toJson,
  transaction,
  type Db,
  type Row,
} from '../db.js';

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

function toProject(r: Row): Project {
  return {
    id: str(r, 'id'),
    root: str(r, 'root'),
    name: str(r, 'name'),
    trustedConfigHash: strOrNull(r, 'trusted_config_hash'),
    createdAt: num(r, 'created_at'),
    updatedAt: num(r, 'updated_at'),
  };
}

export class ProjectRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Returns the project for a canonical root, creating it on first sight. */
  upsertByRoot(root: string, name: string): Project {
    const existing = this.findByRoot(root);
    if (existing) return existing;
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO projects (id, root, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (root) DO NOTHING`,
      )
      .run(id, root, name, now, now);
    return this.findByRoot(root) as Project;
  }

  findByRoot(root: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE root = ?').get(root) as Row | undefined;
    return r ? toProject(r) : null;
  }

  get(id: string): Project {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('project', id);
    return toProject(r);
  }

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Row[]).map(toProject);
  }

  setTrustedConfigHash(id: string, hash: string | null): void {
    this.db
      .prepare('UPDATE projects SET trusted_config_hash = ?, updated_at = ? WHERE id = ?')
      .run(hash, this.clock.now(), id);
  }

  /** Hard delete; cascades to every project-scoped row. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

function toSession(r: Row): Session {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    agentKind: str(r, 'agent_kind'),
    externalId: str(r, 'external_id'),
    status: str(r, 'status') as SessionStatus,
    label: strOrNull(r, 'label'),
    branch: strOrNull(r, 'branch'),
    worktree: str(r, 'worktree'),
    currentTaskId: strOrNull(r, 'current_task_id'),
    transcriptPath: strOrNull(r, 'transcript_path'),
    startedAt: num(r, 'started_at'),
    lastSeenAt: num(r, 'last_seen_at'),
    endedAt: numOrNull(r, 'ended_at'),
  };
}

export interface SessionUpsert {
  projectId: string;
  agentKind: string;
  externalId: string;
  worktree: string;
  branch: string | null;
  transcriptPath: string | null;
}

export class SessionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Finds the session for (project, agent, external id) or creates it. Touching an existing
   * session reactivates it and refreshes branch/worktree.
   */
  upsert(input: SessionUpsert): { session: Session; created: boolean } {
    const now = this.clock.now();
    const existing = this.db
      .prepare('SELECT * FROM sessions WHERE project_id = ? AND agent_kind = ? AND external_id = ?')
      .get(input.projectId, input.agentKind, input.externalId) as Row | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE sessions SET status = 'active', last_seen_at = ?, ended_at = NULL,
             branch = COALESCE(?, branch), worktree = ?, transcript_path = COALESCE(?, transcript_path)
           WHERE id = ?`,
        )
        .run(now, input.branch, input.worktree, input.transcriptPath, str(existing, 'id'));
      return { session: this.get(str(existing, 'id')), created: false };
    }
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, agent_kind, external_id, status, branch, worktree,
           transcript_path, started_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.agentKind,
        input.externalId,
        input.branch,
        input.worktree,
        input.transcriptPath,
        now,
        now,
      );
    return { session: this.get(id), created: true };
  }

  get(id: string): Session {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('session', id);
    return toSession(r);
  }

  find(id: string): Session | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? toSession(r) : null;
  }

  findByExternal(projectId: string, agentKind: string, externalId: string): Session | null {
    const r = this.db
      .prepare('SELECT * FROM sessions WHERE project_id = ? AND agent_kind = ? AND external_id = ?')
      .get(projectId, agentKind, externalId) as Row | undefined;
    return r ? toSession(r) : null;
  }

  /** Sessions considered live: active or idle and seen within `withinMs`. */
  listLive(projectId: string, withinMs: number): Session[] {
    const since = this.clock.now() - withinMs;
    return (
      this.db
        .prepare(
          `SELECT * FROM sessions WHERE project_id = ? AND status IN ('active', 'idle', 'rate_limited')
             AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 100`,
        )
        .all(projectId, since) as Row[]
    ).map(toSession);
  }

  list(projectId: string, max?: number): Session[] {
    return (
      this.db
        .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT ?')
        .all(projectId, limit(max, 50)) as Row[]
    ).map(toSession);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(this.clock.now(), id);
  }

  setStatus(id: string, status: SessionStatus): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, last_seen_at = ?,
           ended_at = CASE WHEN ? = 'ended' THEN ? ELSE ended_at END WHERE id = ?`,
      )
      .run(status, now, status, now, id);
  }

  setCurrentTask(id: string, taskId: string | null): void {
    this.db.prepare('UPDATE sessions SET current_task_id = ? WHERE id = ?').run(taskId, id);
  }

  setLabel(id: string, label: string | null): void {
    this.db.prepare('UPDATE sessions SET label = ? WHERE id = ?').run(label, id);
  }

  /**
   * Hands everything one session still has going to another session of the same agent: its
   * unfinished tasks, its active intents and the messages addressed to it that are not
   * acknowledged yet. Used when the two turn out to be one agent (an MCP server that started on
   * a session of its own and then found the session its client's hooks made). Call it inside a
   * transaction. Returns how many rows moved.
   */
  /**
   * What a task or an intent looks like now, to tell later whether anyone changed it: its
   * `updated_at` and a fingerprint of its content (two writes in one millisecond leave the time
   * as it was). Null when there is no such row.
   */
  rowStamp(kind: 'task' | 'intent', id: string): { updatedAt: number; sig: string } | null {
    if (kind === 'task') {
      const r = this.db
        .prepare(
          `SELECT updated_at, title, description, status, owner_session_id, parent_id, plan, blockers
             FROM tasks WHERE id = ?`,
        )
        .get(id) as Row | undefined;
      if (!r) return null;
      const sig = fingerprint(
        'task',
        str(r, 'title'),
        str(r, 'description'),
        str(r, 'status'),
        strOrNull(r, 'owner_session_id') ?? '',
        strOrNull(r, 'parent_id') ?? '',
        str(r, 'plan'),
        str(r, 'blockers'),
      );
      return { updatedAt: num(r, 'updated_at'), sig };
    }
    const r = this.db
      .prepare(
        `SELECT updated_at, summary, status, session_id, task_id, expires_at,
                (SELECT count(*) FROM intent_targets t WHERE t.intent_id = intents.id) AS targets
           FROM intents WHERE id = ?`,
      )
      .get(id) as Row | undefined;
    if (!r) return null;
    const sig = fingerprint(
      'intent',
      str(r, 'summary'),
      str(r, 'status'),
      str(r, 'session_id'),
      strOrNull(r, 'task_id') ?? '',
      String(num(r, 'expires_at')),
      String(num(r, 'targets')),
    );
    return { updatedAt: num(r, 'updated_at'), sig };
  }

  /**
   * Moves particular rows from one session to another, for an MCP server that spoke for a
   * session it only guessed at and leaves it. Intents and tasks are given as they looked after
   * that server last wrote them (`rowStamp`), and move only while they still belong to `fromId`
   * and look just the same; messages move while `fromId` is still their sender. Anything else
   * stays where it is: when it is not clear whose a row is, it is left. Current tasks are not
   * touched. Returns the ids that moved.
   */
  moveRows(
    fromId: string,
    toId: string,
    rows: {
      intents: readonly { id: string; updatedAt: number; sig: string }[];
      tasks: readonly { id: string; updatedAt: number; sig: string }[];
      messages: readonly string[];
      /**
       * Handoffs re-filed in the name of `toId`, so it cannot pick them up itself: pending ones,
       * and ones `toId` itself already picked up (they are put back as pending).
       */
      handoffs?: readonly string[];
    },
  ): { intents: string[]; tasks: string[]; messages: string[]; handoffs: string[] } {
    const out = {
      intents: [] as string[],
      tasks: [] as string[],
      messages: [] as string[],
      handoffs: [] as string[],
    };
    if (fromId === toId) return out;
    const now = this.clock.now();
    transaction(this.db, () => {
      const unchanged = (
        kind: 'task' | 'intent',
        r: { id: string; updatedAt: number; sig: string },
      ): boolean => {
        const stamp = this.rowStamp(kind, r.id);
        return stamp !== null && stamp.updatedAt === r.updatedAt && stamp.sig === r.sig;
      };
      const intent = this.db.prepare(
        `UPDATE intents SET session_id = ?, updated_at = ?
           WHERE id = ? AND session_id = ? AND status = 'active'`,
      );
      for (const r of rows.intents.slice(0, 500)) {
        if (!unchanged('intent', r)) continue;
        if (Number(intent.run(toId, now, r.id, fromId).changes) > 0) out.intents.push(r.id);
      }
      const task = this.db.prepare(
        `UPDATE tasks SET owner_session_id = ?, updated_at = ?
           WHERE id = ? AND owner_session_id = ? AND status IN ('open', 'in_progress', 'blocked')`,
      );
      for (const r of rows.tasks.slice(0, 500)) {
        if (!unchanged('task', r)) continue;
        if (Number(task.run(toId, now, r.id, fromId).changes) > 0) out.tasks.push(r.id);
      }
      const message = this.db.prepare(
        'UPDATE deliveries SET source_session_id = ? WHERE id = ? AND source_session_id = ?',
      );
      for (const id of rows.messages.slice(0, 500)) {
        if (Number(message.run(toId, id, fromId).changes) > 0) out.messages.push(id);
      }
      const handoff = this.db.prepare(
        `UPDATE handoffs SET from_session_id = ?, status = 'pending',
             claimed_by_session_id = NULL, claimed_at = NULL
           WHERE id = ? AND from_session_id = ?
             AND (status = 'pending' OR (status = 'claimed' AND claimed_by_session_id = ?))`,
      );
      for (const id of (rows.handoffs ?? []).slice(0, 500)) {
        if (Number(handoff.run(toId, id, fromId, toId).changes) > 0) out.handoffs.push(id);
      }
    });
    return out;
  }

  moveWork(fromId: string, toId: string): number {
    if (fromId === toId) return 0;
    const now = this.clock.now();
    let moved = 0;
    moved += Number(
      this.db
        .prepare(
          `UPDATE tasks SET owner_session_id = ?, updated_at = ?
             WHERE owner_session_id = ? AND status IN ('open', 'in_progress', 'blocked')`,
        )
        .run(toId, now, fromId).changes,
    );
    moved += Number(
      this.db
        .prepare(
          `UPDATE intents SET session_id = ?, updated_at = ? WHERE session_id = ? AND status = 'active'`,
        )
        .run(toId, now, fromId).changes,
    );
    moved += Number(
      this.db
        .prepare(
          `UPDATE OR IGNORE deliveries SET target_session_id = ?
             WHERE target_session_id = ? AND status IN ('pending', 'delivered')`,
        )
        .run(toId, fromId).changes,
    );
    const from = this.find(fromId);
    const to = this.find(toId);
    if (from?.currentTaskId && to && !to.currentTaskId) {
      this.setCurrentTask(toId, from.currentTaskId);
    }
    return moved;
  }

  /** Marks sessions not seen for `staleMs` as ended. Returns affected ids. */
  endStale(projectId: string, staleMs: number): string[] {
    const cutoff = this.clock.now() - staleMs;
    const rows = this.db
      .prepare(
        `SELECT id FROM sessions WHERE project_id = ? AND status != 'ended' AND last_seen_at < ?`,
      )
      .all(projectId, cutoff) as Row[];
    const ids = rows.map((r) => str(r, 'id'));
    const stmt = this.db.prepare(`UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?`);
    for (const id of ids) stmt.run(this.clock.now(), id);
    return ids;
  }
}

// ---------------------------------------------------------------------------------------------
// Events (append-only)
// ---------------------------------------------------------------------------------------------

function toEvent(r: Row): MindlyEvent {
  return {
    seq: num(r, 'seq'),
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    sessionId: strOrNull(r, 'session_id'),
    type: str(r, 'type') as EventType,
    payload: json<Record<string, unknown>>(r, 'payload', {}),
    createdAt: num(r, 'created_at'),
  };
}

export interface EventQuery {
  afterSeq?: number;
  beforeSeq?: number;
  since?: number;
  until?: number;
  types?: readonly EventType[];
  sessionId?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

/** Called synchronously after an event is appended in this process. */
export type EventListener = (event: MindlyEvent) => void;

export class EventRepo {
  private readonly listeners = new Set<EventListener>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Calls `listener` after every event this process appends (projections such as saves follow the
   * log this way). A listener must not throw; errors are swallowed so an append never fails because
   * of one. Returns a function that removes the listener.
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Appends an event. Payloads must already be redacted by the caller. `id` may be supplied for
   * idempotent writes (a duplicate id is ignored and the existing event returned).
   */
  append(input: {
    projectId: string;
    sessionId: string | null;
    type: EventType;
    payload: Record<string, unknown>;
    id?: string;
  }): MindlyEvent {
    const now = this.clock.now();
    const id = input.id ?? uuidv7(now);
    const res = this.db
      .prepare(
        `INSERT INTO events (id, project_id, session_id, type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .run(id, input.projectId, input.sessionId, input.type, toJson(input.payload), now);
    const event = this.getById(id) as MindlyEvent;
    if (Number(res.changes) === 0) return event;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners log their own failures; the event is stored either way.
      }
    }
    return event;
  }

  getById(id: string): MindlyEvent | null {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return r ? toEvent(r) : null;
  }

  query(projectId: string, q: EventQuery = {}): MindlyEvent[] {
    const where: string[] = ['project_id = ?'];
    const params: (string | number)[] = [projectId];
    if (q.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(q.afterSeq);
    }
    if (q.beforeSeq !== undefined) {
      where.push('seq < ?');
      params.push(q.beforeSeq);
    }
    if (q.since !== undefined) {
      where.push('created_at >= ?');
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push('created_at < ?');
      params.push(q.until);
    }
    if (q.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(q.sessionId);
    }
    if (q.types && q.types.length > 0) {
      where.push(`type IN (${q.types.map(() => '?').join(', ')})`);
      params.push(...q.types);
    }
    const order = q.order === 'desc' ? 'DESC' : 'ASC';
    params.push(limit(q.limit, 200, 5000));
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ${order} LIMIT ?`)
        .all(...params) as Row[]
    ).map(toEvent);
  }

  /** Highest sequence number across all projects (used by live feeds to poll cheaply). */
  maxSeq(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events').get() as Row;
    return num(r, 'm');
  }

  /** Replaces the payload of old prompt events with a summary-only payload (retention). */
  compactPrompts(olderThan: number): number {
    const res = this.db
      .prepare(
        `UPDATE events SET payload = json_remove(payload, '$.prompt')
         WHERE type = 'prompt.submitted' AND created_at < ? AND json_extract(payload, '$.prompt') IS NOT NULL`,
      )
      .run(olderThan);
    return Number(res.changes);
  }

  deleteOlderThan(olderThan: number): number {
    const res = this.db.prepare('DELETE FROM events WHERE created_at < ?').run(olderThan);
    return Number(res.changes);
  }
}
