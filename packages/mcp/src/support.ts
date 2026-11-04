import {
  isDeniedPath,
  isMindlyError,
  isUuid,
  redactText,
  resolveInsideRoot,
  sanitizeForContext,
  sanitizeLine,
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
  /** Maximum `mindly_send_message` calls per window. Defaults to 20. */
  messageLimit?: number;
  /** Rate-limit window in milliseconds. Defaults to one minute. */
  messageWindowMs?: number;
}

/** The project and calling session a tool call operates on. */
export interface CallScope {
  project: ProjectContext;
  session: Session;
}

/**
 * Resolves the calling session lazily on every tool call. MCP carries no hook session id, so the
 * caller is the most recently active live session of `agentKind` in the project (sessions created
 * by hooks are preferred over MCP fallback sessions). When there is none, a session with external
 * id `mcp-<pid>-<startTime>` is created (or reactivated).
 */
export class SessionResolver {
  private readonly externalId: string;

  constructor(
    private readonly mindly: Mindly,
    private readonly ctx: McpContext,
  ) {
    const pid = ctx.pid ?? process.pid;
    const start = ctx.startTime ?? mindly.kernel.clock.now();
    this.externalId = `mcp-${pid}-${start}`;
  }

  /** External id used for the fallback session of this server process. */
  get fallbackExternalId(): string {
    return this.externalId;
  }

  async resolve(): Promise<CallScope> {
    const project = await this.mindly.projects.resolve(this.ctx.cwd);
    const store = this.mindly.store;
    const live = store.sessions
      .listLive(project.project.id, LIVE_WINDOW_MS)
      .filter((s) => s.agentKind === this.ctx.agentKind && s.status !== 'ended');
    const preferred = live.find((s) => !s.externalId.startsWith('mcp-')) ?? live[0];
    if (preferred) {
      store.sessions.touch(preferred.id);
      return { project, session: store.sessions.get(preferred.id) };
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
    return { project, session };
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
 * Resolves a path supplied by an agent (project-relative, or absolute inside the project) and
 * enforces containment and the deny-list. Returns the project-relative POSIX path.
 */
export function projectPath(mindly: Mindly, project: ProjectContext, input: string): string {
  const resolved = resolveInsideRoot(project.root, input);
  if (resolved.rel === '')
    throw new MindlyError('invalid_input', 'path must be inside the project');
  if (isDeniedPath(resolved.rel, mindly.config.redaction.denyPaths)) {
    throw new MindlyError('forbidden', 'path is on the deny-list');
  }
  return resolved.rel;
}

/** Throws `invalid_input` unless `id` is a UUID. */
export function requireUuid(id: string, what: string): void {
  if (!isUuid(id)) throw new MindlyError('invalid_input', `${what} must be a UUID`);
}

/** Redacts and sanitises stored or agent-supplied text for display (one line). */
export function safeLine(text: string, max = 200): string {
  return sanitizeLine(redactText(text), max);
}

/** Redacts and sanitises stored or agent-supplied text for display (multi-line). */
export function safeText(text: string, max = 2000): string {
  return sanitizeForContext(redactText(text), max);
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
    const message = sanitizeLine(redactText(err.message), 300);
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
