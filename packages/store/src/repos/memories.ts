import {
  notFound,
  uuidv7,
  type Clock,
  type EvidenceType,
  type Memory,
  type MemoryEvidence,
  type MemoryKind,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
  type MemoryVersion,
  type Trust,
} from '@mindly/core';
import {
  bool,
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

function toMemory(r: Row): Memory {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    kind: str(r, 'kind') as MemoryKind,
    title: str(r, 'title'),
    body: str(r, 'body'),
    tags: json<string[]>(r, 'tags', []),
    scope: { paths: json<string[]>(r, 'scope_paths', []), branch: strOrNull(r, 'scope_branch') },
    trust: str(r, 'trust') as Trust,
    status: str(r, 'status') as MemoryStatus,
    source: {
      type: str(r, 'source_type') as MemorySource['type'],
      sessionId: strOrNull(r, 'source_session_id'),
      agentKind: strOrNull(r, 'source_agent_kind'),
    },
    enforce: bool(r, 'enforce'),
    pinned: bool(r, 'pinned'),
    version: num(r, 'version'),
    supersedesId: strOrNull(r, 'supersedes_id'),
    createdAt: num(r, 'created_at'),
    updatedAt: num(r, 'updated_at'),
    lastVerifiedAt: numOrNull(r, 'last_verified_at'),
  };
}

function toVersion(r: Row): MemoryVersion {
  return {
    memoryId: str(r, 'memory_id'),
    version: num(r, 'version'),
    title: str(r, 'title'),
    body: str(r, 'body'),
    tags: json<string[]>(r, 'tags', []),
    scope: { paths: json<string[]>(r, 'scope_paths', []), branch: strOrNull(r, 'scope_branch') },
    trust: str(r, 'trust') as Trust,
    status: str(r, 'status') as MemoryStatus,
    changedBy: {
      type: str(r, 'changed_by_type') as MemorySource['type'],
      sessionId: strOrNull(r, 'changed_by_session'),
      agentKind: strOrNull(r, 'changed_by_agent'),
    },
    reason: strOrNull(r, 'reason'),
    createdAt: num(r, 'created_at'),
  };
}

function toEvidence(r: Row): MemoryEvidence {
  return {
    id: str(r, 'id'),
    memoryId: str(r, 'memory_id'),
    type: str(r, 'type') as EvidenceType,
    ref: str(r, 'ref'),
    excerpt: strOrNull(r, 'excerpt'),
    contentHash: strOrNull(r, 'content_hash'),
    createdAt: num(r, 'created_at'),
    checkedAt: numOrNull(r, 'checked_at'),
    valid: bool(r, 'valid'),
  };
}

export interface MemoryCreate {
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  scope?: Partial<MemoryScope>;
  trust: Trust;
  source: MemorySource;
  enforce?: boolean;
  pinned?: boolean;
  supersedesId?: string | null;
  reason?: string | null;
}

export interface MemoryPatch {
  title?: string;
  body?: string;
  tags?: string[];
  scope?: Partial<MemoryScope>;
  trust?: Trust;
  status?: MemoryStatus;
  enforce?: boolean;
  pinned?: boolean;
  lastVerifiedAt?: number | null;
}

export interface MemoryFilter {
  kinds?: readonly MemoryKind[];
  trust?: readonly Trust[];
  status?: MemoryStatus;
  /** Include memories on this branch plus branch-less ones. Undefined = all branches. */
  branch?: string | null;
  pinned?: boolean;
  updatedSince?: number;
  limit?: number;
}

export interface MemorySearchHit {
  memory: Memory;
  /** bm25 rank (lower is better, as SQLite reports it). */
  rank: number;
}

/**
 * Builds a safe FTS5 MATCH expression from free text: every word becomes a quoted prefix term
 * joined by OR. Quotes are stripped so input can never inject FTS operators or column filters.
 */
export function toFtsQuery(text: string, maxTerms = 16): string | null {
  const words = text
    .toLowerCase()
    .match(/[\p{L}\p{N}_]{2,40}/gu)
    ?.filter((w, i, all) => all.indexOf(w) === i)
    .slice(0, maxTerms);
  if (!words || words.length === 0) return null;
  return words.map((w) => `"${w}"*`).join(' OR ');
}

export class MemoryRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: MemoryCreate): Memory {
    const now = this.clock.now();
    const id = uuidv7(now);
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO memories (id, project_id, kind, title, body, tags, scope_paths, scope_branch,
             trust, status, source_type, source_session_id, source_agent_kind, enforce, pinned,
             version, supersedes_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.kind,
          input.title,
          input.body,
          toJson(input.tags ?? []),
          toJson(input.scope?.paths ?? []),
          input.scope?.branch ?? null,
          input.trust,
          input.source.type,
          input.source.sessionId,
          input.source.agentKind,
          input.enforce ? 1 : 0,
          input.pinned ? 1 : 0,
          input.supersedesId ?? null,
          now,
          now,
        );
      this.writeVersion(this.get(id), input.source, input.reason ?? null);
    });
    return this.get(id);
  }

  /**
   * Applies a patch as a new version. No-op patches do not create versions unless `record` is set
   * (used to record a user's explicit approval of a memory that was already approved).
   */
  update(
    id: string,
    patch: MemoryPatch,
    changedBy: MemorySource,
    reason: string | null,
    record = false,
  ): Memory {
    return transaction(this.db, () => {
      const cur = this.get(id);
      const next: Memory = {
        ...cur,
        title: patch.title ?? cur.title,
        body: patch.body ?? cur.body,
        tags: patch.tags ?? cur.tags,
        scope: {
          paths: patch.scope?.paths ?? cur.scope.paths,
          branch:
            patch.scope && 'branch' in patch.scope
              ? (patch.scope.branch ?? null)
              : cur.scope.branch,
        },
        trust: patch.trust ?? cur.trust,
        status: patch.status ?? cur.status,
        enforce: patch.enforce ?? cur.enforce,
        pinned: patch.pinned ?? cur.pinned,
        lastVerifiedAt:
          patch.lastVerifiedAt === undefined ? cur.lastVerifiedAt : patch.lastVerifiedAt,
      };
      const versioned =
        record ||
        next.title !== cur.title ||
        next.body !== cur.body ||
        toJson(next.tags) !== toJson(cur.tags) ||
        toJson(next.scope) !== toJson(cur.scope) ||
        next.trust !== cur.trust ||
        next.status !== cur.status;
      const now = this.clock.now();
      next.version = versioned ? cur.version + 1 : cur.version;
      this.db
        .prepare(
          `UPDATE memories SET title = ?, body = ?, tags = ?, scope_paths = ?, scope_branch = ?,
             trust = ?, status = ?, enforce = ?, pinned = ?, version = ?, last_verified_at = ?,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.title,
          next.body,
          toJson(next.tags),
          toJson(next.scope.paths),
          next.scope.branch,
          next.trust,
          next.status,
          next.enforce ? 1 : 0,
          next.pinned ? 1 : 0,
          next.version,
          next.lastVerifiedAt,
          versioned ? now : cur.updatedAt,
          id,
        );
      const saved = this.get(id);
      if (versioned) this.writeVersion(saved, changedBy, reason);
      return saved;
    });
  }

  private writeVersion(m: Memory, by: MemorySource, reason: string | null): void {
    this.db
      .prepare(
        `INSERT INTO memory_versions (memory_id, version, title, body, tags, scope_paths, scope_branch,
           trust, status, changed_by_type, changed_by_session, changed_by_agent, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.version,
        m.title,
        m.body,
        toJson(m.tags),
        toJson(m.scope.paths),
        m.scope.branch,
        m.trust,
        m.status,
        by.type,
        by.sessionId,
        by.agentKind,
        reason,
        this.clock.now(),
      );
  }

  get(id: string): Memory {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('memory', id);
    return toMemory(r);
  }

  find(id: string): Memory | null {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
    return r ? toMemory(r) : null;
  }

  private filterSql(
    projectId: string,
    f: MemoryFilter,
  ): { where: string; params: (string | number)[] } {
    const where = ['m.project_id = ?', 'm.status = ?'];
    const params: (string | number)[] = [projectId, f.status ?? 'active'];
    if (f.kinds?.length) {
      where.push(`m.kind IN (${f.kinds.map(() => '?').join(', ')})`);
      params.push(...f.kinds);
    }
    if (f.trust?.length) {
      where.push(`m.trust IN (${f.trust.map(() => '?').join(', ')})`);
      params.push(...f.trust);
    }
    if (f.branch !== undefined) {
      if (f.branch === null) where.push('m.scope_branch IS NULL');
      else {
        where.push('(m.scope_branch IS NULL OR m.scope_branch = ?)');
        params.push(f.branch);
      }
    }
    if (f.pinned !== undefined) {
      where.push('m.pinned = ?');
      params.push(f.pinned ? 1 : 0);
    }
    if (f.updatedSince !== undefined) {
      where.push('m.updated_at >= ?');
      params.push(f.updatedSince);
    }
    return { where: where.join(' AND '), params };
  }

  list(projectId: string, f: MemoryFilter = {}): Memory[] {
    const { where, params } = this.filterSql(projectId, f);
    params.push(limit(f.limit, 100, 1000));
    return (
      this.db
        .prepare(
          `SELECT m.* FROM memories m WHERE ${where} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ?`,
        )
        .all(...params) as Row[]
    ).map(toMemory);
  }

  /** Full-text search with bm25 ranking. Returns [] for queries with no searchable words. */
  search(projectId: string, text: string, f: MemoryFilter = {}): MemorySearchHit[] {
    const match = toFtsQuery(text);
    if (!match) return [];
    const { where, params } = this.filterSql(projectId, f);
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(memories_fts, 5.0, 1.0, 2.0) AS rank
         FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${where}
         ORDER BY rank LIMIT ?`,
      )
      .all(match, ...params, limit(f.limit, 30, 200)) as Row[];
    return rows.map((r) => ({ memory: toMemory(r), rank: num(r, 'rank') }));
  }

  versions(id: string): MemoryVersion[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version ASC')
        .all(id) as Row[]
    ).map(toVersion);
  }

  /**
   * Ids of the project's memories the user approved directly: at least one version that is active
   * and approved was written by the user outside any agent session (the CLI, Mission Control or an
   * interactive prompt), not captured from what they typed to an agent.
   */
  userApprovedIds(projectId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT v.memory_id AS id FROM memory_versions v
           JOIN memories m ON m.id = v.memory_id
         WHERE m.project_id = ? AND v.trust = 'approved' AND v.status = 'active'
           AND v.changed_by_type = 'user' AND v.changed_by_session IS NULL`,
      )
      .all(projectId) as Row[];
    return new Set(rows.map((r) => str(r, 'id')));
  }

  /** Memory state as of a timestamp (time travel). Null if it did not exist yet. */
  asOf(id: string, at: number): MemoryVersion | null {
    const r = this.db
      .prepare(
        `SELECT * FROM memory_versions WHERE memory_id = ? AND created_at <= ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(id, at) as Row | undefined;
    return r ? toVersion(r) : null;
  }

  /** Moves every memory scoped to `fromBranch` to `toBranch` (null = shared). Returns count. */
  promoteBranch(
    projectId: string,
    fromBranch: string,
    toBranch: string | null,
    by: MemorySource,
  ): number {
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM memories WHERE project_id = ? AND scope_branch = ? AND status = 'active'`,
        )
        .all(projectId, fromBranch) as Row[]
    ).map((r) => str(r, 'id'));
    transaction(this.db, () => {
      for (const id of ids) {
        this.update(id, { scope: { branch: toBranch } }, by, `branch ${fromBranch} merged`);
      }
    });
    return ids.length;
  }

  /** Hard delete of one memory and its history (explicit user action only). */
  delete(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  count(projectId: string): Record<Trust, number> {
    const out: Record<Trust, number> = {
      verified: 0,
      approved: 0,
      proposed: 0,
      stale: 0,
      rejected: 0,
    };
    const rows = this.db
      .prepare(
        `SELECT trust, COUNT(*) AS n FROM memories WHERE project_id = ? AND status = 'active' GROUP BY trust`,
      )
      .all(projectId) as Row[];
    for (const r of rows) out[str(r, 'trust') as Trust] = num(r, 'n');
    return out;
  }

  // ------------------------------------------------------------------ evidence

  addEvidence(input: {
    memoryId: string;
    projectId: string;
    type: EvidenceType;
    ref: string;
    excerpt?: string | null;
    contentHash?: string | null;
  }): MemoryEvidence {
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO memory_evidence (id, memory_id, project_id, type, ref, excerpt, content_hash, created_at, checked_at, valid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        id,
        input.memoryId,
        input.projectId,
        input.type,
        input.ref,
        input.excerpt ?? null,
        input.contentHash ?? null,
        now,
        now,
      );
    return toEvidence(this.db.prepare('SELECT * FROM memory_evidence WHERE id = ?').get(id) as Row);
  }

  evidenceFor(memoryId: string): MemoryEvidence[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY created_at')
        .all(memoryId) as Row[]
    ).map(toEvidence);
  }

  /** Evidence rows (of active memories) that reference a given project-relative file. */
  evidenceForFile(projectId: string, path: string): MemoryEvidence[] {
    return (
      this.db
        .prepare(
          `SELECT e.* FROM memory_evidence e JOIN memories m ON m.id = e.memory_id
           WHERE e.project_id = ? AND e.type = 'file' AND e.ref = ? AND m.status = 'active'
           LIMIT 500`,
        )
        .all(projectId, path) as Row[]
    ).map(toEvidence);
  }

  allFileEvidence(projectId: string, max = 5000): MemoryEvidence[] {
    return (
      this.db
        .prepare(
          `SELECT e.* FROM memory_evidence e JOIN memories m ON m.id = e.memory_id
           WHERE e.project_id = ? AND e.type = 'file' AND m.status = 'active' LIMIT ?`,
        )
        .all(projectId, max) as Row[]
    ).map(toEvidence);
  }

  markEvidence(id: string, valid: boolean): void {
    this.db
      .prepare('UPDATE memory_evidence SET valid = ?, checked_at = ? WHERE id = ?')
      .run(valid ? 1 : 0, this.clock.now(), id);
  }
}
