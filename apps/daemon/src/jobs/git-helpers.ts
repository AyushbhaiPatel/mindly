import { existsSync } from 'node:fs';
import { describeError, type Logger, type Session } from '@mindly/core';
import {
  captureWorktreeCommit,
  findRepoRoot,
  gitCommonDir,
  runGit,
  type CapturedCommit,
} from '@mindly/git';

/** A live session's working tree captured as a synthetic commit. */
export interface SessionCapture {
  session: Session;
  /** Top-level directory of the captured working tree. */
  top: string;
  capture: CapturedCommit;
  /** Repository-relative paths changed relative to the capture's parent (bounded). */
  changed: string[];
}

const MAX_CHANGED = 2000;

/**
 * Captures `session`'s worktree when it shares the project's object database (same repository or
 * one of its linked worktrees). Returns null (and logs) when it cannot be captured.
 */
export async function captureSession(
  projectRoot: string,
  session: Session,
  extraDeny: readonly string[],
  logger: Logger,
): Promise<SessionCapture | null> {
  try {
    if (!existsSync(session.worktree)) return null;
    const [own, project] = await Promise.all([
      gitCommonDir(session.worktree),
      gitCommonDir(projectRoot),
    ]);
    if (own !== project) return null;
    const top = await findRepoRoot(session.worktree);
    const capture = await captureWorktreeCommit(session.worktree, {
      extraDeny,
      message: `mindly capture ${session.id}`,
    });
    const changed = capture.parent
      ? await changedBetween(projectRoot, capture.parent, capture.commit)
      : [];
    return { session, top, capture, changed };
  } catch (err) {
    logger.warn('worktree capture failed', { sessionId: session.id, error: describeError(err) });
    return null;
  }
}

/** Repository-relative paths that differ between two commits (bounded). */
export async function changedBetween(root: string, from: string, to: string): Promise<string[]> {
  const res = await runGit(['diff', '--name-only', '-z', '--no-renames', from, to, '--'], {
    cwd: root,
    timeoutMs: 30_000,
  });
  return res.stdout
    .split('\0')
    .filter((p) => p !== '')
    .slice(0, MAX_CHANGED);
}
