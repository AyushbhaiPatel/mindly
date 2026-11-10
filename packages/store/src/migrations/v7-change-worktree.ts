/**
 * v7: the working tree an agent edit was made in.
 *
 * `file_change_worktrees` holds, per recorded edit, the canonical root of the working tree (the
 * main checkout or a linked worktree) the edit's hook ran in, so a checkpoint rescan can tell
 * which tree an edit belongs to even after the session moved on to another one. Edits recorded
 * before v7 have no row: their tree is unknown and they are never credited with a step.
 *
 * A table of its own rather than a column of `file_changes`: SQLite cannot add a column only if
 * it is missing, and this statement must be safe to run twice (two processes opening a v6 store
 * at once may both apply it).
 */
export const MIGRATION_V7_CHANGE_WORKTREE = `
CREATE TABLE IF NOT EXISTS file_change_worktrees (
  change_id  TEXT PRIMARY KEY REFERENCES file_changes(id) ON DELETE CASCADE,
  worktree   TEXT NOT NULL
);
`;
