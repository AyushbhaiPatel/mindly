import { CONFLICT_STATUSES, type Conflict, type ConflictStatus } from '@mindly/core';
import { LIVE_WINDOW_MS, provenanceOf, sessionLabel, standupService, xrayOf } from '@mindly/engine';
import { z } from 'zod';
import { pickSession, projectPath, withProject } from '../context.js';
import {
  ago,
  clean,
  ensureFound,
  formatTime,
  parseDuration,
  plural,
  requireId,
  stripControl,
  table,
  UsageError,
  type Out,
} from '../util.js';
import { parseOptions } from './memory.js';

/** `mindly status`: live agents, work in progress, conflicts and what needs the user. */
export async function status(out: Out, o: { json?: boolean }): Promise<number> {
  return withProject(out.io, ({ mindly, project }) => {
    const store = mindly.store;
    const pid = project.project.id;
    const sessions = store.sessions
      .listLive(pid, LIVE_WINDOW_MS)
      .filter((s) => s.status !== 'ended');
    const tasks = store.tasks.list(pid, { statuses: ['open', 'in_progress', 'blocked'] });
    const intents = store.intents.active(pid);
    const conflicts = store.conflicts.list(pid, { statuses: ['open', 'acknowledged'] });
    const proposed = store.memories.list(pid, {
      trust: ['proposed'],
      status: 'active',
      limit: 500,
    });
    const needsYou = {
      proposedRules: proposed.filter((m) => m.kind === 'rule').length,
      proposedMemories: proposed.filter((m) => m.kind !== 'rule').length,
      criticalConflicts: conflicts.filter((c) => c.severity === 'critical').length,
      pendingHandoffs: store.handoffs.list(pid, 200).filter((h) => h.status === 'pending').length,
    };
    if (o.json) {
      out.json({
        project: project.project,
        trusted: project.trusted,
        sessions,
        tasks,
        intents,
        conflicts,
        needsYou,
      });
      return 0;
    }
    const s = out.style;
    out.line(`${s.bold(clean(project.project.name, 80))} ${s.dim(clean(project.root, 300))}`);
    out.line();
    out.line(s.bold(`Agents (${sessions.length})`));
    if (sessions.length === 0) out.line(s.dim('  No live agent sessions.'));
    for (const line of table(
      sessions.map((x) => [
        `  ${clean(sessionLabel(x), 60)}`,
        x.status,
        x.branch ? clean(x.branch, 60) : '-',
        ago(x.lastSeenAt),
      ]),
    )) {
      out.line(line);
    }
    out.line();
    out.line(s.bold(`Tasks (${tasks.length})`));
    for (const t of tasks.slice(0, 20)) out.line(`  ${t.status.padEnd(12)}${clean(t.title, 100)}`);
    out.line();
    out.line(s.bold(`Intents (${intents.length})`));
    for (const i of intents.slice(0, 20)) {
      const files = i.targets.files.slice(0, 3).map((f) => clean(f, 80));
      out.line(`  ${clean(i.summary, 80)}${files.length ? s.dim(` (${files.join(', ')})`) : ''}`);
    }
    out.line();
    out.line(s.bold(`Open conflicts (${conflicts.length})`));
    for (const c of conflicts.slice(0, 20)) out.line(`  ${conflictLine(out, c)}`);
    out.line();
    const total =
      needsYou.proposedRules +
      needsYou.proposedMemories +
      needsYou.criticalConflicts +
      needsYou.pendingHandoffs;
    out.line(s.bold(`Needs you (${total})`));
    out.line(
      `  ${plural(needsYou.proposedRules, 'proposed rule')}, ${plural(needsYou.proposedMemories, 'proposed memory', 'proposed memories')}, ${plural(needsYou.criticalConflicts, 'critical conflict')}, ${plural(needsYou.pendingHandoffs, 'unclaimed handoff')}`,
    );
    return 0;
  });
}

function conflictLine(out: Out, c: Conflict): string {
  const sev =
    c.severity === 'critical'
      ? out.style.red(c.severity)
      : c.severity === 'warning'
        ? out.style.yellow(c.severity)
        : c.severity;
  return `${c.id}  ${sev}  ${c.status}  ${clean(c.title, 100)}`;
}

/** Parses `path/to/file.ts:42`. */
export function parseFileLine(spec: string): { file: string; line: number } {
  const m = /^(.+):(\d{1,9})$/.exec(spec.trim());
  if (!m) throw new UsageError('expected <file>:<line>, for example src/auth.ts:42');
  const line = Number(m[2]);
  if (line < 1) throw new UsageError('line numbers start at 1');
  return { file: m[1] as string, line };
}

/** `mindly why <file>:<line>`: which agent wrote a line, and why. */
export async function why(out: Out, spec: string, o: { json?: boolean }): Promise<number> {
  const { file, line } = parseFileLine(spec);
  return withProject(out.io, (scope) => {
    const rel = projectPath(scope, out.io.cwd, file).rel;
    const r = provenanceOf(scope.mindly).why(
      scope.project.project.id,
      scope.project.root,
      rel,
      line,
    );
    if (o.json) {
      out.json(r);
      return 0;
    }
    const s = out.style;
    out.line(`${s.bold(`${clean(r.path, 300)}:${r.line}`)}  ${s.dim(clean(r.text, 160))}`);
    if (r.changes.length === 0) {
      out.line('No recorded agent edit introduced this line.');
    }
    for (const [i, c] of r.changes.entries()) {
      const who = clean(c.label ?? c.agentKind ?? 'unknown agent', 60);
      out.line(
        `${i === 0 ? 'Written by' : 'Earlier  '} ${who} with ${clean(c.tool, 40)} at ${formatTime(c.at)}`,
      );
      if (c.prompt) out.line(`  prompt: ${clean(c.prompt, 200)}`);
      out.line(s.dim(`  session ${c.sessionId}`));
    }
    if (r.memories.length) {
      out.line();
      out.line(s.bold('Related memories'));
      for (const m of r.memories) {
        out.line(`  ${m.id}  ${m.kind}  ${m.trust}  ${clean(m.title, 100)}`);
      }
    }
    return 0;
  });
}

const XrayOptions = z.object({
  session: z.string().optional(),
  query: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  json: z.boolean().optional(),
});

/** `mindly xray`: what context a session received and what it missed. */
export async function xray(out: Out, raw: unknown): Promise<number> {
  const o = parseOptions(XrayOptions, raw);
  return withProject(out.io, (scope) => {
    const session = pickSession(scope, o.session);
    const svc = xrayOf(scope.mindly);
    const s = out.style;
    if (o.query !== undefined) {
      const r = svc.explainMissing(session.id, o.query);
      if (o.json) {
        out.json(r);
        return 0;
      }
      out.line(
        s.bold(
          `Why memories matching "${clean(o.query, 80)}" reach ${clean(sessionLabel(session), 60)} or not`,
        ),
      );
      if (r.items.length === 0) out.line(s.dim('No memory matches that query.'));
      for (const it of r.items) {
        out.line(`  ${it.reason.padEnd(15)}${it.memoryId}  ${clean(it.title, 80)}`);
        out.line(s.dim(`  ${' '.repeat(15)}${clean(it.detail, 160)}`));
      }
      return 0;
    }
    const r = svc.session(session.id, o.limit ?? 5);
    if (o.json) {
      out.json(r);
      return 0;
    }
    out.line(
      s.bold(`Context served to ${clean(r.label, 60)}`) + s.dim(` (session ${r.sessionId})`),
    );
    if (r.packets.length === 0) out.line(s.dim('No context packets recorded yet.'));
    for (const p of r.packets) {
      out.line();
      out.line(
        `${formatTime(p.at)}  ${p.trigger}  ${p.tokensUsed}/${p.tokenBudget} tokens${p.query ? `  query: ${clean(p.query, 80)}` : ''}`,
      );
      for (const it of p.included) {
        out.line(
          `  ${s.green('+')} ${it.kind.padEnd(9)}${clean(it.title, 90)} ${s.dim(`(${clean(it.reason, 60)})`)}`,
        );
      }
      for (const it of p.omitted) {
        out.line(
          `  ${s.dim('-')} ${it.kind.padEnd(9)}${clean(it.title, 90)} ${s.dim(`(${clean(it.reason, 60)})`)}`,
        );
      }
    }
    return 0;
  });
}

/** `mindly standup [--since 24h]`. */
export async function standup(out: Out, o: { since?: string; json?: boolean }): Promise<number> {
  const sinceMs = o.since !== undefined ? parseDuration(o.since) : undefined;
  return withProject(out.io, ({ mindly, project }) => {
    const svc = standupService(mindly);
    const since = sinceMs !== undefined ? mindly.kernel.clock.now() - sinceMs : undefined;
    const digest = svc.build(project.project.id, since);
    if (o.json) out.json(digest);
    else out.line(stripControl(svc.render(digest)));
    return 0;
  });
}

/** `mindly conflicts [--all]`. */
export async function conflicts(out: Out, o: { all?: boolean; json?: boolean }): Promise<number> {
  return withProject(out.io, ({ mindly, project }) => {
    const list = mindly.store.conflicts.list(
      project.project.id,
      o.all ? {} : { statuses: ['open', 'acknowledged'] },
    );
    if (o.json) {
      out.json(list);
      return 0;
    }
    if (list.length === 0) out.line(out.style.dim(o.all ? 'No conflicts.' : 'No open conflicts.'));
    for (const c of list) {
      out.line(conflictLine(out, c));
      if (c.paths.length)
        out.line(
          out.style.dim(
            `  ${c.paths
              .slice(0, 5)
              .map((p) => clean(p, 100))
              .join(', ')}`,
          ),
        );
    }
    return 0;
  });
}

const CONFLICT_ACTIONS: Record<string, ConflictStatus> = {
  resolve: 'resolved',
  dismiss: 'dismissed',
  ack: 'acknowledged',
};

/** `mindly conflict <id> resolve|dismiss|ack`. */
export async function conflictAction(out: Out, id: string, action: string): Promise<number> {
  const target = CONFLICT_ACTIONS[action];
  if (!target || !(CONFLICT_STATUSES as readonly string[]).includes(target)) {
    throw new UsageError('action must be resolve, dismiss or ack');
  }
  const cid = requireId(id, 'conflict id');
  return withProject(out.io, ({ mindly, project }) => {
    const store = mindly.store;
    let existing: Conflict | null;
    try {
      existing = store.conflicts.get(cid);
    } catch {
      existing = null;
    }
    ensureFound(existing !== null && existing.projectId === project.project.id, 'conflict');
    const c = store.conflicts.setStatus(cid, target);
    store.events.append({
      projectId: c.projectId,
      sessionId: null,
      type: 'conflict.updated',
      payload: { conflictId: c.id, kind: c.kind, status: target, by: 'user' },
    });
    out.line(`Conflict ${c.id} is now ${c.status}.`);
    return 0;
  });
}
