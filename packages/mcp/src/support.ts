import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
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
  type ProcessLookup,
  type ProcessRef,
  type Session,
} from '@mindly/core';
import type { Mindly, ProjectContext } from '@mindly/engine';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export { SessionResolver } from './session.js';

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
  /** Whether a PID is in use; decides if another server's claim on a session holds. */
  alive?: (pid: number) => boolean;
  /** Where process facts (parent, start time) come from. Defaults to this machine. */
  processes?: ProcessLookup;
  /** The server's own ancestors, nearest first. Defaults to those of this process. */
  ancestors?: readonly ProcessRef[];
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
  /** Directory the client started the server in. */
  cwd: string;
}

/** The project and calling session a tool call operates on. */
export interface CallScope {
  project: ScopedProject;
  session: Session;
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

function there(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A path an agent gave, placed in the working tree. */
export interface PlacedPath {
  /** POSIX path relative to the root of the working tree. */
  rel: string;
  /** Something the agent should know about how the path was read, or null. */
  note: string | null;
}

/**
 * Places a path supplied by an agent in the working tree and enforces containment and the
 * deny-list. An absolute path must be inside the tree. A relative path can mean two things when
 * the server runs in a subfolder: relative to that folder, as a shell would read it, or relative
 * to the root of the tree, which is how Mindly itself prints paths. What exists decides:
 *
 * - from the server's folder when that names something that exists;
 * - else from the root, when it exists there, or when only there the folder it would be in
 *   exists (a file about to be created);
 * - else from the server's folder.
 *
 * When both readings name an existing file the server's folder wins and the note says so. Git's
 * own folder is never a project file: what it holds (configuration, hooks, stored credentials)
 * is not for agents to read or to build checks on.
 */
export function placePath(mindly: Mindly, project: ProjectContext, input: string): PlacedPath {
  const root = project.root;
  const cwd = (project as Partial<ScopedProject>).cwd;
  const inside = (abs: string): { rel: string; abs: string } | null => {
    const r = tryResolveInsideRoot(root, abs);
    return r && r.rel !== '' ? r : null;
  };
  let chosen: string;
  let note: string | null = null;
  if (isAbsolute(input)) {
    chosen = input;
  } else {
    const fromRoot = resolve(root, input);
    const fromCwd =
      cwd !== undefined && tryResolveInsideRoot(root, cwd) ? resolve(cwd, input) : null;
    if (fromCwd === null || fromCwd === fromRoot) {
      chosen = fromRoot;
    } else if (inside(fromCwd) && there(fromCwd)) {
      chosen = fromCwd;
      const other = inside(fromRoot);
      if (other && there(fromRoot)) {
        note = `"${sanitizeLine(input, 200)}" was read from the folder this server runs in (${inside(fromCwd)?.rel}); ${other.rel} exists too, give it as an absolute path if you meant that one.`;
      }
    } else if (inside(fromRoot) && there(fromRoot)) {
      chosen = fromRoot;
    } else if (inside(fromRoot) && !there(dirname(fromCwd)) && there(dirname(fromRoot))) {
      chosen = fromRoot;
    } else {
      chosen = fromCwd;
    }
  }
  const resolved = resolveInsideRoot(root, chosen);
  if (resolved.rel === '')
    throw new MindlyError('invalid_input', 'path must be inside the project');
  if (resolved.rel.split('/').some((segment) => segment.toLowerCase() === '.git')) {
    throw new MindlyError('forbidden', 'path is inside the git folder');
  }
  if (isDeniedPath(resolved.rel, mindly.config.redaction.denyPaths)) {
    throw new MindlyError('forbidden', 'path is on the deny-list');
  }
  if (note === null && !there(dirname(resolved.abs))) {
    note = `${resolved.rel}: the folder it would be in does not exist in this checkout.`;
  }
  return { rel: resolved.rel, note };
}

/** `placePath` for callers that only need the project-relative path. */
export function projectPath(mindly: Mindly, project: ProjectContext, input: string): string {
  return placePath(mindly, project, input).rel;
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
