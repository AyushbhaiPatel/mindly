import {
  CHECKPOINT_MAX_PATHS,
  notFound,
  uuidv7,
  type Checkpoint,
  type CheckpointKind,
  type Clock,
} from '@mindly/core';
import {
  bool,
  json,
  limit,
  num,
  str,
  strOrNull,
  toJson,
  transaction,
  type Db,
  type Row,
} from '../db.js';

function toCheckpoint(r: Row): Checkpoint {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    worktree: str(r, 'worktree'),
    seq: num(r, 'seq'),
    commit: str(r, 'commit_sha'),
    parentCommit: strOrNull(r, 'parent_commit'),
    kind: str(r, 'kind') as CheckpointKind,
    sessionId: strOrNull(r, 'session_id'),
    fileChangeId: strOrNull(r, 'file_change_id'),
    promptEventId: strOrNull(r, 'prompt_event_id'),
    tool: strOrNull(r, 'tool'),
    paths: json<string[]>(r, 'paths', []),
    gap: bool(r, 'gap'),
    createdAt: num(r, 'created_at'),
  };
}

export interface CheckpointCreate {
  projectId: string;
  worktree: string;
  seq: number;
  commit: string;
  parentCommit: string | null;
  kind: CheckpointKind;
  sessionId: string | null;
  fileChangeId: string | null;
  promptEventId: string | null;
  tool: string | null;
  paths: readonly string[];
  gap: boolean;
}

/** The ref of a checkpoint, needed to delete it from git once its row is gone. */
export interface CheckpointRef {
  id: string;
  worktree: string;
  seq: number;
  commit: string;
}

export class CheckpointRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(input: CheckpointCreate): Checkpoint {
    const now = this.clock.now();
    const id = uuidv7(now);
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, project_id, worktree, seq, commit_sha, parent_commit, kind,
           session_id, file_change_id, prompt_event_id, tool, paths, gap, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.worktree,
        input.seq,
        input.commit,
        input.parentCommit,
        input.kind,
        input.sessionId,
        input.fileChangeId,
        input.promptEventId,
        input.tool,
        toJson(input.paths.slice(0, CHECKPOINT_MAX_PATHS)),
        input.gap ? 1 : 0,
        now,
      );
    return this.get(id);
  }

  get(id: string): Checkpoint {
    const r = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('checkpoint', id);
    return toCheckpoint(r);
  }

  /** The newest checkpoint of a working tree, or null. */
  latest(projectId: string, worktree: string): Checkpoint | null {
    const r = this.db
      .prepare(
        'SELECT * FROM checkpoints WHERE project_id = ? AND worktree = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(projectId, worktree) as Row | undefined;
    return r ? toCheckpoint(r) : null;
  }

  /** The checkpoint with step number `seq` of a working tree, or null. */
  bySeq(projectId: string, worktree: string, seq: number): Checkpoint | null {
    const r = this.db
      .prepare('SELECT * FROM checkpoints WHERE project_id = ? AND worktree = ? AND seq = ?')
      .get(projectId, worktree, seq) as Row | undefined;
    return r ? toCheckpoint(r) : null;
  }

  /**
   * Checkpoints of a working tree. `since` keeps those created at or after it; `fromSeq` and
   * `toSeq` bound the step numbers (inclusive). Oldest first unless `order` is `desc`.
   */
  list(
    projectId: string,
    worktree: string,
    opts: {
      since?: number;
      fromSeq?: number;
      toSeq?: number;
      order?: 'asc' | 'desc';
      limit?: number;
    } = {},
  ): Checkpoint[] {
    const where = ['project_id = ?', 'worktree = ?'];
    const params: (string | number)[] = [projectId, worktree];
    if (opts.since !== undefined) {
      where.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts.fromSeq !== undefined) {
      where.push('seq >= ?');
      params.push(opts.fromSeq);
    }
    if (opts.toSeq !== undefined) {
      where.push('seq <= ?');
      params.push(opts.toSeq);
    }
    params.push(limit(opts.limit, 1000, 100_000));
    return (
      this.db
        .prepare(
          `SELECT * FROM checkpoints WHERE ${where.join(' AND ')}
           ORDER BY seq ${opts.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
        )
        .all(...params) as Row[]
    ).map(toCheckpoint);
  }

  /** Distinct working trees of a project that have checkpoints. */
  worktrees(projectId: string): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT worktree FROM checkpoints WHERE project_id = ? ORDER BY worktree')
        .all(projectId) as Row[]
    ).map((r) => str(r, 'worktree'));
  }

  count(projectId: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE project_id = ?')
      .get(projectId) as Row;
    return num(r, 'n');
  }

  /**
   * Rows to prune for a project: older than `before`, or beyond the newest `keep` of a working
   * tree. Deleting nothing here; the caller removes the git refs first, then calls `delete`.
   */
  expired(projectId: string, before: number, keep: number): CheckpointRef[] {
    const rows = this.db
      .prepare(
        `SELECT id, worktree, seq, commit_sha FROM checkpoints
         WHERE project_id = ? AND (created_at < ? OR seq <= (
           SELECT COALESCE(MAX(c2.seq), 0) - ? FROM checkpoints c2
           WHERE c2.project_id = checkpoints.project_id AND c2.worktree = checkpoints.worktree))
         ORDER BY worktree, seq`,
      )
      .all(projectId, before, Math.max(1, Math.trunc(keep))) as Row[];
    return rows.map((r) => ({
      id: str(r, 'id'),
      worktree: str(r, 'worktree'),
      seq: num(r, 'seq'),
      commit: str(r, 'commit_sha'),
    }));
  }

  /** Every checkpoint of a project as refs (for `forget` and `uninstall`). */
  refs(projectId: string): CheckpointRef[] {
    return (
      this.db
        .prepare(
          'SELECT id, worktree, seq, commit_sha FROM checkpoints WHERE project_id = ? ORDER BY worktree, seq',
        )
        .all(projectId) as Row[]
    ).map((r) => ({
      id: str(r, 'id'),
      worktree: str(r, 'worktree'),
      seq: num(r, 'seq'),
      commit: str(r, 'commit_sha'),
    }));
  }

  delete(ids: readonly string[]): number {
    const stmt = this.db.prepare('DELETE FROM checkpoints WHERE id = ?');
    let n = 0;
    transaction(this.db, () => {
      for (const id of ids) n += Number(stmt.run(id).changes);
    });
    return n;
  }
}
