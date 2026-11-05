import { SPLIT_STATUSES } from '@mindly/core';

function oneOf(col: string, values: readonly string[]): string {
  for (const v of values) {
    if (!/^[a-z_.-]+$/.test(v)) throw new Error(`unsafe enum value ${v}`);
  }
  return `CHECK (${col} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

/**
 * v3: `mindly split`. A split divides one goal into parts, each with its own worktree, branch,
 * child task and brief. Briefs are handoffs targeted at a worktree, so handoffs gain that column.
 */
export const MIGRATION_V3_SPLIT = `
CREATE TABLE splits (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug                TEXT NOT NULL,
  goal                TEXT NOT NULL,
  status              TEXT NOT NULL ${oneOf('status', SPLIT_STATUSES)},
  task_id             TEXT NOT NULL,
  base_commit         TEXT NOT NULL,
  base_branch         TEXT,
  strict              INTEGER NOT NULL DEFAULT 0,
  worktree_root       TEXT NOT NULL,
  integration_branch  TEXT,
  contract            TEXT NOT NULL DEFAULT '[]',
  planned_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  finished_at         INTEGER
);
CREATE INDEX splits_project ON splits (project_id, status, updated_at);
CREATE UNIQUE INDEX splits_one_active ON splits (project_id) WHERE status = 'active';

CREATE TABLE split_parts (
  id          TEXT PRIMARY KEY,
  split_id    TEXT NOT NULL REFERENCES splits(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  position    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  agent_kind  TEXT NOT NULL,
  owns        TEXT NOT NULL DEFAULT '[]',
  reads       TEXT NOT NULL DEFAULT '[]',
  depends_on  TEXT NOT NULL DEFAULT '[]',
  brief       TEXT NOT NULL DEFAULT '',
  worktree    TEXT NOT NULL,
  branch      TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  handoff_id  TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (split_id, key)
);
CREATE INDEX split_parts_split ON split_parts (split_id, position);
CREATE INDEX split_parts_project ON split_parts (project_id, worktree);

ALTER TABLE handoffs ADD COLUMN worktree TEXT;
`;
