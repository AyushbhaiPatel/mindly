import {
  fingerprint,
  sanitizeLine,
  shortId,
  type Contract,
  type ContractState,
  type Run,
} from '@mindly/core';
import { commandHash } from '@mindly/engine';
import { captureWorktreeCommit, materializeTree, runChecks } from '@mindly/git';
import {
  failRun,
  finishRun,
  notify,
  outputTail,
  reportConflict,
  startRun,
  type JobContext,
} from './context.js';

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_CONTRACTS_PER_RUN = 50;

/**
 * Command contracts that may run: kind `command`, argv present and `approvedHash` equal to the
 * hash of the current argv (any edit after approval invalidates it).
 */
export function runnableCommandContracts(ctx: JobContext, projectId: string): Contract[] {
  return ctx.mindly.store.contracts
    .list(projectId)
    .filter(
      (c) =>
        c.kind === 'command' &&
        Array.isArray(c.spec.argv) &&
        c.spec.argv.length > 0 &&
        c.approvedHash !== null &&
        c.approvedHash === commandHash(c.spec.argv),
    )
    .slice(0, MAX_CONTRACTS_PER_RUN);
}

/**
 * Runs the project's approved command contracts in a temporary tree built from HEAD plus the
 * project root's working-tree changes. Only for trusted projects. Records each result, opens a
 * critical `contract_broken` conflict on passing to failing and resolves it when fixed. Returns
 * the recorded run, or null when there was nothing to do.
 */
export async function runCommandContracts(ctx: JobContext, projectId: string): Promise<Run | null> {
  const { mindly } = ctx;
  const project = mindly.projects.byId(projectId);
  if (!project.trusted) return null;
  const contracts = runnableCommandContracts(ctx, projectId);
  if (contracts.length === 0) return null;
  const run = mindly.store.runs.create({
    projectId,
    kind: 'contract_sweep',
    title: 'Command contracts',
    input: { contracts: contracts.map((c) => c.id) },
  });
  startRun(ctx, run);
  try {
    const deny = [...mindly.config.redaction.denyPaths, ...project.config.ignore];
    const capture = await captureWorktreeCommit(project.root, { extraDeny: deny });
    const tree = await materializeTree(project.root, capture.commit);
    const rows: Record<string, unknown>[] = [];
    let anyFailed = false;
    try {
      for (const c of contracts) {
        const [res] = await runChecks(tree.path, [
          {
            name: `contract-${shortId(c.id)}`,
            argv: c.spec.argv ?? [],
            timeoutSec: c.spec.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
          },
        ]);
        if (!res) continue;
        const state: ContractState =
          res.status === 'pass' ? 'passing' : res.status === 'fail' ? 'failing' : 'error';
        const message =
          state === 'passing'
            ? 'command passed'
            : state === 'failing'
              ? `command failed (exit ${res.exitCode ?? 'signal'})`
              : `command ${res.status}`;
        if (state !== 'passing') anyFailed = true;
        await recordContractResult(ctx, c, state, message);
        rows.push({
          contractId: c.id,
          memoryId: c.memoryId,
          state,
          exitCode: res.exitCode,
          durationMs: res.durationMs,
          outputTail: outputTail(res.output, 2000),
        });
      }
    } finally {
      await tree.dispose();
    }
    return finishRun(ctx, run, anyFailed ? 'failed' : 'passed', { contracts: rows });
  } catch (err) {
    return failRun(ctx, run, err);
  }
}

async function recordContractResult(
  ctx: JobContext,
  c: Contract,
  state: ContractState,
  message: string,
): Promise<void> {
  const store = ctx.mindly.store;
  const saved = store.contracts.recordResult(c.id, state, message);
  store.events.append({
    projectId: c.projectId,
    sessionId: null,
    type: 'contract.result',
    payload: {
      contractId: c.id,
      memoryId: c.memoryId,
      kind: c.kind,
      state,
      previous: c.state,
      message,
    },
  });
  // Same fingerprint the engine's contract service uses, so both resolve each other's reports.
  const fp = fingerprint('contract_broken', c.id);
  if (c.state === 'passing' && state === 'failing') {
    const memory = store.memories.find(c.memoryId);
    const title = sanitizeLine(memory?.title ?? 'a recorded decision', 120);
    const { isNew } = reportConflict(ctx, {
      projectId: c.projectId,
      kind: 'contract_broken',
      severity: 'critical',
      title: `${memory?.kind === 'decision' ? 'Decision' : 'Memory'} '${title}' no longer holds: ${message}`,
      detail: 'An approved command contract started failing.',
      sessionIds: [],
      paths: [],
      fingerprint: fp,
    });
    if (isNew) {
      const project = store.projects.get(c.projectId);
      await notify(ctx, {
        trigger: 'check_failed',
        title: 'A command contract started failing',
        body: `Contract on '${title}' fails in ${sanitizeLine(project.name, 80)}.`,
        projectName: sanitizeLine(project.name, 80),
        priority: 'high',
        dedupeKey: `contract:${c.id}:${saved.lastRunAt ?? 0}`,
      });
    }
  } else if (c.state === 'failing' && state === 'passing') {
    const open = store.conflicts
      .list(c.projectId, { statuses: ['open', 'acknowledged'], limit: 500 })
      .filter((x) => x.kind === 'contract_broken' && x.fingerprint === fp);
    for (const x of open) {
      store.conflicts.setStatus(x.id, 'resolved');
      store.events.append({
        projectId: c.projectId,
        sessionId: null,
        type: 'conflict.updated',
        payload: { conflictId: x.id, kind: x.kind, status: 'resolved' },
      });
    }
  }
}

/** Scheduler entry: runs command contracts for every trusted project. */
export async function contractsTick(ctx: JobContext): Promise<void> {
  for (const p of ctx.mindly.store.projects.list().slice(0, 200)) {
    await ctx.scheduler.enqueue(`shadow:${p.id}`, async () => {
      await runCommandContracts(ctx, p.id);
    });
  }
}
