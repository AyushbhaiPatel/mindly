import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeError, sanitizeLine, sha256, type Checkpoint, type Session } from '@mindly/core';
import type { Kernel } from '../kernel.js';
import type { ProjectContext } from '../projects.js';

/*
 * Checkpoints: a copy of the code after every agent edit, stored as git commits under
 * `refs/mindly/steps/<worktree id>/<seq>` (see `@mindly/git` `captureCheckpoint`). This service
 * decides when to take one, numbers the steps, keeps the rows and prunes old ones. Everything
 * fails open: a hook never notices a checkpoint that could not be taken.
 */

const DAY_MS = 86_400_000;
/** Every git call while taking a checkpoint is bounded by this. */
export const CHECKPOINT_TIMEOUT_MS = 2000;
/** The hook prunes old checkpoints at most this often (the daemon prunes on its own schedule). */
export const PRUNE_INTERVAL_MS = DAY_MS;

/** What one agent edit tells the service. */
export interface AgentEditInput {
  /** Working-tree-relative paths the tool wrote. */
  paths: readonly string[];
  tool: string;
  fileChangeId: string | null;
  promptEventId: string | null;
}

/** What a prune removed. */
export interface PruneResult {
  refsDeleted: number;
  rowsDeleted: number;
}

type Step = { kind: 'agent'; session: Session; edit: AgentEditInput } | { kind: 'rescan' };

export class CheckpointService {
  private readonly roots = new Map<string, Promise<string | null>>();
  private tmpDir: string | null = null;

  constructor(
    private readonly k: Kernel,
    /** Directory holding one private index per working tree (`$MINDLY_HOME/checkpoints`). */
    private readonly dir: string | null,
  ) {}

  /** True when checkpoints are configured on and git can take them. */
  get enabled(): boolean {
    return this.k.config.checkpoints.enabled && this.k.ports.git.checkpoints !== undefined;
  }

  /** Canonical working tree containing `cwd`, or null outside git. Cached per directory. */
  worktreeOf(cwd: string): Promise<string | null> {
    const git = this.k.ports.git.checkpoints;
    if (!git) return Promise.resolve(null);
    let p = this.roots.get(cwd);
    if (!p) {
      p = git.worktreeRoot(cwd).catch(() => null);
      this.roots.set(cwd, p);
    }
    return p;
  }

  /** Private directory (index and lock) of a working tree. */
  privateDir(worktree: string): string {
    if (this.dir === null) {
      this.tmpDir ??= mkdtempSync(join(tmpdir(), 'mindly-checkpoints-'));
    }
    return join(this.dir ?? (this.tmpDir as string), sha256(worktree).slice(0, 16));
  }

  /**
   * Rescans the whole working tree (session start, a prompt, after a shell command that may
   * have written files). Changes no agent edit explains become an `outside` step; the first
   * checkpoint of a working tree is its `baseline`. Null when nothing changed or it was skipped.
   */
  async rescan(project: ProjectContext, cwd: string): Promise<Checkpoint | null> {
    return this.record(project, cwd, { kind: 'rescan' });
  }

  /** Records one agent edit as a step holding only the paths the tool touched. */
  async afterEdit(
    project: ProjectContext,
    session: Session,
    cwd: string,
    edit: AgentEditInput,
  ): Promise<Checkpoint | null> {
    return this.record(project, cwd, { kind: 'agent', session, edit });
  }

  private async record(
    project: ProjectContext,
    cwd: string,
    step: Step,
  ): Promise<Checkpoint | null> {
    const git = this.k.ports.git.checkpoints;
    if (!git || !this.k.config.checkpoints.enabled) return null;
    const pid = project.project.id;
    let worktree: string | null;
    try {
      worktree = await this.worktreeOf(cwd);
    } catch {
      return null;
    }
    if (!worktree) return null;
    const dir = this.privateDir(worktree);
    let lock: { release(): void } | null;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      lock = git.tryLock(join(dir, 'lock'));
    } catch (err) {
      this.k.logger.warn('checkpoint skipped', { reason: 'lock', error: describeError(err) });
      return null;
    }
    if (!lock) {
      this.markGap(pid, worktree);
      this.k.logger.info('checkpoint skipped', { reason: 'another checkpoint is being taken' });
      return null;
    }
    try {
      const latest = this.k.store.checkpoints.latest(pid, worktree);
      const seq = (latest?.seq ?? 0) + 1;
      const gap = this.hasGap(pid, worktree);
      const edit = step.kind === 'agent' ? step.edit : null;
      const result = await git.capture({
        worktree,
        indexFile: join(dir, 'index'),
        parent: latest ? { commit: latest.commit } : null,
        paths: edit ? edit.paths.slice(0, 50) : null,
        always: edit !== null,
        ref: git.refName(worktree, seq),
        message: `mindly step ${seq}`,
        extraDeny: [...this.k.config.redaction.denyPaths, ...project.config.ignore],
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
      });
      if (result.commit === null) return null;
      const checkpoint = this.k.store.checkpoints.create({
        projectId: pid,
        worktree,
        seq,
        commit: result.commit,
        parentCommit: latest?.commit ?? null,
        kind: edit ? 'agent' : latest ? 'outside' : 'baseline',
        sessionId: step.kind === 'agent' ? step.session.id : null,
        fileChangeId: edit?.fileChangeId ?? null,
        promptEventId: edit?.promptEventId ?? null,
        tool: edit ? sanitizeLine(edit.tool, 40) : null,
        paths: result.changedPaths,
        gap,
      });
      if (gap) this.clearGap(pid, worktree);
      return checkpoint;
    } catch (err) {
      this.markGap(pid, worktree);
      this.k.logger.warn('checkpoint skipped', { reason: 'git', error: describeError(err) });
      return null;
    } finally {
      lock.release();
    }
  }

  private gapKey(projectId: string, worktree: string): string {
    return `checkpoints:gap:${projectId}:${sha256(worktree).slice(0, 16)}`;
  }

  private hasGap(projectId: string, worktree: string): boolean {
    return this.k.store.kv.get<boolean>(this.gapKey(projectId, worktree)) === true;
  }

  private markGap(projectId: string, worktree: string): void {
    try {
      this.k.store.kv.set(this.gapKey(projectId, worktree), true);
    } catch {
      // The next checkpoint simply will not carry the gap mark.
    }
  }

  private clearGap(projectId: string, worktree: string): void {
    this.k.store.kv.delete(this.gapKey(projectId, worktree));
  }

  /** Checkpoints of a working tree, oldest first (see `CheckpointRepo.list`). */
  list(
    projectId: string,
    worktree: string,
    opts: {
      since?: number;
      fromSeq?: number;
      toSeq?: number;
      order?: 'asc' | 'desc';
      limit?: number;
    } = {},
  ): Checkpoint[] {
    return this.k.store.checkpoints.list(projectId, worktree, opts);
  }

  /** The checkpoint with step number `seq`, or null. */
  step(projectId: string, worktree: string, seq: number): Checkpoint | null {
    return this.k.store.checkpoints.bySeq(projectId, worktree, seq);
  }

  latest(projectId: string, worktree: string): Checkpoint | null {
    return this.k.store.checkpoints.latest(projectId, worktree);
  }

  /** Deletes checkpoints older than `checkpoints.keepDays` or beyond `checkpoints.maxPerWorktree`. */
  async prune(projectId: string): Promise<PruneResult> {
    const cfg = this.k.config.checkpoints;
    const before = this.k.clock.now() - cfg.keepDays * DAY_MS;
    const expired = this.k.store.checkpoints.expired(projectId, before, cfg.maxPerWorktree);
    return this.remove(expired);
  }

  /** Prunes once a day at most (the hook calls this; the daemon has its own schedule). */
  async pruneIfDue(projectId: string): Promise<PruneResult | null> {
    const key = `checkpoints:pruned:${projectId}`;
    const last = this.k.store.kv.get<number>(key) ?? 0;
    const now = this.k.clock.now();
    if (now - last < PRUNE_INTERVAL_MS) return null;
    this.k.store.kv.set(key, now);
    try {
      return await this.prune(projectId);
    } catch (err) {
      this.k.logger.warn('checkpoint prune failed', { error: describeError(err) });
      return null;
    }
  }

  /** Prunes every project; failures are logged per project. */
  async pruneAll(): Promise<PruneResult> {
    const total: PruneResult = { refsDeleted: 0, rowsDeleted: 0 };
    for (const p of this.k.store.projects.list().slice(0, 500)) {
      try {
        const r = await this.prune(p.id);
        total.refsDeleted += r.refsDeleted;
        total.rowsDeleted += r.rowsDeleted;
      } catch (err) {
        this.k.logger.warn('checkpoint prune failed', {
          projectId: p.id,
          error: describeError(err),
        });
      }
    }
    return total;
  }

  /** Deletes every checkpoint ref and row of a project (`mindly forget`, `mindly uninstall`). */
  async forget(projectId: string): Promise<PruneResult> {
    return this.remove(this.k.store.checkpoints.refs(projectId));
  }

  private async remove(
    rows: readonly { id: string; worktree: string; seq: number }[],
  ): Promise<PruneResult> {
    const git = this.k.ports.git.checkpoints;
    const byWorktree = new Map<string, string[]>();
    if (git) {
      for (const r of rows) {
        const list = byWorktree.get(r.worktree) ?? [];
        list.push(git.refName(r.worktree, r.seq));
        byWorktree.set(r.worktree, list);
      }
    }
    let refsDeleted = 0;
    for (const [worktree, refs] of byWorktree) {
      try {
        refsDeleted += git ? await git.deleteRefs(worktree, refs) : 0;
      } catch (err) {
        // A working tree that no longer exists keeps no refs anyone can reach.
        this.k.logger.warn('checkpoint refs not deleted', { error: describeError(err) });
      }
    }
    const rowsDeleted = this.k.store.checkpoints.delete(rows.map((r) => r.id));
    return { refsDeleted, rowsDeleted };
  }

  /** How many checkpoints a project has and roughly what they take on disk. */
  async stats(projectId: string): Promise<{ count: number; diskBytes: number | null }> {
    const count = this.k.store.checkpoints.count(projectId);
    const git = this.k.ports.git.checkpoints;
    const worktree = this.k.store.checkpoints.worktrees(projectId)[0];
    if (!git || count === 0 || worktree === undefined) return { count, diskBytes: null };
    try {
      return { count, diskBytes: await git.diskUsage(worktree) };
    } catch {
      return { count, diskBytes: null };
    }
  }
}
