import {
  SENTINEL_CHECK_STATES,
  type Clock,
  type SentinelCheck,
  type SentinelWatch,
} from '@mindly/core';
import { json, num, numOrNull, str, strOrNull, toJson, type Db, type Row } from '../db.js';

/*
 * The sentinel's watches: one row per watched working tree, with what is known per check. The
 * row is small state, rewritten after every pass; the history is in the `sentinel` runs.
 */

const MAX_CHECKS = 20;

/** Keeps only well-formed per-check entries (the JSON column is read back defensively). */
function checksOf(value: unknown): Record<string, SentinelCheck> {
  const out: Record<string, SentinelCheck> = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>).slice(0, MAX_CHECKS)) {
    if (raw === null || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const state = c['state'];
    if (
      typeof state !== 'string' ||
      !(SENTINEL_CHECK_STATES as readonly string[]).includes(state)
    ) {
      continue;
    }
    const numOr = (k: string): number | null => {
      const v = c[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const strOr = (k: string): string | null => {
      const v = c[k];
      return typeof v === 'string' ? v : null;
    };
    out[name] = {
      argvHash: strOr('argvHash') ?? '',
      state: state as SentinelCheck['state'],
      goodSeq: numOr('goodSeq'),
      failingSeq: numOr('failingSeq'),
      brokeAt: numOr('brokeAt'),
      culpritSessionId: strOr('culpritSessionId'),
      conflictId: strOr('conflictId'),
      note: strOr('note'),
      since: numOr('since') ?? 0,
    };
  }
  return out;
}

function toWatch(r: Row): SentinelWatch {
  return {
    projectId: str(r, 'project_id'),
    worktree: str(r, 'worktree'),
    checkedSeq: numOrNull(r, 'checked_seq'),
    checkedAt: numOrNull(r, 'checked_at'),
    setupCommit: strOrNull(r, 'setup_commit'),
    checks: checksOf(json<unknown>(r, 'checks', {})),
    skips: num(r, 'skips'),
    skippedSeq: numOrNull(r, 'skipped_seq'),
    retryAt: numOrNull(r, 'retry_at'),
    updatedAt: num(r, 'updated_at'),
  };
}

/** What a pass writes back. */
export interface SentinelWatchUpdate {
  checkedSeq: number | null;
  checkedAt: number | null;
  setupCommit: string | null;
  checks: Record<string, SentinelCheck>;
  /** Back-off after a pass where nothing could run (all three default to none). */
  skips?: number;
  skippedSeq?: number | null;
  retryAt?: number | null;
}

export class SentinelRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** The watch of one working tree, or null before its first pass. */
  get(projectId: string, worktree: string): SentinelWatch | null {
    const r = this.db
      .prepare('SELECT * FROM sentinel_watches WHERE project_id = ? AND worktree = ?')
      .get(projectId, worktree) as Row | undefined;
    return r ? toWatch(r) : null;
  }

  /** Every watch of a project, by working tree. */
  list(projectId: string): SentinelWatch[] {
    return (
      this.db
        .prepare('SELECT * FROM sentinel_watches WHERE project_id = ? ORDER BY worktree LIMIT 500')
        .all(projectId) as Row[]
    ).map(toWatch);
  }

  /** Writes the state of a working tree after a pass. */
  save(projectId: string, worktree: string, update: SentinelWatchUpdate): SentinelWatch {
    const now = this.clock.now();
    const checks = Object.fromEntries(Object.entries(update.checks).slice(0, MAX_CHECKS));
    this.db
      .prepare(
        `INSERT INTO sentinel_watches (project_id, worktree, checked_seq, checked_at, setup_commit,
           checks, skips, skipped_seq, retry_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, worktree) DO UPDATE SET
           checked_seq = excluded.checked_seq, checked_at = excluded.checked_at,
           setup_commit = excluded.setup_commit, checks = excluded.checks,
           skips = excluded.skips, skipped_seq = excluded.skipped_seq,
           retry_at = excluded.retry_at, updated_at = excluded.updated_at`,
      )
      .run(
        projectId,
        worktree,
        update.checkedSeq,
        update.checkedAt,
        update.setupCommit,
        toJson(checks),
        Math.max(0, Math.trunc(update.skips ?? 0)),
        update.skippedSeq ?? null,
        update.retryAt ?? null,
        now,
      );
    return this.get(projectId, worktree) as SentinelWatch;
  }

  /** Forgets the commit the warm tree was set up at (the tree itself was removed). */
  clearSetup(projectId: string, worktree: string): void {
    this.db
      .prepare(
        'UPDATE sentinel_watches SET setup_commit = NULL WHERE project_id = ? AND worktree = ?',
      )
      .run(projectId, worktree);
  }

  /** Deletes the watch of one working tree; returns whether there was one. */
  delete(projectId: string, worktree: string): boolean {
    const r = this.db
      .prepare('DELETE FROM sentinel_watches WHERE project_id = ? AND worktree = ?')
      .run(projectId, worktree);
    return Number(r.changes) > 0;
  }
}
