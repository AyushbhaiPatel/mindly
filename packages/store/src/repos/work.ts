import {
  notFound,
  uuidv7,
  type Clock,
  type Conflict,
  type ConflictKind,
  type ConflictStatus,
  type Delivery,
  type DeliveryKind,
  type DeliveryStatus,
  type FileChange,
  type Intent,
  type IntentStatus,
  type IntentTargets,
  type Severity,
  type Task,
  type TaskPlanStep,
  type TaskStatus,
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
// Tasks
// ---------------------------------------------------------------------------------------------

function toTask(r: Row): Task {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    title: str(r, 'title'),
    description: str(r, 'description'),
    status: str(r, 'status') as TaskStatus,
    ownerSessionId: strOrNull(r, 'owner_session_id'),
    parentId: strOrNull(r, 'parent_id'),
    plan: json<TaskPlanStep[]>(r, 'plan', []),
    blockers: json<string[]>(r, 'blockers', []),
    createdAt: num(r, 'created_at'),
    updatedAt: num(r, 'updated_at'),
  };
}

export interface TaskCreate {
  projectId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  ownerSessionId?: string | null;
  parentId?: string | null;
  plan?: TaskPlanStep[];
}

export interface TaskPatch {
  title?: string;
  description?: string;
  status?: TaskStatus;
  ownerSessionId?: string | null;
  plan?: TaskPlanStep[];
  blockers?: string[];
}

export class TaskRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: TaskCreate): Task {
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, description, status, owner_session_id, parent_id,
           plan, blockers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.title,
        input.description ?? '',
        input.status ?? 'open',
        input.ownerSessionId ?? null,
        input.parentId ?? null,
        toJson(input.plan ?? []),
        now,
        now,
      );
    return this.get(id);
  }

  get(id: string): Task {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('task', id);
    return toTask(r);
  }

  find(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : null;
  }

  update(id: string, patch: TaskPatch): Task {
    const cur = this.get(id);
    this.db
      .prepare(
        `UPDATE tasks SET title = ?, description = ?, status = ?, owner_session_id = ?, plan = ?,
           blockers = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.title ?? cur.title,
        patch.description ?? cur.description,
        patch.status ?? cur.status,
        patch.ownerSessionId === undefined ? cur.ownerSessionId : patch.ownerSessionId,
        toJson(patch.plan ?? cur.plan),
        toJson(patch.blockers ?? cur.blockers),
        this.clock.now(),
        id,
      );
    return this.get(id);
  }

  list(projectId: string, opts: { statuses?: readonly TaskStatus[]; limit?: number } = {}): Task[] {
    const params: (string | number)[] = [projectId];
    let where = 'project_id = ?';
    if (opts.statuses?.length) {
      where += ` AND status IN (${opts.statuses.map(() => '?').join(', ')})`;
      params.push(...opts.statuses);
    }
    params.push(limit(opts.limit, 100));
    return (
      this.db
        .prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params) as Row[]
    ).map(toTask);
  }

  ownedBy(sessionId: string): Task[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tasks WHERE owner_session_id = ? AND status IN ('open', 'in_progress', 'blocked')
           ORDER BY updated_at DESC LIMIT 20`,
        )
        .all(sessionId) as Row[]
    ).map(toTask);
  }
}

// ---------------------------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------------------------

export class IntentRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private hydrate(r: Row): Intent {
    const targets = this.db
      .prepare('SELECT kind, value FROM intent_targets WHERE intent_id = ?')
      .all(str(r, 'id')) as Row[];
    const t: IntentTargets = { files: [], symbols: [] };
    for (const row of targets) {
      (str(row, 'kind') === 'file' ? t.files : t.symbols).push(str(row, 'value'));
    }
    return {
      id: str(r, 'id'),
      projectId: str(r, 'project_id'),
      sessionId: str(r, 'session_id'),
      taskId: strOrNull(r, 'task_id'),
      summary: str(r, 'summary'),
      targets: t,
      status: str(r, 'status') as IntentStatus,
      createdAt: num(r, 'created_at'),
      updatedAt: num(r, 'updated_at'),
      expiresAt: num(r, 'expires_at'),
    };
  }

  declare(input: {
    projectId: string;
    sessionId: string;
    taskId?: string | null;
    summary: string;
    targets: IntentTargets;
    ttlMs: number;
  }): Intent {
    const now = this.clock.now();
    const id = uuidv7(now);
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO intents (id, project_id, session_id, task_id, summary, status, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.sessionId,
          input.taskId ?? null,
          input.summary,
          now,
          now,
          now + input.ttlMs,
        );
      this.addTargets(id, input.targets);
    });
    return this.get(id);
  }

  addTargets(id: string, targets: Partial<IntentTargets>): void {
    const stmt = this.db.prepare(
      'INSERT INTO intent_targets (intent_id, kind, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    );
    for (const f of targets.files ?? []) stmt.run(id, 'file', f);
    for (const s of targets.symbols ?? []) stmt.run(id, 'symbol', s);
  }

  /** Extends the lifetime of an active intent. */
  refresh(id: string, ttlMs: number): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE intents SET updated_at = ?, expires_at = ? WHERE id = ? AND status = 'active'`,
      )
      .run(now, now + ttlMs, id);
  }

  get(id: string): Intent {
    const r = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('intent', id);
    return this.hydrate(r);
  }

  setStatus(id: string, status: IntentStatus): void {
    this.db
      .prepare('UPDATE intents SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.clock.now(), id);
  }

  closeForSession(sessionId: string, status: IntentStatus = 'completed'): number {
    const res = this.db
      .prepare(
        `UPDATE intents SET status = ?, updated_at = ? WHERE session_id = ? AND status = 'active'`,
      )
      .run(status, this.clock.now(), sessionId);
    return Number(res.changes);
  }

  expire(): number {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `UPDATE intents SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at < ?`,
      )
      .run(now, now);
    return Number(res.changes);
  }

  active(projectId: string): Intent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM intents WHERE project_id = ? AND status = 'active' AND expires_at >= ?
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(projectId, this.clock.now()) as Row[];
    return rows.map((r) => this.hydrate(r));
  }

  activeForSession(sessionId: string): Intent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM intents WHERE session_id = ? AND status = 'active' AND expires_at >= ?
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(sessionId, this.clock.now()) as Row[];
    return rows.map((r) => this.hydrate(r));
  }

  /** Active intents of *other* sessions that target any of the given files. */
  othersTargetingFiles(projectId: string, sessionId: string, files: readonly string[]): Intent[] {
    if (files.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT i.* FROM intents i JOIN intent_targets t ON t.intent_id = i.id
         WHERE i.project_id = ? AND i.session_id != ? AND i.status = 'active' AND i.expires_at >= ?
           AND t.kind = 'file' AND t.value IN (${files.map(() => '?').join(', ')})
         LIMIT 50`,
      )
      .all(projectId, sessionId, this.clock.now(), ...files) as Row[];
    return rows.map((r) => this.hydrate(r));
  }
}

// ---------------------------------------------------------------------------------------------
// File changes (provenance)
// ---------------------------------------------------------------------------------------------

function toFileChange(r: Row, hashes: string[]): FileChange {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    sessionId: str(r, 'session_id'),
    path: str(r, 'path'),
    tool: str(r, 'tool'),
    hunkHashes: hashes,
    addedLines: num(r, 'added_lines'),
    removedLines: num(r, 'removed_lines'),
    promptEventId: strOrNull(r, 'prompt_event_id'),
    createdAt: num(r, 'created_at'),
  };
}

export class FileChangeRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Records an agent edit. `lineHashes` are the hashes of the whole lines the edit added (what
   * `mindly track` measures survival over); `hunkHashes` also hold fragments, for provenance.
   */
  record(
    input: Omit<FileChange, 'id' | 'createdAt'> & { lineHashes?: readonly string[] },
  ): FileChange {
    const now = this.clock.now();
    const id = uuidv7(now);
    const hashes = [...new Set(input.hunkHashes)].slice(0, 5000);
    const lines = [...new Set(input.lineHashes ?? [])].slice(0, 5000);
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO file_changes (id, project_id, session_id, path, tool, added_lines, removed_lines,
             prompt_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.sessionId,
          input.path,
          input.tool,
          input.addedLines,
          input.removedLines,
          input.promptEventId,
          now,
        );
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO file_change_hunks (change_id, hash) VALUES (?, ?)',
      );
      for (const h of hashes) stmt.run(id, h);
      if (lines.length > 0) {
        const line = this.db.prepare(
          'INSERT OR IGNORE INTO file_change_lines (change_id, hash) VALUES (?, ?)',
        );
        for (const h of lines) line.run(id, h);
      }
    });
    return {
      id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      path: input.path,
      tool: input.tool,
      hunkHashes: hashes,
      addedLines: input.addedLines,
      removedLines: input.removedLines,
      promptEventId: input.promptEventId,
      createdAt: now,
    };
  }

  /** Most recent changes whose added lines include `hash`, restricted to one file. */
  findByHash(projectId: string, path: string, hash: string): FileChange[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM file_change_hunks h JOIN file_changes c ON c.id = h.change_id
         WHERE h.hash = ? AND c.project_id = ? AND c.path = ? ORDER BY c.created_at DESC LIMIT 10`,
      )
      .all(hash, projectId, path) as Row[];
    return rows.map((r) => toFileChange(r, [hash]));
  }

  forPath(projectId: string, path: string, max?: number): FileChange[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM file_changes WHERE project_id = ? AND path = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(projectId, path, limit(max, 50)) as Row[]
    ).map((r) => toFileChange(r, []));
  }

  forSession(sessionId: string, since?: number): FileChange[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM file_changes WHERE session_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 500',
        )
        .all(sessionId, since ?? 0) as Row[]
    ).map((r) => toFileChange(r, []));
  }

  /** Changes of a project recorded after `since` (exclusive), newest first. */
  since(projectId: string, since: number, limit = 500): FileChange[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM file_changes WHERE project_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(projectId, since, Math.max(1, Math.min(5000, Math.trunc(limit)))) as Row[]
    ).map((r) => toFileChange(r, []));
  }

  /** Sessions other than `sessionId` that changed `path` since `since`. */
  otherEditors(projectId: string, sessionId: string, path: string, since: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT session_id FROM file_changes
           WHERE project_id = ? AND path = ? AND session_id != ? AND created_at >= ? LIMIT 20`,
        )
        .all(projectId, path, sessionId, since) as Row[]
    ).map((r) => str(r, 'session_id'));
  }

  recentPaths(sessionId: string, since: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT path, MAX(created_at) AS t FROM file_changes WHERE session_id = ? AND created_at >= ?
           GROUP BY path ORDER BY t DESC LIMIT 200`,
        )
        .all(sessionId, since) as Row[]
    ).map((r) => str(r, 'path'));
  }
}

// ---------------------------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------------------------

function toConflict(r: Row): Conflict {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    kind: str(r, 'kind') as ConflictKind,
    severity: str(r, 'severity') as Severity,
    status: str(r, 'status') as ConflictStatus,
    title: str(r, 'title'),
    detail: str(r, 'detail'),
    sessionIds: json<string[]>(r, 'session_ids', []),
    paths: json<string[]>(r, 'paths', []),
    fingerprint: str(r, 'fingerprint'),
    createdAt: num(r, 'created_at'),
    updatedAt: num(r, 'updated_at'),
    resolvedAt: numOrNull(r, 'resolved_at'),
  };
}

export interface ConflictReport {
  projectId: string;
  kind: ConflictKind;
  severity: Severity;
  title: string;
  detail: string;
  sessionIds: string[];
  paths: string[];
  fingerprint: string;
}

export class ConflictRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Opens a conflict, or refreshes the existing one with the same fingerprint. A conflict the
   * user dismissed stays dismissed; a resolved one is reopened if the problem recurs.
   */
  report(input: ConflictReport): { conflict: Conflict; isNew: boolean } {
    const now = this.clock.now();
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT * FROM conflicts WHERE project_id = ? AND fingerprint = ?')
        .get(input.projectId, input.fingerprint) as Row | undefined;
      if (existing) {
        const cur = toConflict(existing);
        if (cur.status === 'dismissed') return { conflict: cur, isNew: false };
        const reopened = cur.status === 'resolved';
        this.db
          .prepare(
            `UPDATE conflicts SET severity = ?, title = ?, detail = ?, session_ids = ?, paths = ?,
               status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
               resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
               updated_at = ? WHERE id = ?`,
          )
          .run(
            input.severity,
            input.title,
            input.detail,
            toJson(input.sessionIds),
            toJson(input.paths),
            now,
            cur.id,
          );
        return { conflict: this.get(cur.id), isNew: reopened };
      }
      const id = uuidv7(now);
      this.db
        .prepare(
          `INSERT INTO conflicts (id, project_id, kind, severity, status, title, detail, session_ids, paths,
             fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.kind,
          input.severity,
          input.title,
          input.detail,
          toJson(input.sessionIds),
          toJson(input.paths),
          input.fingerprint,
          now,
          now,
        );
      return { conflict: this.get(id), isNew: true };
    });
  }

  get(id: string): Conflict {
    const r = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('conflict', id);
    return toConflict(r);
  }

  find(id: string): Conflict | null {
    const r = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as Row | undefined;
    return r ? toConflict(r) : null;
  }

  setStatus(id: string, status: ConflictStatus): Conflict {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE conflicts SET status = ?, updated_at = ?,
           resolved_at = CASE WHEN ? IN ('resolved', 'dismissed') THEN ? ELSE NULL END WHERE id = ?`,
      )
      .run(status, now, status, now, id);
    return this.get(id);
  }

  /** Resolves open conflicts of `kind` whose fingerprint is not in `stillPresent`. */
  /**
   * Resolves the open conflicts of `kind` whose fingerprint is not in `stillPresent`. Conflicts
   * whose fingerprint starts with `exceptPrefix` belong to another reporter and are left alone.
   */
  resolveMissing(
    projectId: string,
    kind: ConflictKind,
    stillPresent: readonly string[],
    opts: { exceptPrefix?: string } = {},
  ): number {
    const open = this.db
      .prepare(
        `SELECT id, fingerprint FROM conflicts WHERE project_id = ? AND kind = ? AND status IN ('open', 'acknowledged')`,
      )
      .all(projectId, kind) as Row[];
    const keep = new Set(stillPresent);
    let n = 0;
    for (const r of open) {
      const fp = str(r, 'fingerprint');
      if (opts.exceptPrefix !== undefined && fp.startsWith(opts.exceptPrefix)) continue;
      if (!keep.has(fp)) {
        this.setStatus(str(r, 'id'), 'resolved');
        n++;
      }
    }
    return n;
  }

  list(
    projectId: string,
    opts: { statuses?: readonly ConflictStatus[]; sessionId?: string; limit?: number } = {},
  ): Conflict[] {
    const params: (string | number)[] = [projectId];
    let where = 'project_id = ?';
    const statuses = opts.statuses ?? ['open', 'acknowledged'];
    where += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
    params.push(...statuses);
    if (opts.sessionId) {
      where += ' AND EXISTS (SELECT 1 FROM json_each(session_ids) WHERE value = ?)';
      params.push(opts.sessionId);
    }
    params.push(limit(opts.limit, 100));
    return (
      this.db
        .prepare(
          `SELECT * FROM conflicts WHERE ${where}
           ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, updated_at DESC
           LIMIT ?`,
        )
        .all(...params) as Row[]
    ).map(toConflict);
  }
}

// ---------------------------------------------------------------------------------------------
// Deliveries (agent telepathy / inbox)
// ---------------------------------------------------------------------------------------------

function toDelivery(r: Row): Delivery {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    targetSessionId: strOrNull(r, 'target_session_id'),
    targetAgentKind: strOrNull(r, 'target_agent_kind'),
    kind: str(r, 'kind') as DeliveryKind,
    priority: num(r, 'priority'),
    title: str(r, 'title'),
    body: str(r, 'body'),
    status: str(r, 'status') as DeliveryStatus,
    dedupeKey: strOrNull(r, 'dedupe_key'),
    sourceSessionId: strOrNull(r, 'source_session_id'),
    createdAt: num(r, 'created_at'),
    deliveredAt: numOrNull(r, 'delivered_at'),
    ackedAt: numOrNull(r, 'acked_at'),
    expiresAt: num(r, 'expires_at'),
  };
}

export interface DeliveryCreate {
  projectId: string;
  targetSessionId: string | null;
  targetAgentKind: string | null;
  kind: DeliveryKind;
  priority?: number;
  title: string;
  body: string;
  dedupeKey?: string | null;
  sourceSessionId: string | null;
  ttlMs: number;
}

export class DeliveryRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Queues a delivery. With a dedupe key, an existing *pending* delivery is updated in place and an
   * already delivered/acked one is re-queued with the new content.
   */
  enqueue(input: DeliveryCreate): Delivery {
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO deliveries (id, project_id, target_session_id, target_agent_kind, kind, priority,
           title, body, status, dedupe_key, source_session_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
           title = excluded.title, body = excluded.body, priority = excluded.priority,
           status = 'pending', delivered_at = NULL, acked_at = NULL,
           created_at = excluded.created_at, expires_at = excluded.expires_at`,
      )
      .run(
        id,
        input.projectId,
        input.targetSessionId,
        input.targetAgentKind,
        input.kind,
        input.priority ?? 0,
        input.title,
        input.body,
        input.dedupeKey ?? null,
        input.sourceSessionId,
        now,
        now + input.ttlMs,
      );
    const r = (
      input.dedupeKey
        ? this.db
            .prepare('SELECT * FROM deliveries WHERE project_id = ? AND dedupe_key = ?')
            .get(input.projectId, input.dedupeKey)
        : this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id)
    ) as Row;
    return toDelivery(r);
  }

  find(id: string): Delivery | null {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Row | undefined;
    return r ? toDelivery(r) : null;
  }

  /** Pending, unexpired deliveries for a session (directly addressed or by agent kind). */
  pendingFor(projectId: string, sessionId: string, agentKind: string, max = 20): Delivery[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM deliveries
           WHERE project_id = ? AND status = 'pending' AND expires_at >= ?
             AND (target_session_id = ? OR (target_session_id IS NULL AND (target_agent_kind = ? OR target_agent_kind IS NULL)))
             AND (source_session_id IS NULL OR source_session_id != ?)
           ORDER BY priority DESC, created_at ASC LIMIT ?`,
        )
        .all(
          projectId,
          this.clock.now(),
          sessionId,
          agentKind,
          sessionId,
          limit(max, 20, 100),
        ) as Row[]
    ).map(toDelivery);
  }

  /**
   * Marks deliveries as delivered. Agent-kind broadcast deliveries are pinned to the receiving
   * session so they are not delivered to a second session as well.
   */
  markDelivered(ids: readonly string[], sessionId: string): void {
    const stmt = this.db.prepare(
      `UPDATE deliveries SET status = 'delivered', delivered_at = ?,
         target_session_id = COALESCE(target_session_id, ?) WHERE id = ? AND status = 'pending'`,
    );
    const now = this.clock.now();
    transaction(this.db, () => {
      for (const id of ids) stmt.run(now, sessionId, id);
    });
  }

  ack(ids: readonly string[], sessionId: string): number {
    const stmt = this.db.prepare(
      `UPDATE deliveries SET status = 'acked', acked_at = ? WHERE id = ? AND target_session_id = ? AND status = 'delivered'`,
    );
    const now = this.clock.now();
    let n = 0;
    transaction(this.db, () => {
      for (const id of ids) n += Number(stmt.run(now, id, sessionId).changes);
    });
    return n;
  }

  /** Acks everything delivered to a session up to `before` (implicit ack on next turn). */
  ackDeliveredBefore(sessionId: string, before: number): number {
    const res = this.db
      .prepare(
        `UPDATE deliveries SET status = 'acked', acked_at = ?
         WHERE target_session_id = ? AND status = 'delivered' AND delivered_at <= ?`,
      )
      .run(this.clock.now(), sessionId, before);
    return Number(res.changes);
  }

  expire(): number {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `UPDATE deliveries SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`,
      )
      .run(now);
    return Number(res.changes);
  }

  list(
    projectId: string,
    opts: { statuses?: readonly DeliveryStatus[]; limit?: number } = {},
  ): Delivery[] {
    const statuses = opts.statuses ?? ['pending', 'delivered'];
    return (
      this.db
        .prepare(
          `SELECT * FROM deliveries WHERE project_id = ? AND status IN (${statuses.map(() => '?').join(', ')})
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(projectId, ...statuses, limit(opts.limit, 100)) as Row[]
    ).map(toDelivery);
  }
}
