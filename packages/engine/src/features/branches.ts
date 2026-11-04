import { invalidInput, type MemorySource } from '@mindly/core';
import type { BusEvents, Kernel } from '../kernel.js';
import type { Mindly, MindlyModule } from '../mindly.js';
import { isValidBranchName } from './snapshots.js';

/*
 * Memory branches. Memories can be scoped to a git branch; once that branch is merged, its
 * memories become shared (branch = null). Merge checks run at session start, bounded and cached.
 */

/** At most this many branches are checked per session start. */
export const MAX_BRANCH_CHECKS = 20;
/** A "not merged" answer is cached this long per (branch, target) pair. */
export const MERGE_CHECK_TTL_MS = 10 * 60_000;

const PROMOTE_SOURCE: MemorySource = { type: 'system', sessionId: null, agentKind: null };

interface CachedCheck {
  merged: boolean;
  at: number;
}

/** Result of one merge check pass. */
export interface BranchCheckResult {
  checked: string[];
  promoted: { branch: string; count: number }[];
}

/** Promotes branch-scoped memories to shared memory. */
export class BranchService {
  constructor(private readonly k: Kernel) {}

  /** Moves every active memory scoped to `branch` to shared memory. Returns how many moved. */
  promote(projectId: string, branch: string): number {
    if (!isValidBranchName(branch)) throw invalidInput('invalid branch name');
    const count = this.k.store.memories.promoteBranch(projectId, branch, null, PROMOTE_SOURCE);
    if (count > 0) {
      this.k.store.events.append({
        projectId,
        sessionId: null,
        type: 'memory.updated',
        payload: { promotedBranch: branch, count },
      });
    }
    return count;
  }

  /** Distinct branches (other than `exclude`) that have active branch-scoped memories. */
  scopedBranches(projectId: string, exclude: string | null): string[] {
    const out = new Set<string>();
    for (const m of this.k.store.memories.list(projectId, { limit: 1000 })) {
      const b = m.scope.branch;
      if (b !== null && b !== exclude && isValidBranchName(b)) out.add(b);
    }
    return [...out].sort();
  }

  /**
   * Checks branches with scoped memories against `into` and promotes merged ones. Needs the
   * optional `GitPort.isMerged`; without it nothing happens.
   */
  async checkMerged(
    projectId: string,
    projectRoot: string,
    into: string,
    exclude: string | null = into,
  ): Promise<BranchCheckResult> {
    const result: BranchCheckResult = { checked: [], promoted: [] };
    const isMerged = this.k.ports.git.isMerged?.bind(this.k.ports.git);
    if (!isMerged || !isValidBranchName(into)) return result;
    const now = this.k.clock.now();
    for (const branch of this.scopedBranches(projectId, exclude).slice(0, MAX_BRANCH_CHECKS)) {
      const key = `branches.merged:${projectId}:${branch}:${into}`;
      const cached = this.k.store.kv.get<CachedCheck>(key);
      if (cached && !cached.merged && now - cached.at < MERGE_CHECK_TTL_MS) continue;
      let merged = false;
      try {
        merged = (await isMerged(projectRoot, branch, into)) === true;
      } catch (err) {
        this.k.logger.warn('branch merge check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      result.checked.push(branch);
      this.k.store.kv.set(key, { merged, at: now } satisfies CachedCheck);
      if (merged) {
        const count = this.promote(projectId, branch);
        result.promoted.push({ branch, count });
      }
    }
    return result;
  }

  /** Bus handler for `session.started`. */
  async onSessionStarted(p: BusEvents['session.started']): Promise<BranchCheckResult> {
    const into = p.session.branch ?? 'main';
    return this.checkMerged(p.projectId, p.projectRoot, into);
  }
}

const services = new WeakMap<Mindly, BranchService>();
const registered = new WeakSet<Mindly>();

/** The branch service attached to `mindly` (created on first use). */
export function branchService(mindly: Mindly): BranchService {
  let svc = services.get(mindly);
  if (!svc) {
    svc = new BranchService(mindly.kernel);
    services.set(mindly, svc);
  }
  return svc;
}

/** Memory-branch module: promotes memories of merged branches at session start. */
export const branchesModule: MindlyModule = (mindly) => {
  if (registered.has(mindly)) return;
  registered.add(mindly);
  const svc = branchService(mindly);
  mindly.bus.on('session.started', 'branches.promote', async (p) => {
    await svc.onSessionStarted(p);
  });
};
