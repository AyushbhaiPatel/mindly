import { AGENT_KIND_RE, shortId } from '@mindly/core';
import { failoverService, isValidBranchName, snapshotService } from '@mindly/engine';
import { z } from 'zod';
import { pickSession, withProject, type ProjectScope } from '../context.js';
import { resolveId } from '../ids.js';
import { confirm } from '../io.js';
import { agentName, count, relativeTime } from '../present/index.js';
import { clean, UsageError, type Out } from '../util.js';
import { renderHandoffs, renderSnapshotDiff, renderSnapshots } from '../views/continuity.js';
import { sessionLookup } from '../views/common.js';
import { parseOptions } from './memory.js';

const HandoffOptions = z.object({
  to: z.string().regex(AGENT_KIND_RE, 'invalid agent kind').optional(),
  summary: z.string().trim().min(1).max(2000),
  next: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  blocker: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  session: z.string().optional(),
  json: z.boolean().optional(),
});

/** `mindly handoff [--to codex] --summary ...`: packages a session's task for another agent. */
export async function handoff(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(HandoffOptions, raw);
  return withProject(out.io, async (scope) => {
    const session = pickSession(scope, o.session);
    const h = await failoverService(scope.mindly).handoffs.create(session, {
      toAgentKind: o.to ?? null,
      summary: o.summary,
      ...(o.next ? { nextSteps: o.next } : {}),
      ...(o.blocker ? { blockers: o.blocker } : {}),
    });
    if (o.json) out.json(h);
    else {
      const sc = out.screen();
      const who = h.toAgentKind ? agentName(h.toAgentKind) : 'The next agent';
      sc.text(`${sc.mark('ok')} Handoff created ${sc.ref(h.id)}: "${clean(h.summary, 100)}"`);
      sc.note(`${who} picks it up when its next session starts in this project.`, 2);
    }
    return 0;
  });
}

/** `mindly handoffs`. */
export async function handoffs(out: Out, o: { json?: boolean }): Promise<number> {
  return withProject(out.io, ({ mindly, project }) => {
    const list = failoverService(mindly).handoffs.list(project.project.id);
    if (o.json) {
      out.json(list);
      return 0;
    }
    renderHandoffs(out.screen(), list, sessionLookup(mindly.store));
    return 0;
  });
}

const Label = z.string().trim().min(1).max(80);

/** `mindly snapshot create <label>`. */
export async function snapshotCreate(
  out: Out,
  label: string,
  o: { json?: boolean },
): Promise<number> {
  const l = Label.safeParse(label);
  if (!l.success) throw new UsageError('the snapshot label must be 1-80 characters');
  return withProject(out.io, async ({ mindly, project }) => {
    const snap = await snapshotService(mindly).create(project.project.id, l.data);
    if (o.json) out.json(snap);
    else {
      const sc = out.screen();
      sc.text(`${sc.mark('ok')} Snapshot "${clean(snap.label, 80)}" saved ${sc.ref(snap.id)}.`);
      if (!snap.gitRef) {
        sc.text(
          `${sc.mark('warn')} The code was not saved (this is not a git repository); memory and tasks were.`,
          2,
        );
      }
      sc.note(`See what changes from here on with: mindly snapshot diff ${shortId(snap.id)}`, 2);
    }
    return 0;
  });
}

/** `mindly snapshot list`. */
export async function snapshotList(out: Out, o: { json?: boolean }): Promise<number> {
  return withProject(out.io, ({ mindly, project }) => {
    const list = snapshotService(mindly).list(project.project.id);
    if (o.json) {
      out.json(list);
      return 0;
    }
    renderSnapshots(out.screen(), list);
    return 0;
  });
}

function snapshotOf(scope: ProjectScope, id: string): string {
  return resolveId(scope.mindly.store, 'snapshot', scope.project.project.id, id);
}

/** `mindly snapshot diff <id>`: what changed in memory and tasks since a snapshot. */
export async function snapshotDiff(out: Out, id: string, o: { json?: boolean }): Promise<number> {
  return withProject(out.io, (scope) => {
    const d = snapshotService(scope.mindly).diff(snapshotOf(scope, id));
    if (o.json) {
      out.json(d);
      return 0;
    }
    renderSnapshotDiff(out.screen(), d);
    return 0;
  });
}

/** `mindly snapshot restore <id> [--branch <name>]` (asks for confirmation). */
export async function snapshotRestore(
  out: Out,
  id: string,
  o: { branch?: string; yes?: boolean; json?: boolean },
): Promise<number> {
  if (o.branch !== undefined && !isValidBranchName(o.branch)) {
    throw new UsageError(`"${clean(o.branch, 60)}" is not a valid git branch name`);
  }
  return withProject(out.io, async (scope) => {
    const sid = snapshotOf(scope, id);
    const svc = snapshotService(scope.mindly);
    const snap = svc.list(scope.project.project.id, 1000).find((s) => s.id === sid);
    out.line(
      `This puts memory and tasks back the way they were at snapshot "${clean(snap?.label ?? shortId(sid), 80)}"${snap ? ` (${relativeTime(snap.createdAt, Date.now())})` : ''}${o.branch ? ` and creates the branch ${clean(o.branch, 100)} with its code` : ''}.`,
    );
    out.line(
      out.style.dim(
        `Nothing is deleted: newer memories are archived and can be restored.${o.branch ? '' : ' Your code is not touched (add --branch <name> to get the code back on a new branch).'}`,
      ),
    );
    if (!(await confirm(out.io, 'Restore?', o.yes === true))) {
      out.line('Nothing was restored.');
      return 1;
    }
    const r = await svc.restore(sid, o.branch ? { branch: o.branch } : {});
    if (o.json) out.json(r);
    else {
      const sc = out.screen();
      sc.text(
        `${sc.mark('ok')} Restored ${count(r.memoriesRestored, 'memory', 'memories')} and ${count(r.tasksRestored, 'task')}; archived ${count(r.memoriesArchived, 'newer memory', 'newer memories')}.`,
      );
      if (r.memoriesMissing) {
        sc.text(
          `${sc.mark('warn')} ${count(r.memoriesMissing, 'memory', 'memories')} could not be restored because ${r.memoriesMissing === 1 ? 'it was' : 'they were'} deleted.`,
          2,
        );
      }
      if (r.branch)
        sc.text(
          `${sc.mark('ok')} Created the branch ${clean(r.branch, 100)} with the snapshot's code.`,
          2,
        );
    }
    return 0;
  });
}
