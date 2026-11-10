/**
 * v7: the working tree an agent edit was made in.
 *
 * `file_changes.worktree` holds the canonical root of the working tree (the main checkout or a
 * linked worktree) the edit's hook ran in, so a checkpoint rescan can tell which tree an edit
 * belongs to even after the session moved on to another one. Rows written before v7 have no
 * worktree: their tree is unknown and they are never credited with a step.
 */
export const MIGRATION_V7_CHANGE_WORKTREE = `
ALTER TABLE file_changes ADD COLUMN worktree TEXT;
`;
