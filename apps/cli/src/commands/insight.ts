import { CONFLICT_STATUSES, shortId, type ConflictStatus } from '@mindly/core';
import { LIVE_WINDOW_MS, provenanceOf, savesOf, standupService, xrayOf } from '@mindly/engine';
import { startOfLocalDay } from '@mindly/store';
import { z } from 'zod';
import { pickSession, projectPath, withProject } from '../context.js';
import { resolveId } from '../ids.js';
import { conflictStatusWord } from '../present/index.js';
import { clean, parseDuration, UsageError, type Out } from '../util.js';
import { conflictText, sessionLookup } from '../views/common.js';
import {
  renderConflicts,
  renderStandup,
  renderWhy,
  renderXray,
  renderXrayQuery,
} from '../views/insight.js';
import { renderStatus, type AgentActivity } from '../views/status.js';
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
    const sessionOf = sessionLookup(store);
    const liveIds = new Set(sessions.map((x) => x.id));
    const since = Date.now() - LIVE_WINDOW_MS;
    const agents: AgentActivity[] = sessions.map((session) => {
      const mine = intents.filter((i) => i.sessionId === session.id);
      const last = store.fileChanges.forSession(session.id, since)[0];
      const task = session.currentTaskId
        ? (tasks.find((t) => t.id === session.currentTaskId) ?? null)
        : null;
      return {
        session,
        editing: [...new Set(mine.flatMap((i) => i.targets.files))],
        plans: mine.filter((i) => i.targets.files.length === 0).map((i) => i.summary),
        lastEdit: last ? { path: last.path, at: last.createdAt } : null,
        task,
      };
    });
    const pendingHandoffs = store.handoffs.list(pid, 200).filter((h) => h.status === 'pending');
    renderStatus(out.screen(), {
      projectName: project.project.name,
      agents,
      conflicts,
      proposed,
      handoffs: pendingHandoffs,
      tasks: tasks.filter((t) => !agents.some((a) => a.task?.id === t.id)),
      otherIntents: intents.filter((i) => !liveIds.has(i.sessionId)),
      config: project.configError
        ? 'invalid'
        : project.configHash === null
          ? 'none'
          : project.trusted
            ? 'trusted'
            : 'untrusted',
      sessionOf,
      savesToday: store.saves.countConfirmed(pid, startOfLocalDay(mindly.kernel.clock.now())),
    });
    return 0;
  });
}

/** Parses `path/to/file.ts:42`. */
export function parseFileLine(spec: string): { file: string; line: number } {
  const m = /^(.+):(\d{1,9})$/.exec(spec.trim());
  if (!m) throw new UsageError('give a file and a line number, for example src/auth.ts:42');
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
    renderWhy(out.screen(), r);
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
    if (o.query !== undefined) {
      const r = svc.explainMissing(session.id, o.query);
      if (o.json) {
        out.json(r);
        return 0;
      }
      renderXrayQuery(out.screen(), session, r);
      return 0;
    }
    const r = svc.session(session.id, o.limit ?? 5);
    if (o.json) {
      out.json(r);
      return 0;
    }
    renderXray(out.screen(), session, r);
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
    else
      renderStandup(
        out.screen(),
        digest,
        savesOf(mindly).summary(project.project.id, digest.since),
      );
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
    renderConflicts(out.screen(), list, sessionLookup(mindly.store), o.all === true);
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
    throw new UsageError(
      `"${clean(action, 20)}" is not something you can do to a conflict; use resolve (it is fixed), dismiss (not a real problem) or ack (seen, still open)`,
    );
  }
  return withProject(out.io, ({ mindly, project }) => {
    const store = mindly.store;
    const cid = resolveId(store, 'conflict', project.project.id, id);
    const before = store.conflicts.get(cid);
    const c = store.conflicts.setStatus(cid, target);
    store.events.append({
      projectId: c.projectId,
      sessionId: null,
      type: 'conflict.updated',
      payload: { conflictId: c.id, kind: c.kind, status: target, by: 'user' },
    });
    const sc = out.screen();
    const what = conflictText(c, sessionLookup(store));
    const word = conflictStatusWord(c.status);
    sc.text(
      before.status === c.status
        ? `Conflict ${shortId(c.id)} was already ${word}: ${what}`
        : `${sc.mark('ok')} Conflict ${shortId(c.id)} marked ${word}: ${what}`,
    );
    return 0;
  });
}
