import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  isDeniedPath,
  isMindlyError,
  isUuid,
  redactText,
  resolveInsideRoot,
  sanitizeForContext,
  sanitizeLine,
  tryResolveInsideRoot,
  MindlyError,
  type Logger,
  type Session,
} from '@mindly/core';
import { LIVE_WINDOW_MS, type Mindly, type ProjectContext } from '@mindly/engine';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Per-connection settings for the MCP server. */
export interface McpContext {
  /** Agent kind of the client that spawned the server (`claude-code`, `codex`, `cursor`, ...). */
  agentKind: string;
  /** Working directory the client started the server in; resolves the project. */
  cwd: string;
  /** Process id used in the fallback session id. Defaults to `process.pid`. */
  pid?: number;
  /** Server start time used in the fallback session id. Defaults to the engine clock. */
  startTime?: number;
  /** Whether a process is still running; decides if another server's claim on a session holds. */
  alive?: (pid: number) => boolean;
  /** Maximum `mindly_send_message` calls per window. Defaults to 20. */
  messageLimit?: number;
  /** Rate-limit window in milliseconds. Defaults to one minute. */
  messageWindowMs?: number;
}

/**
 * The project as a tool call sees it: `root` is the working tree the server runs in, which is a
 * linked worktree when the client was started in one. Paths an agent gives, the files read for
 * evidence and the lines `mindly_why` explains are the ones of that tree, as they are for hooks.
 */
export interface ScopedProject extends ProjectContext {
  /** Root of the main checkout (the project's own root). */
  mainRoot: string;
  /** Directory the client started the server in; relative paths are read from here. */
  cwd: string;
}

/** The project and calling session a tool call operates on. */
export interface CallScope {
  project: ScopedProject;
  session: Session;
}

/** Which server speaks for a session (stored under `mcp:bound:<session id>`). */
interface Binding {
  /** Identifies one server (several can live in one process in tests). */
  owner: string;
  pid: number;
  /** Refreshed while the server is in use; a claim nobody refreshed is free again. */
  at: number;
}

const BINDING_REFRESH_MS = 60_000;

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Resolves the calling session of a tool call. MCP carries no hook session id, so a server works
 * out once which session it speaks for and then keeps it:
 *
 * - a live session of `agentKind` that hooks created in the working tree the server runs in, and
 *   that no other running MCP server already speaks for (the most recently active one);
 * - otherwise a session of its own, with external id `mcp-<pid>-<startTime>`.
 *
 * The choice holds for the life of the process. It is made again only when the session has ended
 * or is no longer live, and a server on its own session moves to a hook session once one shows
 * up (the client's first hook may run after its first tool call). Two clients of one agent kind
 * therefore never share a session, and a second window never takes over the first one's.
 */
export class SessionResolver {
  private readonly externalId: string;
  private readonly owner: string;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  private bound: { id: string; own: boolean; refreshedAt: number } | null = null;
  private scoped: ScopedProject | null = null;
  private readonly roots = new Map<string, string | null>();

  constructor(
    private readonly mindly: Mindly,
    private readonly ctx: McpContext,
  ) {
    this.pid = ctx.pid ?? process.pid;
    const start = ctx.startTime ?? mindly.kernel.clock.now();
    this.externalId = `mcp-${this.pid}-${start}`;
    this.owner = `${this.externalId}-${randomBytes(6).toString('hex')}`;
    this.alive = ctx.alive ?? processAlive;
  }

  /** External id used for the fallback session of this server process. */
  get fallbackExternalId(): string {
    return this.externalId;
  }

  private async project(): Promise<ScopedProject> {
    if (this.scoped) return this.scoped;
    const project = await this.mindly.projects.resolve(this.ctx.cwd);
    const treeRoot = (await this.rootOf(this.ctx.cwd)) ?? project.root;
    this.scoped = { ...project, root: treeRoot, mainRoot: project.root, cwd: this.ctx.cwd };
    return this.scoped;
  }

  private async rootOf(dir: string): Promise<string | null> {
    const known = this.roots.get(dir);
    if (known !== undefined) return known;
    const root = await this.mindly.kernel.ports.git.findRepoRoot(dir).catch(() => null);
    if (this.roots.size < 200) this.roots.set(dir, root);
    return root;
  }

  private key(sessionId: string): string {
    return `mcp:bound:${sessionId}`;
  }

  /** True when another running server speaks for `sessionId`. */
  private taken(sessionId: string): boolean {
    const b = this.mindly.store.kv.get<Binding>(this.key(sessionId));
    if (!b || typeof b !== 'object' || b.owner === this.owner) return false;
    if (typeof b.pid !== 'number' || !this.alive(b.pid)) return false;
    return typeof b.at === 'number' && this.mindly.kernel.clock.now() - b.at <= LIVE_WINDOW_MS;
  }

  private bind(sessionId: string, own: boolean): void {
    const now = this.mindly.kernel.clock.now();
    const claim: Binding = { owner: this.owner, pid: this.pid, at: now };
    this.mindly.store.kv.set(this.key(sessionId), claim);
    this.bound = { id: sessionId, own, refreshedAt: now };
  }

  private unbind(): void {
    if (!this.bound) return;
    const key = this.key(this.bound.id);
    if (this.mindly.store.kv.get<Binding>(key)?.owner === this.owner) {
      this.mindly.store.kv.delete(key);
    }
    this.bound = null;
  }

  /**
   * Takes the live hook session of this agent kind, in this working tree, that no other server
   * speaks for yet (the most recently active one), or returns null.
   */
  private async takeHookSession(project: ScopedProject): Promise<Session | null> {
    const live = this.mindly.store.sessions
      .listLive(project.project.id, LIVE_WINDOW_MS)
      .filter(
        (s) =>
          s.agentKind === this.ctx.agentKind &&
          s.status !== 'ended' &&
          !s.externalId.startsWith('mcp-'),
      );
    for (const s of live) {
      const root = (s.worktree ? await this.rootOf(s.worktree) : null) ?? project.mainRoot;
      if (root !== project.root) continue;
      // Looked at and taken in one transaction, so two servers starting together do not both
      // settle on the same session.
      const got = this.mindly.store.transaction(() => {
        if (this.taken(s.id)) return false;
        this.bind(s.id, false);
        return true;
      });
      if (got) return s;
    }
    return null;
  }

  /** Ends the session this server made for itself and closes what it announced. */
  private endOwnSession(sessionId: string): void {
    const store = this.mindly.store;
    const s = store.sessions.find(sessionId);
    if (!s || !s.externalId.startsWith('mcp-')) return;
    store.intents.closeForSession(sessionId);
    if (s.status !== 'ended') store.sessions.setStatus(sessionId, 'ended');
  }

  async resolve(): Promise<CallScope> {
    const project = await this.project();
    const store = this.mindly.store;
    const now = this.mindly.kernel.clock.now();

    if (this.bound && !this.bound.own) {
      const cur = store.sessions.find(this.bound.id);
      const live = cur !== null && cur.status !== 'ended' && now - cur.lastSeenAt <= LIVE_WINDOW_MS;
      if (live) {
        if (now - this.bound.refreshedAt > BINDING_REFRESH_MS) this.bind(this.bound.id, false);
        return { project, session: cur };
      }
      this.unbind();
    }

    // Unbound, or on a session of its own: the client's hook session is preferred once there is
    // one, since that is where its edits, prompts and tasks are recorded.
    const own = this.bound;
    const hooked = await this.takeHookSession(project);
    if (hooked) {
      if (own) {
        this.endOwnSession(own.id);
        store.kv.delete(this.key(own.id));
      }
      return { project, session: store.sessions.get(hooked.id) };
    }

    const existing = store.sessions.findByExternal(
      project.project.id,
      this.ctx.agentKind,
      this.externalId,
    );
    const branch = existing ? null : await this.mindly.kernel.ports.git.currentBranch(this.ctx.cwd);
    const { session } = store.sessions.upsert({
      projectId: project.project.id,
      agentKind: this.ctx.agentKind,
      externalId: this.externalId,
      worktree: this.ctx.cwd,
      branch,
      transcriptPath: null,
    });
    if (!own || now - own.refreshedAt > BINDING_REFRESH_MS) this.bind(session.id, true);
    return { project, session };
  }

  /**
   * Lets go of the session when the client disconnects. The session this server made for itself
   * is ended and its intents are closed, so the agent does not stay "live" with nobody behind
   * it; a hook session is only handed back.
   */
  release(): void {
    const bound = this.bound;
    if (!bound) return;
    try {
      if (bound.own) this.endOwnSession(bound.id);
      this.unbind();
    } catch {
      // The store may already be closed; nothing to hand back then.
    }
  }
}

/** Sliding-window rate limiter (per server process). */
export class RateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** Records an attempt; throws `forbidden` when the limit is exceeded. */
  take(what: string): void {
    const t = this.now();
    while (this.hits.length > 0 && (this.hits[0] as number) <= t - this.windowMs) this.hits.shift();
    if (this.hits.length >= this.max) {
      throw new MindlyError(
        'forbidden',
        `rate limit: at most ${this.max} ${what} per ${Math.round(this.windowMs / 1000)}s`,
      );
    }
    this.hits.push(t);
  }
}

/**
 * Resolves a path supplied by an agent and enforces containment and the deny-list. A relative
 * path is read from the directory the server runs in, an absolute one must be inside the working
 * tree; either way the result is the POSIX path relative to that tree's root. Git's own folder is
 * never a project file: what it holds (configuration, hooks, stored credentials) is not for
 * agents to read or to build checks on.
 */
export function projectPath(mindly: Mindly, project: ProjectContext, input: string): string {
  const cwd = (project as Partial<ScopedProject>).cwd;
  const from = cwd !== undefined && tryResolveInsideRoot(project.root, cwd) ? cwd : project.root;
  const resolved = resolveInsideRoot(
    project.root,
    isAbsolute(input) ? input : resolve(from, input),
  );
  if (resolved.rel === '')
    throw new MindlyError('invalid_input', 'path must be inside the project');
  if (resolved.rel.split('/').includes('.git')) {
    throw new MindlyError('forbidden', 'path is inside the git folder');
  }
  if (isDeniedPath(resolved.rel, mindly.config.redaction.denyPaths)) {
    throw new MindlyError('forbidden', 'path is on the deny-list');
  }
  return resolved.rel;
}

/** Throws `invalid_input` unless `id` is a UUID. */
export function requireUuid(id: string, what: string): void {
  if (!isUuid(id)) throw new MindlyError('invalid_input', `${what} must be a UUID`);
}

let extraPatterns: readonly string[] = [];

/**
 * Sets the user's `redaction.extraPatterns` for everything this module renders. Called when a
 * server is created: a process runs one server over one configuration.
 */
export function useRedaction(patterns: readonly string[]): void {
  extraPatterns = [...patterns];
}

/** Redacts and sanitises stored or agent-supplied text for display (one line). */
export function safeLine(text: string, max = 200): string {
  return sanitizeLine(redactText(text, { extraPatterns }), max);
}

/** Redacts and sanitises stored or agent-supplied text for display (multi-line). */
export function safeText(text: string, max = 2000): string {
  return sanitizeForContext(redactText(text, { extraPatterns }), max);
}

/** A successful tool result with plain text and optional structured content. */
export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * Maps any thrown value to an MCP tool error. `MindlyError`s keep their code and (sanitised)
 * message; anything else becomes a generic `internal` error and is logged. Never includes stacks.
 */
export function toolError(err: unknown, tool: string, logger: Logger): CallToolResult {
  if (isMindlyError(err)) {
    const message = safeLine(err.message, 300);
    logger.info('mcp tool rejected', { tool, code: err.code });
    return {
      content: [{ type: 'text', text: `${err.code}: ${message}` }],
      structuredContent: { error: { code: err.code, message } },
      isError: true,
    };
  }
  logger.error('mcp tool failed', {
    tool,
    error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error',
  });
  return {
    content: [{ type: 'text', text: 'internal: the tool failed unexpectedly' }],
    structuredContent: { error: { code: 'internal', message: 'the tool failed unexpectedly' } },
    isError: true,
  };
}
