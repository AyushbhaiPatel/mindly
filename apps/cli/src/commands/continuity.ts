import { AGENT_KIND_RE, MindlyError } from '@mindly/core';
import { failoverService, isValidBranchName, snapshotService } from '@mindly/engine';
import { z } from 'zod';
import { pickSession, withProject, type ProjectScope } from '../context.js';
import { confirm } from '../io.js';
import { ago, clean, formatTime, requireId, table, UsageError, type Out } from '../util.js';
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
      out.line(`Handoff ${h.id} created for ${h.toAgentKind ?? 'the next agent'}.`);
      out.line(out.style.dim('It is offered to the next matching session at its start.'));
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
    if (list.length === 0) out.line(out.style.dim('No handoffs.'));
    for (const line of table(
      list.map((h) => [
        h.id,
        h.status,
        h.reason,
        `to ${h.toAgentKind ?? 'any'}`,
        ago(h.createdAt),
        clean(h.summary, 80),
      ]),
    )) {
      out.line(line);
    }
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
  if (!l.success) throw new UsageError('label must be 1-80 characters');
  return withProject(out.io, async ({ mindly, project }) => {
    const snap = await snapshotService(mindly).create(project.project.id, l.data);
    if (o.json) out.json(snap);
    else {
      out.line(`Snapshot ${snap.id} "${clean(snap.label, 80)}" created.`);
      if (!snap.gitRef)
        out.line(
          out.style.yellow(
            'No git ref was captured (not a git repository?): memory and task state only.',
          ),
        );
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
    if (list.length === 0) out.line(out.style.dim('No snapshots.'));
    for (const line of table(
      list.map((s) => [
        s.id,
        formatTime(s.createdAt),
        s.commit ? s.commit.slice(0, 12) : '-',
        clean(s.label, 80),
      ]),
    )) {
      out.line(line);
    }
    return 0;
  });
}

function snapshotOf(scope: ProjectScope, id: string): string {
  const sid = requireId(id, 'snapshot id');
  const found = snapshotService(scope.mindly)
    .list(scope.project.project.id, 1000)
    .some((s) => s.id === sid);
  if (!found) throw new MindlyError('not_found', 'snapshot not found in this project');
  return sid;
}

/** `mindly snapshot diff <id>`: what changed in memory and tasks since a snapshot. */
export async function snapshotDiff(out: Out, id: string, o: { json?: boolean }): Promise<number> {
  return withProject(out.io, (scope) => {
    const d = snapshotService(scope.mindly).diff(snapshotOf(scope, id));
    if (o.json) {
      out.json(d);
      return 0;
    }
    const s = out.style;
    out.line(
      s.bold(`Since "${clean(d.snapshot.label, 80)}" (${formatTime(d.snapshot.createdAt)})`),
    );
    const section = (title: string, rows: string[]): void => {
      out.line(`${title}: ${rows.length}`);
      for (const r of rows.slice(0, 20)) out.line(`  ${r}`);
    };
    section(
      'Memories added',
      d.memories.added.map((m) => clean(m.title, 100)),
    );
    section(
      'Memories changed',
      d.memories.updated.map((m) => `${clean(m.title, 100)} (v${m.from} -> v${m.to})`),
    );
    section(
      'Memories archived',
      d.memories.archived.map((m) => clean(m.title, 100)),
    );
    section(
      'Tasks added',
      d.tasks.added.map((t) => clean(t.title, 100)),
    );
    section(
      'Tasks changed',
      d.tasks.changed.map((t) => `${clean(t.title, 100)} (${t.from} -> ${t.to})`),
    );
    out.line(
      `Conflicts opened: ${d.conflicts.opened.length}, closed: ${d.conflicts.closed.length}`,
    );
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
    throw new UsageError('invalid branch name');
  }
  return withProject(out.io, async (scope) => {
    const sid = snapshotOf(scope, id);
    const svc = snapshotService(scope.mindly);
    const snap = svc.list(scope.project.project.id, 1000).find((s) => s.id === sid);
    out.line(
      `Restore memory and task state to "${clean(snap?.label ?? sid, 80)}"${o.branch ? ` and create branch ${clean(o.branch, 100)} at its code` : ''}.`,
    );
    out.line(out.style.dim('Nothing is deleted: newer memories are archived and can be restored.'));
    if (!(await confirm(out.io, 'Restore?', o.yes === true))) return 1;
    const r = await svc.restore(sid, o.branch ? { branch: o.branch } : {});
    if (o.json) out.json(r);
    else {
      out.line(
        `Restored ${r.memoriesRestored} memories and ${r.tasksRestored} tasks; archived ${r.memoriesArchived}${r.memoriesMissing ? `; ${r.memoriesMissing} could not be restored (deleted)` : ''}.`,
      );
      if (r.branch) out.line(`Branch ${clean(r.branch, 100)} created.`);
    }
    return 0;
  });
}
