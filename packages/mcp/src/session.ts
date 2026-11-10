import { randomBytes } from 'node:crypto';
import {
  ancestorChain,
  hookAncestryKey,
  isLauncherName,
  isShellName,
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

/** How a session relates to a server (see `SessionResolver.relation`). */
interface Relation {
  known: boolean;
  depth: number;
  rank: number | null;
  windowAlive: boolean | null;
  /** Whether a process of the session's client still runs; null when nothing was recorded. */
  clientRuns: boolean | null;
  /**
   * True when the session's client runs and is not one of this server's ancestors, which could
   * be read: the client of another window.
   */
  foreignClient: boolean;
}

/** A row an MCP server wrote while on a guess, where it is now and what it looked like then. */
interface WorkRow {
  kind: 'intent' | 'task' | 'message' | 'handoff';
  id: string;
  /** The session the row is with now. */
  at: string;
  updatedAt: number;
  sig: string;
}

/**
 * What a server did since it last spoke for a session that is its own (known, or its own
 * `mcp-` session): the rows it wrote and the task it made current.
 */
interface ServerWork {
  rows: Map<string, WorkRow>;
  currentTask: string | null;
  /** Memories it recorded: they stay where they are, and are named in its handoffs. */
  memories: Set<string>;
  /**
   * Current tasks it set itself, by session, while acting as a guess that was the one window
   * there is: such a pointer does not tell that the session's window took the task up.
   */
  currents: Map<string, string>;
}

/** Most rows a server records while on a guess; past it, new rows stay where they are made. */
const MAX_WORK_ROWS = 1000;

/** How many launchers may stand between a server and its client. */
const MAX_LAUNCHERS = 2;

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
  private work: ServerWork | null = null;
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
   * How `session` relates to this server, from the ancestors its first hook recorded. `depth` is
   * where the two chains meet in the server's own chain (0: the server's parent), -1 when they do
   * not meet or nothing was recorded.
   *
   * Only one thing proves that a session is the server's own: its hooks were started by the
   * server's parent, which is then the client of both (`known`). Everything else is a guess, and
   * `rank` orders guesses (lower is better; null: not to be guessed at all):
   *
   * - 1: the chains meet a little further up, with only launchers (`npx`, a node shim, a shell)
   *   between the server and the meeting point on its side, and on the hook's side only the
   *   process that started the hook below it. That is what a server started through a launcher
   *   sees of its own client. It is also what a crashed window looks like whose client was
   *   started straight from the same host as a client that happens to be called `node`, which is
   *   why it stays a guess and gives way as soon as something better turns up.
   * - 2: nothing tells (no record, chains that do not meet).
   * - 3: as 1, but meeting at a shell or with more than one process below the meeting point on
   *   the hook's side: a hook that went through two short-lived processes, or a window that is
   *   gone. Such a guess is not kept alive by the server.
   * - 4: another client is still running below the meeting point: most likely another window.
   * - null: the chains meet beyond a process on the server's side that is not a launcher (its own
   *   client), and nothing below the meeting point on the hook's side runs any more: a window
   *   that was closed without ending its session (`windowAlive` false).
   */
  private relation(session: Session): Relation {
    const recorded = parseProcessChain(
      this.mindly.store.kv.get<unknown>(hookAncestryKey(session.agentKind, session.externalId)),
    );
    const is = (r: Omit<Relation, 'foreignClient'>, foreignClient = false): Relation => ({
      ...r,
      foreignClient,
    });
    if (recorded.length === 0) {
      return is({ known: false, depth: -1, rank: 2, windowAlive: null, clientRuns: null });
    }
    const mine = this.chain();
    const same = (a: ProcessRef, b: ProcessRef): boolean =>
      a.pid === b.pid && a.start === b.start && a.start !== '';
    let meet = -1;
    let depth = -1;
    for (let i = 0; i < recorded.length && meet === -1; i++) {
      const j = mine.findIndex((m) => same(m, recorded[i] as ProcessRef));
      if (j !== -1) {
        meet = i;
        depth = j;
      }
    }
    if (meet === -1) {
      // Another tree: its client is the hook's parent or the process above it.
      const clientRuns = recorded.slice(0, 2).some((h) => this.runs(h));
      // Where this server's ancestors could be read, a client that runs and is not among them is
      // another window's (the rank stays: a guess may still have to be made).
      return is(
        { known: false, depth: -1, rank: 2, windowAlive: true, clientRuns },
        clientRuns && mine.length > 0,
      );
    }
    if (depth === 0) {
      return is({ known: true, depth, rank: 0, windowAlive: true, clientRuns: true });
    }
    const below = recorded.slice(0, meet);
    if (below.some((h) => this.runs(h))) {
      return is({ known: false, depth, rank: 4, windowAlive: true, clientRuns: true }, true);
    }
    const through =
      depth <= MAX_LAUNCHERS && mine.slice(0, depth).every((m) => isLauncherName(m.name));
    if (!through) {
      return below.length <= 1
        ? is({ known: false, depth, rank: 2, windowAlive: null, clientRuns: false })
        : is({ known: false, depth, rank: null, windowAlive: false, clientRuns: false });
    }
    const close = below.length <= 1 && !isShellName(mine[depth]?.name);
    // Through launchers to a close meeting point, the client is that point, a running ancestor
    // of this server; otherwise nothing of the hook's side runs any more.
    return is({ known: false, depth, rank: close ? 1 : 3, windowAlive: null, clientRuns: close });
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
   * Moves to a better session when there is one. Returns true when the server moved.
   *
   * The session of this server's own client is known when exactly one live session of its kind
   * had its hooks started by the server's parent. When several were (one host process running
   * several sessions, each with a server of its own) ancestry cannot tell them apart, and the
   * server guesses among those.
   *
   * A server with no session yet guesses when it cannot know: the most recently active session
   * nobody speaks for, leaving out sessions whose client is gone. A server on a session of its
   * own moves only to a session it knows is its own, and only then takes its work along: a guess
   * may be another window, and work moved there would stay there. Where this server's own
   * ancestors cannot be read at all, nothing can be known, and the guess is the rule as before.
   */
  private async improve(project: ScopedProject): Promise<boolean> {
    const before = this.bound;
    const all = await this.hookSessions(project);
    const relations = new Map(all.map((s) => [s.id, this.relation(s)]));
    // A session that is not live (the bound guess, once it has left the live window) is looked
    // at directly rather than assumed to be among the live ones.
    const rel = (s: Session): Relation => relations.get(s.id) ?? this.relation(s);
    // Known: the session whose hooks the server's parent started, when only one has. Several is
    // one host running several sessions, which ancestry cannot tell apart: a guess among those.
    const known = all.filter((s) => rel(s).known);
    const ours = known.length === 1 ? (known[0] as Session) : null;
    if (ours && before?.id === ours.id) {
      // The guess was right: its hook record arrived after the server bound to it.
      if (!before.sure) this.take(ours.id, false, true);
      return false;
    }
    if (ours && this.take(ours.id, false, true)) {
      if (before?.own) this.handOver(before.id, ours.id);
      return true;
    }
    // A server on a session of its own moves only to a session it knows is its own: a guess may
    // be another window, and its work would stay there. Unless nothing can be known at all.
    if (before?.own && this.chain().length > 0) return false;

    // Guesses, best first: by rank, then (for launcher matches) the closest meeting point, then
    // the most recently active.
    const key = (s: Session): [number, number] => {
      const r = rel(s);
      if (r.known) return [0, 0];
      const rank = r.rank ?? Infinity;
      return [rank, rank === 1 || rank === 3 ? r.depth : 0];
    };
    const better = (x: [number, number], y: [number, number]): boolean =>
      x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
    const pool = (known.length > 1 ? known : all).filter(
      (s) => s.id !== before?.id && rel(s).rank !== null,
    );
    const ordered = pool
      .map((s, i) => ({ s, k: key(s), i }))
      .sort((x, y) => (better(x.k, y.k) ? -1 : better(y.k, x.k) ? 1 : x.i - y.i));
    // A server on a guess moves only to a strictly better one; it does not hop between equals.
    const current =
      before && !before.own
        ? (() => {
            const cur = this.mindly.store.sessions.find(before.id);
            return cur ? key(cur) : null;
          })()
        : null;
    for (const { s, k } of ordered) {
      if (current && !better(k, current)) break;
      // A server on a session of its own moves its work only onto a guess that is the one
      // window there is; otherwise it stays where it is.
      if (before?.own && !(await this.sole(project, s))) continue;
      if (!this.take(s.id, false, false)) continue;
      if (before?.own) this.handOver(before.id, s.id);
      return true;
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
      } else if (cur && !this.bound.own && !this.bound.sure) {
        // A guessed session whose client is gone (a window closed without ending its session),
        // or that has left the live window because nothing kept it alive, is let go, and the
        // server chooses again.
        const stale = this.mindly.kernel.clock.now() - cur.lastSeenAt > LIVE_WINDOW_MS;
        if (stale || this.relation(cur).windowAlive === false) this.drop();
      }
    }

    // A session known to be this client's is kept. Anything less is left for a better one.
    if (!this.bound || this.bound.own || !this.bound.sure) await this.improve(project);

    if (this.bound && !this.bound.own) {
      // The session is alive while its server is being used, whether or not a hook ran lately.
      // A guess only while its client still runs (or nothing is known about it): the server
      // must not keep the session of a window that is gone alive.
      const session = store.sessions.get(this.bound.id);
      if (this.bound.sure || this.relation(session).clientRuns !== false) {
        store.sessions.touch(this.bound.id);
      }
      this.carryWork(session.id, this.bound.sure);
      const now = store.sessions.get(this.bound.id);
      if (this.bound.sure) return { project, session: now };
      if (await this.sole(project, now)) {
        return { project, session: now, ownWrite: (taskId) => this.ownWrite(now.id, taskId) };
      }
      return this.guessScope(project, now);
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
    this.carryWork(session.id, true);
    return { project, session };
  }

  /**
   * True when the guess `session` is the one window there is, which the server then treats as its
   * own session for everything. That takes all of:
   *
   * - nothing tells that it is another window's: it is a launcher match or nothing is recorded
   *   (rank 1 or 2), its client is not known to be gone, and its client is not a process that
   *   runs outside this server's ancestry where that could be read;
   * - it is the only candidate: no other live session of this agent kind in this tree has a
   *   client that runs or may run;
   * - no other running server speaks for it, nor for any other live session of this agent kind
   *   in this tree (such a server is another window's).
   *
   * With one window (a server started through a launcher, or a system where the process table
   * cannot be read) that is the normal case.
   */
  private async sole(project: ScopedProject, session: Session): Promise<boolean> {
    const r = this.relation(session);
    if (r.rank !== 1 && r.rank !== 2) return false;
    if (r.clientRuns === false || r.foreignClient) return false;
    const others = (await this.hookSessions(project)).filter((s) => s.id !== session.id);
    if (others.some((s) => this.relation(s).clientRuns !== false)) return false;
    for (const [id, claim] of Object.entries(this.claims())) {
      if (claim.owner === this.owner) continue;
      if (id === session.id) return false;
      const s = this.mindly.store.sessions.find(id);
      if (!s || s.status === 'ended' || s.projectId !== project.project.id) continue;
      if (s.agentKind !== this.ctx.agentKind) continue;
      const root = (s.worktree ? await this.rootOf(s.worktree) : null) ?? project.mainRoot;
      if (root === project.root) return false;
    }
    return true;
  }

  /**
   * The server's own session, as a sender: what it files while it speaks for a session it cannot
   * tell from another window's is filed in its own name, so that window cannot take it as its
   * own. The session is not kept live: it exists to be named.
   */
  private selfSession(project: ScopedProject): Session {
    const store = this.mindly.store;
    const { session } = store.sessions.upsert({
      projectId: project.project.id,
      agentKind: this.ctx.agentKind,
      externalId: this.externalId,
      worktree: this.ctx.cwd,
      branch: null,
      transcriptPath: null,
    });
    if (this.bound?.id !== session.id) store.sessions.setStatus(session.id, 'ended');
    return store.sessions.get(session.id);
  }

  /**
   * The scope of a call made while the server speaks for a session it only guessed at. The
   * session it is given carries the server's own current task, not the other window's, and
   * `guess` records what this call writes, against that session whatever the server does later.
   */
  private guessScope(project: ScopedProject, session: Session): CallScope {
    const store = this.mindly.store;
    // Looked up when used, not now: by the time a slow call notes what it wrote, the server may
    // have moved on and settled what it had (and the row then goes after it from where it is).
    const work = (): ServerWork =>
      (this.work ??= {
        rows: new Map(),
        currentTask: null,
        memories: new Set(),
        currents: new Map(),
      });
    const at = session.id;
    const owns = (id: string): boolean => {
      const row = this.work?.rows.get(`task:${id}`);
      return row !== undefined && row.at === at && this.ownsTask(row, null);
    };
    const unfinished = (id: string | null | undefined): string | null => {
      if (!id || !owns(id)) return null;
      const t = store.tasks.find(id);
      return t && ['open', 'in_progress', 'blocked'].includes(t.status) ? id : null;
    };
    // The server's own current task: the one it made current, or else an unfinished one it wrote.
    const ownTask = (): string | null =>
      unfinished(this.work?.currentTask) ??
      [...(this.work?.rows.values() ?? [])]
        .filter((r) => r.kind === 'task' && r.at === at)
        .map((r) => unfinished(r.id))
        .find((id) => id !== null) ??
      null;
    const current = ownTask();
    return {
      project,
      session: { ...session, currentTaskId: current },
      guess: {
        sessionId: at,
        // Whose work a handoff describes: none of the other window's.
        workOf: () => ({ ...session, id: `mcp-work-${this.owner}`, currentTaskId: ownTask() }),
        decisionIds: () => [...(this.work?.memories ?? [])],
        self: () => this.selfSession(project),
        noteHandoff: (id, from) => {
          work().rows.set(`handoff:${id}`, {
            kind: 'handoff',
            id,
            at: from,
            updatedAt: 0,
            sig: '',
          });
        },
        note: (kind, id) => {
          const w = work();
          if (kind === 'memory') {
            if (w.memories.size < MAX_WORK_ROWS) w.memories.add(id);
            return;
          }
          if (w.rows.size >= MAX_WORK_ROWS) {
            this.logger?.warn('mcp work not recorded: too many rows on a guessed session', {
              kind,
            });
            return;
          }
          if (kind === 'message') {
            w.rows.set(`message:${id}`, { kind, id, at, updatedAt: 0, sig: '' });
            return;
          }
          const stamp = store.sessions.rowStamp(kind, id);
          if (stamp) w.rows.set(`${kind}:${id}`, { kind, id, at, ...stamp });
        },
        noteCurrentTask: (taskId) => {
          work().currentTask = taskId;
        },
        wrote: (kind, id) => this.work?.rows.has(`${kind}:${id}`) ?? false,
        owns,
        disown: (id) => {
          this.work?.rows.delete(`task:${id}`);
          if (this.work?.currentTask === id) this.work.currentTask = null;
        },
      },
    };
  }

  /**
   * True when the task the server wrote on a guess (`row`) is still its own: with the session
   * the server left it with, changed by nobody since the server last wrote it, and the current
   * task of no live session but the server's own (`ownId`, and its `mcp-` session). A window that
   * picked the task up (a handoff it claimed, say) has made it its own even where the task row
   * itself did not change.
   */
  private ownsTask(
    row: WorkRow,
    ownId: string | null,
    busy: ReadonlySet<string> | null = null,
  ): boolean {
    const store = this.mindly.store;
    const task = store.tasks.find(row.id);
    if (!task || task.ownerSessionId !== row.at) return false;
    const stamp = store.sessions.rowStamp('task', row.id);
    if (!stamp || stamp.updatedAt !== row.updatedAt || stamp.sig !== row.sig) return false;
    return !(busy ?? this.currentTasks(task.projectId, ownId)).has(task.id);
  }

  /** The current tasks of the live sessions of a project, but the server's own (`ownId`). */
  private currentTasks(projectId: string, ownId: string | null): Set<string> {
    const out = new Set<string>();
    for (const s of this.mindly.store.sessions.listLive(projectId, LIVE_WINDOW_MS)) {
      if (s.status === 'ended' || s.id === ownId || s.externalId === this.externalId) continue;
      // A current task this server set itself, acting as that session, is not the window's doing.
      if (s.currentTaskId && this.work?.currents.get(s.id) !== s.currentTaskId) {
        out.add(s.currentTaskId);
      }
    }
    return out;
  }

  /**
   * A call made while the server acted as the guessed session `sessionId` (the one window there
   * is) wrote task `taskId`. When it is a task the server tracks from a guess, this was the
   * server's own write: its stamp is taken again, and a current task the call set is the
   * server's doing, not the window's.
   */
  private ownWrite(sessionId: string, taskId: string): void {
    const work = this.work;
    const row = work?.rows.get(`task:${taskId}`);
    if (!work || !row) return;
    const store = this.mindly.store;
    try {
      const task = store.tasks.find(taskId);
      const stamp = store.sessions.rowStamp('task', taskId);
      if (!task || !stamp) return;
      const at = task.ownerSessionId === sessionId ? sessionId : row.at;
      work.rows.set(`task:${taskId}`, { ...row, at, ...stamp });
      if (store.sessions.find(sessionId)?.currentTaskId === taskId) {
        work.currents.set(sessionId, taskId);
      }
    } catch (err) {
      this.logger?.warn('mcp work not recorded', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Takes what this server did along to the session it now speaks for, and, once that session is
   * its own (`home`), settles it there: its current task is set, and nothing is tracked any more.
   * A row someone else changed in the meantime stays where it is. When moving fails, nothing is
   * dropped: the next call tries again.
   */
  private carryWork(toId: string, home: boolean): void {
    const work = this.work;
    if (!work) return;
    const store = this.mindly.store;
    try {
      // Handoffs the server filed in its own name stay so until it is home: then they are filed
      // in the name of its session, which therefore cannot pick its own handoff up.
      const projectId = this.scoped?.project.id ?? null;
      const busy = projectId ? this.currentTasks(projectId, home ? toId : null) : null;
      const moving = [...work.rows.values()].filter((r) => {
        if (r.at === toId || (r.kind === 'handoff' && !home)) return false;
        // A task that is no longer the server's own (a window took it up) stays where it is.
        if (r.kind === 'task' && !this.ownsTask(r, home ? toId : null, busy)) {
          work.rows.delete(`task:${r.id}`);
          if (work.currentTask === r.id) work.currentTask = null;
          return false;
        }
        return true;
      });
      for (const at of new Set(moving.map((r) => r.at))) {
        const rows = moving.filter((r) => r.at === at);
        const pick = (kind: WorkRow['kind']) => rows.filter((r) => r.kind === kind);
        const moved = store.sessions.moveRows(at, toId, {
          intents: pick('intent'),
          tasks: pick('task'),
          messages: pick('message').map((r) => r.id),
          handoffs: pick('handoff').map((r) => r.id),
        });
        const done = new Set([
          ...moved.intents.map((id) => `intent:${id}`),
          ...moved.tasks.map((id) => `task:${id}`),
          ...moved.messages.map((id) => `message:${id}`),
          ...moved.handoffs.map((id) => `handoff:${id}`),
        ]);
        for (const r of rows) {
          const key = `${r.kind}:${r.id}`;
          if (!done.has(key)) {
            // Changed by someone else, or no longer where this server left it: not its to move.
            work.rows.delete(key);
            continue;
          }
          const stamp =
            r.kind === 'task' || r.kind === 'intent' ? store.sessions.rowStamp(r.kind, r.id) : null;
          work.rows.set(key, { ...r, at: toId, ...(stamp ?? {}) });
        }
      }
      if (!home) return;
      this.work = null;
      // Its current task, or, when that one is finished, another unfinished task it wrote.
      const unfinished = (id: string): boolean => {
        const t = store.tasks.find(id);
        return t?.ownerSessionId === toId && ['open', 'in_progress', 'blocked'].includes(t.status);
      };
      const tasks = [...work.rows.values()].filter((r) => r.kind === 'task').map((r) => r.id);
      const current = [work.currentTask, ...tasks].find(
        (id): id is string => id !== null && tasks.includes(id) && unfinished(id),
      );
      if (current) store.sessions.setCurrentTask(toId, current);
    } catch (err) {
      this.logger?.warn('mcp work not moved', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
