import {
  notFound,
  uuidv7,
  type Clock,
  type ContextItem,
  type ContextPacket,
  type Contract,
  type ContractKind,
  type ContractSpec,
  type ContractState,
  type Handoff,
  type HandoffPacket,
  type HandoffStatus,
  type Run,
  type RunKind,
  type RunStatus,
  type Snapshot,
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
// Context packets (Context X-Ray)
// ---------------------------------------------------------------------------------------------

function toPacket(r: Row): ContextPacket {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    sessionId: str(r, 'session_id'),
    trigger: str(r, 'trigger') as ContextPacket['trigger'],
    query: strOrNull(r, 'query'),
    included: json<ContextItem[]>(r, 'included', []),
    omitted: json<ContextItem[]>(r, 'omitted', []),
    tokenBudget: num(r, 'token_budget'),
    tokensUsed: num(r, 'tokens_used'),
    createdAt: num(r, 'created_at'),
  };
}

export class ContextPacketRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  record(input: Omit<ContextPacket, 'id' | 'createdAt'>): ContextPacket {
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO context_packets (id, project_id, session_id, trigger, query, included, omitted,
           token_budget, tokens_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.sessionId,
        input.trigger,
        input.query,
        toJson(input.included.slice(0, 200)),
        toJson(input.omitted.slice(0, 200)),
        input.tokenBudget,
        input.tokensUsed,
        now,
      );
    return { ...input, id, createdAt: now };
  }

  forSession(sessionId: string, max?: number): ContextPacket[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM context_packets WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(sessionId, limit(max, 20)) as Row[]
    ).map(toPacket);
  }

  get(id: string): ContextPacket {
    const r = this.db.prepare('SELECT * FROM context_packets WHERE id = ?').get(id) as
      Row | undefined;
    if (!r) throw notFound('context packet', id);
    return toPacket(r);
  }

  /** Packets in which a given memory/delivery ref was included or omitted. */
  mentioning(projectId: string, ref: string, max?: number): ContextPacket[] {
    return (
      this.db
        .prepare(
          `SELECT p.* FROM context_packets p WHERE p.project_id = ? AND (
             EXISTS (SELECT 1 FROM json_each(p.included) WHERE json_extract(value, '$.ref') = ?) OR
             EXISTS (SELECT 1 FROM json_each(p.omitted) WHERE json_extract(value, '$.ref') = ?))
           ORDER BY p.created_at DESC LIMIT ?`,
        )
        .all(projectId, ref, ref, limit(max, 20)) as Row[]
    ).map(toPacket);
  }

  deleteOlderThan(before: number): number {
    return Number(
      this.db.prepare('DELETE FROM context_packets WHERE created_at < ?').run(before).changes,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------------------------------------

function toHandoff(r: Row): Handoff {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    fromSessionId: str(r, 'from_session_id'),
    toAgentKind: strOrNull(r, 'to_agent_kind'),
    taskId: strOrNull(r, 'task_id'),
    reason: str(r, 'reason') as Handoff['reason'],
    summary: str(r, 'summary'),
    packet: json<HandoffPacket>(r, 'packet', {
      goal: '',
      plan: [],
      filesChanged: [],
      recentPrompts: [],
      decisions: [],
      blockers: [],
      nextSteps: [],
      branch: null,
      headCommit: null,
    }),
    status: str(r, 'status') as HandoffStatus,
    claimedBySessionId: strOrNull(r, 'claimed_by_session_id'),
    createdAt: num(r, 'created_at'),
    claimedAt: numOrNull(r, 'claimed_at'),
  };
}

export class HandoffRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: {
    projectId: string;
    fromSessionId: string;
    toAgentKind: string | null;
    taskId: string | null;
    reason: Handoff['reason'];
    summary: string;
    packet: HandoffPacket;
    /** Only a session started in this worktree (or below it) may claim the handoff. */
    worktree?: string | null;
  }): Handoff {
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO handoffs (id, project_id, from_session_id, to_agent_kind, task_id, reason, summary,
           packet, status, created_at, worktree) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.fromSessionId,
        input.toAgentKind,
        input.taskId,
        input.reason,
        input.summary,
        toJson(input.packet),
        now,
        input.worktree ?? null,
      );
    return this.get(id);
  }

  get(id: string): Handoff {
    const r = this.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('handoff', id);
    return toHandoff(r);
  }

  /**
   * Pending handoffs a new session of `agentKind` may pick up (excluding its own). A handoff
   * targeted at a worktree is only offered to a session whose `worktree` is that folder or one
   * below it; the others are offered to every session of the agent kind.
   */
  pendingFor(
    projectId: string,
    agentKind: string,
    sessionId: string,
    worktree: string | null = null,
  ): Handoff[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM handoffs WHERE project_id = ? AND status = 'pending'
             AND (to_agent_kind IS NULL OR to_agent_kind = ?) AND from_session_id != ?
             AND (worktree IS NULL OR worktree = ? OR substr(?, 1, length(worktree) + 1) = worktree || '/')
           ORDER BY (worktree IS NOT NULL) DESC, created_at DESC LIMIT 5`,
        )
        .all(projectId, agentKind, sessionId, worktree ?? '', worktree ?? '') as Row[]
    ).map(toHandoff);
  }

  /** Cancels every pending handoff targeted at `worktree`. Returns how many. */
  cancelForWorktree(projectId: string, worktree: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE handoffs SET status = 'cancelled' WHERE project_id = ? AND status = 'pending' AND worktree = ?`,
        )
        .run(projectId, worktree).changes,
    );
  }

  /** Atomically claims a pending handoff. Returns false if someone else claimed it first. */
  claim(id: string, sessionId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE handoffs SET status = 'claimed', claimed_by_session_id = ?, claimed_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(sessionId, this.clock.now(), id);
    return Number(res.changes) === 1;
  }

  setStatus(id: string, status: HandoffStatus): void {
    this.db.prepare('UPDATE handoffs SET status = ? WHERE id = ?').run(status, id);
  }

  list(projectId: string, max?: number): Handoff[] {
    return (
      this.db
        .prepare('SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(projectId, limit(max, 50)) as Row[]
    ).map(toHandoff);
  }
}

// ---------------------------------------------------------------------------------------------
// Contracts (executable memory)
// ---------------------------------------------------------------------------------------------

function toContract(r: Row): Contract {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    memoryId: str(r, 'memory_id'),
    kind: str(r, 'kind') as ContractKind,
    spec: json<ContractSpec>(r, 'spec', {}),
    approvedHash: strOrNull(r, 'approved_hash'),
    state: str(r, 'state') as ContractState,
    lastMessage: strOrNull(r, 'last_message'),
    lastRunAt: numOrNull(r, 'last_run_at'),
    createdAt: num(r, 'created_at'),
  };
}

export class ContractRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: {
    projectId: string;
    memoryId: string;
    kind: ContractKind;
    spec: ContractSpec;
    approvedHash: string | null;
  }): Contract {
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO contracts (id, project_id, memory_id, kind, spec, approved_hash, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?)`,
      )
      .run(
        id,
        input.projectId,
        input.memoryId,
        input.kind,
        toJson(input.spec),
        input.approvedHash,
        now,
      );
    return this.get(id);
  }

  get(id: string): Contract {
    const r = this.db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('contract', id);
    return toContract(r);
  }

  list(projectId: string): Contract[] {
    return (
      this.db
        .prepare('SELECT * FROM contracts WHERE project_id = ? ORDER BY created_at LIMIT 1000')
        .all(projectId) as Row[]
    ).map(toContract);
  }

  forMemory(memoryId: string): Contract[] {
    return (
      this.db.prepare('SELECT * FROM contracts WHERE memory_id = ?').all(memoryId) as Row[]
    ).map(toContract);
  }

  /** Contracts whose spec reads `path` (all `command` contracts are included as well). */
  forPath(projectId: string, path: string): Contract[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM contracts WHERE project_id = ? AND (json_extract(spec, '$.path') = ? OR kind = 'command')`,
        )
        .all(projectId, path) as Row[]
    ).map(toContract);
  }

  /**
   * Stores a result and keeps the contract's last passing/failing one (see `lastConclusive`), in
   * one transaction. A passing or failing result is remembered as it is. Before any other result
   * replaces a passing or failing state, that state is remembered: it is the newest conclusive
   * result whatever was remembered before (nothing, for a contract last run before this was kept;
   * something older, when a process of a previous version wrote the state alone).
   * Throws `not_found`, writing nothing, for a contract that no longer exists.
   */
  recordResult(id: string, state: ContractState, message: string | null): Contract {
    return transaction(this.db, () => {
      const now = this.clock.now();
      const conclusive = state === 'passing' || state === 'failing';
      if (!conclusive) {
        this.db
          .prepare(
            `INSERT INTO kv (key, value, updated_at)
               SELECT ?, json_quote(state), ? FROM contracts
               WHERE id = ? AND state IN ('passing', 'failing')
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(conclusiveKey(id), now, id);
      }
      const res = this.db
        .prepare('UPDATE contracts SET state = ?, last_message = ?, last_run_at = ? WHERE id = ?')
        .run(state, message, now, id);
      if (Number(res.changes) === 0) throw notFound('contract', id);
      if (conclusive) this.setLastConclusive(id, state);
      return this.get(id);
    });
  }

  /**
   * The last result of a contract that was passing or failing, kept apart from `state` so a later
   * `error` does not hide it. 'none': known to have had neither. Undefined: nothing recorded yet
   * (a contract last run before this was kept).
   */
  lastConclusive(id: string): ContractConclusive | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(conclusiveKey(id)) as
      Row | undefined;
    const v = r ? json<unknown>(r, 'value', null) : null;
    return v === 'passing' || v === 'failing' || v === 'none' ? v : undefined;
  }

  setLastConclusive(id: string, value: ContractConclusive): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(conclusiveKey(id), toJson(value), this.clock.now());
  }

  /**
   * The hash of the pattern and file content a check of this contract last ran out of time on,
   * so that check is not repeated; null when none did.
   */
  slowRun(id: string): string | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(slowKey(id)) as
      Row | undefined;
    const v = r ? json<unknown>(r, 'value', null) : null;
    return typeof v === 'string' ? v : null;
  }

  setSlowRun(id: string, runHash: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(slowKey(id), toJson(runHash), this.clock.now());
  }

  /** Drops what is remembered for contracts that no longer exist (deleted with their memory). */
  pruneConclusive(): void {
    const prune = this.db.prepare(
      `DELETE FROM kv WHERE key LIKE ? AND substr(key, ?) NOT IN (SELECT id FROM contracts)`,
    );
    for (const prefix of KV_PREFIXES) prune.run(`${prefix}%`, prefix.length + 1);
  }

  /** The distinct patterns of all stored pattern contracts. */
  patterns(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT json_extract(spec, '$.pattern') AS pattern FROM contracts
           WHERE json_extract(spec, '$.pattern') IS NOT NULL`,
        )
        .all() as Row[]
    ).map((r) => str(r, 'pattern'));
  }

  /** Deletes kv entries under `prefix` other than the keys in `keep`. */
  pruneKeys(prefix: string, keep: readonly string[]): void {
    const kept = new Set(keep);
    const rows = this.db
      .prepare('SELECT key FROM kv WHERE key LIKE ?')
      // `%` and `_` in the prefix only widen the match; the check below is exact.
      .all(`${prefix}%`) as Row[];
    const drop = this.db.prepare('DELETE FROM kv WHERE key = ?');
    for (const r of rows) {
      const key = str(r, 'key');
      if (key.startsWith(prefix) && !kept.has(key)) drop.run(key);
    }
  }

  approve(id: string, hash: string | null): void {
    this.db.prepare('UPDATE contracts SET approved_hash = ? WHERE id = ?').run(hash, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM contracts WHERE id = ?').run(id);
    const drop = this.db.prepare('DELETE FROM kv WHERE key = ?');
    for (const prefix of KV_PREFIXES) drop.run(`${prefix}${id}`);
  }
}

/** A contract's last passing/failing result, or 'none' when it never had one. */
export type ContractConclusive = 'passing' | 'failing' | 'none';

const CONCLUSIVE_PREFIX = 'contract:conclusive:';
const SLOW_PREFIX = 'contract:slow:';
/** Every kv entry kept per contract, removed with it. */
const KV_PREFIXES = [CONCLUSIVE_PREFIX, SLOW_PREFIX] as const;
const conclusiveKey = (id: string): string => `${CONCLUSIVE_PREFIX}${id}`;
const slowKey = (id: string): string => `${SLOW_PREFIX}${id}`;

// ---------------------------------------------------------------------------------------------
// Snapshots (time machine)
// ---------------------------------------------------------------------------------------------

export interface SnapshotWithState extends Snapshot {
  state: Record<string, unknown>;
}

function toSnapshot(r: Row): SnapshotWithState {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    label: str(r, 'label'),
    gitRef: strOrNull(r, 'git_ref'),
    commit: strOrNull(r, 'commit_sha'),
    state: json<Record<string, unknown>>(r, 'state', {}),
    createdAt: num(r, 'created_at'),
  };
}

export class SnapshotRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: {
    id?: string;
    projectId: string;
    label: string;
    gitRef: string | null;
    commit: string | null;
    state: Record<string, unknown>;
  }): SnapshotWithState {
    const now = this.clock.now();
    const id = input.id ?? uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO snapshots (id, project_id, label, git_ref, commit_sha, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, input.label, input.gitRef, input.commit, toJson(input.state), now);
    return this.get(id);
  }

  get(id: string): SnapshotWithState {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('snapshot', id);
    return toSnapshot(r);
  }

  list(projectId: string, max?: number): Snapshot[] {
    return (
      this.db
        .prepare(
          `SELECT id, project_id, label, git_ref, commit_sha, '{}' AS state, created_at
           FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(projectId, limit(max, 50)) as Row[]
    ).map((r) => {
      const s = toSnapshot(r);
      return {
        id: s.id,
        projectId: s.projectId,
        label: s.label,
        gitRef: s.gitRef,
        commit: s.commit,
        createdAt: s.createdAt,
      };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Runs (shadow merge, replay, review, sweeps)
// ---------------------------------------------------------------------------------------------

function toRun(r: Row): Run {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    kind: str(r, 'kind') as RunKind,
    status: str(r, 'status') as RunStatus,
    title: str(r, 'title'),
    input: json<Record<string, unknown>>(r, 'input', {}),
    result: json<Record<string, unknown> | null>(r, 'result', null),
    startedAt: numOrNull(r, 'started_at'),
    finishedAt: numOrNull(r, 'finished_at'),
    createdAt: num(r, 'created_at'),
  };
}

export class RunRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: {
    projectId: string;
    kind: RunKind;
    title: string;
    input: Record<string, unknown>;
  }): Run {
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, kind, status, title, input, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, input.projectId, input.kind, input.title, toJson(input.input), now);
    return this.get(id);
  }

  start(id: string): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
      )
      .run(this.clock.now(), id);
  }

  finish(
    id: string,
    status: Exclude<RunStatus, 'queued' | 'running'>,
    result: Record<string, unknown>,
  ): Run {
    this.db
      .prepare('UPDATE runs SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(status, toJson(result), this.clock.now(), id);
    return this.get(id);
  }

  get(id: string): Run {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('run', id);
    return toRun(r);
  }

  list(projectId: string, opts: { kind?: RunKind; limit?: number } = {}): Run[] {
    const rows = opts.kind
      ? this.db
          .prepare(
            'SELECT * FROM runs WHERE project_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(projectId, opts.kind, limit(opts.limit, 20))
      : this.db
          .prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(projectId, limit(opts.limit, 20));
    return (rows as Row[]).map(toRun);
  }

  latest(projectId: string, kind: RunKind): Run | null {
    return this.list(projectId, { kind, limit: 1 })[0] ?? null;
  }

  /**
   * Runs of `kind` created at or after `since`, optionally only those whose `input.<field>`
   * equals `value` (e.g. the bisects the sentinel started today).
   */
  countSince(
    projectId: string,
    kind: RunKind,
    since: number,
    where?: { field: string; value: string },
  ): number {
    if (where && !/^[A-Za-z][A-Za-z0-9]*$/.test(where.field)) {
      throw new Error(`unsafe input field ${where.field}`);
    }
    const r = (
      where
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND kind = ? AND created_at >= ?
               AND json_extract(input, '$.${where.field}') = ?`,
            )
            .get(projectId, kind, since, where.value)
        : this.db
            .prepare(
              'SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND kind = ? AND created_at >= ?',
            )
            .get(projectId, kind, since)
    ) as Row;
    return num(r, 'n');
  }

  /** The newest run of `kind` whose `input.<field>` equals `value` (e.g. the merge check of one split). */
  latestWithInput(projectId: string, kind: RunKind, field: string, value: string): Run | null {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) throw new Error(`unsafe input field ${field}`);
    const r = this.db
      .prepare(
        `SELECT * FROM runs WHERE project_id = ? AND kind = ? AND json_extract(input, '$.${field}') = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, kind, value) as Row | undefined;
    return r ? toRun(r) : null;
  }
}

// ---------------------------------------------------------------------------------------------
// Key/value state
// ---------------------------------------------------------------------------------------------

export class KvRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  get<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? json<T | null>(r, 'value', null) : null;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, toJson(value), this.clock.now());
  }

  /**
   * Deletes at most `max` keys starting with `prefix` that were last written before `before`.
   * Returns how many went. The prefix is matched literally (`%` and `_` in it are not wildcards).
   */
  deleteStale(prefix: string, before: number, max = 200): number {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return Number(
      this.db
        .prepare(
          `DELETE FROM kv WHERE key IN (
             SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND updated_at < ? LIMIT ?)`,
        )
        .run(like, before, Math.max(0, Math.trunc(max))).changes,
    );
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  /**
   * Entries whose key starts with `prefix`, in key order. The prefix is matched as a key range,
   * so it may hold any character.
   */
  list<T>(prefix: string, limit = 100): { key: string; value: T | null }[] {
    const rows = this.db
      .prepare('SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?')
      .all(prefix, `${prefix}\uffff`, Math.max(1, Math.min(1000, Math.trunc(limit)))) as Row[];
    return rows.map((r) => ({ key: str(r, 'key'), value: json<T | null>(r, 'value', null) }));
  }

  /** Deletes the keys `<prefix><session id>` of every session of a project; returns how many. */
  deleteForSessions(prefix: string, projectId: string): number {
    const r = this.db
      .prepare('DELETE FROM kv WHERE key IN (SELECT ? || id FROM sessions WHERE project_id = ?)')
      .run(prefix, projectId);
    return Number(r.changes);
  }
}
