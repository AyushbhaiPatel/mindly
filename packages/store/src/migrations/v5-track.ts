/**
 * v5: line survival (`mindly track`). One row per agent edit, computed once the edit is old
 * enough: how many of the line hashes it added (`file_change_hunks`) were still in the file when
 * checked. Files skipped (deny-listed, too large) get a row with both counts 0 so they are never
 * read again and never counted. No file content is stored.
 */
export const MIGRATION_V5_TRACK = `
CREATE TABLE line_survival (
  change_id     TEXT PRIMARY KEY REFERENCES file_changes(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL,
  checked_at    INTEGER NOT NULL,
  total_hashes  INTEGER NOT NULL,
  kept_hashes   INTEGER NOT NULL
);
CREATE INDEX line_survival_project ON line_survival (project_id);
`;
