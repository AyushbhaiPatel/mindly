/**
 * v5: line survival (`mindly track`).
 *
 * - `file_change_lines`: the whole lines an agent edit added (hashes only), recorded at edit
 *   time. Survival is measured over these, so partial-line fragments and unchanged context
 *   lines inside an edit never count.
 * - `line_survival`: one row per agent edit, computed once the edit is old enough: how many of
 *   those line hashes were still in the file when checked. Skipped files (deny-listed, too large,
 *   no branch to read) get a row with both counts 0 so they are never read again and never
 *   counted. No file content is stored.
 * - An index on `file_changes (created_at, id)` for the survival job's scan.
 */
export const MIGRATION_V5_TRACK = `
CREATE TABLE file_change_lines (
  change_id  TEXT NOT NULL REFERENCES file_changes(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  PRIMARY KEY (change_id, hash)
);

CREATE TABLE line_survival (
  change_id     TEXT PRIMARY KEY REFERENCES file_changes(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL,
  checked_at    INTEGER NOT NULL,
  total_hashes  INTEGER NOT NULL,
  kept_hashes   INTEGER NOT NULL
);
CREATE INDEX line_survival_project ON line_survival (project_id);

CREATE INDEX file_changes_created ON file_changes (created_at, id);
`;
