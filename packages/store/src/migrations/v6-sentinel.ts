import { RUN_STATUSES } from '@mindly/core';

/** `col IN ('a','b')` from a closed enum tuple (values are compile-time constants, not input). */
function oneOf(col: string, values: readonly string[]): string {
  for (const v of values) {
    if (!/^[a-z_.-]+$/.test(v)) throw new Error(`unsafe enum value ${v}`);
  }
  return `CHECK (${col} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

/** Run kinds as of v6, frozen so this migration's SQL never changes. */
const V6_RUN_KINDS = [
  'shadow_merge',
  'replay',
  'review',
  'contract_sweep',
  'bisect',
  'sentinel',
] as const;

/**
 * v6: the sentinel.
 *
 * - `runs` is rebuilt so its kind check accepts `sentinel` (SQLite cannot alter a check).
 * - `sentinel_watches`: one row per watched working tree: the newest step the checks ran at, the
 *   commit the warm scratch tree last ran its setup at, and per check what is known (passing since
 *   a step, or failing since a step and which step broke it) as JSON, and the back-off of a step
 *   where nothing could run. No command output and no
 *   file content is stored here; that lives in the run records.
 */
export const MIGRATION_V6_SENTINEL = `
CREATE TABLE runs_v6 (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL ${oneOf('kind', V6_RUN_KINDS)},
  status       TEXT NOT NULL ${oneOf('status', RUN_STATUSES)},
  title        TEXT NOT NULL,
  input        TEXT NOT NULL,
  result       TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  created_at   INTEGER NOT NULL
);
INSERT INTO runs_v6 (id, project_id, kind, status, title, input, result, started_at, finished_at, created_at)
  SELECT id, project_id, kind, status, title, input, result, started_at, finished_at, created_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v6 RENAME TO runs;
CREATE INDEX runs_project ON runs (project_id, kind, created_at);

CREATE TABLE sentinel_watches (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree      TEXT NOT NULL,
  checked_seq   INTEGER,
  checked_at    INTEGER,
  setup_commit  TEXT,
  checks        TEXT NOT NULL DEFAULT '{}',
  skips         INTEGER NOT NULL DEFAULT 0,
  skipped_seq   INTEGER,
  retry_at      INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, worktree)
);
`;
