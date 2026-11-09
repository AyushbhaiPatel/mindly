import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeError,
  isMindlyError,
  sanitizeLine,
  sha256,
  type Checkpoint,
  type CheckpointKind,
  type FileChange,
  type Session,
} from '@mindly/core';
import type { Kernel } from '../kernel.js';
import type { ProjectContext } from '../projects.js';

/*
 * Checkpoints: a copy of the code after every agent edit, stored as parentless git commits under
 * `refs/mindly/steps/<worktree id>/<seq>` (see `@mindly/git` `captureCheckpoint`). This service
 * decides when to take one, numbers the steps, attributes them, keeps the rows and prunes old
 * ones. Everything fails open: a hook never notices a checkpoint that could not be taken.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Every git call while taking a checkpoint is bounded by this. */
export const CHECKPOINT_TIMEOUT_MS = 2000;
/** The hook prunes old checkpoints at most this often (the daemon prunes on its own schedule). */
export const PRUNE_INTERVAL_MS = DAY_MS;
/** A ref without a row is deleted by the prune once it is this old (a row may still be coming). */
const ORPHAN_REF_MIN_AGE_MS = HOUR_MS;

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
    /** The daemon's state file (`$MINDLY_HOME/daemon.json`); a live daemon prunes on its own. */
    private readonly daemonStateFile: string | null = null,
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

  /** Removes the temp folder an instance without a home made for its private indexes. */
  dispose(): void {
    if (this.tmpDir === null) return;
    rmSync(this.tmpDir, { recursive: true, force: true });
    this.tmpDir = null;
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
   * have written files). Changes that match an agent's recorded edit since the last step are
   * credited to that agent (its own checkpoint was skipped); the rest become an `outside` step.
   * The first checkpoint of a working tree is its `baseline`. Null when nothing changed or the
   * checkpoint was skipped.
   */
  async rescan(project: ProjectContext, cwd: string): Promise<Checkpoint | null> {
    return this.record(project, cwd, { kind: 'rescan' });
  }

  /**
   * Records one agent edit as a step holding only the paths the tool touched. When the tree
   * already equals the previous step because a rescan took the edit first, that step is
   * re-attributed to the agent instead.
   */
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
      const gap = this.hasGap(pid, worktree);
      const edit = step.kind === 'agent' ? step.edit : null;
      // After a skipped checkpoint the tree holds an edit no step has: the whole tree is scanned,
      // so that edit lands in this step (marked as a gap) and not in a later one nobody made.
      const editPaths = edit && !gap ? edit.paths.slice(0, 50) : null;
      const capture = async (seq: number) =>
        git.capture({
          worktree,
          indexFile: join(dir, 'index'),
          parent: latest ? { commit: latest.commit } : null,
          paths: editPaths,
          always: false,
          ref: git.refName(worktree, seq),
          message: `mindly step ${seq}`,
          extraDeny: [...this.k.config.redaction.denyPaths, ...project.config.ignore],
          timeoutMs: CHECKPOINT_TIMEOUT_MS,
        });
      // The next free step number: rows and refs may disagree after a crash, a prune without
      // its refs or a reset home, so the high-water mark and the refs themselves are consulted.
      let seq = Math.max(latest?.seq ?? 0, this.highWater(pid, worktree)) + 1;
      let result;
      try {
        result = await capture(seq);
      } catch (err) {
        if (!isMindlyError(err, 'conflict')) throw err;
        const id = git.worktreeId(worktree);
        const refs = await git.listRefs(project.root);
        seq = Math.max(seq, ...refs.filter((r) => r.worktreeId === id).map((r) => r.seq)) + 1;
        result = await capture(seq);
      }
      // The ref exists now: the number is taken even if the row below never gets written.
      if (result.commit !== null) this.setHighWater(pid, worktree, seq);
      if (result.commit === null) {
        // The edit was already taken by a rescan that ran between the write and this hook.
        if (edit && latest && latest.kind === 'outside' && this.covers(latest, edit)) {
          const own = new Set(edit.paths);
          return this.k.store.checkpoints.attribute(latest.id, {
            kind: 'agent',
            sessionId: step.kind === 'agent' ? step.session.id : null,
            fileChangeId: edit.fileChangeId,
            promptEventId: edit.promptEventId,
            tool: sanitizeLine(edit.tool, 40),
            // The rescan may have picked up more than this edit: the step is then not the agent's alone.
            gap: latest.gap || latest.paths.some((p) => !own.has(p)),
          });
        }
        return null;
      }
      const who = edit
        ? {
            kind: 'agent' as CheckpointKind,
            sessionId: step.kind === 'agent' ? step.session.id : null,
            fileChangeId: edit.fileChangeId,
            promptEventId: edit.promptEventId,
            tool: sanitizeLine(edit.tool, 40),
            // A fresh index means the whole tree was scanned: the step may hold more than this edit.
            gap: gap || result.fresh,
          }
        : await this.attributeRescan(pid, worktree, latest, result.changedPaths, gap);
      const checkpoint = this.k.store.checkpoints.create({
        projectId: pid,
        worktree,
        seq,
        commit: result.commit,
        parentCommit: latest?.commit ?? null,
        paths: result.changedPaths,
        ...who,
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

  /** True when the step's recorded paths include every path of the edit. */
  private covers(step: Checkpoint, edit: AgentEditInput): boolean {
    const paths = new Set(step.paths);
    return edit.paths.length > 0 && edit.paths.every((p) => paths.has(p));
  }

  /**
   * Who a rescan's changes belong to: the agent whose recorded edits since the last step cover
   * them (its own checkpoint was skipped), else nobody. Changes from several agents, or an agent
   * step that may hold more, are marked as a gap. Recorded edits carry paths relative to the
   * working tree their agent runs in, so only edits made in this working tree count: the same
   * path edited in another linked worktree of the project explains nothing here.
   */
  private async attributeRescan(
    projectId: string,
    worktree: string,
    latest: Checkpoint | null,
    changedPaths: readonly string[],
    gap: boolean,
  ): Promise<{
    kind: CheckpointKind;
    sessionId: string | null;
    fileChangeId: string | null;
    promptEventId: string | null;
    tool: string | null;
    gap: boolean;
  }> {
    const nobody = { sessionId: null, fileChangeId: null, promptEventId: null, tool: null };
    if (!latest) return { kind: 'baseline', ...nobody, gap };
    const changed = new Set(changedPaths);
    const here = new Map<string, boolean>();
    const matches: FileChange[] = [];
    for (const c of this.k.store.fileChanges.since(projectId, latest.createdAt)) {
      if (!changed.has(c.path)) continue;
      let inTree = here.get(c.sessionId);
      if (inTree === undefined) {
        inTree = await this.sessionInWorktree(c.sessionId, worktree);
        here.set(c.sessionId, inTree);
      }
      if (inTree) matches.push(c);
    }
    const sessions = new Set(matches.map((c) => c.sessionId));
    if (sessions.size !== 1) return { kind: 'outside', ...nobody, gap: gap || sessions.size > 1 };
    const newest = matches[0] as FileChange;
    const explained = new Set(matches.map((c) => c.path));
    return {
      kind: 'agent',
      sessionId: newest.sessionId,
      fileChangeId: newest.id,
      promptEventId: newest.promptEventId,
      tool: sanitizeLine(newest.tool, 40),
      gap: gap || changedPaths.some((p) => !explained.has(p)),
    };
  }

  /** True when the session's agent runs in `worktree` (false when that cannot be told). */
  private async sessionInWorktree(sessionId: string, worktree: string): Promise<boolean> {
    const session = this.k.store.sessions.find(sessionId);
    if (!session) return false;
    return (await this.worktreeOf(session.worktree)) === worktree;
  }

  private kvKey(what: string, projectId: string, worktree: string): string {
    return `checkpoints:${what}:${projectId}:${sha256(worktree).slice(0, 16)}`;
  }

  private hasGap(projectId: string, worktree: string): boolean {
    return this.k.store.kv.get<boolean>(this.kvKey('gap', projectId, worktree)) === true;
  }

  private markGap(projectId: string, worktree: string): void {
    try {
      this.k.store.kv.set(this.kvKey('gap', projectId, worktree), true);
    } catch {
      // The next checkpoint simply will not carry the gap mark.
    }
  }

  private clearGap(projectId: string, worktree: string): void {
    this.k.store.kv.delete(this.kvKey('gap', projectId, worktree));
  }

  /** The highest step number ever given to this working tree (survives pruned rows). */
  private highWater(projectId: string, worktree: string): number {
    return this.k.store.kv.get<number>(this.kvKey('seq', projectId, worktree)) ?? 0;
  }

  private setHighWater(projectId: string, worktree: string, seq: number): void {
    this.k.store.kv.set(this.kvKey('seq', projectId, worktree), seq);
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

  /**
   * Deletes checkpoints older than `checkpoints.keepDays` or beyond `checkpoints.maxPerWorktree`,
   * and refs that lost their row. Rows go only once their refs are gone, so nothing is left
   * behind in the repository.
   */
  async prune(projectId: string): Promise<PruneResult> {
    const cfg = this.k.config.checkpoints;
    const before = this.k.clock.now() - cfg.keepDays * DAY_MS;
    const expired = this.k.store.checkpoints.expired(projectId, before, cfg.maxPerWorktree);
    const git = this.k.ports.git.checkpoints;
    const root = this.k.store.projects.get(projectId).root;
    const result: PruneResult = { refsDeleted: 0, rowsDeleted: 0 };
    if (!git) {
      result.rowsDeleted = this.k.store.checkpoints.delete(expired.map((r) => r.id));
      return result;
    }
    const expiredIds = new Set(expired.map((r) => r.id));
    const kept = new Set(
      this.k.store.checkpoints
        .refs(projectId)
        .filter((r) => !expiredIds.has(r.id))
        .map((r) => git.refName(r.worktree, r.seq)),
    );
    const now = this.k.clock.now();
    const refs = (await git.listRefs(root)).filter(
      (r) => !kept.has(r.ref) && now - r.createdAt >= ORPHAN_REF_MIN_AGE_MS,
    );
    const wanted = new Set([
      ...refs.map((r) => r.ref),
      ...expired.map((r) => git.refName(r.worktree, r.seq)),
    ]);
    if (wanted.size > 0) result.refsDeleted = await git.deleteRefs(root, [...wanted]);
    result.rowsDeleted = this.k.store.checkpoints.delete(expired.map((r) => r.id));
    this.k.store.kv.set(`checkpoints:pruned:${projectId}`, now);
    return result;
  }

  /**
   * Prunes once a day at most, and not at all while the daemon is running (it prunes every hour
   * on its own): the hook calls this, and a prune's git calls are too slow for a hook.
   */
  async pruneIfDue(projectId: string): Promise<PruneResult | null> {
    const key = `checkpoints:pruned:${projectId}`;
    const last = this.k.store.kv.get<number>(key) ?? 0;
    const now = this.k.clock.now();
    if (now - last < PRUNE_INTERVAL_MS || this.daemonAlive()) return null;
    this.k.store.kv.set(key, now);
    try {
      return await this.prune(projectId);
    } catch (err) {
      this.k.logger.warn('checkpoint prune failed', { error: describeError(err) });
      return null;
    }
  }

  /** True when `daemon.json` names a process that exists. */
  private daemonAlive(): boolean {
    if (this.daemonStateFile === null) return false;
    try {
      const raw = JSON.parse(readFileSync(this.daemonStateFile, 'utf8')) as { pid?: unknown };
      if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return false;
      process.kill(raw.pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
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

  /**
   * Deletes every checkpoint ref of the project's repository and every row (`mindly forget`,
   * `mindly uninstall`). Rows go even when the repository is gone.
   */
  async forget(projectId: string): Promise<PruneResult> {
    const git = this.k.ports.git.checkpoints;
    const rows = this.k.store.checkpoints.refs(projectId);
    let refsDeleted = 0;
    if (git) {
      try {
        const root = this.k.store.projects.get(projectId).root;
        const refs = (await git.listRefs(root)).map((r) => r.ref);
        refsDeleted = await git.deleteRefs(root, refs);
      } catch (err) {
        this.k.logger.warn('checkpoint refs not deleted', { error: describeError(err) });
      }
    }
    return { refsDeleted, rowsDeleted: this.k.store.checkpoints.delete(rows.map((r) => r.id)) };
  }

  /** How many checkpoints a project has and roughly what they take on disk. */
  async stats(projectId: string): Promise<{ count: number; diskBytes: number | null }> {
    const count = this.k.store.checkpoints.count(projectId);
    const git = this.k.ports.git.checkpoints;
    if (!git || count === 0) return { count, diskBytes: null };
    try {
      return { count, diskBytes: await git.diskUsage(this.k.store.projects.get(projectId).root) };
    } catch {
      return { count, diskBytes: null };
    }
  }
}
