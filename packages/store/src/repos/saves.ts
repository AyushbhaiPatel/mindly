import {
  notFound,
  uuidv7,
  type Clock,
  type Save,
  type SaveKind,
  type SaveRefs,
  type SaveStatus,
} from '@mindly/core';
import { json, limit, num, numOrNull, str, toJson, transaction, type Db, type Row } from '../db.js';

function toSave(r: Row): Save {
  return {
    id: str(r, 'id'),
    projectId: str(r, 'project_id'),
    kind: str(r, 'kind') as SaveKind,
    status: str(r, 'status') as SaveStatus,
    title: str(r, 'title'),
    sessionIds: json<string[]>(r, 'session_ids', []),
    paths: json<string[]>(r, 'paths', []),
    evidence: json<string[]>(r, 'evidence', []),
    fingerprint: str(r, 'fingerprint'),
    refs: json<SaveRefs>(r, 'refs', {}),
    createdAt: num(r, 'created_at'),
    confirmedAt: numOrNull(r, 'confirmed_at'),
  };
}

export interface SaveCreate {
  projectId: string;
  kind: SaveKind;
  title: string;
  sessionIds: string[];
  paths: string[];
  /** At least one event id: the intervention. */
  evidence: string[];
  fingerprint: string;
  refs: SaveRefs;
  /** Kinds whose evidence is complete when they are caught are recorded confirmed. */
  confirmed?: boolean;
}

const MAX_EVIDENCE = 20;

/** Merges event ids, keeping the first (the intervention) and the most recent ones. */
function mergeEvidence(current: readonly string[], add: readonly string[]): string[] {
  const all = [...new Set([...current, ...add])];
  return all.length <= MAX_EVIDENCE ? all : [all[0] as string, ...all.slice(-(MAX_EVIDENCE - 1))];
}

/**
 * Saves. A save is created once per fingerprint and then only moves forward:
 * `caught` to `confirmed`, `expired` or `rejected`, and `confirmed` to `rejected` (the user said it
 * was not a save, or its conflict was dismissed). Nothing ever moves a save back to `caught` or
 * from `expired`/`rejected` to `confirmed`, so retries of the same problem never count it again.
 */
export class SaveRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Records a save unless one with the same fingerprint exists (then that one is returned). */
  record(input: SaveCreate): { save: Save; created: boolean } {
    const now = this.clock.now();
    const id = uuidv7(now);
    const res = this.db
      .prepare(
        `INSERT INTO saves (id, project_id, kind, status, title, session_ids, paths, evidence,
           fingerprint, refs, created_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, fingerprint) DO NOTHING`,
      )
      .run(
        id,
        input.projectId,
        input.kind,
        input.confirmed ? 'confirmed' : 'caught',
        input.title,
        toJson(input.sessionIds),
        toJson(input.paths),
        toJson(mergeEvidence([], input.evidence)),
        input.fingerprint,
        toJson(input.refs),
        now,
        input.confirmed ? now : null,
      );
    if (Number(res.changes) === 1) return { save: this.get(id), created: true };
    const existing = this.db
      .prepare('SELECT * FROM saves WHERE project_id = ? AND fingerprint = ?')
      .get(input.projectId, input.fingerprint) as Row;
    return { save: toSave(existing), created: false };
  }

  get(id: string): Save {
    const r = this.db.prepare('SELECT * FROM saves WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw notFound('save', id);
    return toSave(r);
  }

  find(id: string): Save | null {
    const r = this.db.prepare('SELECT * FROM saves WHERE id = ?').get(id) as Row | undefined;
    return r ? toSave(r) : null;
  }

  /**
   * Moves a save to `status`, appending evidence (and, on confirmation, the final title and
   * sessions when they are only known then). Allowed moves: caught to confirmed or expired, caught
   * or confirmed to rejected. Returns the updated save, or null when the move is not allowed from
   * its current status (nothing changes then).
   */
  settle(
    id: string,
    status: Exclude<SaveStatus, 'caught'>,
    change: { evidence?: readonly string[]; title?: string; sessionIds?: string[] } = {},
  ): Save | null {
    const from = status === 'rejected' ? ['caught', 'confirmed'] : ['caught'];
    return transaction(this.db, () => {
      const cur = this.find(id);
      if (!cur || !from.includes(cur.status)) return null;
      const now = this.clock.now();
      this.db
        .prepare(
          `UPDATE saves SET status = ?, evidence = ?, title = ?, session_ids = ?,
             confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END
           WHERE id = ?`,
        )
        .run(
          status,
          toJson(mergeEvidence(cur.evidence, change.evidence ?? [])),
          change.title ?? cur.title,
          toJson(change.sessionIds ?? cur.sessionIds),
          status,
          now,
          id,
        );
      return this.get(id);
    });
  }

  /** Saves of a project, newest first. */
  list(
    projectId: string,
    opts: {
      since?: number;
      statuses?: readonly SaveStatus[];
      kinds?: readonly SaveKind[];
      limit?: number;
    } = {},
  ): Save[] {
    const where = ['project_id = ?'];
    const params: (string | number)[] = [projectId];
    if (opts.statuses?.length) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
      params.push(...opts.statuses);
    }
    if (opts.since !== undefined) {
      where.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      params.push(...opts.kinds);
    }
    params.push(limit(opts.limit, 100, 1000));
    return (
      this.db
        .prepare(
          `SELECT * FROM saves WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(...params) as Row[]
    ).map(toSave);
  }

  /** Confirmed saves created at or after `since` (one indexed range count). */
  countConfirmed(projectId: string, since: number): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM saves WHERE project_id = ? AND status = 'confirmed' AND created_at >= ?`,
      )
      .get(projectId, since) as Row;
    return num(r, 'n');
  }
}
