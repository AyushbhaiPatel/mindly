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
  type Task,
  type MindlyEvent,
} from '@mindly/core';
import type { BusEvents, Kernel } from '../kernel.js';
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

/**
 * Where a piece of text comes from. `client` is the agent client's own error report (an error
 * event, an error-level system entry, an API error written in place of the answer); `assistant`
 * is anything the model wrote.
 */
export type NoticeSource = 'assistant' | 'client';

/**
 * One rate-limit signature: a stable id (recorded in events) and the patterns that detect it.
 * `re` is the strict form for text the assistant wrote; `client` is the generous form for the
 * client's own error reports.
 */
export interface RateLimitSignature {
  id: string;
  re: RegExp;
  client: RegExp;
}

/** A pending usage-limit handoff older than this is no longer offered to anyone. */
export const RATE_LIMIT_HANDOFF_MAX_AGE_MS = 7 * DAY_MS;

/** Longest handoff summary kept; the CLI and the MCP tool accept exactly this much. */
export const HANDOFF_SUMMARY_MAX_CHARS = 300;

/** A limit notice is one short line; longer lines are prose or tool output. */
const MAX_NOTICE_LINE_CHARS = 300;
/** An assistant message is a notice only when all of it is: this short, this few lines. */
const MAX_NOTICE_MESSAGE_CHARS = 400;
const MAX_NOTICE_MESSAGE_LINES = 4;

const APOS = "(?:'|\\u2019)";
const QUALIFIER = '(?:(?:api|stream|http|request|provider|server|unexpected|fatal) )?';
// The label in front of a failure. In text the assistant wrote only "Error" (with what kind),
// "Request failed" and "Fatal" count: "Warning", "WARN", "Failed" and "Failure" are what logs
// and test runners print, and the assistant quotes those all the time. A client's own error
// report may carry any of them.
const LABEL_WORDS: Record<NoticeSource, string> = {
  assistant: `${QUALIFIER}error|request failed|fatal`,
  client: `${QUALIFIER}(?:error|failed|failure|fatal|warning|warn)`,
};
// When to come back, which is how a notice goes on after the phrase.
const HINT =
  '(?:(?:please )?(?:try again|retry|retrying|wait|resets?|upgrade|check (?:your|quota))\\b|your limit will reset\\b|\\(e\\.g\\.)';
// What may follow the phrase. For the client's reports: the end of the line, punctuation or a
// hint. For the assistant the line has to end there or go on with a hint, so that
// "Rate limit exceeded: the API now answers 429" stays a sentence about code.
const TAIL: Record<NoticeSource, string> = {
  assistant: `(?=\\s*(?:[.!]?\\s*$|[.,;:!|\\u00b7\\u2219\\u2022\\u2013\\u2014-]?\\s*${HINT}))`,
  client: `(?=\\s*(?:$|[.,:;!(\\[{|\\u00b7\\u2219\\u2022]|[-\\u2013\\u2014]\\s|${HINT}))`,
};

function label(source: NoticeSource): string {
  return `(?:\\[?(?:${LABEL_WORDS[source]})\\b\\]?\\s*[:\\-]?\\s*(?:\\(?\\d{3}\\)?\\s*[:\\-]?\\s*)?)`;
}

/** A signature from a pattern that is given the label and tail of its source. */
function both(id: string, build: (label: string, tail: string) => string): RateLimitSignature {
  const re = (source: NoticeSource) => new RegExp(build(label(source), TAIL[source]), 'i');
  return { id, re: re('assistant'), client: re('client') };
}

/** A signature whose phrase opens the line (after an optional label) and is followed by a tail. */
function notice(id: string, body: string): RateLimitSignature {
  return both(id, (l, tail) => `^${l}?(?:${body})${tail}`);
}

const HTTP = '(?:http(?:/\\d(?:\\.\\d)?)? )?';
// "429" alone matches line numbers and ids, so it must open the line as a status.
function http429(id: string): RateLimitSignature {
  return both(
    id,
    (l, tail) =>
      `^${l}?${HTTP}(?:status(?: code)?\\s*:?\\s*)?429\\b${tail}|^${l}?${HTTP}429 too many requests\\b`,
  );
}
const RATE_LIMITED = `(?:you are being |you${APOS}re being |requests? (?:was|were|is|are) )?rate[ -]?limited`;

/**
 * Per-agent rate-limit signatures. These are heuristics based on the messages each agent prints
 * today; they will drift as agents change their wording and are meant to become user-configurable.
 * Generic signatures apply to every agent.
 *
 * A signature is matched against one line at a time and has to open that line the way a notice
 * does ("Usage limit reached.", "API Error: 429 ...", "You've hit your usage limit"). The shape
 * of a line cannot tell a notice from a sentence about one, so where the text comes from
 * decides how it is read (see `detectRateLimit`). Missing an unusual wording is the cheaper
 * mistake: a false match takes the work away from a healthy session.
 */
export const RATE_LIMIT_SIGNATURES: Readonly<Record<string, readonly RateLimitSignature[]>> = {
  'claude-code': [
    notice('claude.usage_limit_reached', '(?:claude(?: ai)? )?usage limit reached'),
    notice(
      'claude.five_hour_limit',
      `(?:you${APOS}ve (?:hit|reached) your )?5-hour limit(?: reached)?`,
    ),
    notice(
      'claude.limit_reached',
      `(?:session|weekly|daily|opus|sonnet) limit reached|you${APOS}ve (?:hit|reached) your (?:session|weekly|daily) limit`,
    ),
    both('claude.limit_will_reset', () => '^(?:your )?limit will reset (?:at|in|on)\\b'),
    // The API error type is a name in code unless the line is an error with a 429 or an error
    // body in it: "API Error: 429 {"type":"rate_limit_error"}".
    both(
      'claude.rate_limit_error',
      (l) => `^(?=.*(?:\\b429\\b|"type"\\s*:\\s*"))${l}.{0,120}\\brate_limit_error\\b`,
    ),
    http429('claude.http_429'),
  ],
  codex: [
    notice('codex.usage_limit', `you${APOS}ve hit your usage limit`),
    notice(
      'codex.rate_limit',
      `rate limit (?:reached|exceeded|hit)|you${APOS}ve hit (?:a|the|your) rate limit|${RATE_LIMITED}`,
    ),
    http429('codex.http_429'),
  ],
  gemini: [
    notice('gemini.resource_exhausted', 'resource has been exhausted'),
    both(
      'gemini.resource_exhausted_status',
      () =>
        '^\\[?(?:(?:api|stream|http|request) )?error\\b.{0,80}\\bresource_exhausted\\b|^resource_exhausted\\b\\s*(?:$|[.:])',
    ),
    both(
      'gemini.quota_exhausted',
      (l) => `^${l}?(?:you have|you${APOS}ve) exhausted your (?:(?:daily|free|current) )?quota\\b`,
    ),
  ],
  generic: [
    notice(
      'generic.usage_limit',
      `usage limit (?:reached|exceeded|hit)|you${APOS}ve (?:hit|reached) (?:your|the) usage limit`,
    ),
    notice('generic.rate_limit', `rate[ _-]?limit[ _](?:exceeded|reached|error)|${RATE_LIMITED}`),
    notice('generic.too_many_requests', `${HTTP}(?:429 )?too many requests`),
    notice(
      'generic.quota_exceeded',
      `quota (?:exceeded|exhausted)|(?:you have|you${APOS}ve) exceeded your (?:(?:current|daily|monthly) )?quota`,
    ),
    http429('generic.http_429'),
  ],
};

/** Signatures that apply to `agentKind`: its own, then the generic fallbacks. */
export function signaturesFor(agentKind: string): RateLimitSignature[] {
  const own = Object.hasOwn(RATE_LIMIT_SIGNATURES, agentKind)
    ? (RATE_LIMIT_SIGNATURES[agentKind] ?? [])
    : [];
  return [...own, ...(RATE_LIMIT_SIGNATURES.generic ?? [])];
}

const FENCE = /^\s*(?:```|~~~)/;
// Whatever a terminal UI draws in front of a status line: bullets, quote marks, gutters,
// box-drawing, status glyphs and emoji. "[" is kept: it may open a tag or an error label.
const LEAD_SYMBOLS = /^[^\p{L}\p{N}[]+/u;
const CLOCK = '\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,6})?';
const STAMP = `(?:\\d{4}-\\d{2}-\\d{2}(?:[T ]${CLOCK})?(?:Z|[+-]\\d{2}:?\\d{2})?|${CLOCK})`;
// A log timestamp, bare or bracketed, or a short bracketed tag without spaces ("[error]").
const LEAD_STAMP = new RegExp(`^(?:\\[${STAMP}\\]|${STAMP}(?=\\s))\\s*`);
const LEAD_TAG = /^\[[^\]\s]{1,24}\]\s+/;
// Lines the assistant writes *about* something: a list item, a checkbox, a heading, a
// quotation, a code comment, a diff line, a test-runner result.
const WRITTEN_ABOUT =
  /^(?:[-*+•‣◦]\s|\d{1,3}[.)]\s|\[[ xX]\]|#{1,6}\s|["'`“”‘’«»>]|\/\/|\/\*|<!--|--\s|@@|[✓✔√✅☑]|(?:PASS|FAIL|ok \d|not ok)\b)/;

/** `line` without the decoration and log prefixes in front of its first word. */
function stripLead(line: string): string {
  let rest = line;
  for (let i = 0; i < 4; i++) {
    const next = rest.replace(LEAD_SYMBOLS, '').replace(LEAD_STAMP, '').replace(LEAD_TAG, '');
    if (next === rest) break;
    rest = next;
  }
  return rest;
}

/**
 * The lines of `text` that could be a notice, without the decoration, timestamp or tag in front
 * of them. Lines in a code fence are never one: that is where logs are quoted.
 *
 * An error the client reported is read line by line. Text the assistant wrote is read only
 * when the whole message is a notice (a few short lines, nothing else) and then without the
 * lines it wrote about something: a long answer never counts, whatever one of its lines says.
 */
export function noticeLines(text: string, source: NoticeSource = 'assistant'): string[] {
  const lines = text.split(/\r?\n/);
  if (source === 'assistant') {
    if (text.trim().length > MAX_NOTICE_MESSAGE_CHARS) return [];
    if (lines.filter((l) => l.trim() !== '').length > MAX_NOTICE_MESSAGE_LINES) return [];
  }
  const out: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || raw.length > 4 * MAX_NOTICE_LINE_CHARS) continue;
    if (source === 'assistant' && WRITTEN_ABOUT.test(raw.trimStart())) continue;
    const line = stripLead(raw).trimEnd();
    if (line.length === 0 || line.length > MAX_NOTICE_LINE_CHARS) continue;
    out.push(line);
  }
  return out;
}

/**
 * Returns the id of the first matching signature, or null. Each text is one message from
 * `source`; input is treated as untrusted text.
 */
export function detectRateLimit(
  agentKind: string,
  texts: readonly string[],
  source: NoticeSource = 'assistant',
): string | null {
  const sigs = signaturesFor(agentKind);
  for (const raw of texts.slice(-MAX_ENTRIES)) {
    for (const line of noticeLines(raw.slice(0, MAX_TEXT_PER_ENTRY), source)) {
      for (const s of sigs) if ((source === 'client' ? s.client : s.re).test(line)) return s.id;
    }
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
  /**
   * True when `text` is something the agent itself said or an error its client reported. Tool
   * calls, tool output, attachments and injected context are not: they quote the project.
   */
  agent: boolean;
  /** True when `text` is the client's own error report rather than something the model wrote. */
  client: boolean;
  /** True when the entry is a tool call or a tool result: the agent was at work. */
  tool: boolean;
  text: string;
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

const TEXT_PARTS = new Set(['text', 'output_text']);
const TOOL_PARTS = new Set(['tool_use', 'tool_result', 'server_tool_use', 'function_call']);
const TOOL_ENTRIES = new Set([
  'tool_use',
  'tool_result',
  'function_call',
  'function_call_output',
  'local_shell_call',
  'local_shell_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'exec_command_begin',
  'exec_command_end',
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  'patch_apply_begin',
  'patch_apply_end',
]);

/** The plain text of a message body: a string, or the text parts of a content array. */
function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content.slice(0, 50)) {
    if (typeof part === 'string') parts.push(part);
    else {
      const type = field(part, 'type');
      const text = field(part, 'text');
      // Tool calls, tool results and thinking are skipped: only what the agent said counts.
      if (typeof type === 'string' && TEXT_PARTS.has(type) && typeof text === 'string') {
        parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function errorText(obj: unknown): string | null {
  for (const v of [
    field(obj, 'message'),
    field(obj, 'content'),
    field(field(obj, 'error'), 'message'),
    field(obj, 'error'),
  ]) {
    const text = messageText(v);
    if (text) return text;
  }
  return null;
}

const CODEX_ERROR_EVENTS = new Set(['error', 'stream_error']);

/** True when the entry is a tool call or a tool result, in any of the known shapes. */
function isToolEntry(obj: unknown): boolean {
  const kinds = [field(obj, 'type'), field(obj, 'role'), field(field(obj, 'payload'), 'type')];
  if (kinds.some((k) => k === 'tool' || (typeof k === 'string' && TOOL_ENTRIES.has(k)))) {
    return true;
  }
  const content = field(field(obj, 'message'), 'content') ?? field(obj, 'content');
  return (
    Array.isArray(content) &&
    content.slice(0, 50).some((part) => {
      const type = field(part, 'type');
      return typeof type === 'string' && TOOL_PARTS.has(type);
    })
  );
}

/**
 * What the agent said in one transcript entry, or null when the entry is anything else, and
 * whether it is the client's own error report. Known shapes: Claude Code (`type: "assistant"`
 * with a content array, flagged `isApiErrorMessage` when the client wrote it in place of an
 * answer; `type: "system"` error lines), Codex rollouts (`payload.type: "message"` with
 * `role: "assistant"`, `agent_message`, `error`) and plain `{ role: "assistant", content }` logs.
 */
function agentText(obj: unknown): { text: string; client: boolean } | null {
  if (isUserSide(obj)) return null;
  const said = (text: string | null, client: boolean) => (text === null ? null : { text, client });
  const type = field(obj, 'type');
  const payload = field(obj, 'payload');
  if (payload !== null && typeof payload === 'object') {
    const kind = field(payload, 'type');
    if (kind === 'message' && field(payload, 'role') === 'assistant') {
      return said(messageText(field(payload, 'content')), false);
    }
    if (kind === 'agent_message') return said(errorText(payload), false);
    if (typeof kind === 'string' && CODEX_ERROR_EVENTS.has(kind)) {
      return said(errorText(payload), true);
    }
    return null;
  }
  const message = field(obj, 'message');
  const role = field(message, 'role') ?? field(obj, 'role');
  if (type === 'assistant' || role === 'assistant') {
    return said(
      messageText(field(message, 'content') ?? field(obj, 'content') ?? message),
      field(obj, 'isApiErrorMessage') === true,
    );
  }
  const subtype = field(obj, 'subtype');
  const isError =
    type === 'error' ||
    (type === 'system' &&
      (field(obj, 'level') === 'error' || (typeof subtype === 'string' && /error/i.test(subtype))));
  return isError ? said(errorText(obj), true) : null;
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
      out.push({
        ts: null,
        user: false,
        agent: true,
        client: false,
        tool: false,
        text: trimmed.slice(0, MAX_TEXT_PER_ENTRY),
      });
      continue;
    }
    const said = agentText(obj);
    out.push({
      ts: parseTs(field(obj, 'timestamp')),
      user: isUserSide(obj),
      agent: said !== null,
      client: said?.client ?? false,
      tool: isToolEntry(obj),
      text: (said?.text ?? '').slice(0, MAX_TEXT_PER_ENTRY),
    });
  }
  return out;
}

/**
 * What the agent said after `since`, optionally only from one source. Entries with timestamps
 * are compared directly; when the transcript has no timestamps, only entries after the last
 * user-side entry are considered.
 */
export function recentAgentTexts(
  entries: readonly TranscriptEntry[],
  since: number,
  source?: NoticeSource,
): string[] {
  const anyTs = entries.some((e) => e.ts !== null);
  let lastUser = -1;
  entries.forEach((e, i) => {
    if (e.user) lastUser = i;
  });
  return entries
    .filter(
      (e, i) =>
        e.agent &&
        (source === undefined || e.client === (source === 'client')) &&
        (anyTs ? e.ts !== null && e.ts >= since : i > lastUser),
    )
    .map((e) => e.text);
}

/**
 * True when the transcript shows a tool call or a tool result after `since`. Needs timestamps:
 * without them a tool result cannot be told from the prompt that started the turn.
 */
export function ranToolsSince(entries: readonly TranscriptEntry[], since: number): boolean {
  return entries.some((e) => e.tool && e.ts !== null && e.ts >= since);
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

function isUnfinished(task: Task): boolean {
  return task.status !== 'done' && task.status !== 'abandoned';
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
  // A task the session already finished is not what it was doing when it stopped: the goal then
  // comes from the latest request, and the finished task is left alone.
  const current = session.currentTaskId ? k.store.tasks.find(session.currentTaskId) : null;
  const task =
    (current && isUnfinished(current) ? current : null) ??
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
    const summary = this.clean(input.summary, HANDOFF_SUMMARY_MAX_CHARS);
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

  /**
   * The agent that should continue after `limited`: the one after it in `config.failover.order`,
   * wrapping round. With `projectId`, agents that hit their own limit in that project within the
   * last day are passed over while another one is left, so work is not handed back to an agent
   * that just handed it on.
   */
  nextAgent(limited: string, projectId?: string): string | null {
    const order = this.k.config.failover.order;
    const at = order.indexOf(limited);
    const others = [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))].filter(
      (a) => a !== limited,
    );
    if (others.length === 0) return null;
    const alsoLimited = new Set(
      projectId
        ? this.k.store.sessions
            .listLive(projectId, DAY_MS)
            .filter((s) => s.status === 'rate_limited')
            .map((s) => s.agentKind)
        : [],
    );
    return others.find((a) => !alsoLimited.has(a)) ?? others[0] ?? null;
  }

  /** This session's usage-limit handoff that nobody picked up yet. */
  private pendingRateLimitHandoff(projectId: string, sessionId: string): Handoff | null {
    return (
      this.k.store.handoffs
        .list(projectId, 100)
        .find(
          (h) =>
            h.fromSessionId === sessionId && h.reason === 'rate_limit' && h.status === 'pending',
        ) ?? null
    );
  }

  /**
   * Withdraws the handoff a session left when it hit its limit, once the session has plainly
   * carried on: a turn that started after the handoff in which the agent ran tools or changed
   * a file, or that ended with an answer longer than any notice. A turn that shows no notice
   * and no work proves nothing: the notice may be worded in a way no signature knows, and
   * cancelling then would lose the handoff exactly when it is needed.
   */
  private withdrawStaleHandoff(
    projectId: string,
    session: Session,
    turnStartedAt: number,
    turn: { ranTools: boolean; said: readonly string[] },
  ): void {
    const stale = this.pendingRateLimitHandoff(projectId, session.id);
    if (!stale || stale.createdAt >= turnStartedAt) return;
    const worked =
      turn.ranTools ||
      this.k.store.fileChanges.recentPaths(session.id, turnStartedAt).length > 0 ||
      this.k.store.events.query(projectId, {
        sessionId: session.id,
        types: ['tool.before', 'tool.after'],
        since: turnStartedAt,
        limit: 1,
      }).length > 0;
    const answered = turn.said.some((t) => t.trim().length > MAX_NOTICE_MESSAGE_CHARS);
    if (!worked && !answered) return;
    this.k.store.handoffs.setStatus(stale.id, 'cancelled');
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

    // What the model wrote, and what the client reported on its own: the two are read
    // differently (see `noticeLines`).
    const said: string[] = [];
    const reported: string[] = [];
    if (p.lastMessage) said.push(p.lastMessage.slice(0, MAX_TEXT_PER_ENTRY));
    const path = p.transcriptPath ?? session.transcriptPath;
    let transcriptRead = true;
    let ranTools = false;
    if (path) {
      const tail = readTranscriptTail(path, this.homeDir);
      if (tail === null) transcriptRead = false;
      else {
        const entries = parseTranscriptTail(tail);
        reported.push(...recentAgentTexts(entries, since, 'client'));
        said.push(...recentAgentTexts(entries, since, 'assistant'));
        // The transcript holds every tool call of the turn, whatever the tool was.
        ranTools = ranToolsSince(entries, since);
      }
    }
    const signature =
      detectRateLimit(session.agentKind, reported, 'client') ??
      detectRateLimit(session.agentKind, said, 'assistant');
    if (!signature) {
      // Without the transcript the turn was not really looked at: leave the handoff alone.
      if (lastPrompt && transcriptRead) {
        this.withdrawStaleHandoff(p.projectId, session, lastPrompt.createdAt, { ranTools, said });
      }
      return null;
    }
    this.k.store.kv.set(guardKey, epoch);
    return this.handleRateLimit(p.projectId, session, signature);
  }

  private async handleRateLimit(
    projectId: string,
    session: Session,
    signature: string,
  ): Promise<Handoff | null> {
    this.k.store.sessions.setStatus(session.id, 'rate_limited');
    const existing = this.pendingRateLimitHandoff(projectId, session.id);
    const to = this.nextAgent(session.agentKind, projectId);
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
      // Titles and counts only: never prompt text or code (docs/security.md, T3).
      await this.k.ports.notifier.send({
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
        if (h.createdAt < this.k.clock.now() - RATE_LIMIT_HANDOFF_MAX_AGE_MS) continue;
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
