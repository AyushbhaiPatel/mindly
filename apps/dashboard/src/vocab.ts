/*
 * Every word Mission Control shows for an internal concept lives here, so the dashboard and the
 * CLI speak the same language (see docs/output-style.md, "Vocabulary"). Pure functions only: no
 * React, no DOM, so the module is unit-tested in node.
 */
import type {
  Conflict,
  ConflictStatus,
  ContextItem,
  ContextPacket,
  DeliveryKind,
  DeliveryStatus,
  Handoff,
  MemoryKind,
  MemorySource,
  MindlyEvent,
  RunKind,
  RunStatus,
  Session,
  Severity,
  TaskStatus,
  Trust,
} from './types';

/* ------------------------------------------------------------------------------------------ */
/* Ids and names                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * The 8-character short id shown everywhere instead of a UUID: the last 8 hex characters with
 * dashes removed. Same logic as `shortId()` in `@mindly/core` (duplicated because core runtime
 * code must never reach the browser bundle).
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return '';
  return id.replace(/-/g, '').slice(-8);
}

const PRODUCT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  gemini: 'Gemini CLI',
  generic: 'Agent',
};

/** Product name for an agent kind slug: `claude-code` becomes "Claude Code". */
export function productName(kind: string | null | undefined): string {
  if (!kind) return 'An agent';
  const known = PRODUCT_NAMES[kind];
  if (known) return known;
  return kind
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** "Claude Code · 4409d433": the agent plus its short tag. */
export function sessionName(session: Pick<Session, 'agentKind' | 'id'> | undefined): string {
  if (!session) return 'An agent';
  return `${productName(session.agentKind)} · ${shortId(session.id)}`;
}

/** Just the product name of a session's agent ("Codex"), for running sentences. */
export function agentOf(session: Pick<Session, 'agentKind'> | undefined): string {
  return session ? productName(session.agentKind) : 'an agent';
}

/** Possessive form for sentences: "Codex's", "Claude Code's". */
export function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

/**
 * Replaces agent kind slugs inside free text written by the engine ("claude-code and codex are
 * both editing…") with product names. Only whole words are replaced.
 */
export function humanizeAgentText(text: string): string {
  return text
    .replace(/(?<![\w/.`-])(claude-code|codex|cursor|gemini-cli)(?![\w/`-]|\.\w)/g, (m) =>
      productName(m),
    )
    .replace(/\b([Ss])hadow merge/g, (_m, s: string) =>
      s === 'S' ? 'Merge check' : 'merge check',
    );
}

/* ------------------------------------------------------------------------------------------ */
/* Plurals and lists                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** "1 agent", "2 agents". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** "a", "a and b", "a, b and c". */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** First file plus "and N more". */
export function filesPhrase(files: readonly string[]): string {
  if (files.length === 0) return '';
  if (files.length === 1) return files[0]!;
  return `${files[0]} and ${count(files.length - 1, 'other file')}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Times                                                                                       */
/* ------------------------------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Relative time in local time: "just now", "40s ago", "3m ago", "2h ago", "yesterday 14:05",
 * "Mon 09:12", "3 Nov". Future times read "in 5m".
 */
export function relTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const d = Math.round((now - ms) / 1000);
  if (d < -5) {
    const f = -d;
    if (f < 60) return `in ${f}s`;
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    if (f < 86_400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86_400)}d`;
  }
  if (d < 10) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  const date = new Date(ms);
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = startOfDay(now);
  if (d < 6 * 3600 || ms >= today) return `${Math.floor(d / 3600)}h ago`;
  const dayMs = 86_400_000;
  if (ms >= today - dayMs) return `yesterday ${hhmm}`;
  if (ms >= today - 6 * dayMs) return `${WEEKDAYS[date.getDay()]} ${hhmm}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Absolute local time for tooltips: "Wed 4 Nov 2026, 14:05:09". */
export function absTime(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Status words                                                                                */
/* ------------------------------------------------------------------------------------------ */

/** Session status in words: working / idle / hit its usage limit / finished. */
export function sessionStatusWords(status: Session['status']): string {
  switch (status) {
    case 'active':
      return 'working';
    case 'idle':
      return 'idle';
    case 'rate_limited':
      return 'hit its usage limit';
    case 'ended':
      return 'finished';
    default:
      return String(status).replace(/_/g, ' ');
  }
}

/** Severity in words: FYI / check this / urgent. */
export function severityWords(severity: Severity): string {
  switch (severity) {
    case 'critical':
      return 'urgent';
    case 'warning':
      return 'check this';
    default:
      return 'FYI';
  }
}

/** Conflict status in words: open / seen / resolved / dismissed. */
export function conflictStatusWords(status: ConflictStatus): string {
  return status === 'acknowledged' ? 'seen' : status;
}

/** Button label that moves a conflict to a status. */
export function conflictActionWords(status: Exclude<ConflictStatus, 'open'>): string {
  switch (status) {
    case 'acknowledged':
      return 'Mark as seen';
    case 'resolved':
      return 'Mark resolved';
    case 'dismissed':
      return 'Dismiss';
  }
}

/** Memory kind in words: rule / decision / fact / known pitfall / note. */
export function memoryKindWords(kind: MemoryKind): string {
  return kind === 'mistake' ? 'known pitfall' : kind;
}

/** Plural memory kind for filters and counts. */
export function memoryKindPlural(kind: MemoryKind): string {
  return kind === 'mistake' ? 'known pitfalls' : `${kind}s`;
}

/** Who wrote a memory, in words: "you", "Codex", "Mindly", "the code". */
export function sourceWords(
  src: MemorySource,
  sessions: ReadonlyMap<string, Pick<Session, 'agentKind' | 'id'>>,
): string {
  if (src.type === 'user') return 'you';
  if (src.type === 'system') return 'Mindly';
  if (src.type === 'code') return 'the code';
  const s = src.sessionId ? sessions.get(src.sessionId) : undefined;
  return s ? productName(s.agentKind) : productName(src.agentKind);
}

/**
 * Trust level in words. `by` names who suggested a proposed memory ("Codex"); the result reads
 * "suggested by Codex, waiting for you".
 */
export function trustWords(trust: Trust, by?: string): string {
  switch (trust) {
    case 'approved':
      return 'approved by you';
    case 'verified':
      return 'confirmed in the code';
    case 'proposed':
      return by && by !== 'you' ? `suggested by ${by}, waiting for you` : 'waiting for you';
    case 'stale':
      return 'may be outdated (code changed)';
    case 'rejected':
      return 'rejected';
    default:
      return String(trust);
  }
}

/** Longer explanation of a trust level, for tooltips. */
export function trustHelp(trust: Trust): string {
  switch (trust) {
    case 'approved':
      return 'You wrote or approved this. Agents treat it as true.';
    case 'verified':
      return 'Mindly checked this against the repository and it still holds.';
    case 'proposed':
      return 'An agent suggested this. Agents see it as a hint until you approve it.';
    case 'stale':
      return 'The code this relied on changed. Kept for history; check whether it still holds.';
    case 'rejected':
      return 'You rejected this. It is never given to an agent again.';
    default:
      return '';
  }
}

/** Task status in words. */
export function taskStatusWords(status: TaskStatus): string {
  switch (status) {
    case 'open':
      return 'to do';
    case 'in_progress':
      return 'in progress';
    case 'abandoned':
      return 'dropped';
    default:
      return status;
  }
}

/** Status of an update for an agent: not seen yet / seen / expired. */
export function deliveryStatusWords(status: DeliveryStatus): string {
  switch (status) {
    case 'pending':
      return 'not seen yet';
    case 'delivered':
    case 'acked':
      return 'seen';
    case 'expired':
      return 'expired';
    default:
      return String(status);
  }
}

/** What an update for an agent is about. */
export function deliveryKindWords(kind: DeliveryKind): string {
  switch (kind) {
    case 'impact':
      return 'change that affects it';
    case 'stale_memory':
      return 'outdated memory';
    case 'rule':
      return 'new rule';
    default:
      return kind;
  }
}

/** Handoff status: "waiting for Claude Code" / "picked up by Codex". */
export function handoffStatusWords(
  h: Pick<Handoff, 'status' | 'toAgentKind'>,
  claimedBy?: string,
): string {
  switch (h.status) {
    case 'pending':
      return `waiting for ${h.toAgentKind ? productName(h.toAgentKind) : 'any agent'}`;
    case 'claimed':
      return `picked up by ${claimedBy ?? 'an agent'}`;
    case 'completed':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      return String(h.status);
  }
}

/** Why a handoff was made. */
export function handoffReasonWords(reason: Handoff['reason']): string {
  switch (reason) {
    case 'rate_limit':
      return 'the agent hit its usage limit';
    case 'crash':
      return 'the agent stopped unexpectedly';
    default:
      return 'handed off on purpose';
  }
}

/** Run kind: merge check / review / replay / checks. */
export function runKindWords(kind: RunKind | string | null | undefined): string {
  switch (kind) {
    case 'shadow_merge':
      return 'merge check';
    case 'replay':
      return 'replay';
    case 'review':
      return 'review';
    case 'contract_sweep':
      return 'checks run';
    default:
      return 'run';
  }
}

/** Run status in words. */
export function runStatusWords(status: RunStatus | string): string {
  switch (status) {
    case 'queued':
      return 'waiting to start';
    case 'error':
      return 'could not run';
    default:
      return String(status);
  }
}

/** Check (contract) state in words. */
export function checkStateWords(state: string): string {
  switch (state) {
    case 'unknown':
      return 'not run yet';
    case 'error':
      return 'could not run';
    default:
      return state;
  }
}

/** Generic fallback: turns any remaining enum into words. */
export function words(value: string): string {
  return value.replace(/[._]/g, ' ');
}

/* ------------------------------------------------------------------------------------------ */
/* Terms explained (tooltips)                                                                  */
/* ------------------------------------------------------------------------------------------ */

export type Term =
  | 'intent'
  | 'conflict'
  | 'handoff'
  | 'mergeCheck'
  | 'xray'
  | 'memory'
  | 'trust'
  | 'update'
  | 'check'
  | 'contextSize'
  | 'snapshot'
  | 'provenance';

/** One-sentence definitions shown the first time a term appears. */
export const TERMS: Record<Term, string> = {
  intent:
    'Intent: what an agent says it is about to edit, so other agents can stay out of the way.',
  conflict:
    'Conflict: two agents whose work collides, or a change that breaks something another agent relies on.',
  handoff:
    'Handoff: unfinished work packaged up by an agent that stopped, so the next agent can continue it.',
  mergeCheck:
    "Merge check: Mindly merges every agent's work in a scratch copy and runs the project's checks, without touching your branches.",
  xray: 'Context X-Ray: exactly what Mindly gave an agent, what it left out, and why.',
  memory:
    'Memory: rules, decisions, facts and known pitfalls that Mindly gives to every agent working in this project.',
  trust:
    'Trust: whether a memory was approved by you, confirmed in the code, only suggested by an agent, or may be outdated.',
  update:
    'Update: a note Mindly passes to an agent, for example that another agent changed a file it uses.',
  check:
    'Check: a small test tied to a memory (a file exists, a pattern is present) that keeps the memory honest.',
  contextSize:
    'Context size: how much of the space Mindly reserves in the agent’s prompt this context used. When it is full, the least relevant items are left out.',
  snapshot: 'Snapshot: code, memory and tasks saved together so you can go back to this point.',
  provenance: 'Provenance: which agent wrote a line, when, and in response to what.',
};

/* ------------------------------------------------------------------------------------------ */
/* Summary bar and "Needs you"                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface SummaryInput {
  sessions: readonly Pick<Session, 'status'>[];
  needsYou: number;
  lastMergeCheck: { status: string; at: number | null } | null;
  now?: number;
}

/** "2 agents working · 2 things need you · last merge check passed 3m ago". */
export function summaryLine(input: SummaryInput): string {
  const now = input.now ?? Date.now();
  const parts: string[] = [];
  const working = input.sessions.filter((s) => s.status === 'active').length;
  const idle = input.sessions.filter((s) => s.status === 'idle').length;
  const limited = input.sessions.filter((s) => s.status === 'rate_limited').length;
  if (working + idle + limited === 0) parts.push('No agents running');
  else {
    if (working > 0) parts.push(`${count(working, 'agent')} working`);
    if (idle > 0) parts.push(`${idle} idle`);
    if (limited > 0) parts.push(`${limited} hit ${limited === 1 ? 'its' : 'their'} usage limit`);
  }
  parts.push(
    input.needsYou === 0
      ? 'nothing needs you'
      : `${count(input.needsYou, 'thing')} ${input.needsYou === 1 ? 'needs' : 'need'} you`,
  );
  const m = input.lastMergeCheck;
  if (m) {
    if (m.status === 'queued' || m.status === 'running') parts.push('merge check running');
    else parts.push(`last merge check ${runStatusWords(m.status)} ${relTime(m.at, now)}`);
  }
  return parts.join(' · ');
}

/** True when the overview has nothing going on at all. */
export function isAllQuiet(input: SummaryInput): boolean {
  return input.needsYou === 0 && !input.sessions.some((s) => s.status !== 'ended');
}

/* ------------------------------------------------------------------------------------------ */
/* Conflicts as problem statements                                                             */
/* ------------------------------------------------------------------------------------------ */

const code = (s: string) => `\`${s}\``;

/**
 * A conflict written as a problem statement ("Claude Code changed `src/auth.ts`; Codex's work
 * uses it"). Inline code is marked with backticks; the UI renders it as code.
 */
export function conflictHeadline(
  c: Pick<Conflict, 'kind' | 'title' | 'sessionIds' | 'paths'>,
  sessions: ReadonlyMap<string, Pick<Session, 'agentKind' | 'id'>>,
): string {
  const names = [...new Set(c.sessionIds.map((id) => agentOf(sessions.get(id)))).values()].filter(
    (n) => n !== 'an agent',
  );
  const a = names[0];
  const b = names[1];
  const path = c.paths[0];
  const where = path ? code(path) : 'the same code';
  switch (c.kind) {
    case 'intent_overlap':
    case 'file_overlap':
      if (a && b) return `${a} and ${b} are both editing ${where}`;
      return `Two agents are editing ${where} at the same time`;
    case 'impact':
      if (a && b) return `${a} changed ${where}; ${possessive(b)} work uses it`;
      if (a) return `${a} changed ${where}, which other code uses`;
      break;
    case 'contract_broken':
      return `${a ? `${possessive(a)} change` : 'A change'} broke a check${
        path ? ` in ${where}` : ''
      }`;
    case 'merge_conflict':
      if (a && b) return `${a} and ${b}'s changes don't merge cleanly in ${where}`;
      return `Agents' changes don't merge cleanly in ${where}`;
    case 'check_failed':
      return "The project's checks fail when everyone's work is merged";
    case 'decision_contradiction':
      return `${a ? `${possessive(a)} change` : 'A change'} goes against a recorded decision`;
  }
  return humanizeAgentText(c.title);
}

/** Splits text with `backtick` spans into plain and code parts for rendering as text nodes. */
export function splitCode(text: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  const parts = text.split('`');
  parts.forEach((p, i) => {
    if (p) out.push({ text: p, code: i % 2 === 1 });
  });
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Context X-Ray                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** When a context packet was built, as a phrase. */
export function triggerWords(trigger: ContextPacket['trigger']): string {
  switch (trigger) {
    case 'session_start':
      return 'at session start';
    case 'prompt':
      return 'with a prompt';
    case 'pre_tool':
      return 'before using a tool';
    case 'post_tool':
      return 'after using a tool';
    case 'mcp':
      return 'when it asked Mindly';
    default:
      return words(String(trigger));
  }
}

/** Kind of item in a context packet. */
export function contextItemKindWords(kind: ContextItem['kind']): string {
  switch (kind) {
    case 'delivery':
      return 'update';
    case 'intent':
      return 'edit in progress';
    case 'session':
      return 'agent';
    default:
      return kind;
  }
}

/** Plain reason an item was left out of a context packet. */
export function omitReasonWords(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('budget') || r.includes('full') || r.includes('token')) {
    return 'the context was full';
  }
  if (r.includes('rejected')) return 'you rejected it';
  if (r.includes('stale') || r.includes('outdated')) return 'it may be outdated';
  if (r.includes('scope') || r.includes('does not match') || r.includes('branch')) {
    return 'it is about other files';
  }
  if (r.includes('threshold') || r.includes('score') || r.includes('relevan')) {
    return 'it was not relevant enough';
  }
  return humanizeAgentText(reason);
}

/** Relevance score (0..1) in words. */
export function relevanceWords(score: number): string {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

/** Context size: "short" or "long", never a token count. */
export function contextSizeWords(used: number, budget: number): string {
  if (budget <= 0) return 'short';
  return used / budget > 0.6 ? 'long' : 'short';
}

/**
 * The X-Ray story of one packet: "Codex received 3 items at session start; 2 were left out
 * because the context was full."
 */
export function xraySentence(
  p: Pick<ContextPacket, 'trigger' | 'included' | 'omitted'>,
  agent: string,
): string {
  const head = `${agent} received ${count(p.included.length, 'item')} ${triggerWords(p.trigger)}`;
  if (p.omitted.length === 0) return `${head}; nothing was left out.`;
  const reasons = new Map<string, number>();
  for (const o of p.omitted) {
    const w = omitReasonWords(o.reason);
    reasons.set(w, (reasons.get(w) ?? 0) + 1);
  }
  const n = p.omitted.length;
  const verb = n === 1 ? 'was' : 'were';
  if (reasons.size === 1) {
    return `${head}; ${n} ${verb} left out because ${[...reasons.keys()][0]}.`;
  }
  const detail = [...reasons].sort((x, y) => y[1] - x[1]).map(([w, k]) => `${k} because ${w}`);
  return `${head}; ${n} ${verb} left out (${joinWords(detail)}).`;
}

/* ------------------------------------------------------------------------------------------ */
/* Activity stream                                                                             */
/* ------------------------------------------------------------------------------------------ */

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent';

export interface EventLine {
  /** Who did it, already in plain words ("Claude Code · 4409d433"), or null for Mindly itself. */
  actor: string | null;
  /** The rest of the sentence, starting lowercase after an actor or capitalised without one. */
  text: string;
  tone: Tone;
}

function str(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.length > 160 ? `${v.slice(0, 157)}…` : v;
  }
  return null;
}

function list(payload: Record<string, unknown>, key: string): string[] {
  const v = payload[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function payloadFiles(payload: Record<string, unknown>): string | null {
  const fs = [...list(payload, 'files'), ...list(payload, 'paths')];
  const single = str(payload, 'path', 'file');
  if (single) fs.unshift(single);
  return fs.length === 0 ? null : filesPhrase(fs);
}

const quote = (s: string) => `“${s}”`;

/**
 * Renders an event as a plain sentence ("Codex · f57f6d10 started editing src/auth.ts"). Never
 * shows the event type name. Payload fields are untrusted and optional; every branch has a
 * fallback.
 */
export function describeEvent(
  ev: Pick<MindlyEvent, 'type' | 'payload' | 'sessionId'>,
  sessions: ReadonlyMap<string, Pick<Session, 'agentKind' | 'id'>>,
): EventLine {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const s = ev.sessionId ? sessions.get(ev.sessionId) : undefined;
  const kind = str(p, 'agentKind', 'agent');
  const actor = s
    ? sessionName(s)
    : kind
      ? productName(kind)
      : ev.sessionId
        ? `An agent · ${shortId(ev.sessionId)}`
        : null;
  const rawTitle = str(p, 'title', 'summary');
  const title = rawTitle ? humanizeAgentText(rawTitle) : null;
  const f = payloadFiles(p);
  const line = (text: string, tone: Tone = 'neutral'): EventLine => ({ actor, text, tone });
  const sys = (text: string, tone: Tone = 'neutral'): EventLine => ({ actor: null, text, tone });
  const memKind = str(p, 'kind');
  const memWord = memKind ? memoryKindWords(memKind as MemoryKind) : 'memory';

  switch (ev.type) {
    case 'session.started':
      return line(`started working${str(p, 'branch') ? ` on ${str(p, 'branch')}` : ''}`, 'good');
    case 'session.ended':
      return line('finished');
    case 'session.idle':
      return line('went idle');
    case 'session.rate_limited':
      return line('hit its usage limit', 'warn');
    case 'prompt.submitted':
      return line(`got a new prompt${title ? `: ${quote(title)}` : ''}`);
    case 'tool.before':
      return line(`is running ${str(p, 'tool') ?? 'a tool'}${f ? ` on ${f}` : ''}`);
    case 'tool.after':
      return line(`ran ${str(p, 'tool') ?? 'a tool'}${f ? ` on ${f}` : ''}`);
    case 'file.changed': {
      const add = typeof p.addedLines === 'number' ? p.addedLines : null;
      const rem = typeof p.removedLines === 'number' ? p.removedLines : null;
      const lines =
        add !== null || rem !== null ? ` (${count((add ?? 0) + (rem ?? 0), 'line')} changed)` : '';
      return line(`edited ${f ?? 'a file'}${lines}`);
    }
    case 'memory.created':
      return actor
        ? line(`suggested a ${memWord}: ${quote(title ?? 'untitled')}`, 'info')
        : sys(`New ${memWord}: ${quote(title ?? 'untitled')}`, 'info');
    case 'memory.updated':
      return actor
        ? line(`updated a ${memWord}: ${quote(title ?? 'untitled')}`)
        : sys(`A ${memWord} was updated: ${quote(title ?? 'untitled')}`);
    case 'memory.stale':
      return sys(
        `A ${memWord} may be outdated because the code changed: ${quote(title ?? 'untitled')}`,
        'warn',
      );
    case 'memory.archived':
      return sys(`A ${memWord} was archived: ${quote(title ?? 'untitled')}`);
    case 'rule.captured':
      return actor
        ? line(`suggested a rule: ${quote(title ?? str(p, 'body') ?? 'untitled')}`, 'accent')
        : sys(`New rule: ${quote(title ?? str(p, 'body') ?? 'untitled')}`, 'accent');
    case 'task.created':
      return line(`started a task: ${quote(title ?? 'untitled')}`);
    case 'task.updated': {
      const st = str(p, 'status');
      return line(
        `moved ${quote(title ?? 'a task')}${st ? ` to ${taskStatusWords(st as TaskStatus)}` : ''}`,
      );
    }
    case 'intent.declared':
      return line(f ? `plans to edit ${f}` : `plans to: ${title ?? 'make a change'}`, 'info');
    case 'intent.closed':
      return line(f ? `finished editing ${f}` : 'finished an edit');
    case 'conflict.opened': {
      const sev = str(p, 'severity') as Severity | null;
      return sys(
        `Conflict${sev ? ` (${severityWords(sev)})` : ''}: ${title ?? 'two agents collided'}`,
        sev === 'critical' ? 'bad' : 'warn',
      );
    }
    case 'conflict.updated': {
      const st = str(p, 'status') as ConflictStatus | null;
      return sys(
        `Conflict ${st ? `marked ${conflictStatusWords(st)}` : 'updated'}: ${title ?? 'untitled'}`,
      );
    }
    case 'delivery.queued': {
      const to = str(p, 'targetAgentKind');
      return sys(
        `Update waiting for ${to ? productName(to) : 'an agent'}${title ? `: ${title}` : ''}`,
      );
    }
    case 'delivery.delivered':
    case 'delivery.acked':
      return line(`saw an update${title ? `: ${title}` : ''}`);
    case 'handoff.created': {
      const to = str(p, 'toAgentKind');
      return line(
        `handed off ${title ? quote(title) : 'its work'} to ${to ? productName(to) : 'the next agent'}`,
        'warn',
      );
    }
    case 'handoff.claimed':
      return line(`picked up a handoff${title ? `: ${quote(title)}` : ''}`, 'good');
    case 'contract.result': {
      const state = str(p, 'state');
      const what = title ? `: ${title}` : '';
      if (state === 'passing') return sys(`Check passing${what}`, 'good');
      if (state === 'failing') return sys(`Check failing${what}`, 'bad');
      if (state === 'error') return sys(`Check could not run${what}`, 'bad');
      return sys(`Check ran${what}`);
    }
    case 'context.served': {
      const n = typeof p.items === 'number' ? p.items : null;
      return line(`received context from Mindly${n !== null ? ` (${count(n, 'item')})` : ''}`);
    }
    case 'snapshot.created':
      return sys(`Snapshot saved: ${quote(str(p, 'label') ?? 'untitled')}`);
    case 'snapshot.restored':
      return sys(
        `Snapshot restored${str(p, 'branch') ? ` to branch ${str(p, 'branch')}` : ''}`,
        'warn',
      );
    case 'run.started': {
      const k = runKindWords(str(p, 'kind'));
      return sys(`${k[0]!.toUpperCase()}${k.slice(1)} started`);
    }
    case 'run.finished': {
      const st = str(p, 'status');
      const k = runKindWords(str(p, 'kind'));
      return sys(
        `${k[0]!.toUpperCase()}${k.slice(1)} ${st ? runStatusWords(st) : 'finished'}`,
        st === 'passed' ? 'good' : st === 'failed' || st === 'error' ? 'bad' : 'neutral',
      );
    }
    case 'turn.completed':
      return line(`finished a step${title ? `: ${title}` : ''}`);
    default:
      return line('did something Mindly does not describe yet');
  }
}
