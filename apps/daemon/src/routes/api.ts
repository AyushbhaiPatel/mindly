import {
  conflictNeedsUser,
  MINDLY_VERSION,
  describeError,
  type Memory,
  type Project,
  type Trust,
} from '@mindly/core';
import {
  LIVE_WINDOW_MS,
  USER,
  provenanceOf,
  renderSavesCard,
  savesOf,
  snapshotService,
  splitOf,
  standupService,
  type Mindly,
} from '@mindly/engine';
import { captureWorktreeCommit, runGit } from '@mindly/git';
import { parseNumstat } from '@mindly/runners';
import type { MemoryPatch } from '@mindly/store';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clearedSessionCookie, readCookie, SESSION_COOKIE, sessionCookie } from '../auth.js';
import type { AuthState } from '../auth.js';
import { ApiError, parse, sendError } from '../http/errors.js';
import { authGuard, publicGuard, type Listener } from '../http/security.js';
import type { JobContext } from '../jobs/context.js';
import { createShadowMergeRun, executeShadowMerge } from '../jobs/shadow-merge.js';
import { queueRun } from '../jobs/runs.js';
import type { LiveFeed } from '../live.js';
import {
  ConflictStatusBody,
  ConflictsQuery,
  DeliveriesQuery,
  EventsQuery,
  ExchangeBody,
  IdParams,
  LimitQuery,
  MemoriesQuery,
  MemoryPatchBody,
  NewMemoryBody,
  ProjectParams,
  ProvenanceQuery,
  ReplayBody,
  RestoreBody,
  ReviewBody,
  RunsQuery,
  SavesCardQuery,
  SavesQuery,
  SnapshotBody,
  SplitsQuery,
  StandupQuery,
  TasksQuery,
  TrustBody,
  XrayQuery,
} from './schemas.js';

/** What the API routes need. */
export interface ApiDeps {
  mindly: Mindly;
  auth: AuthState;
  listener: Listener;
  jobs: JobContext;
  live: LiveFeed;
}

const MAX_DIFF_FILES = 500;

/** Registers every `/api` route (see docs/api.md). */
export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { mindly, auth } = deps;
  const store = mindly.store;

  // ---- public ----------------------------------------------------------------------------
  await app.register(async (pub) => {
    pub.addHook('onRequest', publicGuard());

    pub.get('/api/health', async () => ({ ok: true, version: MINDLY_VERSION }));

    pub.post('/api/auth/exchange', async (req, reply) => {
      const { code } = parse(ExchangeBody, req.body ?? {});
      const session = auth.exchange(code);
      if (!session) return sendError(reply, 'unauthenticated', 'Login code is invalid or expired.');
      reply.header('Set-Cookie', sessionCookie(session.sessionId));
      return { ok: true, expiresAt: session.expiresAt };
    });
  });

  // ---- authenticated ---------------------------------------------------------------------
  await app.register(async (api) => {
    api.addHook('onRequest', authGuard(auth, deps.listener));

    const projectOf = (req: FastifyRequest): Project =>
      store.projects.get(parse(ProjectParams, req.params).projectId);
    const idOf = (req: FastifyRequest): string => parse(IdParams, req.params).id;
    const accepted = <T>(reply: FastifyReply, value: T): T => {
      reply.code(202);
      return value;
    };

    api.post('/api/auth/codes', async (req) => {
      if (req.mindlyAuth !== 'bearer') {
        throw new ApiError('forbidden', 'Login codes are issued to the CLI token only.');
      }
      return auth.issueCode();
    });

    api.post('/api/auth/logout', async (req, reply) => {
      auth.revoke(readCookie(req.headers.cookie, SESSION_COOKIE));
      reply.header('Set-Cookie', clearedSessionCookie());
      return reply.code(204).send();
    });

    api.get('/api/live', { websocket: true }, (socket) => {
      deps.live.accept(socket);
    });

    // ---- projects ------------------------------------------------------------------------
    api.get('/api/projects', async () => store.projects.list());

    api.get('/api/projects/:projectId/overview', async (req) => {
      const project = projectOf(req);
      const pid = project.id;
      const conflicts = store.conflicts.list(pid);
      const proposed = store.memories.list(pid, { trust: ['proposed'], limit: 1000 });
      const memoryCounts: Record<Trust, number> = store.memories.count(pid);
      const activeSplit = store.splits.active(pid);
      const blockedParts = activeSplit
        ? store.splits
            .parts(activeSplit.id)
            .filter((p) => store.tasks.get(p.taskId).status === 'blocked')
            .map((p) => ({ key: p.key, title: p.title }))
        : [];
      const splitCheck = activeSplit ? splitOf(mindly).latestMergeCheck(activeSplit) : null;
      const splitCheckFailed =
        splitCheck !== null && (splitCheck.status === 'failed' || splitCheck.status === 'error');
      return {
        project,
        sessions: store.sessions.listLive(pid, LIVE_WINDOW_MS).filter((s) => s.status !== 'ended'),
        tasks: store.tasks.list(pid, { statuses: ['open', 'in_progress', 'blocked'] }),
        intents: store.intents.active(pid),
        conflicts,
        memoryCounts,
        pendingDeliveries: store.deliveries.list(pid, { statuses: ['pending'], limit: 500 }).length,
        lastShadowMerge: store.runs.latest(pid, 'shadow_merge'),
        needsYou: {
          proposedRules: proposed.filter((m) => m.kind === 'rule').length,
          proposedMemories: proposed.filter((m) => m.kind !== 'rule').length,
          criticalConflicts: conflicts.filter((c) => c.severity === 'critical').length,
          openConflicts: conflicts.filter((c) => conflictNeedsUser(c)).length,
          pendingHandoffs: store.handoffs
            .list(pid, 200)
            .filter((h) => h.status === 'pending' && !h.packet.split).length,
          blockedParts: blockedParts.length,
          failedMergeChecks: splitCheckFailed ? 1 : 0,
        },
        split: activeSplit
          ? {
              id: activeSplit.id,
              goal: activeSplit.goal,
              blockedParts,
              mergeCheck: splitCheck
                ? {
                    runId: splitCheck.id,
                    status: splitCheck.status,
                    conflictedPaths: Array.isArray(splitCheck.result?.['conflictedPaths'])
                      ? (splitCheck.result['conflictedPaths'] as string[]).slice(0, 20)
                      : [],
                  }
                : null,
            }
          : null,
        lastSeq: store.events.maxSeq(),
      };
    });

    api.get('/api/projects/:projectId/sessions', async (req) => {
      const { limit } = parse(LimitQuery, req.query);
      return store.sessions.list(projectOf(req).id, limit);
    });

    api.get('/api/projects/:projectId/events', async (req) => {
      const q = parse(EventsQuery, req.query);
      return store.events.query(projectOf(req).id, {
        ...(q.afterSeq !== undefined ? { afterSeq: q.afterSeq } : {}),
        ...(q.beforeSeq !== undefined ? { beforeSeq: q.beforeSeq } : {}),
        ...(q.types ? { types: q.types } : {}),
        ...(q.sessionId ? { sessionId: q.sessionId } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.order ? { order: q.order } : {}),
      });
    });

    // ---- memories ------------------------------------------------------------------------
    api.get('/api/projects/:projectId/memories', async (req) => {
      const pid = projectOf(req).id;
      const q = parse(MemoriesQuery, req.query);
      const filter = {
        ...(q.kind ? { kinds: [q.kind] } : {}),
        ...(q.trust ? { trust: [q.trust] } : {}),
        ...(q.branch !== undefined ? { branch: q.branch } : {}),
        ...(q.status ? { status: q.status } : {}),
        limit: q.limit ?? 100,
      };
      if (q.q && q.q.trim() !== '') {
        return mindly.memory.search(pid, q.q, filter).map((h) => h.memory);
      }
      return mindly.memory.list(pid, filter);
    });

    api.post('/api/projects/:projectId/memories', async (req, reply) => {
      const project = projectOf(req);
      const b = parse(NewMemoryBody, req.body ?? {});
      const memory = mindly.memory.remember({
        projectId: project.id,
        projectRoot: project.root,
        kind: b.kind,
        title: b.title,
        body: b.body,
        source: USER,
        reason: 'created in Mission Control',
        ...(b.tags ? { tags: b.tags } : {}),
        ...(b.scopePaths ? { scopePaths: b.scopePaths } : {}),
        ...(b.enforce !== undefined ? { enforce: b.enforce } : {}),
        ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
      });
      reply.code(201);
      return memory;
    });

    api.get('/api/memories/:id', async (req) => {
      const memory = store.memories.get(idOf(req));
      return {
        memory,
        versions: store.memories.versions(memory.id),
        evidence: store.memories.evidenceFor(memory.id),
        contracts: store.contracts.forMemory(memory.id),
        xray: store.contextPackets.mentioning(memory.projectId, memory.id, 20),
      };
    });

    api.patch('/api/memories/:id', async (req) => {
      const id = idOf(req);
      const b = parse(MemoryPatchBody, req.body ?? {});
      store.memories.get(id);
      const patch: MemoryPatch = {
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.body !== undefined ? { body: b.body } : {}),
        ...(b.tags !== undefined ? { tags: b.tags } : {}),
        ...(b.scopePaths !== undefined ? { scope: { paths: b.scopePaths } } : {}),
        ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
        ...(b.enforce !== undefined ? { enforce: b.enforce } : {}),
      };
      return mindly.memory.update(id, patch, USER, 'edited in Mission Control');
    });

    const memoryAction = (action: (id: string) => Memory) => async (req: FastifyRequest) => {
      const id = idOf(req);
      store.memories.get(id);
      return action(id);
    };
    api.post(
      '/api/memories/:id/approve',
      memoryAction((id) => mindly.memory.approve(id)),
    );
    api.post(
      '/api/memories/:id/reject',
      memoryAction((id) => mindly.memory.reject(id)),
    );
    api.post(
      '/api/memories/:id/archive',
      memoryAction((id) => mindly.memory.archive(id, USER)),
    );

    api.delete('/api/memories/:id', async (req, reply) => {
      mindly.memory.forget(idOf(req));
      return reply.code(204).send();
    });

    // ---- coordination --------------------------------------------------------------------
    api.get('/api/projects/:projectId/conflicts', async (req) => {
      const { status } = parse(ConflictsQuery, req.query);
      return store.conflicts.list(projectOf(req).id, status ? { statuses: [status] } : {});
    });

    api.post('/api/conflicts/:id/status', async (req) => {
      const id = idOf(req);
      const { status } = parse(ConflictStatusBody, req.body ?? {});
      store.conflicts.get(id);
      const conflict = store.conflicts.setStatus(id, status);
      store.events.append({
        projectId: conflict.projectId,
        sessionId: null,
        type: 'conflict.updated',
        payload: { conflictId: conflict.id, kind: conflict.kind, status, by: 'user' },
      });
      return conflict;
    });

    api.get('/api/projects/:projectId/tasks', async (req) => {
      const { status } = parse(TasksQuery, req.query);
      return store.tasks.list(projectOf(req).id, status ? { statuses: [status] } : {});
    });

    api.get('/api/projects/:projectId/intents', async (req) =>
      store.intents.active(projectOf(req).id),
    );

    api.get('/api/projects/:projectId/deliveries', async (req) => {
      const { status } = parse(DeliveriesQuery, req.query);
      return store.deliveries.list(projectOf(req).id, status ? { statuses: [status] } : {});
    });

    api.get('/api/projects/:projectId/handoffs', async (req) =>
      store.handoffs.list(projectOf(req).id),
    );

    // ---- splits --------------------------------------------------------------------------
    api.get('/api/projects/:projectId/splits', async (req) => {
      const { status, limit } = parse(SplitsQuery, req.query);
      return store.splits.list(projectOf(req).id, {
        ...(status ? { statuses: [status] } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    });

    api.get('/api/splits/:id', async (req) => {
      const { id } = parse(IdParams, req.params);
      return splitOf(mindly).status(id);
    });

    // ---- runs ----------------------------------------------------------------------------
    api.get('/api/projects/:projectId/runs', async (req) => {
      const q = parse(RunsQuery, req.query);
      return store.runs.list(projectOf(req).id, {
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
    });

    api.post('/api/projects/:projectId/shadow-merge', async (req, reply) => {
      const pid = projectOf(req).id;
      const run = createShadowMergeRun(deps.jobs, pid, 'user');
      void deps.jobs.scheduler.enqueue(`shadow:${pid}`, async () => {
        await executeShadowMerge(deps.jobs, store.runs.get(run.id));
      });
      return accepted(reply, run);
    });

    api.post('/api/projects/:projectId/review', async (req, reply) => {
      const pid = projectOf(req).id;
      const b = parse(ReviewBody, req.body ?? {});
      const session = store.sessions.find(b.sessionId);
      if (!session || session.projectId !== pid)
        throw new ApiError('not_found', 'session not found');
      if (session.agentKind === b.reviewer) {
        throw new ApiError('invalid_input', 'the reviewer must be a different agent');
      }
      const run = store.runs.create({
        projectId: pid,
        kind: 'review',
        title: `Review of ${session.agentKind} by ${b.reviewer}`,
        input: { sessionId: session.id, reviewer: b.reviewer },
      });
      queueRun(deps.jobs, run);
      return accepted(reply, run);
    });

    api.post('/api/projects/:projectId/replay', async (req, reply) => {
      const pid = projectOf(req).id;
      const b = parse(ReplayBody, req.body ?? {});
      const run = store.runs.create({
        projectId: pid,
        kind: 'replay',
        title: `Replay with ${b.agents.join(', ')}`,
        input: { prompt: b.prompt, baseCommit: b.baseCommit ?? 'HEAD', agents: b.agents },
      });
      queueRun(deps.jobs, run);
      return accepted(reply, run);
    });

    // ---- insight -------------------------------------------------------------------------
    api.get('/api/sessions/:id/xray', async (req) => {
      const session = store.sessions.get(idOf(req));
      const { limit } = parse(XrayQuery, req.query);
      return store.contextPackets.forSession(session.id, limit ?? 10);
    });

    api.get('/api/projects/:projectId/provenance', async (req) => {
      const project = projectOf(req);
      const q = parse(ProvenanceQuery, req.query);
      const r = provenanceOf(mindly).why(project.id, project.root, q.file, q.line);
      const latest = r.changes[0];
      const memories = r.memories
        .map((m) => store.memories.find(m.id))
        .filter((m): m is Memory => m !== null);
      return {
        file: r.path,
        line: r.line,
        text: r.text,
        found: r.changes.length > 0,
        sessionId: latest?.sessionId ?? null,
        agentKind: latest?.agentKind ?? null,
        createdAt: latest?.at ?? null,
        tool: latest?.tool ?? null,
        promptSummary: latest?.prompt ?? null,
        memories,
        changes: r.changes,
      };
    });

    api.get('/api/projects/:projectId/standup', async (req) => {
      const pid = projectOf(req).id;
      const { since } = parse(StandupQuery, req.query);
      const svc = standupService(mindly);
      const digest = svc.build(pid, since);
      return { digest, markdown: svc.render(digest) };
    });

    // ---- saves (read and reject only; nothing here creates or confirms a save) -----------
    const WEEK_MS = 7 * 86_400_000;
    api.get('/api/projects/:projectId/saves', async (req) => {
      const pid = projectOf(req).id;
      const q = parse(SavesQuery, req.query);
      const since = q.since ?? mindly.kernel.clock.now() - WEEK_MS;
      const svc = savesOf(mindly);
      const { total, byKind, byAgent } = svc.summary(pid, since);
      const saves = svc.list(pid, {
        since,
        limit: 500,
        ...(q.status === 'all'
          ? {}
          : { statuses: q.status ? [q.status] : (['confirmed', 'caught'] as const) }),
      });
      return { since, summary: { total, byKind, byAgent }, saves };
    });

    api.post('/api/saves/:id/reject', async (req) => {
      const id = idOf(req);
      store.saves.get(id);
      return savesOf(mindly).rejectByUser(id);
    });

    api.get('/api/projects/:projectId/saves/card.svg', async (req, reply) => {
      const project = projectOf(req);
      const q = parse(SavesCardQuery, req.query);
      const now = mindly.kernel.clock.now();
      const summary = savesOf(mindly).summary(project.id, q.since ?? now - WEEK_MS);
      const svg = renderSavesCard({
        summary,
        until: now,
        ...(q.details === '1'
          ? {
              details: {
                projectName: project.name,
                saves: summary.recent.map((s) => ({ title: s.title, paths: s.paths })),
              },
            }
          : {}),
      });
      reply.type('image/svg+xml; charset=utf-8');
      return svg;
    });

    api.get('/api/projects/:projectId/snapshots', async (req) =>
      snapshotService(mindly).list(projectOf(req).id),
    );

    api.post('/api/projects/:projectId/snapshots', async (req, reply) => {
      const pid = projectOf(req).id;
      const { label } = parse(SnapshotBody, req.body ?? {});
      const snap = await snapshotService(mindly).create(pid, label);
      reply.code(201);
      return snap;
    });

    api.get('/api/snapshots/:id/diff', async (req) => {
      const d = snapshotService(mindly).diff(idOf(req));
      const files = d.snapshot.commit
        ? await filesSince(mindly, d.snapshot.projectId, d.snapshot.commit, deps)
        : undefined;
      return {
        snapshot: d.snapshot,
        memories: {
          added: d.memories.added.length,
          changed: d.memories.updated.length,
          removed: d.memories.archived.length,
        },
        tasks: { added: d.tasks.added.length, changed: d.tasks.changed.length, removed: 0 },
        conflicts: { opened: d.conflicts.opened.length, closed: d.conflicts.closed.length },
        ...(files ? { files } : {}),
        details: { memories: d.memories, tasks: d.tasks, conflicts: d.conflicts },
      };
    });

    api.post('/api/snapshots/:id/restore', async (req) => {
      const id = idOf(req);
      const { branch } = parse(RestoreBody, req.body ?? {});
      return snapshotService(mindly).restore(id, branch ? { branch } : {});
    });

    // ---- trust ---------------------------------------------------------------------------
    const trustStatus = (projectId: string) => {
      const ctx = mindly.projects.byId(projectId);
      return {
        trusted: ctx.trusted,
        configHash: ctx.configHash,
        configError: ctx.configError,
        checks: ctx.config.checks.map((c) => ({ name: c.name, argv: c.argv })),
      };
    };
    api.get('/api/projects/:projectId/trust', async (req) => trustStatus(projectOf(req).id));
    api.post('/api/projects/:projectId/trust', async (req) => {
      const pid = projectOf(req).id;
      const { configHash } = parse(TrustBody, req.body ?? {});
      // Only the exact config the user reviewed may be trusted; the engine refuses a changed file
      // with a `conflict` error (409).
      mindly.projects.trust(pid, configHash.toLowerCase());
      return trustStatus(pid);
    });
  });
}

/**
 * Files that changed between a snapshot commit and the project's current working tree (captured
 * without touching it). Fail-soft: returns undefined when git cannot answer.
 */
async function filesSince(
  mindly: Mindly,
  projectId: string,
  commit: string,
  deps: ApiDeps,
): Promise<{ path: string; status: string; added?: number; removed?: number }[] | undefined> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return undefined;
  try {
    const project = mindly.projects.byId(projectId);
    const deny = [...mindly.config.redaction.denyPaths, ...project.config.ignore];
    const now = await captureWorktreeCommit(project.root, { extraDeny: deny });
    const res = await runGit(
      ['diff', '--numstat', '-z', '--no-renames', commit, now.commit, '--'],
      {
        cwd: project.root,
        timeoutMs: 30_000,
      },
    );
    return parseNumstat(res.stdout)
      .slice(0, MAX_DIFF_FILES)
      .map((f) => ({
        path: f.path,
        status: 'changed',
        ...(f.added !== null ? { added: f.added } : {}),
        ...(f.deleted !== null ? { removed: f.deleted } : {}),
      }));
  } catch (err) {
    deps.jobs.logger.warn('snapshot file diff failed', { error: describeError(err) });
    return undefined;
  }
}
