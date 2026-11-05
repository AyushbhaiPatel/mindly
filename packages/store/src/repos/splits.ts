import {
  notFound,
  uuidv7,
  type Clock,
  type Split,
  type SplitContractItem,
  type SplitPart,
  type SplitStatus,
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

function toSplit(r: Row): Split {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    slug: str(r, 'slug'),
    goal: str(r, 'goal'),
    status: str(r, 'status') as SplitStatus,
    taskId: str(r, 'task_id'),
    baseCommit: str(r, 'base_commit'),
    baseBranch: strOrNull(r, 'base_branch'),
    strict: bool(r, 'strict'),
    worktreeRoot: str(r, 'worktree_root'),
    integrationBranch: strOrNull(r, 'integration_branch'),
    contract: json<SplitContractItem[]>(r, 'contract', []),
    plannedBy: str(r, 'planned_by'),
    createdAt: num(r, 'created_at'),
    updatedAt: num(r, 'updated_at'),
    finishedAt: numOrNull(r, 'finished_at'),
  };
}

function toPart(r: Row): SplitPart {
  return {
    id: str(r, 'id'),
    splitId: str(r, 'split_id'),
    projectId: str(r, 'project_id'),
    key: str(r, 'key'),
    position: num(r, 'position'),
    title: str(r, 'title'),
    agentKind: str(r, 'agent_kind'),
    owns: json<string[]>(r, 'owns', []),
    reads: json<string[]>(r, 'reads', []),
    dependsOn: json<string[]>(r, 'depends_on', []),
    brief: str(r, 'brief'),
    worktree: str(r, 'worktree'),
    branch: str(r, 'branch'),
    taskId: str(r, 'task_id'),
    handoffId: strOrNull(r, 'handoff_id'),
    createdAt: num(r, 'created_at'),
  };
}

export interface SplitCreate {
  projectId: string;
  slug: string;
  goal: string;
  taskId: string;
  baseCommit: string;
  baseBranch: string | null;
  strict: boolean;
  worktreeRoot: string;
  contract: SplitContractItem[];
  plannedBy: string;
  parts: Omit<SplitPart, 'id' | 'splitId' | 'projectId' | 'createdAt'>[];
}

export interface SplitPatch {
  status?: SplitStatus;
  integrationBranch?: string | null;
  contract?: SplitContractItem[];
  finishedAt?: number | null;
}

/** Splits and their parts. A part's worktree is unique within a project while the split is active. */
export class SplitRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Creates a split and its parts in one transaction. */
  create(input: SplitCreate): { split: Split; parts: SplitPart[] } {
    const now = this.clock.now();
    const id = uuidv7(now);
    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO splits (id, project_id, slug, goal, status, task_id, base_commit, base_branch,
             strict, worktree_root, integration_branch, contract, planned_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.slug,
          input.goal,
          input.taskId,
          input.baseCommit,
          input.baseBranch,
          input.strict ? 1 : 0,
          input.worktreeRoot,
          toJson(input.contract),
          input.plannedBy,
          now,
          now,
        );
      const stmt = this.db.prepare(
        `INSERT INTO split_parts (id, split_id, project_id, key, position, title, agent_kind, owns, reads,
           depends_on, brief, worktree, branch, task_id, handoff_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of input.parts) {
        stmt.run(
          uuidv7(now),
          id,
          input.projectId,
          p.key,
          p.position,
          p.title,
          p.agentKind,
          toJson(p.owns),
          toJson(p.reads),
          toJson(p.dependsOn),
          p.brief,
          p.worktree,
          p.branch,
          p.taskId,
          p.handoffId,
          now,
        );
      }
      return { split: this.get(id), parts: this.parts(id) };
    });
  }

  get(id: string): Split {
    const r = this.db.prepare('SELECT * FROM splits WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('split', id);
    return toSplit(r);
  }

  find(id: string): Split | null {
    const r = this.db.prepare('SELECT * FROM splits WHERE id = ?').get(id) as Row | undefined;
    return r ? toSplit(r) : null;
  }

  update(id: string, patch: SplitPatch): Split {
    const cur = this.get(id);
    this.db
      .prepare(
        `UPDATE splits SET status = ?, integration_branch = ?, contract = ?, finished_at = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.status ?? cur.status,
        patch.integrationBranch === undefined ? cur.integrationBranch : patch.integrationBranch,
        toJson(patch.contract ?? cur.contract),
        patch.finishedAt === undefined ? cur.finishedAt : patch.finishedAt,
        this.clock.now(),
        id,
      );
    return this.get(id);
  }

  /** Splits of a project, newest first. */
  list(
    projectId: string,
    opts: { statuses?: readonly SplitStatus[]; limit?: number } = {},
  ): Split[] {
    const params: (string | number)[] = [projectId];
    let where = 'project_id = ?';
    if (opts.statuses?.length) {
      where += ` AND status IN (${opts.statuses.map(() => '?').join(', ')})`;
      params.push(...opts.statuses);
    }
    params.push(limit(opts.limit, 50));
    return (
      this.db
        .prepare(`SELECT * FROM splits WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as Row[]
    ).map(toSplit);
  }

  /** The project's active split, if any (at most one at a time). */
  active(projectId: string): Split | null {
    return this.list(projectId, { statuses: ['active'], limit: 1 })[0] ?? null;
  }

  /** The split whose contract contains the decision memory `memoryId`, if any. */
  findByContractMemory(memoryId: string): Split | null {
    const r = this.db
      .prepare(
        `SELECT s.* FROM splits s, json_each(s.contract) c
         WHERE json_extract(c.value, '$.memoryId') = ? LIMIT 1`,
      )
      .get(memoryId) as Row | undefined;
    return r ? toSplit(r) : null;
  }

  parts(splitId: string): SplitPart[] {
    return (
      this.db
        .prepare('SELECT * FROM split_parts WHERE split_id = ? ORDER BY position ASC')
        .all(splitId) as Row[]
    ).map(toPart);
  }

  part(id: string): SplitPart {
    const r = this.db.prepare('SELECT * FROM split_parts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('split part', id);
    return toPart(r);
  }

  /** The part of an active split whose worktree contains `path` (exact or a subdirectory). */
  partForWorktree(projectId: string, path: string): SplitPart | null {
    const r = this.db
      .prepare(
        `SELECT p.* FROM split_parts p JOIN splits s ON s.id = p.split_id
         WHERE p.project_id = ? AND s.status = 'active'
           AND (p.worktree = ? OR substr(?, 1, length(p.worktree) + 1) = p.worktree || '/')
         ORDER BY length(p.worktree) DESC LIMIT 1`,
      )
      .get(projectId, path, path) as Row | undefined;
    return r ? toPart(r) : null;
  }

  setPartHandoff(partId: string, handoffId: string): void {
    this.db.prepare('UPDATE split_parts SET handoff_id = ? WHERE id = ?').run(handoffId, partId);
  }

  /** The part whose child task is `taskId`, if any. */
  partForTask(taskId: string): SplitPart | null {
    const r = this.db.prepare('SELECT * FROM split_parts WHERE task_id = ?').get(taskId) as
      Row | undefined;
    return r ? toPart(r) : null;
  }
}
