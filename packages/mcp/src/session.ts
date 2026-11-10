import { randomBytes } from 'node:crypto';
import {
  ancestorChain,
  hookAncestryKey,
  parseProcessChain,
  systemProcessLookup,
  type Logger,
  type ProcessLookup,
  type ProcessRef,
  type Session,
} from '@mindly/core';
import { LIVE_WINDOW_MS, type Mindly } from '@mindly/engine';
import type { CallScope, McpContext, ScopedProject } from './support.js';

/*
 * Which session a server speaks for.
 *
 * MCP carries no hook session id, so a server has to work out which of the live sessions of its
 * agent kind is the one of its own client. Two things tell it:
 *
 * - Process ancestry. The hooks of a window and its MCP server are started by the same client
 *   process. The first hook of a session records the ancestors of its process; a session whose
 *   recorded ancestors meet the server's own, with nothing still running in between on the
 *   hook's side, was made by the server's own client. That is a match that can be relied on.
 * - Claims. Every server records which session it speaks for, so two servers never share one.
 *
 * Where ancestry says nothing (no hooks for this client, a system where it cannot be read) the
 * server takes the most recently active session nobody has claimed. That is a guess, and it is
 * treated as one: the server moves to its own client's session as soon as that can be told.
 */

/** Key of the one record that holds every claim: `{ [sessionId]: Claim }`. */
export const CLAIMS_KEY = 'mcp:claims';

/** One server speaking for one session. */
interface Claim {
  /** Identifies one server (several can live in one process in tests). */
  owner: string;
  pid: number;
  /** When that process started; with the PID it tells it from a later process. Empty: unknown. */
  start: string;
  /** True when the session is known to be the one of the server's own client. */
  sure: boolean;
}

type Claims = Record<string, Claim>;

/** How long one reading of the process table is used. */
const PROCESS_VIEW_MS = 5000;

function pidInUse(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Resolves the calling session of a tool call. A server settles on one session and keeps it:
 *
 * - the live session that the hooks of its own client made, in the working tree it runs in;
 * - else the most recently active live session of its agent kind in that tree that no other
 *   running server speaks for;
 * - else a session of its own, with external id `mcp-<pid>-<startTime>`.
 *
 * It chooses again only when the session has ended or another server took it over, and it
 * leaves a guessed session or a session of its own for its client's session once that exists.
 * What it did on its own session (tasks, intents, unread messages) moves along.
 */
export class SessionResolver {
  private readonly externalId: string;
  private readonly owner: string;
  private readonly pid: number;
  private readonly alive: (pid: number) => boolean;
  private readonly customLookup: ProcessLookup | null;
  private lookup: ProcessLookup;
  private lookupAt = Date.now();
  private self: ProcessRef | null = null;
  private ancestors: readonly ProcessRef[] | null;
  private bound: { id: string; own: boolean; sure: boolean } | null = null;
  private scoped: ScopedProject | null = null;
  private readonly roots = new Map<string, string | null>();

  constructor(
    private readonly mindly: Mindly,
    private readonly ctx: McpContext,
    private readonly logger?: Logger,
  ) {
    this.pid = ctx.pid ?? process.pid;
    const start = ctx.startTime ?? mindly.kernel.clock.now();
    this.externalId = `mcp-${this.pid}-${start}`;
    this.owner = `${this.externalId}-${randomBytes(6).toString('hex')}`;
    this.alive = ctx.alive ?? pidInUse;
    this.customLookup = ctx.processes ?? null;
    this.lookup = this.customLookup ?? systemProcessLookup();
    this.ancestors = ctx.ancestors ?? null;
  }

  /** External id used for the fallback session of this server process. */
  get fallbackExternalId(): string {
    return this.externalId;
  }

  // ----------------------------------------------------------------- processes

  /**
   * A fresh view of the process table, at most every few seconds: where it comes from `ps` it
   * costs a process start, which a tool call should not pay every time.
   */
  private refresh(): void {
    if (this.customLookup) return;
    const now = Date.now();
    if (now - this.lookupAt < PROCESS_VIEW_MS) return;
    this.lookupAt = now;
    this.lookup = systemProcessLookup();
  }

  private runs(ref: { pid: number; start: string }): boolean {
    if (!this.alive(ref.pid)) return false;
    if (ref.start === '') return true;
    const now = this.lookup(ref.pid);
    return now === null || now.start === ref.start;
  }

  private me(): ProcessRef {
    this.self ??= { pid: this.pid, start: this.lookup(this.pid)?.start ?? '' };
    return this.self;
  }

  private chain(): readonly ProcessRef[] {
    this.ancestors ??= ancestorChain(process.pid, this.lookup);
    return this.ancestors;
  }

  /**
   * True when `session` was made by the hooks of this server's own client: the ancestors its
   * first hook recorded meet the server's, and nothing between the hook and that common
   * ancestor is still running. A process still running there is another client (a second
   * window started from the same terminal shares only the terminal with this server).
   */
  private mine(session: Session): boolean {
    const mine = this.chain();
    if (mine.length === 0) return false;
    const recorded = parseProcessChain(
      this.mindly.store.kv.get<unknown>(hookAncestryKey(session.agentKind, session.externalId)),
    );
    const meet = recorded.findIndex((h) =>
      mine.some((m) => m.pid === h.pid && m.start === h.start && h.start !== ''),
    );
    if (meet === -1) return false;
    return !recorded.slice(0, meet).some((h) => this.runs(h));
  }

  // ----------------------------------------------------------------- project

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

  // ----------------------------------------------------------------- claims

  /** Every claim whose server still runs. Call inside a transaction when the result is written. */
  private claims(): Claims {
    const raw = this.mindly.store.kv.get<unknown>(CLAIMS_KEY);
    const out: Claims = {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, value] of Object.entries(raw as Record<string, Partial<Claim> | null>)) {
      if (!value || typeof value.owner !== 'string' || typeof value.pid !== 'number') continue;
      const claim: Claim = {
        owner: value.owner,
        pid: value.pid,
        start: typeof value.start === 'string' ? value.start : '',
        sure: value.sure === true,
      };
      // A claim is free only when its process is gone; one left by a crash is dropped here.
      if (claim.owner === this.owner || this.runs(claim)) out[id] = claim;
    }
    return out;
  }

  private holds(sessionId: string): boolean {
    return this.claims()[sessionId]?.owner === this.owner;
  }

  /**
   * Takes `sessionId` unless another running server holds it. A claim that was only a guess
   * gives way to a server that knows the session is its own.
   */
  private take(sessionId: string, own: boolean, sure: boolean): boolean {
    return this.mindly.store.transaction(() => {
      const all = this.claims();
      const held = all[sessionId];
      if (held && held.owner !== this.owner && (held.sure || !sure)) return false;
      // A server speaks for one session: what it held before is let go.
      const claims = this.withoutMine(all);
      const me = this.me();
      claims[sessionId] = { owner: this.owner, pid: me.pid, start: me.start, sure };
      this.mindly.store.kv.set(CLAIMS_KEY, claims);
      this.bound = { id: sessionId, own, sure };
      return true;
    });
  }

  private withoutMine(claims: Claims): Claims {
    return Object.fromEntries(Object.entries(claims).filter(([, c]) => c.owner !== this.owner));
  }

  private drop(): void {
    this.mindly.store.transaction(() => {
      this.mindly.store.kv.set(CLAIMS_KEY, this.withoutMine(this.claims()));
    });
    this.bound = null;
  }

  // ----------------------------------------------------------------- choosing

  /** Live hook sessions of this agent kind in this working tree, most recently active first. */
  private async hookSessions(project: ScopedProject): Promise<Session[]> {
    const live = this.mindly.store.sessions
      .listLive(project.project.id, LIVE_WINDOW_MS)
      .filter(
        (s) =>
          s.agentKind === this.ctx.agentKind &&
          s.status !== 'ended' &&
          !s.externalId.startsWith('mcp-'),
      );
    const out: Session[] = [];
    for (const s of live) {
      const root = (s.worktree ? await this.rootOf(s.worktree) : null) ?? project.mainRoot;
      if (root === project.root) out.push(s);
    }
    return out;
  }

  /**
   * Moves to a better session when there is one: the session of this server's own client, or,
   * for a server that has none yet, the most recently active one nobody speaks for. Returns
   * true when the server moved.
   */
  private async improve(project: ScopedProject): Promise<boolean> {
    const before = this.bound;
    const candidates = (await this.hookSessions(project)).filter((s) => s.id !== before?.id);
    const sure = candidates.filter((s) => this.mine(s));
    const guessed = before && !before.own ? [] : candidates.filter((s) => !sure.includes(s));
    for (const [list, known] of [
      [sure, true],
      [guessed, false],
    ] as const) {
      for (const s of list) {
        if (!this.take(s.id, false, known)) continue;
        if (before?.own) this.handOver(before.id, s.id);
        return true;
      }
    }
    return false;
  }

  /**
   * The server leaves the session it made for itself for its client's hook session: what it
   * did so far (unfinished tasks, active intents, unread messages) goes with it, and the empty
   * session is ended.
   */
  private handOver(ownId: string, hookId: string): void {
    const store = this.mindly.store;
    store.transaction(() => {
      const own = store.sessions.find(ownId);
      if (!own || !own.externalId.startsWith('mcp-')) return;
      store.sessions.moveWork(ownId, hookId);
      store.intents.closeForSession(ownId);
      if (own.status !== 'ended') store.sessions.setStatus(ownId, 'ended');
    });
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
    this.refresh();

    // Still ours? The session may have ended, and another server may have taken it over while
    // this one sat idle: then this server is no longer the one that speaks for it.
    if (this.bound) {
      const cur = store.sessions.find(this.bound.id);
      const ended = cur === null || (cur.status === 'ended' && !this.bound.own);
      if (ended || !this.holds(this.bound.id)) {
        if (ended) this.drop();
        else this.bound = null;
      }
    }

    // A session known to be this client's is kept. Anything less is left for a better one.
    if (!this.bound || this.bound.own || !this.bound.sure) await this.improve(project);

    if (this.bound && !this.bound.own) {
      // The session is alive while its server is being used, whether or not a hook ran lately.
      store.sessions.touch(this.bound.id);
      return { project, session: store.sessions.get(this.bound.id) };
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
    if (!this.bound) this.take(session.id, true, true);
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
      this.drop();
    } catch (err) {
      // The store may be closed, or locked by another process for longer than we may wait. The
      // claim is dropped by the next server that looks (its process is gone by then).
      this.logger?.warn('mcp session not released', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
