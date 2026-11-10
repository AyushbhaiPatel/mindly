import { z } from 'zod';
import {
  AgentKindSchema,
  invalidInput,
  isUuid,
  notFound,
  sanitizeLine,
  MEMORY_KINDS,
  MindlyError,
  TASK_STATUSES,
  type Delivery,
  type Handoff,
  type Logger,
  type Memory,
  type MemoryKind,
  type Task,
  type Trust,
} from '@mindly/core';
import {
  contractsOf,
  failoverService,
  memoryLine,
  provenanceOf,
  relativeTime,
  renderSections,
  sessionLabel,
  sourceLabel,
  splitOf,
  LIVE_WINDOW_MS,
  type Mindly,
  type Section,
} from '@mindly/engine';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  ok,
  placePath,
  projectPath,
  safeLine,
  safeText,
  toolError,
  type CallScope,
  type GuessScope,
  type RateLimiter,
  type SessionResolver,
} from './support.js';

/** Dependencies shared by every tool handler. */
export interface ToolDeps {
  mindly: Mindly;
  sessions: SessionResolver;
  messages: RateLimiter;
  logger: Logger;
}

// ---------------------------------------------------------------------------------------------
// Input schemas. Every limit here is deliberately tight; the engine applies its own caps too.
// ---------------------------------------------------------------------------------------------

const Id = z.string().max(64).refine(isUuid, 'must be a UUID');
const PathArg = z.string().min(1).max(500);
const ScopeGlobs = z.array(z.string().min(1).max(300)).max(20);
const Tags = z.array(z.string().min(1).max(40)).max(12);
const Evidence = z
  .array(z.strictObject({ path: PathArg, excerpt: z.string().min(1).max(2000).optional() }))
  .max(10);
const ListOfLines = (max: number, chars = 300) => z.array(z.string().min(1).max(chars)).max(max);
const SEARCH_TRUST = ['verified', 'approved', 'proposed', 'stale'] as const;
const AGENT_MEMORY_KINDS = MEMORY_KINDS;
const DECLARATIVE_CONTRACTS = [
  'file_exists',
  'pattern_present',
  'pattern_absent',
  'json_key',
  'export_present',
] as const;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };

// ---------------------------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------------------------

function memoryItem(m: Memory): string {
  return `${memoryLine(m)} (id ${m.id})`;
}

function memorySummary(m: Memory): Record<string, unknown> {
  return {
    id: m.id,
    kind: m.kind,
    title: safeLine(m.title, 160),
    trust: m.trust,
    source: sourceLabel(m),
    scopePaths: m.scope.paths.map((p) => safeLine(p, 300)),
    version: m.version,
    updatedAt: m.updatedAt,
  };
}

function taskLine(mindly: Mindly, t: Task, now: number): string {
  const owner = t.ownerSessionId ? mindly.store.sessions.find(t.ownerSessionId) : null;
  const parts = [`- [${t.status}] ${safeLine(t.title, 200)}`];
  parts.push(owner ? `owner ${safeLine(sessionLabel(owner), 80)}` : 'unowned');
  if (t.blockers.length) {
    parts.push(`blockers: ${t.blockers.map((b) => safeLine(b, 120)).join('; ')}`);
  }
  if (t.plan.length) {
    parts.push(`plan ${t.plan.filter((s) => s.done).length}/${t.plan.length} done`);
  }
  parts.push(`updated ${relativeTime(t.updatedAt, now)}`, `id ${t.id}`);
  return parts.join(' \u00b7 ');
}

function taskSummary(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    title: safeLine(t.title, 200),
    status: t.status,
    ownerSessionId: t.ownerSessionId,
    plan: t.plan.map((s) => ({ text: safeLine(s.text, 300), done: s.done })),
    blockers: t.blockers.map((b) => safeLine(b, 300)),
    updatedAt: t.updatedAt,
  };
}

function deliveryLine(mindly: Mindly, d: Delivery, now: number): string {
  const from = d.sourceSessionId ? mindly.store.sessions.find(d.sourceSessionId) : null;
  const who = from ? safeLine(sessionLabel(from), 80) : 'Mindly';
  const body = d.body ? ` \u2014 ${safeText(d.body, 600).replace(/\n/g, ' ')}` : '';
  return `- [${d.kind} \u00b7 from ${who} \u00b7 ${relativeTime(d.createdAt, now)}] ${safeLine(d.title, 200)}${body} (id ${d.id}, ${d.status})`;
}

/** Renders sections as a delimited, labelled Mindly reference block, or `empty` if none. */
function block(sections: Section[], empty: string, intro?: string): string {
  return renderSections(sections, intro) ?? empty;
}

function ensureProject(scope: CallScope, projectId: string, what: string, id: string): void {
  if (projectId !== scope.project.project.id) throw notFound(what, id);
}

/**
 * Takes `taskId` up for the server while it speaks for a session it only guessed at: the task
 * becomes the session's (where the server's work lives until it is home) and the server's own
 * current task. The session's current task is the other window's and is never written.
 */
function takeUpOnGuess(mindly: Mindly, scope: CallScope, taskId: string): Task {
  const guess = scope.guess as GuessScope;
  const task = mindly.store.tasks.update(taskId, {
    ownerSessionId: guess.sessionId,
    status: 'in_progress',
  });
  mindly.store.events.append({
    projectId: task.projectId,
    sessionId: guess.sessionId,
    type: 'task.updated',
    payload: { taskId: task.id, status: task.status, claimedBy: guess.sessionId },
  });
  guess.note('task', task.id);
  guess.noteCurrentTask(task.id);
  return task;
}

/**
 * True when `task` is the server's own while it speaks for a session it only guessed at: it took
 * the task up itself, the task is still with that session (where its work lives until it is
 * home), nobody else changed it since, and no other live session has made it its current task.
 */
function ownOnGuess(guess: GuessScope, task: Task): boolean {
  return task.ownerSessionId === guess.sessionId && guess.owns(task.id);
}

/** Why a task the server wrote on a guess is no longer its own. */
const TAKEN_SINCE =
  'Another session has taken it up or changed it since this server wrote it, and this server ' +
  "cannot tell its own session from that window's";

/** Tools whose result names a memory they stored. */
const MEMORY_TOOLS = new Set(['mindly_remember', 'mindly_record_mistake']);

/** Why the inbox is empty while the server cannot tell its session from another window's. */
const GUESS_INBOX =
  'This server cannot tell yet whether the session it speaks for is its own or another ' +
  "window's, so messages for that session are left for it. They are shown once the server " +
  'knows its own session.';

/**
 * A title must still say something once it is cleaned for storage: the schema's minimum length
 * counts spaces and invisible characters, which are removed afterwards.
 */
function requireTitle(title: string): void {
  if (sanitizeLine(title, 200) === '') throw invalidInput('title: must not be empty');
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

/** The scope of a call on a session the server cannot tell from another window's. */
type GuessCallScope = CallScope & { guess: GuessScope };

/**
 * What a tool does while the server speaks for a session it cannot tell from another window's (a
 * guess that is not the one window there is). Every tool says, so that none can forget:
 *
 * - `'shared'`: the tool reads and changes nothing that is the calling session's own, or only
 *   rows that the guess records and takes along to the server's own session once it is known
 *   (see `GuessScope.note`);
 * - a handler: what the tool does instead. It must leave that window's own state alone: its
 *   inbox and messages, the handoffs waiting for it, the tasks it owns and its current task.
 */
type OnGuess<S extends z.ZodObject> =
  | 'shared'
  | ((args: z.infer<S>, scope: GuessCallScope) => Promise<CallToolResult> | CallToolResult);

/** Registers every `mindly_*` tool on `server`. */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { mindly, sessions, messages, logger } = deps;
  const now = (): number => mindly.kernel.clock.now();

  function tool<S extends z.ZodObject>(
    name: string,
    config: {
      title: string;
      description: string;
      input: S;
      annotations: ToolAnnotations;
      onGuess: OnGuess<S>;
    },
    handler: (args: z.infer<S>, scope: CallScope) => Promise<CallToolResult> | CallToolResult,
  ): void {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: { title: config.title, ...config.annotations },
      },
      (async (raw: unknown) => {
        try {
          // The SDK validates too; parsing again keeps the handler independent of that.
          const parsed = config.input.safeParse(raw ?? {});
          if (!parsed.success) {
            throw invalidInput(
              parsed.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
                .join('; '),
            );
          }
          const scope = await sessions.resolve();
          // Acting as the one window there is, a current task the call sets (a claim, a handoff
          // it picks up) is the server's own doing.
          const currentOf = () =>
            scope.ownWrite ? mindly.store.sessions.find(scope.session.id)?.currentTaskId : null;
          const before = currentOf();
          // The one gate between a call and the state of a window this server may not be: on a
          // guess, a tool runs its guest handler unless it touches nothing of the session's own.
          const result =
            scope.guess && config.onGuess !== 'shared'
              ? await config.onGuess(parsed.data, scope as GuessCallScope)
              : await handler(parsed.data, scope);
          const after = currentOf();
          if (after && after !== before) scope.ownWrite?.(after);
          // A memory stored on a guess is named in the server's handoffs (its source is the
          // guessed session, so it cannot be found by session).
          const stored = (result.structuredContent as { memory?: { id?: unknown } } | undefined)
            ?.memory?.id;
          if (
            scope.guess &&
            MEMORY_TOOLS.has(name) &&
            typeof stored === 'string' &&
            !result.isError
          ) {
            scope.guess.note('memory', stored);
          }
          return result;
        } catch (err) {
          return toolError(err, name, logger);
        }
      }) as never,
    );
  }

  // ----------------------------------------------------------------- context

  tool(
    'mindly_context',
    {
      title: 'Mindly context',
      description:
        'Current Mindly context for this agent: project rules, other live agents, open conflicts, ' +
        'key decisions, pitfalls and pending messages. Reading it has effects: the messages shown ' +
        'are marked delivered, and a handoff waiting for you is picked up (its task becomes ' +
        'yours), so each is shown once. With `query`, returns memory relevant to that text plus ' +
        'pending messages.',
      input: z.strictObject({ query: z.string().min(1).max(2000).optional() }),
      // Not read-only and not idempotent: a client must not pre-fetch or repeat this call.
      annotations: WRITE,
      // What is waiting for the session (a handoff, messages) is left for that window, nothing
      // is recorded against it, and only the tasks the server took up itself are its own.
      onGuess: (args, scope) => contextOf(args.query, scope, scope.guess),
    },
    (args, scope) => contextOf(args.query, scope, null),
  );

  function contextOf(
    query: string | undefined,
    scope: CallScope,
    guest: GuessScope | null,
  ): CallToolResult {
    const { project, session } = scope;
    const build = () =>
      query
        ? mindly.context.prompt(project, session, query)
        : mindly.context.sessionStart(project, session);
    const built = guest
      ? mindly.context.asGuest(session, build, { ownsTask: (id) => guest.owns(id) })
      : build();
    return ok(built.text ?? 'No Mindly context for this project right now.', {
      packetId: built.packet?.id ?? null,
      deliveries: built.deliveries.map((d) => d.id),
      sessionId: session.id,
    });
  }

  tool(
    'mindly_search_memory',
    {
      title: 'Search Mindly memory',
      description:
        'Full-text search over project memory (facts, decisions, rules, mistakes, notes), ' +
        'optionally filtered by kind and trust. Results carry trust and source labels.',
      input: z.strictObject({
        query: z.string().min(1).max(500),
        kinds: z.array(z.enum(MEMORY_KINDS)).min(1).max(5).optional(),
        trust: z.array(z.enum(SEARCH_TRUST)).min(1).max(4).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: READ_ONLY,
      onGuess: 'shared',
    },
    (args, { project }) => {
      const hits = mindly.memory.search(project.project.id, args.query, {
        ...(args.kinds ? { kinds: args.kinds } : {}),
        ...(args.trust ? { trust: args.trust as Trust[] } : {}),
        limit: args.limit ?? 10,
      });
      const items = hits.map((h) => h.memory);
      return ok(
        block(
          [{ heading: 'Matching project memory', lines: items.map(memoryItem) }],
          'No matching memory.',
        ),
        { results: items.map(memorySummary) },
      );
    },
  );

  // ----------------------------------------------------------------- memory writes

  tool(
    'mindly_remember',
    {
      title: 'Remember',
      description:
        'Store a fact, decision, note, mistake or rule for every agent on this project. Agent ' +
        'memories are always stored as "proposed" until the user approves them. Optional file ' +
        'evidence ({ path, excerpt }) must exist in the project; scope globs limit where it applies.',
      input: z.strictObject({
        kind: z.enum(AGENT_MEMORY_KINDS),
        title: z.string().min(1).max(160),
        body: z.string().max(4000).optional(),
        tags: Tags.optional(),
        scopePaths: ScopeGlobs.optional(),
        evidence: Evidence.optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
      // Project memory; on a guess it is noted and named in the server's handoffs.
      onGuess: 'shared',
    },
    (args, { project, session }) => {
      const evidence = (args.evidence ?? []).map((e) => ({
        path: projectPath(mindly, project, e.path),
        ...(e.excerpt !== undefined ? { excerpt: e.excerpt } : {}),
      }));
      const m = mindly.memory.remember({
        projectId: project.project.id,
        projectRoot: project.root,
        kind: args.kind as MemoryKind,
        title: args.title,
        body: args.body ?? '',
        ...(args.tags ? { tags: args.tags } : {}),
        ...(args.scopePaths ? { scopePaths: args.scopePaths } : {}),
        ...(evidence.length ? { evidence } : {}),
        source: { type: 'agent', sessionId: session.id, agentKind: session.agentKind },
        reason: 'remembered via MCP',
      });
      return ok(
        block(
          [{ heading: 'Stored memory', lines: [memoryItem(m)] }],
          'Stored.',
          m.trust === 'proposed' ? 'Stored as proposed; the user can approve it.' : undefined,
        ),
        { memory: memorySummary(m) },
      );
    },
  );

  tool(
    'mindly_update_memory',
    {
      title: 'Update memory',
      description:
        'Refine one of your own proposed memories (title, body, tags, scope) or archive it. ' +
        'User memories and memories of other agents cannot be changed.',
      input: z.strictObject({
        id: Id,
        title: z.string().min(1).max(160).optional(),
        body: z.string().max(4000).optional(),
        tags: Tags.optional(),
        scopePaths: ScopeGlobs.optional(),
        archive: z.boolean().optional(),
        reason: z.string().max(300).optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
      // Allowed by agent kind and trust, not by session.
      onGuess: 'shared',
    },
    (args, scope) => {
      const { session } = scope;
      const cur = mindly.store.memories.find(args.id);
      if (!cur) throw notFound('memory', args.id);
      ensureProject(scope, cur.projectId, 'memory', args.id);
      if (
        cur.source.type !== 'agent' ||
        cur.source.agentKind !== session.agentKind ||
        cur.trust !== 'proposed'
      ) {
        throw new MindlyError('forbidden', 'agents may only refine their own proposed memories');
      }
      const m = mindly.memory.update(
        args.id,
        {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.body !== undefined ? { body: args.body } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.scopePaths !== undefined ? { scope: { paths: args.scopePaths } } : {}),
          ...(args.archive ? { status: 'archived' as const } : {}),
        },
        { type: 'agent', sessionId: session.id, agentKind: session.agentKind },
        args.reason ? safeLine(args.reason, 300) : 'refined via MCP',
      );
      return ok(
        block(
          [
            {
              heading: m.status === 'archived' ? 'Archived memory' : 'Updated memory',
              lines: [memoryItem(m)],
            },
          ],
          'Updated.',
        ),
        { memory: { ...memorySummary(m), status: m.status } },
      );
    },
  );

  tool(
    'mindly_record_mistake',
    {
      title: 'Record mistake',
      description:
        'Record an approach that failed and what to do instead, so other agents avoid it. ' +
        'Optional `files` scope globs surface it before edits to matching files.',
      input: z.strictObject({
        what: z.string().min(1).max(160),
        instead: z.string().min(1).max(2000),
        details: z.string().max(1500).optional(),
        files: ScopeGlobs.optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
      // Project memory; on a guess it is noted and named in the server's handoffs.
      onGuess: 'shared',
    },
    (args, { project, session }) => {
      const body = [`What failed: ${args.what}`, `Do instead: ${args.instead}`];
      if (args.details) body.push(`Details: ${args.details}`);
      const m = mindly.memory.remember({
        projectId: project.project.id,
        projectRoot: project.root,
        kind: 'mistake',
        title: args.what,
        body: body.join('\n'),
        tags: ['mistake'],
        ...(args.files ? { scopePaths: args.files } : {}),
        source: { type: 'agent', sessionId: session.id, agentKind: session.agentKind },
        reason: 'mistake recorded via MCP',
      });
      return ok(block([{ heading: 'Recorded pitfall', lines: [memoryItem(m)] }], 'Recorded.'), {
        memory: memorySummary(m),
      });
    },
  );

  tool(
    'mindly_add_contract',
    {
      title: 'Add contract',
      description:
        'Bind a memory to a declarative check over the repository (file_exists, pattern_present, ' +
        'pattern_absent, json_key, export_present). It is re-evaluated whenever the file changes. ' +
        'Command contracts can only be created by the user.',
      input: z.strictObject({
        memoryId: Id,
        kind: z.enum(DECLARATIVE_CONTRACTS),
        path: PathArg,
        pattern: z.string().min(1).max(300).optional(),
        key: z.string().min(1).max(200).optional(),
        symbol: z.string().min(1).max(120).optional(),
      }),
      annotations: WRITE,
      // A check on project memory; the session only names who added it.
      onGuess: 'shared',
    },
    (args, scope) => {
      if ((args.kind as string) === 'command') {
        throw new MindlyError('forbidden', 'only the user can create command contracts');
      }
      const memory = mindly.store.memories.find(args.memoryId);
      if (!memory) throw notFound('memory', args.memoryId);
      ensureProject(scope, memory.projectId, 'memory', args.memoryId);
      const path = projectPath(mindly, scope.project, args.path);
      const spec: Record<string, string> = { path };
      if (args.kind === 'pattern_present' || args.kind === 'pattern_absent') {
        if (!args.pattern) throw invalidInput('pattern is required for pattern contracts');
        spec['pattern'] = args.pattern;
      } else if (args.kind === 'json_key') {
        if (!args.key) throw invalidInput('key is required for json_key contracts');
        spec['key'] = args.key;
      } else if (args.kind === 'export_present') {
        if (!args.symbol) throw invalidInput('symbol is required for export_present contracts');
        spec['symbol'] = args.symbol;
      }
      const c = contractsOf(mindly).create(args.memoryId, args.kind, spec, {
        type: 'agent',
        sessionId: scope.session.id,
        agentKind: scope.session.agentKind,
      });
      const message = c.lastMessage ? safeLine(c.lastMessage, 200) : '';
      // Contracts are checked against the main checkout, also when this agent works in a linked
      // worktree: say so, or "does not exist" for a file the agent just made reads as a bug.
      const elsewhere =
        scope.project.root === scope.project.mainRoot
          ? ''
          : ' It is checked against the main checkout, not this worktree, so it reflects your changes once they are merged.';
      return ok(
        `Contract ${c.id} (${c.kind} on ${safeLine(path, 300)}) is ${c.state}${message ? `: ${message}` : ''}.${elsewhere}`,
        { contract: { id: c.id, kind: c.kind, path, state: c.state, message } },
      );
    },
  );

  // ----------------------------------------------------------------- coordination

  tool(
    'mindly_declare_intent',
    {
      title: 'Declare intent',
      description:
        'Announce what you are about to change (summary, files, symbols). Returns warnings when ' +
        'another live agent is working on the same files.',
      input: z.strictObject({
        summary: z.string().min(1).max(300),
        files: z.array(PathArg).min(1).max(100),
        symbols: z.array(z.string().min(1).max(120)).max(100).optional(),
      }),
      annotations: WRITE,
      // On a guess the intent is noted and goes along with the server once its session is known.
      onGuess: 'shared',
    },
    (args, scope) => {
      const { project, session } = scope;
      const placed = args.files.map((f) => placePath(mindly, project, f));
      const files = [...new Set(placed.map((p) => p.rel))];
      // How a path was read when that is not obvious (two files it could mean, a folder that is
      // not there): the agent can then correct an intent recorded on the wrong file.
      const notes = [...new Set(placed.flatMap((p) => (p.note ? [safeLine(p.note, 400)] : [])))];
      const { intent, overlap } = mindly.intents.declare(
        session,
        args.summary,
        files,
        args.symbols ?? [],
      );
      scope.guess?.note('intent', intent.id);
      const warnings = overlap.warnings.map((w) => safeLine(w, 400));
      const sections: Section[] = [
        { heading: 'Coordination warnings', lines: warnings.map((w) => `- ${w}`) },
        { heading: 'Paths', lines: notes.map((n) => `- ${n}`) },
      ];
      const text =
        warnings.length || notes.length
          ? block(
              sections,
              '',
              `Intent recorded for ${files.length} file(s).${warnings.length ? '' : ' No other agent is working on them.'}`,
            )
          : `Intent recorded for ${files.length} file(s). No other agent is working on them.`;
      return ok(text, {
        intentId: intent.id,
        files,
        warnings,
        notes,
        conflicts: overlap.conflicts.map((c) => c.id),
      });
    },
  );

  tool(
    'mindly_task_create',
    {
      title: 'Create task',
      description:
        'Create a shared task with an optional plan. By default you own it and it starts in progress.',
      input: z.strictObject({
        title: z.string().min(1).max(200),
        description: z.string().max(4000).optional(),
        plan: ListOfLines(50).optional(),
        assignToMe: z.boolean().optional(),
        parentId: Id.optional(),
      }),
      annotations: WRITE,
      // The task is taken up for the server without touching the session's current task.
      onGuess: (args, scope) => createTask(args, scope, true),
    },
    (args, scope) => createTask(args, scope, false),
  );

  function createTask(
    args: {
      title: string;
      description?: string | undefined;
      plan?: string[] | undefined;
      assignToMe?: boolean | undefined;
      parentId?: string | undefined;
    },
    scope: CallScope,
    guest: boolean,
  ): CallToolResult {
    requireTitle(args.title);
    if (args.parentId) {
      const parent = mindly.store.tasks.find(args.parentId);
      if (!parent) throw notFound('task', args.parentId);
      ensureProject(scope, parent.projectId, 'task', args.parentId);
    }
    const mine = args.assignToMe !== false;
    const created = mindly.tasks.create({
      projectId: scope.project.project.id,
      title: args.title,
      ...(args.description !== undefined ? { description: safeText(args.description, 4000) } : {}),
      ...(args.plan ? { plan: args.plan } : {}),
      owner: mine && !guest ? scope.session : null,
      parentId: args.parentId ?? null,
    });
    const t = mine && guest ? takeUpOnGuess(mindly, scope, created.id) : created;
    return ok(`Created task ${t.id}: ${safeLine(t.title, 200)} (${t.status}).`, {
      task: taskSummary(t),
    });
  }

  tool(
    'mindly_task_update',
    {
      title: 'Update task',
      description:
        'Update a task: status, plan (steps with done flags), blockers, title or description.',
      input: z.strictObject({
        id: Id,
        status: z.enum(TASK_STATUSES).optional(),
        plan: z
          .array(z.strictObject({ text: z.string().min(1).max(300), done: z.boolean() }))
          .max(50)
          .optional(),
        blockers: ListOfLines(20).optional(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(4000).optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
      // Tasks are shared work any agent may update; the session only names who did. A task that
      // is still the server's own is noted again, so it still goes along with the server; one it
      // wrote that someone else has taken up since stays where it is.
      onGuess: 'shared',
    },
    (args, scope) => {
      if (args.title !== undefined) requireTitle(args.title);
      const cur = mindly.store.tasks.find(args.id);
      if (!cur) throw notFound('task', args.id);
      ensureProject(scope, cur.projectId, 'task', args.id);
      const guess = scope.guess;
      const own = guess ? ownOnGuess(guess, cur) : false;
      const lost = guess !== undefined && !own && guess.wrote('task', cur.id);
      const t = mindly.tasks.update(
        args.id,
        {
          ...(args.status ? { status: args.status } : {}),
          ...(args.plan ? { plan: args.plan } : {}),
          ...(args.blockers ? { blockers: args.blockers } : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(args.description !== undefined
            ? { description: safeText(args.description, 4000) }
            : {}),
        },
        scope.session,
      );
      // The server's own write: a task it tracks keeps the stamp of it, on a guess or not.
      if (own) guess?.note('task', t.id);
      scope.ownWrite?.(t.id);
      if (lost) {
        guess?.disown(t.id);
        return ok(
          `Updated task ${t.id}: ${safeLine(t.title, 200)} (${t.status}). It is no longer yours and stays where it is: ${TAKEN_SINCE}.`,
          { task: taskSummary(t), own: false },
        );
      }
      return ok(`Updated task ${t.id}: ${safeLine(t.title, 200)} (${t.status}).`, {
        task: taskSummary(t),
      });
    },
  );

  tool(
    'mindly_task_claim',
    {
      title: 'Claim task',
      description:
        'Take ownership of a task; it becomes your current task and moves to in progress.',
      input: z.strictObject({ id: Id }),
      annotations: WRITE_IDEMPOTENT,
      // A task the guessed session already owns is that window's own work, unless the server
      // took it up itself and nobody has taken it up since: claiming it changes nothing there.
      // Anything else is taken up for the server.
      onGuess: (args, scope) => {
        const cur = claimable(args.id, scope);
        const guess = scope.guess;
        if (cur.ownerSessionId === guess.sessionId && !ownOnGuess(guess, cur)) {
          if (guess.wrote('task', cur.id)) {
            // It stays where it is, and no longer goes along with the server.
            guess.disown(cur.id);
            return ok(
              `Not claimed: task ${cur.id} (${safeLine(cur.title, 200)}) is no longer yours. ${TAKEN_SINCE}, so nothing was changed and the task stays where it is. Create a new task for your work instead.`,
              { claimed: false, task: taskSummary(cur) },
            );
          }
          return ok(
            `Not claimed: task ${cur.id} (${safeLine(cur.title, 200)}) belongs to a session this server cannot tell apart from another window's, so nothing was changed. Create a new task for your work instead.`,
            { claimed: false, task: taskSummary(cur) },
          );
        }
        const t = takeUpOnGuess(mindly, scope, cur.id);
        return ok(`Claimed task ${t.id}: ${safeLine(t.title, 200)}.`, { task: taskSummary(t) });
      },
    },
    (args, scope) => {
      claimable(args.id, scope);
      const t = mindly.tasks.claim(args.id, scope.session);
      scope.ownWrite?.(t.id);
      return ok(`Claimed task ${t.id}: ${safeLine(t.title, 200)}.`, { task: taskSummary(t) });
    },
  );

  /** The task `id` of this project, when it can still be claimed. */
  function claimable(id: string, scope: CallScope): Task {
    const cur = mindly.store.tasks.find(id);
    if (!cur) throw notFound('task', id);
    ensureProject(scope, cur.projectId, 'task', id);
    if (cur.status === 'done' || cur.status === 'abandoned') {
      throw new MindlyError('conflict', `task is ${cur.status}`);
    }
    return cur;
  }

  tool(
    'mindly_tasks',
    {
      title: 'List tasks',
      description: 'List project tasks, optionally filtered by status or to the ones you own.',
      input: z.strictObject({
        status: z.array(z.enum(TASK_STATUSES)).min(1).max(5).optional(),
        mine: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: READ_ONLY,
      // "Mine" is what the server took up itself and still has, not the tasks of the window it
      // guessed at nor a task someone has since taken.
      onGuess: (args, scope) => listTasks(args, scope, (t) => ownOnGuess(scope.guess, t)),
    },
    (args, scope) => listTasks(args, scope, null),
  );

  /** `guessMine`: on a guess, which tasks are the server's own (null: the session owns them). */
  function listTasks(
    args: {
      status?: Task['status'][] | undefined;
      mine?: boolean | undefined;
      limit?: number | undefined;
    },
    { project, session }: CallScope,
    guessMine: ((t: Task) => boolean) | null,
  ): CallToolResult {
    let tasks = mindly.tasks.list(
      project.project.id,
      args.status ?? ['open', 'in_progress', 'blocked'],
    );
    if (args.mine) tasks = tasks.filter(guessMine ?? ((t) => t.ownerSessionId === session.id));
    tasks = tasks.slice(0, args.limit ?? 30);
    const t = now();
    const note =
      args.mine && guessMine
        ? 'Only tasks this server took up itself are listed as yours: it cannot tell yet whether the session it speaks for is its own or another window’s.'
        : undefined;
    return ok(
      block(
        [{ heading: 'Tasks', lines: tasks.map((x) => taskLine(mindly, x, t)) }],
        note ? `No tasks. ${note}` : 'No tasks.',
        tasks.length ? note : undefined,
      ),
      { tasks: tasks.map(taskSummary) },
    );
  }

  tool(
    'mindly_split_status',
    {
      title: 'Split status',
      description:
        'The current split of this project (a goal divided between agents in parallel worktrees): ' +
        'your part and the files it owns, every other part and its progress, the shared contract ' +
        'and the latest merge check. Read-only; the user creates, merges and aborts splits.',
      input: z.strictObject({}),
      annotations: READ_ONLY,
      // A part is told by the working tree, which a guess shares with the server.
      onGuess: 'shared',
    },
    async (_args, { project, session }) => {
      const svc = splitOf(mindly);
      const current = svc.current(project.project.id);
      if (!current) return ok('No split in this project.', { split: null });
      const r = await svc.status(current.id);
      const mine = svc.partForSession(session);
      const t = now();
      const partLine = (p: (typeof r.parts)[number]): string => {
        const bits = [
          `- [${p.state}] ${p.part.position + 1}. ${safeLine(p.part.title, 120)} (${p.part.agentKind}${mine?.id === p.part.id ? ', you' : ''})`,
          `owns ${p.part.owns.map((g) => safeLine(g, 160)).join(', ')}`,
        ];
        if (p.part.dependsOn.length) bits.push(`depends on ${p.part.dependsOn.join(', ')}`);
        if (p.filesChanged.length) bits.push(`${p.filesChanged.length} file(s) changed`);
        if (p.conflicts.length) bits.push(`${p.conflicts.length} open conflict(s)`);
        if (p.lastActivityAt !== null) bits.push(`active ${relativeTime(p.lastActivityAt, t)}`);
        return bits.join(' \u00b7 ');
      };
      const check = r.mergeCheck;
      const checkResult = check?.result as { clean?: boolean; conflictedPaths?: string[] } | null;
      const sections: Section[] = [
        {
          heading: `Split "${safeLine(r.split.goal, 200)}" (${r.split.status}${r.split.strict ? ', strict' : ''})`,
          lines: [
            mine
              ? `  Your part: "${safeLine(mine.title, 120)}" \u2014 edit only ${mine.owns.map((g) => safeLine(g, 160)).join(', ')}.`
              : '  You are not working in a part of this split.',
          ],
        },
        { heading: 'Parts', lines: r.parts.map(partLine) },
        {
          heading: 'Contract',
          lines: r.contract.map(
            (c) =>
              `- ${safeLine(c.name, 120)} \u2014 ${safeLine(c.definition, 400)} (owned by part ${c.owner})`,
          ),
        },
        {
          heading: 'Merge check',
          lines: check
            ? [
                `  ${check.status}, ${relativeTime(check.createdAt, t)}${
                  checkResult?.clean === false && checkResult.conflictedPaths?.length
                    ? `; conflicts in ${checkResult.conflictedPaths
                        .slice(0, 10)
                        .map((p) => safeLine(p, 200))
                        .join(', ')}`
                    : ''
                }`,
              ]
            : ['  No merge check yet.'],
        },
      ];
      return ok(block(sections, 'No split.'), {
        split: {
          id: r.split.id,
          slug: r.split.slug,
          goal: safeLine(r.split.goal, 500),
          status: r.split.status,
          strict: r.split.strict,
          baseCommit: r.split.baseCommit,
          integrationBranch: r.split.integrationBranch,
        },
        myPart: mine ? mine.key : null,
        parts: r.parts.map((p) => ({
          key: p.part.key,
          title: safeLine(p.part.title, 120),
          agentKind: p.part.agentKind,
          owns: p.part.owns,
          reads: p.part.reads,
          dependsOn: p.part.dependsOn,
          worktree: p.part.worktree,
          branch: p.part.branch,
          taskId: p.part.taskId,
          state: p.state,
          filesChanged: p.filesChanged.slice(0, 200),
          conflicts: p.conflicts.length,
          lastActivityAt: p.lastActivityAt,
        })),
        contract: r.contract.map((c) => ({
          name: safeLine(c.name, 120),
          owner: c.owner,
          definition: safeText(c.definition, 2000),
          memoryId: c.memoryId,
        })),
        mergeCheck: check
          ? { id: check.id, status: check.status, createdAt: check.createdAt, result: check.result }
          : null,
      });
    },
  );

  tool(
    'mindly_send_message',
    {
      title: 'Send message',
      description:
        'Send a message to another agent kind (delivered to its next session) or to a specific ' +
        'session id. Delivered at the next turn of the recipient. Limited to 20 messages per minute.',
      input: z.strictObject({
        toAgentKind: AgentKindSchema.optional(),
        toSessionId: Id.optional(),
        title: z.string().min(1).max(200),
        body: z.string().max(1500).optional(),
        priority: z.number().int().min(0).max(5).optional(),
      }),
      annotations: WRITE,
      // On a guess what it sends is noted and goes along with the server once its session is known.
      onGuess: 'shared',
    },
    (args, scope) => {
      const { project, session } = scope;
      if ((args.toAgentKind === undefined) === (args.toSessionId === undefined)) {
        throw invalidInput('give exactly one of toAgentKind or toSessionId');
      }
      if (args.toSessionId !== undefined) {
        const target = mindly.store.sessions.find(args.toSessionId);
        if (!target) throw notFound('session', args.toSessionId);
        ensureProject(scope, target.projectId, 'session', args.toSessionId);
        if (target.id === session.id) throw invalidInput('cannot send a message to yourself');
      }
      messages.take('messages');
      const sent = mindly.telepathy.send({
        projectId: project.project.id,
        from: session,
        to:
          args.toSessionId !== undefined
            ? { sessionIds: [args.toSessionId] }
            : { agentKind: args.toAgentKind as string },
        kind: 'message',
        title: args.title,
        body: args.body ?? '',
        priority: args.priority ?? 2,
      });
      for (const d of sent) scope.guess?.note('message', d.id);
      return ok(`Queued ${sent.length} message(s).`, { deliveries: sent.map((d) => d.id) });
    },
  );

  tool(
    'mindly_inbox',
    {
      title: 'Inbox',
      description:
        'Messages and updates for you that are not yet acknowledged (pending and delivered). ' +
        'Does not mark anything delivered; use mindly_ack once handled.',
      input: z.strictObject({ limit: z.number().int().min(1).max(50).optional() }),
      annotations: READ_ONLY,
      // What waits for the session may be another window's: it is left for that window.
      onGuess: () => ok(`Inbox is empty. ${GUESS_INBOX}`, { items: [], guessed: true }),
    },
    (args, { project, session }) => {
      const max = args.limit ?? 20;
      const pending = mindly.telepathy.pending(session, max);
      const delivered = mindly.store.deliveries
        .list(project.project.id, { statuses: ['delivered'], limit: 200 })
        .filter((d) => d.targetSessionId === session.id);
      const items = [...pending, ...delivered].slice(0, max);
      const t = now();
      return ok(
        block(
          [{ heading: 'Your inbox', lines: items.map((d) => deliveryLine(mindly, d, t)) }],
          'Inbox is empty.',
        ),
        {
          items: items.map((d) => ({
            id: d.id,
            kind: d.kind,
            status: d.status,
            priority: d.priority,
            title: safeLine(d.title, 200),
            body: safeText(d.body, 1500),
            fromSessionId: d.sourceSessionId,
            createdAt: d.createdAt,
          })),
        },
      );
    },
  );

  tool(
    'mindly_ack',
    {
      title: 'Acknowledge',
      description: 'Acknowledge inbox items by id so they are not shown again.',
      input: z.strictObject({ ids: z.array(Id).min(1).max(50) }),
      annotations: WRITE_IDEMPOTENT,
      // Nothing in the session's inbox is the server's to acknowledge while it may be another
      // window's.
      onGuess: () => ok(`Acknowledged 0 item(s). ${GUESS_INBOX}`, { acked: 0, guessed: true }),
    },
    (args, { session }) => {
      const wanted = new Set(args.ids);
      const pending = mindly.telepathy.pending(session, 100).filter((d) => wanted.has(d.id));
      mindly.telepathy.markDelivered(session, pending);
      const n = mindly.telepathy.ack(session, [...wanted]);
      return ok(`Acknowledged ${n} item(s).`, { acked: n });
    },
  );

  tool(
    'mindly_handoff',
    {
      title: 'Hand off',
      description:
        'Package your current work (summary, next steps, blockers) for the next session of another ' +
        'agent (or any agent) to pick up.',
      input: z.strictObject({
        summary: z.string().min(1).max(300),
        nextSteps: ListOfLines(20).optional(),
        blockers: ListOfLines(20).optional(),
        toAgentKind: AgentKindSchema.optional(),
      }),
      annotations: WRITE,
      // Filed in the server's own name, describing the server's own work (never the other
      // window's task, prompts or files): the window it guessed at must not take it as its own.
      onGuess: async (args, scope) => {
        const self = scope.guess.self();
        const h = await failoverService(mindly).handoffs.create(self, {
          workOf: scope.guess.workOf(),
          decisionIds: scope.guess.decisionIds(),
          ...handoffInput(args),
        });
        scope.guess.noteHandoff(h.id, self.id);
        return handoffResult(h);
      },
    },
    async (args, scope) =>
      handoffResult(
        await failoverService(mindly).handoffs.create(scope.session, handoffInput(args)),
      ),
  );

  function handoffInput(args: {
    summary: string;
    nextSteps?: string[] | undefined;
    blockers?: string[] | undefined;
    toAgentKind?: string | undefined;
  }) {
    return {
      summary: args.summary,
      toAgentKind: args.toAgentKind ?? null,
      ...(args.nextSteps ? { nextSteps: args.nextSteps } : {}),
      ...(args.blockers ? { blockers: args.blockers } : {}),
    };
  }

  function handoffResult(h: Handoff): CallToolResult {
    return ok(
      `Handoff ${h.id} created for ${h.toAgentKind ?? 'any agent'}: ${safeLine(h.summary, 300)}.`,
      { handoff: { id: h.id, toAgentKind: h.toAgentKind, status: h.status, taskId: h.taskId } },
    );
  }

  tool(
    'mindly_why',
    {
      title: 'Why is this line here',
      description:
        'Code provenance for file:line \u2014 which agent session and prompt wrote it, and project ' +
        'memories backed by evidence in the file.',
      input: z.strictObject({ file: PathArg, line: z.number().int().min(1).max(10_000_000) }),
      annotations: READ_ONLY,
      onGuess: 'shared',
    },
    (args, { project }) => {
      const placed = placePath(mindly, project, args.file);
      const rel = placed.rel;
      const r = provenanceOf(mindly).why(project.project.id, project.root, rel, args.line);
      const t = now();
      const changes = r.changes.map((c) => {
        const who = c.label ? safeLine(c.label, 80) : 'an unknown session';
        const prompt = c.prompt ? ` \u2014 prompt: "${safeLine(c.prompt, 200)}"` : '';
        return `- ${who} via ${safeLine(c.tool, 40)}, ${relativeTime(c.at, t)}${prompt}`;
      });
      const memories = r.memories
        .map((pm) => mindly.store.memories.find(pm.id))
        .filter((m): m is Memory => m !== null)
        .map(memoryItem);
      const sections: Section[] = [
        { heading: `Line ${r.line} of ${safeLine(r.path, 300)}`, lines: [`  ${r.text}`] },
        {
          heading: 'Written by',
          lines: changes.length ? changes : ['- No agent edit on record for this line.'],
        },
        { heading: 'Memory backed by this file', lines: memories },
        { heading: 'Path', lines: placed.note ? [`- ${safeLine(placed.note, 400)}`] : [] },
      ];
      return ok(block(sections, 'Nothing known.'), {
        path: r.path,
        line: r.line,
        changes: r.changes.map((c) => ({
          sessionId: c.sessionId,
          agentKind: c.agentKind,
          at: c.at,
          tool: safeLine(c.tool, 40),
          prompt: c.prompt ? safeLine(c.prompt, 200) : null,
        })),
        memories: r.memories.map((m) => ({ ...m, title: safeLine(m.title, 160) })),
      });
    },
  );

  tool(
    'mindly_status',
    {
      title: 'Mindly status',
      description:
        'Live agents on this project, open conflicts and counts of items needing the user.',
      input: z.strictObject({}),
      annotations: READ_ONLY,
      // Project-wide; the session is only marked in the list.
      onGuess: 'shared',
    },
    (_args, { project, session }) => {
      const pid = project.project.id;
      const t = now();
      const live = mindly.store.sessions
        .listLive(pid, LIVE_WINDOW_MS)
        .filter((s) => s.status !== 'ended');
      const agentLines = live.map((s) => {
        const task = s.currentTaskId ? mindly.store.tasks.find(s.currentTaskId) : null;
        const files = [
          ...new Set(mindly.store.intents.activeForSession(s.id).flatMap((i) => i.targets.files)),
        ].slice(0, 6);
        const parts = [
          `- ${safeLine(sessionLabel(s), 80)}${s.id === session.id ? ' (you)' : ''} (${s.status}, active ${relativeTime(s.lastSeenAt, t)})`,
        ];
        if (task) parts.push(`task: ${safeLine(task.title, 120)}`);
        if (files.length) parts.push(`editing: ${files.map((f) => safeLine(f, 200)).join(', ')}`);
        return parts.join('; ');
      });
      const conflicts = mindly.store.conflicts.list(pid, { limit: 50 });
      const conflictLines = conflicts
        .slice(0, 10)
        .map((c) => `- [${c.severity}] ${safeLine(c.title, 200)}`);
      const proposed = mindly.store.memories.list(pid, { trust: ['proposed'], limit: 1000 });
      const needsYou = {
        proposedRules: proposed.filter((m) => m.kind === 'rule').length,
        proposedMemories: proposed.filter((m) => m.kind !== 'rule').length,
        criticalConflicts: conflicts.filter((c) => c.severity === 'critical').length,
        pendingHandoffs: mindly.store.handoffs.list(pid, 100).filter((h) => h.status === 'pending')
          .length,
      };
      const needsLines = [
        `- ${needsYou.proposedRules} proposed rule(s), ${needsYou.proposedMemories} other proposed memories awaiting approval`,
        `- ${needsYou.criticalConflicts} critical conflict(s), ${needsYou.pendingHandoffs} unclaimed handoff(s)`,
      ];
      return ok(
        block(
          [
            { heading: 'Live agents', lines: agentLines },
            { heading: `Open conflicts (${conflicts.length})`, lines: conflictLines },
            { heading: 'Needs the user', lines: needsLines },
          ],
          'Nothing to report.',
          `Project: ${project.project.name}`,
        ),
        {
          project: { id: pid, name: safeLine(project.project.name, 200) },
          sessionId: session.id,
          liveAgents: live.map((s) => ({
            id: s.id,
            agentKind: s.agentKind,
            status: s.status,
            lastSeenAt: s.lastSeenAt,
            currentTaskId: s.currentTaskId,
          })),
          openConflicts: conflicts.length,
          needsYou,
        },
      );
    },
  );
}
