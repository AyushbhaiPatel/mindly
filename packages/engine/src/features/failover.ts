import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, normalize, relative } from 'node:path';
import {
  AGENT_KIND_RE,
  invalidInput,
  redactText,
  sanitizeLine,
  MindlyError,
  type Handoff,
  type HandoffPacket,
  type HandoffStatus,
  type Session,
  type MindlyEvent,
} from '@mindly/core';
import type { BusEvents, Kernel } from '../kernel.js';
import { NotifyOutbox } from './outbox.js';
import type { Mindly, MindlyModule } from '../mindly.js';

/*
 * Rate-limit failover. When an agent stops because it hit a usage or rate limit, Mindly marks the
 * session `rate_limited`, packages what it was doing into a handoff for the next agent in
 * `config.failover.order` and pages the user. The next session of that agent claims the handoff
 * at session start (see ContextBuilder). Launching that agent automatically is left to a runner.
 */

/** At most this many bytes are read from the end of a transcript file. */
export const MAX_TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const MAX_TEXT_PER_ENTRY = 8000;
const MAX_ENTRIES = 400;
const DAY_MS = 24 * 60 * 60_000;

/** One rate-limit signature: a stable id (recorded in events) and the pattern that detects it. */
export interface RateLimitSignature {
  id: string;
  re: RegExp;
}

// "429" alone matches line numbers and ids, so it must appear next to an HTTP/rate-limit word.
const HTTP_429 =
  /\b(?:status|code|error|http)\b\D{0,16}\b429\b|\b429\b\D{0,24}\b(?:too many requests|rate)/i;

/**
 * Per-agent rate-limit signatures. These are heuristics based on the messages each agent prints
 * today; they will drift as agents change their wording and are meant to become user-configurable.
 * Generic signatures apply to every agent. Bare phrases such as "rate limit" are deliberately
 * anchored ("rate limit reached", "hit the rate limit", ...) so an assistant talking *about* rate
 * limiting in the user's code does not trigger a failover.
 */
export const RATE_LIMIT_SIGNATURES: Readonly<Record<string, readonly RateLimitSignature[]>> = {
  'claude-code': [
    { id: 'claude.usage_limit_reached', re: /usage limit reached/i },
    { id: 'claude.five_hour_limit', re: /\b5-hour limit\b/i },
    { id: 'claude.limit_will_reset', re: /limit will reset/i },
    { id: 'claude.rate_limit_error', re: /\brate_limit_error\b/ },
    { id: 'claude.http_429', re: HTTP_429 },
  ],
  codex: [
    { id: 'codex.usage_limit', re: /you(?:'|\u2019)ve hit your usage limit/i },
    {
      id: 'codex.rate_limit',
      re: /\brate limit(?:ed| (?:reached|exceeded|hit))\b|\bhit (?:a|the|your) rate limit\b|\brate limit\b.{0,40}\b(?:try again|retry|resets?)\b/i,
    },
    { id: 'codex.http_429', re: HTTP_429 },
  ],
  generic: [
    { id: 'generic.usage_limit', re: /\busage limit (?:reached|exceeded|hit)\b/i },
    { id: 'generic.rate_limit', re: /\brate[ _-]?limit(?:ed|[ _](?:exceeded|reached|error))\b/i },
    { id: 'generic.too_many_requests', re: /\btoo many requests\b/i },
    { id: 'generic.quota_exceeded', re: /\bquota (?:exceeded|exhausted)\b/i },
    { id: 'generic.http_429', re: HTTP_429 },
  ],
};

/** Signatures that apply to `agentKind`: its own, then the generic fallbacks. */
export function signaturesFor(agentKind: string): RateLimitSignature[] {
  const own = Object.hasOwn(RATE_LIMIT_SIGNATURES, agentKind)
    ? (RATE_LIMIT_SIGNATURES[agentKind] ?? [])
    : [];
  return [...own, ...(RATE_LIMIT_SIGNATURES.generic ?? [])];
}

/** Returns the id of the first matching signature, or null. Input is treated as untrusted text. */
export function detectRateLimit(agentKind: string, texts: readonly string[]): string | null {
  const sigs = signaturesFor(agentKind);
  for (const raw of texts.slice(-MAX_ENTRIES)) {
    const text = raw.slice(0, MAX_TEXT_PER_ENTRY);
    for (const s of sigs) if (s.re.test(text)) return s.id;
  }
  return null;
}

function insideDir(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Reads at most `maxBytes` from the end of a transcript file. Returns null unless `path` is an
 * absolute path to a regular file. If any component of the path is a symlink, the resolved file
 * must be inside `homeDir`. A partial first line is dropped when the file was cut.
 */
export function readTranscriptTail(
  path: string,
  homeDir: string = homedir(),
  maxBytes: number = MAX_TRANSCRIPT_TAIL_BYTES,
): string | null {
  if (!isAbsolute(path) || path.includes('\0') || path.length > 4096) return null;
  let fd: number | null = null;
  try {
    const real = realpathSync(path);
    if (real !== normalize(path)) {
      let home: string;
      try {
        home = realpathSync(homeDir);
      } catch {
        return null;
      }
      if (!insideDir(home, real)) return null;
    }
    if (!statSync(real).isFile()) return null;
    fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, Math.max(0, maxBytes));
    if (len === 0) return '';
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    let text = buf.subarray(0, n).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** One parsed transcript line. */
export interface TranscriptEntry {
  /** Entry time in ms, when the line carries a timestamp. */
  ts: number | null;
  /** True for entries authored on the user side (prompts, tool results). */
  user: boolean;
  text: string;
}

function collectText(value: unknown, out: string[], budget: { left: number }, depth: number): void {
  if (budget.left <= 0 || depth > 8) return;
  if (typeof value === 'string') {
    const s = value.slice(0, budget.left);
    budget.left -= s.length;
    out.push(s);
  } else if (Array.isArray(value)) {
    for (const v of value.slice(0, 50)) collectText(v, out, budget, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value).slice(0, 50)) {
      // Skip opaque blobs and metadata that cannot carry a rate-limit message.
      if (key === 'signature' || key === 'data' || key === 'uuid' || key === 'parentUuid') continue;
      collectText(v, out, budget, depth + 1);
    }
  }
}

function field(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function isUserSide(obj: unknown): boolean {
  const markers = [
    field(obj, 'type'),
    field(obj, 'role'),
    field(field(obj, 'message'), 'role'),
    field(field(obj, 'payload'), 'type'),
    field(field(obj, 'payload'), 'role'),
  ];
  return markers.some((m) => m === 'user' || m === 'user_message');
}

function parseTs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v.length <= 64) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Parses JSONL transcript text (Claude Code / Codex style). Non-JSON lines become raw entries. */
export function parseTranscriptTail(tail: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of tail.split('\n').slice(-MAX_ENTRIES)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      out.push({ ts: null, user: false, text: trimmed.slice(0, MAX_TEXT_PER_ENTRY) });
      continue;
    }
    const parts: string[] = [];
    collectText(obj, parts, { left: MAX_TEXT_PER_ENTRY }, 0);
    out.push({
      ts: parseTs(field(obj, 'timestamp')),
      user: isUserSide(obj),
      text: parts.join('\n'),
    });
  }
  return out;
}

/**
 * Agent-side texts newer than `since`. Entries with timestamps are compared directly; when the
 * transcript has no timestamps, only entries after the last user-side entry are considered.
 */
export function recentAgentTexts(entries: readonly TranscriptEntry[], since: number): string[] {
  const anyTs = entries.some((e) => e.ts !== null);
  let lastUser = -1;
  entries.forEach((e, i) => {
    if (e.user) lastUser = i;
  });
  return entries
    .filter((e, i) => !e.user && (anyTs ? e.ts !== null && e.ts >= since : i > lastUser))
    .map((e) => e.text);
}

async function safely<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

function promptSummaries(events: readonly MindlyEvent[]): string[] {
  return events
    .map((e) => (typeof e.payload.summary === 'string' ? sanitizeLine(e.payload.summary, 200) : ''))
    .filter((s) => s.length > 0)
    .reverse();
}

/** Extra content a caller can add to a handoff packet (already-untrusted input is cleaned). */
export interface HandoffExtras {
  goal?: string;
  nextSteps?: string[];
  blockers?: string[];
}

/**
 * Builds a handoff packet for `session` from the engine state: its task (plan, blockers, undone
 * steps), files it changed, its last three prompt summaries (already redacted), memories it
 * created in the last 24 h and the current branch/HEAD.
 */
export async function buildHandoffPacket(
  k: Kernel,
  session: Session,
  extras: HandoffExtras = {},
): Promise<{ packet: HandoffPacket; taskId: string | null }> {
  const now = k.clock.now();
  const task =
    (session.currentTaskId ? k.store.tasks.find(session.currentTaskId) : null) ??
    k.store.tasks.ownedBy(session.id)[0] ??
    null;
  const prompts = k.store.events.query(session.projectId, {
    sessionId: session.id,
    types: ['prompt.submitted'],
    order: 'desc',
    limit: 3,
  });
  const recentPrompts = promptSummaries(prompts);
  const decisions = k.store.memories
    .list(session.projectId, { updatedSince: now - DAY_MS, limit: 200 })
    .filter(
      (m) =>
        m.source.sessionId === session.id && m.createdAt >= now - DAY_MS && m.trust !== 'rejected',
    )
    .map((m) => m.title)
    .slice(0, 10);
  const filesChanged = k.store.fileChanges.recentPaths(session.id, session.startedAt).slice(0, 50);
  const branch =
    (await safely(k.ports.git.currentBranch(session.worktree), null)) ?? session.branch;
  const headCommit = await safely(k.ports.git.headCommit(session.worktree), null);
  const plan = task?.plan ?? [];
  const nextSteps = extras.nextSteps ?? plan.filter((s) => !s.done).map((s) => s.text);
  const packet: HandoffPacket = {
    goal:
      task?.title ??
      extras.goal ??
      recentPrompts[recentPrompts.length - 1] ??
      "Continue the previous session's work",
    plan,
    filesChanged,
    recentPrompts,
    decisions,
    blockers: [...(task?.blockers ?? []), ...(extras.blockers ?? [])].slice(0, 20),
    nextSteps: nextSteps.slice(0, 20),
    branch: branch ? sanitizeLine(branch, 200) : null,
    headCommit: headCommit && /^[0-9a-f]{7,64}$/i.test(headCommit) ? headCommit : null,
  };
  return { packet, taskId: task?.id ?? null };
}

/** Input for a manual handoff (MCP tool or CLI). */
export interface ManualHandoffInput {
  /** Agent kind that should pick it up; null or omitted means any agent. */
  toAgentKind?: string | null;
  summary: string;
  nextSteps?: string[];
  blockers?: string[];
}

/** Manual handoffs: create, list and cancel. */
export class HandoffService {
  constructor(private readonly k: Kernel) {}

  private clean(text: string, max: number): string {
    return sanitizeLine(
      redactText(text, { extraPatterns: this.k.config.redaction.extraPatterns }),
      max,
    );
  }

  /** Creates a pending handoff from `session` for the next session of `toAgentKind`. */
  async create(session: Session, input: ManualHandoffInput): Promise<Handoff> {
    const to = input.toAgentKind ?? null;
    if (to !== null && !AGENT_KIND_RE.test(to)) throw invalidInput('invalid agent kind');
    const summary = this.clean(input.summary, 300);
    if (!summary) throw invalidInput('handoff summary is empty');
    const cleanList = (items: readonly string[] | undefined): string[] | undefined =>
      items
        ?.slice(0, 20)
        .map((s) => this.clean(s, 300))
        .filter((s) => s.length > 0);
    const nextSteps = cleanList(input.nextSteps);
    const blockers = cleanList(input.blockers);
    const { packet, taskId } = await buildHandoffPacket(this.k, session, {
      goal: summary,
      ...(nextSteps ? { nextSteps } : {}),
      ...(blockers ? { blockers } : {}),
    });
    const handoff = this.k.store.handoffs.create({
      projectId: session.projectId,
      fromSessionId: session.id,
      toAgentKind: to,
      taskId,
      reason: 'manual',
      summary,
      packet,
    });
    this.k.store.events.append({
      projectId: session.projectId,
      sessionId: session.id,
      type: 'handoff.created',
      payload: { handoffId: handoff.id, reason: 'manual', toAgentKind: to },
    });
    return handoff;
  }

  /** Recent handoffs of a project, optionally filtered by status. */
  list(projectId: string, status?: HandoffStatus): Handoff[] {
    const all = this.k.store.handoffs.list(projectId, 100);
    return status ? all.filter((h) => h.status === status) : all;
  }

  /** Cancels a pending handoff. Throws `conflict` if it was already claimed or closed. */
  cancel(id: string): Handoff {
    const h = this.k.store.handoffs.get(id);
    if (h.status !== 'pending') {
      throw new MindlyError('conflict', `handoff is ${h.status}, not pending`);
    }
    this.k.store.handoffs.setStatus(id, 'cancelled');
    return this.k.store.handoffs.get(id);
  }
}

/** A rate-limit handoff waiting for an agent; consumed by a future auto-launch runner. */
export interface PendingLaunch {
  handoffId: string;
  projectId: string;
  projectRoot: string;
  fromSessionId: string;
  fromAgentKind: string | null;
  toAgentKind: string | null;
  worktree: string | null;
  branch: string | null;
  createdAt: number;
  /** Mirrors `config.failover.autoLaunch`; the runner must not launch when false. */
  autoLaunch: boolean;
}

/** Options for the failover feature. */
export interface FailoverOptions {
  /** Home directory used for the transcript symlink check (defaults to `os.homedir()`). */
  homeDir?: string;
}

/** Detects rate limits on `turn.stopped` and turns them into handoffs. */
export class FailoverService {
  readonly handoffs: HandoffService;
  private readonly homeDir: string;

  constructor(
    private readonly k: Kernel,
    options: FailoverOptions = {},
  ) {
    this.handoffs = new HandoffService(k);
    this.homeDir = options.homeDir ?? homedir();
  }

  /** The agent that should continue after `limited`, per `config.failover.order`. */
  nextAgent(limited: string): string | null {
    return this.k.config.failover.order.find((a) => a !== limited) ?? null;
  }

  /**
   * Bus handler for `turn.stopped`. Returns the created handoff, or null when nothing was detected
   * (or failover is disabled, or this prompt's rate limit was already handled).
   */
  async onTurnStopped(p: BusEvents['turn.stopped']): Promise<Handoff | null> {
    if (!this.k.config.failover.enabled) return null;
    const session = this.k.store.sessions.find(p.session.id) ?? p.session;
    const lastPrompt = this.k.store.events.query(p.projectId, {
      sessionId: session.id,
      types: ['prompt.submitted'],
      order: 'desc',
      limit: 1,
    })[0];
    const since = lastPrompt?.createdAt ?? session.startedAt;
    const epoch = lastPrompt?.id ?? `start:${session.startedAt}`;
    const guardKey = `failover.detected:${session.id}`;
    if (this.k.store.kv.get<string>(guardKey) === epoch) return null;

    const texts: string[] = [];
    if (p.lastMessage) texts.push(p.lastMessage.slice(0, MAX_TEXT_PER_ENTRY));
    const path = p.transcriptPath ?? session.transcriptPath;
    if (path) {
      const tail = readTranscriptTail(path, this.homeDir);
      if (tail) texts.push(...recentAgentTexts(parseTranscriptTail(tail), since));
    }
    const signature = detectRateLimit(session.agentKind, texts);
    if (!signature) return null;
    this.k.store.kv.set(guardKey, epoch);
    return this.handleRateLimit(p.projectId, session, signature);
  }

  private async handleRateLimit(
    projectId: string,
    session: Session,
    signature: string,
  ): Promise<Handoff | null> {
    this.k.store.sessions.setStatus(session.id, 'rate_limited');
    const existing = this.k.store.handoffs
      .list(projectId, 100)
      .find(
        (h) =>
          h.fromSessionId === session.id && h.reason === 'rate_limit' && h.status === 'pending',
      );
    const to = this.nextAgent(session.agentKind);
    this.k.store.events.append({
      projectId,
      sessionId: session.id,
      type: 'session.rate_limited',
      payload: {
        agent: session.agentKind,
        signature,
        toAgentKind: to,
        handoffId: existing?.id ?? null,
      },
    });
    if (existing) return null;

    const { packet, taskId } = await buildHandoffPacket(this.k, session);
    const handoff = this.k.store.handoffs.create({
      projectId,
      fromSessionId: session.id,
      toAgentKind: to,
      taskId,
      reason: 'rate_limit',
      summary: sanitizeLine(`${session.agentKind} hit its usage limit: ${packet.goal}`, 300),
      packet,
    });
    this.k.store.events.append({
      projectId,
      sessionId: session.id,
      type: 'handoff.created',
      payload: { handoffId: handoff.id, reason: 'rate_limit', toAgentKind: to },
    });
    await this.notify(projectId, session, to, handoff.id);
    return handoff;
  }

  private async notify(
    projectId: string,
    session: Session,
    to: string | null,
    handoffId: string,
  ): Promise<void> {
    if (!this.k.config.notify.triggers.includes('rate_limited')) return;
    try {
      const project = sanitizeLine(this.k.store.projects.get(projectId).name, 80);
      // Titles and counts only: never prompt text or code (docs/security.md, T3). This runs
      // inside a hook, which cannot wait for a pager: the page is written down and sent by the
      // daemon or once the hook has answered (see outbox.ts).
      new NotifyOutbox(this.k).enqueue({
        trigger: 'rate_limited',
        title: `${session.agentKind} hit its usage limit`,
        body: `${session.agentKind} hit its usage limit in ${project}; handoff ready for ${to ?? 'the next agent'}`,
        projectName: project,
        priority: 'high',
        dedupeKey: `rate_limited:${handoffId}`,
      });
    } catch (err) {
      this.k.logger.warn('rate-limit notification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Pending rate-limit handoffs a runner could act on. Information only: nothing is launched here,
   * and a runner must honour `autoLaunch`.
   */
  pendingLaunch(projectId?: string): PendingLaunch[] {
    const projects = projectId
      ? [this.k.store.projects.get(projectId)]
      : this.k.store.projects.list().slice(0, 200);
    const out: PendingLaunch[] = [];
    for (const project of projects) {
      for (const h of this.k.store.handoffs.list(project.id, 50)) {
        if (h.status !== 'pending' || h.reason !== 'rate_limit') continue;
        const from = this.k.store.sessions.find(h.fromSessionId);
        out.push({
          handoffId: h.id,
          projectId: project.id,
          projectRoot: project.root,
          fromSessionId: h.fromSessionId,
          fromAgentKind: from?.agentKind ?? null,
          toAgentKind: h.toAgentKind,
          worktree: from?.worktree ?? null,
          branch: h.packet.branch,
          createdAt: h.createdAt,
          autoLaunch: this.k.config.failover.autoLaunch,
        });
      }
    }
    return out;
  }
}

const services = new WeakMap<Mindly, FailoverService>();
const registered = new WeakSet<Mindly>();

/** The failover service attached to `mindly` (created on first use). */
export function failoverService(mindly: Mindly, options: FailoverOptions = {}): FailoverService {
  let svc = services.get(mindly);
  if (!svc) {
    svc = new FailoverService(mindly.kernel, options);
    services.set(mindly, svc);
  }
  return svc;
}

/** Creates the failover module with options (e.g. a custom home directory in tests). */
export function createFailoverModule(options: FailoverOptions = {}): MindlyModule {
  return (mindly) => {
    if (registered.has(mindly)) return;
    registered.add(mindly);
    const svc = failoverService(mindly, options);
    mindly.bus.on('turn.stopped', 'failover', async (p) => {
      await svc.onTurnStopped(p);
    });
  };
}

/** Rate-limit failover module: `mindly.use(failoverModule)`. */
export const failoverModule: MindlyModule = createFailoverModule();
