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
  SaveKind,
  SaveStatus,
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
  // Rules imported from AGENTS.md, CLAUDE.md, … (same check as isRepoFileSource in @mindly/core).
  if (src.type === 'agent' && src.sessionId === null && src.agentKind === 'repo-file') {
    return 'a repository file';
  }
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

/** What one save of each kind is (the share card uses the same words for its counts). */
export function saveKindWords(kind: SaveKind | string): string {
  switch (kind) {
    case 'impact_warned':
      return 'Told about a change before building on it';
    case 'overlap_avoided':
      return "Stopped before overwriting another agent's work";
    case 'rule_enforced':
      return 'Write blocked by your rule';
    case 'mistake_avoided':
      return 'Known pitfall avoided';
    case 'merge_conflict_early':
      return 'Merge conflict found before merging';
    case 'check_broken_early':
      return 'Broken check fixed before merging';
    case 'limit_handoff':
      return 'Work continued after a usage limit';
    default:
      return 'Save';
  }
}

/** A save's status in plain words. */
export function saveStatusWords(status: SaveStatus | string): string {
  switch (status) {
    case 'caught':
      return 'pending';
    case 'confirmed':
      return 'counted';
    case 'expired':
      return 'not confirmed in time';
    case 'rejected':
      return 'not a save';
    default:
      return status;
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
    case 'bisect':
      return 'bisect';
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

/** State of a split part in words. */
export function splitPartStateWords(
  state: 'waiting' | 'working' | 'done' | 'blocked' | string,
): string {
  switch (state) {
    case 'waiting':
      return 'waiting for an agent';
    case 'working':
      return 'in progress';
    default:
      return String(state);
  }
}

/** Status of a split in words. */
export function splitStatusWords(status: 'active' | 'merged' | 'aborted' | string): string {
  switch (status) {
    case 'active':
      return 'in progress';
    case 'aborted':
      return 'abandoned';
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
  | 'provenance'
  | 'needsYou'
  | 'agents'
  | 'tasks'
  | 'runs'
  | 'split'
  | 'standup'
  | 'configTrust'
  | 'saves';

/**
 * Explanations shown only in the "?" tooltip next to a section label. The page itself states
 * facts; anything that explains a concept belongs here.
 */
export const TERMS: Record<Term, string> = {
  saves:
    'Save: a time Mindly demonstrably helped, for example an agent was told about a change before it wrote code using it. A save counts only when what happened next shows the problem was avoided, and it links to the events that prove it.',
  intent:
    'Intent: what an agent says it is about to edit, so other agents can stay out of the way. An intent expires unless the agent renews it.',
  conflict:
    'Conflict: two agents whose work collides, or a change that breaks something another agent relies on. Decide which change wins, then mark it resolved.',
  handoff:
    'Handoff: unfinished work packaged up by an agent that stopped (for example at its usage limit). The next session of the agent it names picks it up and continues.',
  mergeCheck:
    "Merge check: Mindly merges every agent's work in a scratch copy and runs the project's checks, without touching your branches.",
  xray: 'Context X-Ray: each time an agent starts, gets a prompt or is about to edit a file, Mindly sends it what matters right now. This shows what it got, what was left out, and why. Newest first.',
  memory:
    'Memory: rules, decisions, facts and known pitfalls that Mindly gives to every agent working in this project. Approved rules apply to every agent.',
  trust:
    'Trust: whether a memory was approved by you, confirmed in the code, only suggested by an agent (a hint until you approve it), or may be outdated because the code it relied on changed.',
  update:
    'Update: a note Mindly passes to an agent, for example that another agent changed a file it uses.',
  check:
    'Check: a small test tied to a memory (a file exists, a pattern is present) that keeps the memory honest.',
  contextSize:
    'Context size: how much of the space Mindly reserves in the agent’s prompt this context used. When it is full, the least relevant items are left out.',
  snapshot:
    'Snapshot: code (tracked and untracked), memory and tasks saved together. Restoring creates a new branch and never touches your current one.',
  provenance:
    'Provenance: which agent wrote a line, when, and in response to what. Lines written by a person or before Mindly was installed have no record.',
  needsYou:
    'Needs you: decisions only you can make. Suggested rules and memories are hints to agents until you approve them; a handoff is picked up by the next session of the agent it names; a blocked split part or a failed split merge check waits for you.',
  agents:
    'Agents: Claude Code, Codex and Cursor sessions active in this project in the last 30 minutes. Editing lists the files each agent said it is about to change.',
  tasks:
    'Tasks: what each agent is working on and its plan, shared so agents do not duplicate work.',
  runs: 'Runs: merge checks, cross-agent reviews (another agent reads the changes) and replays (several agents get the same prompt in separate copies, compared side by side). Reviews and replays launch agents on this machine and may use paid API quota.',
  split:
    'Split: one goal divided into parts, each worked on by an agent in its own copy of the repository (a git worktree next to it) with the files it owns. Agents are warned, or blocked in strict mode, when they edit another part\u2019s files. The contract is the set of decisions the parts share. Merging combines the parts into one new branch and never touches your branches.',
  standup: 'Standup: a short written summary of what agents did in the chosen period.',
  configTrust:
    "Config trust: Mindly runs no command from this repository's .mindly/config.json until you trust that exact file. If the file changes, Mindly asks again. Without trust, merge checks combine the work but skip the commands.",
};

/* ------------------------------------------------------------------------------------------ */
/* Stat row and "Needs you"                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface StatInput {
  sessions: readonly Pick<Session, 'status'>[];
  needsYou: number;
  lastMergeCheck: { status: string; at: number | null } | null;
  /** Confirmed saves of the last 7 days; the stat is left out while unknown. */
  saves?: number;
}

export interface Stat {
  /** A count, or one word for the merge check ("failed"). */
  value: string;
  label: string;
  tone: Tone;
  /** For the merge check: when it finished, shown after the label. */
  at?: number | null;
}

/**
 * The Mission Control stat row: counts as numbers with a label underneath, and the last merge
 * check as one word ("failed").
 */
export function overviewStats(input: StatInput): Stat[] {
  const by = (st: Session['status']) => input.sessions.filter((s) => s.status === st).length;
  const out: Stat[] = [
    { value: String(by('active')), label: 'working', tone: 'good' },
    { value: String(by('idle')), label: 'idle', tone: 'warn' },
  ];
  const limited = by('rate_limited');
  if (limited > 0) out.push({ value: String(limited), label: 'at usage limit', tone: 'bad' });
  out.push({
    value: String(input.needsYou),
    label: 'need you',
    tone: input.needsYou > 0 ? 'bad' : 'neutral',
  });
  if (input.saves !== undefined) {
    out.push({
      value: String(input.saves),
      label: input.saves === 1 ? 'save this week' : 'saves this week',
      tone: input.saves > 0 ? 'good' : 'neutral',
    });
  }
  const m = input.lastMergeCheck;
  if (!m) {
    out.push({ value: 'none', label: 'merge check', tone: 'neutral' });
    return out;
  }
  const running = m.status === 'queued' || m.status === 'running';
  out.push({
    value: running ? 'running' : runStatusWords(m.status),
    label: 'merge check',
    tone:
      m.status === 'passed'
        ? 'good'
        : m.status === 'failed' || m.status === 'error'
          ? 'bad'
          : 'info',
    at: m.at,
  });
  return out;
}

/** What a "Needs you" row is about. */
export type NeedKind = 'conflict' | 'rule' | 'memory' | 'handoff' | 'split';

/** Kind label at the start of a "Needs you" row: "Conflict", "Rule", "Memory", "Handoff". */
export function needKindWords(kind: NeedKind): string {
  return kind[0]!.toUpperCase() + kind.slice(1);
}

/** The one action of a "Needs you" row. */
export function needActionWords(kind: NeedKind): string {
  switch (kind) {
    case 'conflict':
      return 'Resolve';
    case 'handoff':
      return 'Details';
    case 'split':
      return 'Open';
    default:
      return 'Review';
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Tables                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * Short age for time columns: "now", "12s", "3m", "2h", "4d", then a date. No "ago": the column
 * says what it is.
 */
export function shortAge(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const d = Math.max(0, Math.round((now - ms) / 1000));
  if (d < 10) return 'now';
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h`;
  if (d < 7 * 86_400) return `${Math.floor(d / 86_400)}d`;
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** "+2 more" after a truncated list. */
export function moreWords(n: number): string {
  return `+${n} more`;
}

/** Trust in one or two words, for a table column. */
export function trustShort(trust: Trust): string {
  switch (trust) {
    case 'approved':
      return 'approved';
    case 'verified':
      return 'confirmed in code';
    case 'proposed':
      return 'waiting for you';
    case 'stale':
      return 'may be outdated';
    case 'rejected':
      return 'rejected';
    default:
      return String(trust);
  }
}

/** Order of the one-line memory summary on Mission Control. */
export const MEMORY_SUMMARY_ORDER: readonly Trust[] = ['approved', 'verified', 'proposed', 'stale'];

/** The one-line memory summary: "3 approved", "1 confirmed in code", … (zero counts left out). */
export function memorySummary(
  counts: Partial<Record<Trust, number>>,
): { trust: Trust; n: number; text: string }[] {
  return MEMORY_SUMMARY_ORDER.filter((t) => (counts[t] ?? 0) > 0).map((t) => ({
    trust: t,
    n: counts[t] ?? 0,
    text: trustShort(t),
  }));
}

/** Task progress as "1/3", or an empty string when the task has no plan. */
export function progressWords(done: number, total: number): string {
  return total > 0 ? `${done}/${total}` : '';
}

/** Column headers, shared by every table. */
export const COLUMNS = {
  agent: 'Agent',
  task: 'Task',
  editing: 'Editing',
  active: 'Active',
  severity: 'Severity',
  what: 'What',
  agents: 'Agents',
  age: 'Age',
  check: 'Check',
  result: 'Result',
  time: 'Time',
  trust: 'Trust',
  kind: 'Kind',
  title: 'Title',
  from: 'From',
  updated: 'Updated',
  status: 'Status',
  owner: 'Owner',
  progress: 'Progress',
  edit: 'Edit',
  files: 'Files',
  expires: 'Expires',
  update: 'Update',
  route: 'From → to',
  when: 'When',
  handoff: 'Handoff',
  item: 'Item',
  relevance: 'Relevance',
  why: 'Why',
  version: 'Version',
  change: 'Change',
  by: 'By',
  type: 'Type',
  ref: 'Ref',
  checked: 'Checked',
  spec: 'Spec',
  lastRun: 'Last run',
  fileLine: 'File:line',
  finding: 'Finding',
  label: 'Label',
  commit: 'Commit',
  saved: 'Saved',
  name: 'Name',
  command: 'Command',
} as const;

/** Empty states: the fact only. Explanations live in the "?" tooltips (TERMS). */
export const EMPTY = {
  needsYou: 'Nothing needs you.',
  agents: 'No agents active in the last 30 minutes.',
  conflicts: 'No open conflicts.',
  mergeCheck: 'No merge check yet.',
  memory: 'No memories yet.',
  memoryFiltered: 'No memories match these filters.',
  memoryArchived: 'Nothing archived.',
  activity: 'No activity yet.',
  tasks: 'No tasks.',
  intents: 'No agent is editing anything.',
  deliveries: 'No updates.',
  deliveriesUnseen: 'Every update has been seen.',
  deliveriesSeen: 'No update has been seen yet.',
  handoffs: 'No handoffs.',
  runs: 'Nothing has run yet.',
  split: 'No split in this project. Start one with mindly split "<goal>".',
  splitContract: 'No shared contract.',
  splitFiles: 'No files changed yet.',
  runWaiting: 'Waiting to start.',
  runRunning: 'Running.',
  runResult: 'No result yet.',
  findings: 'No findings.',
  replay: 'No agent reported a result.',
  xray: 'No context sent to this agent yet.',
  included: 'Nothing included.',
  omitted: 'Nothing left out.',
  standup: 'No agent activity in this period.',
  snapshots: 'No snapshots yet.',
  evidence: 'No evidence linked.',
  checks: 'No checks.',
  givenTo: 'Not given to any agent yet.',
  provenance: 'No agent edit recorded for this line.',
  configChecks: 'No checks defined.',
  saves:
    'No saves this week. One appears when Mindly warns or stops an agent and what happens next shows the problem was avoided.',
} as const;

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

/**
 * The short "What" column of a conflict row: no agent names (they have their own column).
 * "Both editing `src/auth.ts`", "Change broke a check in `src/x.ts`".
 */
export function conflictWhat(
  c: Pick<Conflict, 'kind' | 'title' | 'sessionIds' | 'paths'>,
  sessions: ReadonlyMap<string, Pick<Session, 'agentKind' | 'id'>>,
): string {
  const path = c.paths[0];
  const where = path ? code(path) : 'the same code';
  switch (c.kind) {
    case 'intent_overlap':
    case 'file_overlap':
      return `Both editing ${where}`;
    case 'impact': {
      const a = agentOf(sessions.get(c.sessionIds[0] ?? ''));
      return `${a === 'an agent' ? 'A change to' : `${a} changed`} ${where}`;
    }
    case 'contract_broken':
      return `Change broke a check${path ? ` in ${where}` : ''}`;
    case 'merge_conflict':
      return `Changes don't merge cleanly in ${where}`;
    case 'check_failed':
      return 'Checks fail when the work is merged';
    case 'decision_contradiction':
      return 'Change goes against a recorded decision';
  }
  return humanizeAgentText(c.title);
}

/**
 * The "Agents" column of a conflict row: "Claude Code, Codex", or "Codex → Cursor" when one
 * agent's change affects another's work.
 */
export function conflictAgents(
  c: Pick<Conflict, 'kind' | 'sessionIds'>,
  sessions: ReadonlyMap<string, Pick<Session, 'agentKind' | 'id'>>,
): string {
  const names = [...new Set(c.sessionIds.map((id) => agentOf(sessions.get(id))))].filter(
    (n) => n !== 'an agent',
  );
  if (names.length === 0) return '—';
  if (c.kind === 'impact' && names.length === 2) return `${names[0]} → ${names[1]}`;
  return names.join(', ');
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
  /** Who did it, as a product name ("Claude Code"), or null for Mindly itself. */
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
 * Renders an event as an actor ("Codex") and the rest of a plain sentence ("started editing
 * src/auth.ts"). Ids never appear in the line. Never
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
    ? productName(s.agentKind)
    : kind
      ? productName(kind)
      : ev.sessionId
        ? 'An agent'
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
    case 'tool.before': {
      if (str(p, 'deniedBy')) {
        return line(`was stopped by your rule from editing ${f ?? 'a file'}`, 'warn');
      }
      if (Array.isArray(p.overlaps) && p.overlaps.length > 0) {
        return line(`was told another agent is editing ${f ?? 'the same file'}`, 'warn');
      }
      const cmd = str(p, 'command');
      if (cmd && list(p, 'mistakes').length > 0) {
        return line(`was reminded that \`${cmd}\` failed before`, 'warn');
      }
      return line(`is running ${str(p, 'tool') ?? 'a tool'}${f ? ` on ${f}` : ''}`);
    }
    case 'tool.after': {
      const cmd = str(p, 'command');
      if (cmd) {
        // `again: false`: a command of a session waiting for evidence, not the one it was warned about.
        const failed =
          p.failed === true ? (p.again === false ? ', which failed' : ', which failed again') : '';
        return line(`ran \`${cmd}\`${failed}`);
      }
      return line(`ran ${str(p, 'tool') ?? 'a tool'}${f ? ` on ${f}` : ''}`);
    }
    case 'file.changed': {
      const add = typeof p.addedLines === 'number' ? p.addedLines : null;
      const rem = typeof p.removedLines === 'number' ? p.removedLines : null;
      const diff = [add ? `+${add}` : '', rem ? `−${rem}` : ''].filter(Boolean).join(' ');
      const lines = diff ? ` (${diff})` : '';
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
    case 'split.created': {
      const n = list(p, 'parts').length;
      return sys(`Split started with ${n > 0 ? count(n, 'part') : 'several parts'}`, 'accent');
    }
    case 'split.merged': {
      const branch = str(p, 'branch');
      return sys(`Split merged${branch ? ` into ${branch}` : ''}`, 'good');
    }
    case 'split.aborted':
      return sys('Split abandoned; its worktrees were removed', 'warn');
    case 'turn.completed':
      return line(`finished a step${title ? `: ${title}` : ''}`);
    case 'save.caught':
      return sys(`Possible save, waiting for evidence${title ? `: ${title}` : ''}`, 'info');
    case 'save.confirmed':
      return sys(`Mindly saved you${title ? `: ${title}` : ''}`, 'good');
    case 'save.rejected':
      return sys(`Not counted as a save${title ? `: ${title}` : ''}`);
    default:
      return line('did something Mindly does not describe yet');
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Plain-language introductions: always visible, one sentence, under a title                 */
/* ------------------------------------------------------------------------------------------ */

/** The five pages, in the order of the navigation. */
export type Page = 'home' | 'memory' | 'agents' | 'history' | 'settings';

export const PAGES: readonly { key: Page; label: string; intro: string }[] = [
  {
    key: 'home',
    label: 'Home',
    intro:
      'What your agents are doing in this project right now, what needs your decision, and where Mindly helped.',
  },
  {
    key: 'memory',
    label: 'Memory',
    intro:
      'What every agent is told about this project: rules, decisions, facts and known pitfalls. Agents can only suggest; you approve.',
  },
  {
    key: 'agents',
    label: 'Agents',
    intro:
      'Who is working on what, which files each agent is editing, what Mindly told whom, and work passed from one agent to another.',
  },
  {
    key: 'history',
    label: 'History',
    intro:
      'Merge checks, bisects and reviews that ran, exactly what each agent was told, and who wrote which line.',
  },
  {
    key: 'settings',
    label: 'Settings',
    intro: 'This project, the commands Mindly may run here, and where your data lives.',
  },
];

/** One-line introductions under section titles. Facts about what the section shows, in plain words. */
export const INTRO = {
  agentsNow:
    'Every agent that worked in this folder in the last 30 minutes, and what it is doing. An agent shows up here on its own when it starts.',
  decisions:
    'Things only you can decide. Nothing here changes how agents work until you act on it.',
  helped:
    'Times Mindly stopped a problem. One counts only when what happened next proves the problem was avoided.',
  activity: 'What agents and Mindly did, newest first.',
  conflicts:
    'Two agents whose work collides, or a change that breaks something another agent relies on.',
  mergeCheck:
    "Mindly merges every agent's work in a scratch copy and runs your checks, without touching your branches.",
} as const;

/** The sub-pages of Agents and History. */
export const SUBPAGES = {
  agents: [
    { key: 'team', label: 'Working together' },
    { key: 'split', label: 'Split' },
  ],
  history: [
    { key: 'runs', label: 'Runs' },
    { key: 'xray', label: 'What agents were told' },
    { key: 'provenance', label: 'Who wrote this line' },
    { key: 'standup', label: 'Standup' },
    { key: 'snapshots', label: 'Snapshots' },
  ],
} as const;

/** The short guide behind "What am I looking at?". */
export const GUIDE: readonly { term: string; text: string }[] = [
  {
    term: 'Agent',
    text: 'A coding assistant connected to Mindly: Claude Code, Codex, Cursor or Gemini CLI. Each session of one is listed on its own.',
  },
  {
    term: 'Rule',
    text: 'Something every agent must follow in this project ("use pnpm, never npm"). Agents can suggest rules from what you tell them; only you approve them.',
  },
  {
    term: 'Decision',
    text: 'A choice the project made, written down so agents stop re-deciding it. A decision can carry a check that runs after every edit.',
  },
  {
    term: 'Conflict',
    text: 'Two agents editing the same code, or a change that breaks something another agent relies on. You decide which change wins, then mark it resolved.',
  },
  {
    term: 'Save',
    text: 'A time Mindly stopped a problem: an agent warned before building on changed code, a write blocked by your rule, a merge conflict found early. Counted only with proof.',
  },
  {
    term: 'Merge check',
    text: "Mindly merges every agent's work in a scratch copy and runs your checks there, so you learn about conflicts before anything is merged.",
  },
  {
    term: 'Bisect',
    text: 'Finds the exact agent edit that broke a command, who made it and from which prompt. Run it with mindly bisect -- <command>.',
  },
  {
    term: 'Split',
    text: 'One goal divided between agents, each in its own copy of the repository with the files it owns, merged back into one branch.',
  },
  {
    term: 'Handoff',
    text: 'Unfinished work packaged up when an agent stops, for example at its usage limit. The next agent picks it up with the goal, plan and files.',
  },
];

export interface HomeSummary {
  working: number;
  idle: number;
  limited: number;
  decisions: number;
  conflicts: number;
  savesWeek: number | undefined;
}

/**
 * The one sentence at the top of Home: "2 agents working · 1 conflict open · 3 decisions wait
 * for you · Mindly helped 4 times this week."
 */
export function homeSentence(s: HomeSummary): string {
  const parts: string[] = [];
  if (s.working > 0) parts.push(`${count(s.working, 'agent')} working`);
  else if (s.idle > 0) parts.push(`${count(s.idle, 'agent')} idle, none working`);
  else parts.push('No agent working right now');
  if (s.limited > 0) parts.push(`${s.limited} at a usage limit`);
  if (s.conflicts > 0) parts.push(`${count(s.conflicts, 'conflict')} open`);
  else parts.push('nothing broken');
  if (s.decisions > 0) {
    parts.push(`${count(s.decisions, 'decision')} ${s.decisions === 1 ? 'waits' : 'wait'} for you`);
  }
  if (s.savesWeek !== undefined && s.savesWeek > 0) {
    parts.push(`Mindly helped ${s.savesWeek === 1 ? 'once' : `${s.savesWeek} times`} this week`);
  }
  return `${parts.join(' · ')}.`;
}

/** What a group of "Needs you" items is, with its count: "3 suggested rules". */
export function needGroupWords(kind: 'rule' | 'memory', n: number): string {
  if (kind === 'rule') return count(n, 'suggested rule');
  return count(n, 'suggested memory', 'suggested memories');
}

/** Why a group needs the user, in one line. */
export function needGroupWhy(kind: 'rule' | 'memory'): string {
  if (kind === 'rule') {
    return 'Picked up from what you told an agent. Agents see them as hints until you approve them.';
  }
  return 'Facts and pitfalls an agent noticed. Agents treat them as unverified until you approve them.';
}

/** What an agent is doing, as one short phrase for its card. */
export function agentDoingWords(input: {
  status: Session['status'];
  editing: readonly string[];
  lastEdit: { path: string; at: number } | null;
  lastSeenAt: number;
  now: number;
}): string {
  if (input.status === 'rate_limited') return 'hit its usage limit';
  if (input.editing.length > 0) return `editing ${filesPhrase(input.editing)}`;
  if (input.lastEdit) {
    return `edited ${input.lastEdit.path} ${relTime(input.lastEdit.at, input.now)}`;
  }
  if (input.status === 'ended') return `finished ${relTime(input.lastSeenAt, input.now)}`;
  return `last active ${relTime(input.lastSeenAt, input.now)}`;
}
