import {
  invalidInput,
  sanitizeLine,
  SynapseError,
  uuidv7,
  type MemorySource,
  type Snapshot,
  type TaskPlanStep,
  type TaskStatus,
} from '@synapse/core';
import type { BusEvents, Kernel } from '../kernel.js';
import { LIVE_WINDOW_MS } from '../kernel.js';
import type { Synapse, SynapseModule } from '../synapse.js';

/*
 * Multi-agent time machine. A snapshot records the engine state (memory versions, tasks, open
 * conflicts, live sessions) plus, when the git port supports it, a hidden ref with the working
 * tree. Restoring never deletes anything: memories get new versions carrying their snapshot-time
 * content, newer memories are archived, and code is restored onto a *new* branch only.
 */

/** Automatic snapshots are taken at session start when the last one is older than this. */
export const AUTO_SNAPSHOT_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_ITEMS = 1000;

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Validates a git branch name supplied by a user: only `[A-Za-z0-9._/-]`, no `..`, no leading
 * `-`, plus git's own rules that matter for safety (no leading/trailing `/`, no `//`, no
 * `.lock` suffix, no leading `.` in a component).
 */
export function isValidBranchName(name: string): boolean {
  if (!BRANCH_RE.test(name)) return false;
  if (name.startsWith('-') || name.includes('..') || name.includes('//')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock'))
    return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.'));
}

/** Engine state captured in a snapshot (stored as JSON in `snapshots.state`). */
export interface SnapshotState {
  v: 1;
  memories: { id: string; version: number }[];
  tasks: { id: string; status: TaskStatus; ownerSessionId: string | null; plan: TaskPlanStep[] }[];
  conflicts: string[];
  sessions: {
    id: string;
    agentKind: string;
    status: string;
    label: string | null;
    branch: string | null;
    currentTaskId: string | null;
  }[];
}

/** Changes since a snapshot. */
export interface SnapshotDiff {
  snapshot: Snapshot;
  memories: {
    added: { id: string; title: string }[];
    updated: { id: string; title: string; from: number; to: number }[];
    archived: { id: string; title: string }[];
  };
  tasks: {
    added: { id: string; title: string }[];
    changed: {
      id: string;
      title: string;
      from: TaskStatus;
      to: TaskStatus;
      planChanged: boolean;
    }[];
  };
  conflicts: { opened: string[]; closed: string[] };
}

/** What a restore did. */
export interface RestoreResult {
  snapshot: Snapshot;
  memoriesRestored: number;
  memoriesArchived: number;
  /** Memories in the snapshot that were hard-deleted since and cannot be restored. */
  memoriesMissing: number;
  tasksRestored: number;
  branch: string | null;
}

const RESTORE_SOURCE: MemorySource = { type: 'user', sessionId: null, agentKind: null };

function parseState(raw: Record<string, unknown>): SnapshotState {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS * 5) : []);
  return {
    v: 1,
    memories: arr(raw.memories).filter(
      (m): m is { id: string; version: number } =>
        typeof (m as { id?: unknown }).id === 'string' &&
        typeof (m as { version?: unknown }).version === 'number',
    ),
    tasks: arr(raw.tasks).filter(
      (t): t is SnapshotState['tasks'][number] =>
        typeof (t as { id?: unknown }).id === 'string' &&
        typeof (t as { status?: unknown }).status === 'string' &&
        Array.isArray((t as { plan?: unknown }).plan),
    ),
    conflicts: arr(raw.conflicts).filter((c): c is string => typeof c === 'string'),
    sessions: arr(raw.sessions) as SnapshotState['sessions'],
  };
}

function samePlan(a: readonly TaskPlanStep[], b: readonly TaskPlanStep[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Creates, diffs and restores snapshots. */
export class SnapshotService {
  constructor(private readonly k: Kernel) {}

  private captureState(projectId: string): SnapshotState {
    const s = this.k.store;
    return {
      v: 1,
      memories: s.memories
        .list(projectId, { limit: MAX_ITEMS })
        .map((m) => ({ id: m.id, version: m.version })),
      tasks: s.tasks.list(projectId, { limit: 500 }).map((t) => ({
        id: t.id,
        status: t.status,
        ownerSessionId: t.ownerSessionId,
        plan: t.plan,
      })),
      conflicts: s.conflicts.list(projectId, { limit: 500 }).map((c) => c.id),
      sessions: s.sessions.listLive(projectId, LIVE_WINDOW_MS).map((x) => ({
        id: x.id,
        agentKind: x.agentKind,
        status: x.status,
        label: x.label,
        branch: x.branch,
        currentTaskId: x.currentTaskId,
      })),
    };
  }

  /**
   * Captures engine state (and a git ref when the port supports it and `worktree` is given or the
   * project root is used). Git failures are logged and leave `gitRef` null.
   */
  async create(projectId: string, label: string, worktree?: string): Promise<Snapshot> {
    const project = this.k.store.projects.get(projectId);
    const cleanLabel = sanitizeLine(label, 80) || 'snapshot';
    const id = uuidv7(this.k.clock.now());
    let git: { ref: string; commit: string } | null = null;
    if (this.k.ports.git.createSnapshotRef) {
      try {
        git = await this.k.ports.git.createSnapshotRef(project.root, worktree ?? project.root, id);
      } catch (err) {
        this.k.logger.warn('snapshot git ref failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const state = this.captureState(projectId);
    const snap = this.k.store.snapshots.create({
      id,
      projectId,
      label: cleanLabel,
      gitRef: git?.ref ?? null,
      commit: git?.commit ?? null,
      state: state as unknown as Record<string, unknown>,
    });
    this.k.store.events.append({
      projectId,
      sessionId: null,
      type: 'snapshot.created',
      payload: {
        snapshotId: snap.id,
        label: snap.label,
        memories: state.memories.length,
        tasks: state.tasks.length,
        git: snap.gitRef !== null,
      },
    });
    return {
      id: snap.id,
      projectId: snap.projectId,
      label: snap.label,
      gitRef: snap.gitRef,
      commit: snap.commit,
      createdAt: snap.createdAt,
    };
  }

  /** Snapshots of a project, newest first. */
  list(projectId: string, max = 50): Snapshot[] {
    return this.k.store.snapshots.list(projectId, max);
  }

  /** What changed in memories, tasks and conflicts since the snapshot. */
  diff(snapshotId: string): SnapshotDiff {
    const snap = this.k.store.snapshots.get(snapshotId);
    const state = parseState(snap.state);
    const pid = snap.projectId;
    const s = this.k.store;
    const snapMem = new Map(state.memories.map((m) => [m.id, m.version]));
    const active = s.memories.list(pid, { limit: MAX_ITEMS });
    const activeIds = new Set(active.map((m) => m.id));
    const out: SnapshotDiff = {
      snapshot: {
        id: snap.id,
        projectId: pid,
        label: snap.label,
        gitRef: snap.gitRef,
        commit: snap.commit,
        createdAt: snap.createdAt,
      },
      memories: { added: [], updated: [], archived: [] },
      tasks: { added: [], changed: [] },
      conflicts: { opened: [], closed: [] },
    };
    for (const m of active) {
      const v = snapMem.get(m.id);
      if (v === undefined) out.memories.added.push({ id: m.id, title: m.title });
      else if (v !== m.version)
        out.memories.updated.push({ id: m.id, title: m.title, from: v, to: m.version });
    }
    for (const [id] of snapMem) {
      if (activeIds.has(id)) continue;
      const m = s.memories.find(id);
      out.memories.archived.push({ id, title: m?.title ?? '(deleted)' });
    }
    const snapTasks = new Map(state.tasks.map((t) => [t.id, t]));
    for (const t of s.tasks.list(pid, { limit: 500 })) {
      const before = snapTasks.get(t.id);
      if (!before) {
        if (t.createdAt > snap.createdAt) out.tasks.added.push({ id: t.id, title: t.title });
        continue;
      }
      const planChanged = !samePlan(before.plan, t.plan);
      if (before.status !== t.status || planChanged) {
        out.tasks.changed.push({
          id: t.id,
          title: t.title,
          from: before.status,
          to: t.status,
          planChanged,
        });
      }
    }
    const openNow = new Set(s.conflicts.list(pid, { limit: 500 }).map((c) => c.id));
    const openThen = new Set(state.conflicts);
    out.conflicts.opened = [...openNow].filter((id) => !openThen.has(id));
    out.conflicts.closed = [...openThen].filter((id) => !openNow.has(id));
    return out;
  }

  /**
   * Non-destructive restore. Memories whose version changed get a new version with their
   * snapshot-time content (archived ones are re-activated); active memories that were not part of
   * the snapshot are archived; tasks get their snapshot status and plan back. With `branch`, the
   * snapshot's code is checked out onto that *new* branch (requires git support and a git ref).
   */
  async restore(snapshotId: string, options: { branch?: string } = {}): Promise<RestoreResult> {
    const snap = this.k.store.snapshots.get(snapshotId);
    const branch = options.branch ?? null;
    if (branch !== null) {
      if (!isValidBranchName(branch)) throw invalidInput('invalid branch name');
      if (!this.k.ports.git.restoreSnapshotToBranch || !snap.gitRef) {
        throw new SynapseError('unavailable', 'this snapshot has no git ref to restore from');
      }
    }
    const state = parseState(snap.state);
    const pid = snap.projectId;
    const s = this.k.store;
    const reason = `restored from snapshot "${snap.label}"`;
    const result: RestoreResult = {
      snapshot: {
        id: snap.id,
        projectId: pid,
        label: snap.label,
        gitRef: snap.gitRef,
        commit: snap.commit,
        createdAt: snap.createdAt,
      },
      memoriesRestored: 0,
      memoriesArchived: 0,
      memoriesMissing: 0,
      tasksRestored: 0,
      branch: null,
    };

    // Code first: if git fails nothing in the engine has changed yet.
    if (branch !== null && this.k.ports.git.restoreSnapshotToBranch) {
      const project = s.projects.get(pid);
      await this.k.ports.git.restoreSnapshotToBranch(project.root, snap.id, branch);
      result.branch = branch;
    }

    s.transaction(() => {
      const inSnapshot = new Set<string>();
      for (const { id, version } of state.memories) {
        inSnapshot.add(id);
        const cur = s.memories.find(id);
        if (!cur || cur.projectId !== pid) {
          result.memoriesMissing++;
          continue;
        }
        if (cur.version === version && cur.status === 'active') continue;
        const then = s.memories.versions(id).find((v) => v.version === version);
        if (!then) {
          result.memoriesMissing++;
          continue;
        }
        const m = s.memories.update(
          id,
          {
            title: then.title,
            body: then.body,
            tags: then.tags,
            scope: then.scope,
            trust: then.trust,
            status: 'active',
          },
          RESTORE_SOURCE,
          reason,
        );
        result.memoriesRestored++;
        s.events.append({
          projectId: pid,
          sessionId: null,
          type: 'memory.updated',
          payload: { memoryId: id, version: m.version, restoredFrom: snap.id },
        });
      }
      for (const m of s.memories.list(pid, { limit: MAX_ITEMS })) {
        if (inSnapshot.has(m.id)) continue;
        s.memories.update(m.id, { status: 'archived' }, RESTORE_SOURCE, reason);
        result.memoriesArchived++;
        s.events.append({
          projectId: pid,
          sessionId: null,
          type: 'memory.archived',
          payload: { memoryId: m.id, restoredFrom: snap.id },
        });
      }
      for (const t of state.tasks) {
        const cur = s.tasks.find(t.id);
        if (!cur || cur.projectId !== pid) continue;
        if (cur.status === t.status && samePlan(cur.plan, t.plan)) continue;
        s.tasks.update(t.id, { status: t.status, plan: t.plan });
        result.tasksRestored++;
        s.events.append({
          projectId: pid,
          sessionId: null,
          type: 'task.updated',
          payload: { taskId: t.id, status: t.status, restoredFrom: snap.id },
        });
      }
      s.events.append({
        projectId: pid,
        sessionId: null,
        type: 'snapshot.restored',
        payload: {
          snapshotId: snap.id,
          memoriesRestored: result.memoriesRestored,
          memoriesArchived: result.memoriesArchived,
          tasksRestored: result.tasksRestored,
          branch: result.branch,
        },
      });
    });
    return result;
  }

  /**
   * Bus handler for `session.started`: takes an `auto` snapshot when the last snapshot is older
   * than six hours and something happened since. Returns the snapshot, or null.
   */
  async onSessionStarted(p: BusEvents['session.started']): Promise<Snapshot | null> {
    const now = this.k.clock.now();
    const last = this.k.store.snapshots.list(p.projectId, 1)[0];
    if (last && now - last.createdAt < AUTO_SNAPSHOT_INTERVAL_MS) return null;
    const recent = this.k.store.events.query(p.projectId, {
      since: last?.createdAt ?? 0,
      order: 'desc',
      limit: 10,
    });
    const meaningful = recent.some(
      (e) =>
        e.type !== 'snapshot.created' &&
        e.type !== 'snapshot.restored' &&
        !(e.type === 'session.started' && e.sessionId === p.session.id),
    );
    if (!meaningful) return null;
    return this.create(p.projectId, 'auto', p.session.worktree);
  }
}

const services = new WeakMap<Synapse, SnapshotService>();
const registered = new WeakSet<Synapse>();

/** The snapshot service attached to `synapse` (created on first use). */
export function snapshotService(synapse: Synapse): SnapshotService {
  let svc = services.get(synapse);
  if (!svc) {
    svc = new SnapshotService(synapse.kernel);
    services.set(synapse, svc);
  }
  return svc;
}

/** Time-machine module: auto-snapshots on session start. `synapse.use(snapshotsModule)`. */
export const snapshotsModule: SynapseModule = (synapse) => {
  if (registered.has(synapse)) return;
  registered.add(synapse);
  const svc = snapshotService(synapse);
  synapse.bus.on('session.started', 'snapshots.auto', async (p) => {
    await svc.onSessionStarted(p);
  });
};
