import { CHECKPOINT_KINDS, RUN_STATUSES } from '@mindly/core';

/** `col IN ('a','b')` from a closed enum tuple (values are compile-time constants, not input). */
function oneOf(col: string, values: readonly string[]): string {
  for (const v of values) {
    if (!/^[a-z_.-]+$/.test(v)) throw new Error(`unsafe enum value ${v}`);
  }
  return `CHECK (${col} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

/**
 * Run kinds as of v4. Frozen here so this migration's SQL never changes when a later version adds
 * a kind (v6 rebuilds the table again for `sentinel`).
 */
const V4_RUN_KINDS = ['shadow_merge', 'replay', 'review', 'contract_sweep', 'bisect'] as const;

/**
 * v4: checkpoints (`mindly bisect`). One row per copy of a working tree stored under
 * `refs/mindly/steps/<worktree id>/<seq>`; `seq` increases per working tree. The `runs` table is
 * rebuilt so its kind check accepts the new `bisect` run kind (SQLite cannot alter a check).
 */
export const MIGRATION_V4_BISECT = `
CREATE TABLE runs_v4 (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL ${oneOf('kind', V4_RUN_KINDS)},
  status       TEXT NOT NULL ${oneOf('status', RUN_STATUSES)},
  title        TEXT NOT NULL,
  input        TEXT NOT NULL,
  result       TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  created_at   INTEGER NOT NULL
);
INSERT INTO runs_v4 (id, project_id, kind, status, title, input, result, started_at, finished_at, created_at)
  SELECT id, project_id, kind, status, title, input, result, started_at, finished_at, created_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v4 RENAME TO runs;
CREATE INDEX runs_project ON runs (project_id, kind, created_at);

CREATE TABLE checkpoints (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worktree         TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  commit_sha       TEXT NOT NULL,
  parent_commit    TEXT,
  kind             TEXT NOT NULL ${oneOf('kind', CHECKPOINT_KINDS)},
  session_id       TEXT,
  file_change_id   TEXT,
  prompt_event_id  TEXT,
  tool             TEXT,
  paths            TEXT NOT NULL DEFAULT '[]',
  gap              INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  UNIQUE (project_id, worktree, seq)
);
CREATE INDEX checkpoints_worktree ON checkpoints (project_id, worktree, seq);
CREATE INDEX checkpoints_session ON checkpoints (session_id);
`;
