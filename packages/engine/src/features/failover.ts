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
 * Both patterns match the wording at the start of a line (after an optional label) and say
 * nothing about what follows it.
 *
 * `client` is matched against the client's own error reports, and anything may follow the
 * wording there. `account` marks the wordings that name the account's own limit ("Usage limit
 * reached", "You've hit your weekly limit"): only those are looked for in text the assistant
 * wrote, with `re`, and there the rest of the line must be the notice's own tail (see
 * `noticeTail`). The vocabulary of any rate-limited API ("rate limit exceeded", "429", "too
 * many requests") is what an agent writes about all day, so it counts only from the client.
 */
export interface RateLimitSignature {
  id: string;
  account: boolean;
  re: RegExp;
  client: RegExp;
}

/** A pending usage-limit handoff older than this is no longer offered to anyone. */
export const RATE_LIMIT_HANDOFF_MAX_AGE_MS = 7 * DAY_MS;

/** Longest handoff summary kept; the CLI and the MCP tool accept exactly this much. */
export const HANDOFF_SUMMARY_MAX_CHARS = 300;

/** A notice the assistant relays is one line; an error body from a client can be long. */
const MAX_NOTICE_LINE_CHARS: Record<NoticeSource, number> = { assistant: 400, client: 2000 };
/** An answer longer than this is more than a notice. */
const MAX_NOTICE_MESSAGE_CHARS = 400;

const APOS = "(?:'|\\u2019)";
const QUALIFIER = '(?:(?:api|stream|http|request|provider|server|unexpected|fatal) )?';
// The label in front of a failure. In text the assistant wrote only "Error" (with what kind),
// "Request failed" and "Fatal" count: "Warning", "WARN", "Failed" and "Failure" are what logs
// and test runners print. A client's own error report may carry any of them.
const LABEL_WORDS: Record<NoticeSource, string> = {
  assistant: `${QUALIFIER}error|request failed|fatal`,
  client: `${QUALIFIER}(?:error|failed|failure|fatal|warning|warn)`,
};
// Words that start another clause: "..., and the new resetAt field says when", "which ...".
const CLAUSE =
  ',\\s*(?:and|but|which|so|because|while|when|then|since|though|once)\\b|\\b(?:which|because|while|whereas|once|so that|and the|that the)\\b';
// The time in "Your limit will reset at 3pm (Europe/Berlin)": no other clause, no new sentence.
const RESET_TIME = `(?:(?!${CLAUSE}|[.!?;]\\s)[^\\n]){0,60}`;

// Every sentence of the tail of a notice says how to get going again.
const TAIL_WORD =
  /\b(?:upgrade|try again|retry|resets?|credits?|plan|billing|usage|quota|admin|docs|settings|pricing|subscribe|subscription|wait)\b/i;
// A tail line on its own starts with that word: "Try again at 5pm.", "/upgrade to ...".
const TAIL_START =
  /^(?:(?:please|or|and|then|to|you can)\s+)*(?:upgrade|try again|retry|resets?|wait|subscribe|check your|contact your admin|your (?:limit|quota) will reset)\b/i;
// Code in a sentence makes it a sentence about code: "Retry logic added in src/limit.ts".
const CODE_REF =
  /`|\b[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|php|cs|md|json|ya?ml|toml|sql|sh|css|html)\b/i;
const URL = /\bhttps?:\/\/\S+/gi;
const NOTICE_SEP = /^\s*[.,;:!|·∙•–—/-]/;
const SENTENCE_BREAK = /[.!?;](?=\s|$)|[|·∙•–—]/;

/** The sentences of `text`, with the dots and marks inside URLs left alone. */
function tailSentences(text: string): string[] {
  const masked = text.replace(URL, (u) => u.replace(/[.!?;|]/g, '_'));
  return masked
    .split(SENTENCE_BREAK)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** True when every sentence of `text` is about getting going again and none is about code. */
function allTail(text: string, mustStart: boolean): boolean {
  const sentences = tailSentences(text);
  return (
    sentences.length > 0 &&
    sentences.every(
      (t) => TAIL_WORD.test(t) && !CODE_REF.test(t) && (!mustStart || TAIL_START.test(t)),
    )
  );
}

/**
 * True when `rest`, what follows the wording of a notice on its line, is the notice's own tail:
 * nothing; the reset time some clients append as "|<epoch>"; or, after a mark, sentences that
 * each say how to get going again ("· resets 3pm", ". Upgrade to Pro (https://...), visit
 * https://... to purchase more credits or try again at 5:12 PM."). "Usage limit reached in
 * the billing module" or "...: discussed in standup" stay sentences about something else.
 */
function noticeTail(rest: string): boolean {
  const t = rest.trim();
  if (/^[.!]?$/.test(t) || /^\|\d{9,13}$/.test(t)) return true;
  return NOTICE_SEP.test(rest) && allTail(t.replace(/^[.,;:!|·∙•–—/-]+/, ''), false);
}

/** A line that is only the tail of a notice, as a client prints it under the notice. */
function tailOnlyLine(line: string): boolean {
  return allTail(line, true);
}

function label(source: NoticeSource): string {
  return `(?:\\[?(?:${LABEL_WORDS[source]})\\b\\]?\\s*[:\\-]?\\s*(?:\\(?\\d{3}\\)?\\s*[:\\-]?\\s*)?)`;
}

type Build = (label: string) => string;

function signature(id: string, account: boolean, build: Build): RateLimitSignature {
  const re = (source: NoticeSource) => new RegExp(build(label(source)), 'i');
  return { id, account, re: re('assistant'), client: re('client') };
}

/** The phrase opens the line, after an optional label. */
const opening =
  (body: string): Build =>
  (l) =>
    `^${l}?(?:${body})`;

/** A wording that names the account's limit: read from the assistant and from the client. */
function account(id: string, build: Build): RateLimitSignature {
  return signature(id, true, build);
}

/** API vocabulary: read from the client's own error reports only. */
function api(id: string, build: Build): RateLimitSignature {
  return signature(id, false, build);
}

const HTTP = '(?:http(?:/\\d(?:\\.\\d)?)? )?';
// "429" alone matches line numbers and ids, so it must open the line as a status.
const HTTP_429: Build = (l) => `^${l}?${HTTP}(?:status(?: code)?\\s*:?\\s*)?429\\b`;
const RATE_LIMITED = `(?:you are being |you${APOS}re being |requests? (?:was|were|is|are) )?rate[ -]?limited`;
const HIT = `you${APOS}ve (?:hit|reached)`;
const PLAN = '(?:session|weekly|daily|5-hour|opus|sonnet)';

/**
 * Per-agent rate-limit signatures; the generic ones apply to every agent.
 *
 * UNVERIFIED: these wordings are collected from what each client has been seen to print and
 * from its API's documented errors, not checked against the current release of each CLI. They
 * will drift as the clients change their messages and are meant to become user-configurable.
 * Keep every wording in this table, so there is one place to correct.
 *
 * A signature is matched against one line at a time. The shape of a line cannot tell a notice
 * from a sentence about one, so where the text comes from and where it stands in the turn
 * decide how it is read (see `noticeLines` and `FailoverService.onTurnStopped`). Missing an
 * unusual wording is the cheaper mistake: a false match takes the work away from a healthy
 * session.
 */
export const RATE_LIMIT_SIGNATURES: Readonly<Record<string, readonly RateLimitSignature[]>> = {
  'claude-code': [
    // "Claude usage limit reached. Your limit will reset at 3pm.", "Claude AI usage limit
    // reached|1712345678"
    account('claude.usage_limit_reached', opening('(?:claude(?: ai)? )?usage limit reached')),
    // "5-hour limit reached ∙ resets 5pm"
    account('claude.five_hour_limit', opening(`(?:${HIT} your )?5-hour limit(?: reached)?`)),
    // "Weekly limit reached ∙ resets Mon 9am", "Opus weekly limit reached ∙ resets Oct 9, 5pm",
    // "You've hit your session limit · resets 3pm", "You've hit your limit · resets 10pm"
    account(
      'claude.limit_reached',
      opening(`(?:${PLAN} ){0,2}limit reached|${HIT} your (?:${PLAN} ){0,2}limit`),
    ),
    // "Your limit will reset at 3pm (Europe/Berlin)."
    account(
      'claude.limit_will_reset',
      (l) => `^${l}?(?:your )?limit will reset (?:at|in|on|after)\\b${RESET_TIME}`,
    ),
    // 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    // "API Error: Request rejected (429) · rate_limit_error"
    api('claude.rate_limit_error', () => '\\brate_limit_error\\b'),
    api('claude.http_429', HTTP_429),
  ],
  codex: [
    // "You've hit your usage limit. Upgrade to Pro or try again in 3 hours."
    account('codex.usage_limit', opening(`${HIT} your usage limit`)),
    // "stream error: rate limit reached", "Rate limit reached for gpt-5 in organization org-…
    // Please try again in 2s."
    api(
      'codex.rate_limit',
      (l) =>
        `^${l}?(?:rate limit (?:reached|exceeded|hit)|you${APOS}ve hit (?:a|the|your) rate limit|${RATE_LIMITED})`,
    ),
    // "exceeded retry limit, last status: 429 Too Many Requests"
    api('codex.retry_limit', (l) => `^${l}?exceeded retry limit\\b.{0,80}\\b429\\b`),
    api('codex.http_429', HTTP_429),
  ],
  gemini: [
    // "You have exhausted your daily quota on this model.", "You have exhausted your capacity
    // on this model. Your quota will reset after 2h."
    account(
      'gemini.quota_exhausted',
      (l) =>
        `^${l}?(?:you have|you${APOS}ve) exhausted your (?:(?:daily|free|current) )?(?:quota|capacity)(?: (?:on|for) (?:this|the) model)?`,
    ),
    // "Resource has been exhausted (e.g. check quota)."
    api('gemini.resource_exhausted', opening('resource has been exhausted')),
    // '[API Error: {"error":{"code":429,"message":"…","status":"RESOURCE_EXHAUSTED"}}]'
    api('gemini.resource_exhausted_status', () => '\\bresource_exhausted\\b'),
  ],
  generic: [
    account(
      'generic.usage_limit',
      opening(`usage limit (?:reached|exceeded|hit)|${HIT} (?:your|the) (?:usage )?limit`),
    ),
    // "You exceeded your current quota, please check your plan and billing details."
    account(
      'generic.quota_used_up',
      opening(`(?:you|you have|you${APOS}ve) exceeded your (?:(?:current|daily|monthly) )?quota`),
    ),
    api(
      'generic.rate_limit',
      opening(`rate[ _-]?limit[ _](?:exceeded|reached|error)|${RATE_LIMITED}`),
    ),
    api('generic.too_many_requests', opening(`${HTTP}(?:429 )?too many requests`)),
    api('generic.quota_exceeded', opening('quota (?:exceeded|exhausted)')),
    api('generic.http_429', HTTP_429),
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
// "Rate limited, retrying in 30s", "429 Too Many Requests; retrying 1/5 in 205ms": the client
// is still trying, which is the opposite of having stopped at a limit.
const RETRYING = /\bretrying\b|\b(?:retry|attempt)\s+#?\d+\s*(?:\/|of)\s*\d+/i;
// The line a client writes in place of the assistant's answer when the API call failed.
const API_ERROR_LINE = /^[^\p{L}\p{N}[]*\[?API Error\b/u;

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

/** Every signature that names the account's limit, of any agent: the shape of a notice. */
const ACCOUNT_SIGNATURES: readonly RateLimitSignature[] = Object.values(RATE_LIMIT_SIGNATURES)
  .flat()
  .filter((sig) => sig.account);

/** True when `line` is the notice of `sig` as the assistant would relay it: wording, then tail. */
function relaysNotice(sig: RateLimitSignature, line: string): boolean {
  const m = sig.re.exec(line);
  return m !== null && noticeTail(line.slice(m[0].length));
}

/** True when `line` (decoration stripped) is a notice or the tail a client prints under one. */
function noticeShaped(line: string): boolean {
  return tailOnlyLine(line) || ACCOUNT_SIGNATURES.some((sig) => relaysNotice(sig, line));
}

/** A non-empty line of a message, and whether it is a fence marker or inside a fence. */
interface MessageLine {
  raw: string;
  fenced: boolean;
}

function messageLines(text: string): MessageLine[] {
  const out: MessageLine[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      out.push({ raw, fenced: true });
    } else if (raw.trim() !== '') out.push({ raw, fenced });
  }
  return out;
}

/** `raw` as a candidate notice line from `source`, or null when it can never be one. */
function candidate(raw: string, source: NoticeSource): string | null {
  if (raw.length > 2 * MAX_NOTICE_LINE_CHARS[source] || RETRYING.test(raw)) return null;
  if (source === 'assistant' && WRITTEN_ABOUT.test(raw.trimStart())) return null;
  const line = stripLead(raw).trimEnd();
  return line.length === 0 || line.length > MAX_NOTICE_LINE_CHARS[source] ? null : line;
}

/**
 * The lines of one message that could be a notice, without the decoration, timestamp or tag in
 * front of them. Lines in a code fence are never one (that is where logs are quoted), and
 * neither is a line that says the client is retrying.
 *
 * An error the client reported is read line by line. Of what the assistant wrote only the end
 * is read, whatever came before it: a limit is the last thing said in a message. That end is
 * the last line, or the last two or three when each of them is shaped like a notice or its tail
 * ("You've hit your limit · resets 10pm" then "/upgrade to increase your usage limit."). It is
 * not a notice when it is written about something (a list item, a quotation, a test result) or
 * introduced by a line ending in a colon ("The banner now reads:").
 */
export function noticeLines(text: string, source: NoticeSource = 'assistant'): string[] {
  const lines = messageLines(text);
  if (source === 'client') {
    return lines
      .filter((l) => !l.fenced)
      .map((l) => candidate(l.raw, source))
      .filter((l): l is string => l !== null);
  }
  const run: string[] = [];
  let i = lines.length - 1;
  for (; i >= 0 && run.length < 3; i--) {
    const l = lines[i];
    const line = !l || l.fenced ? null : candidate(l.raw, source);
    if (line === null || (run.length > 0 && !noticeShaped(line))) break;
    run.unshift(line);
  }
  if (run.length === 0) return [];
  // Only the last line is taken on its own; a longer run must be all notice and tail.
  if (run.length > 1 && !run.every(noticeShaped)) return run.slice(-1);
  const before = lines[i];
  if (before && !before.fenced && /:\s*$/.test(before.raw)) return [];
  return run;
}

/**
 * Returns the id of the first matching signature, or null. Each text is one message from
 * `source`; input is treated as untrusted text. A one-line message that opens with "API Error"
 * is what a client writes when the call failed, and is read as the client's report even when
 * it arrives as the assistant's message.
 */
export function detectRateLimit(
  agentKind: string,
  texts: readonly string[],
  source: NoticeSource = 'assistant',
): string | null {
  const sigs = signaturesFor(agentKind);
  for (const raw of texts.slice(-MAX_ENTRIES)) {
    const text = raw.slice(0, MAX_TEXT_PER_ENTRY);
    const trimmed = text.trim();
    const from: NoticeSource =
      source === 'assistant' && !trimmed.includes('\n') && API_ERROR_LINE.test(trimmed)
        ? 'client'
        : source;
    for (const line of noticeLines(text, from)) {
      for (const s of sigs) {
        if (from === 'client' ? s.client.test(line) : s.account && relaysNotice(s, line)) {
          return s.id;
        }
      }
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

/** A subagent's entries are not the main agent's notice or work. */
function isSidechain(obj: unknown): boolean {
  return field(obj, 'isSidechain') === true;
}

/** True when the entry is a tool call or a tool result, in any of the known shapes. */
function isToolEntry(obj: unknown): boolean {
  if (isSidechain(obj)) return false;
  // Gemini CLI keeps the tool calls of a turn on the model's entry (unverified shape).
  const calls = field(obj, 'toolCalls');
  if (Array.isArray(calls) && calls.length > 0) return true;
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
  if (isUserSide(obj) || isSidechain(obj)) return null;
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
  // `type: "gemini"` is how Gemini CLI session logs are believed to mark the model's turns
  // (unverified against the current release).
  if (type === 'assistant' || type === 'gemini' || role === 'assistant' || role === 'model') {
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

function entryOf(obj: unknown): TranscriptEntry {
  const said = agentText(obj);
  return {
    ts: parseTs(field(obj, 'timestamp')),
    user: isUserSide(obj) && !isSidechain(obj),
    agent: said !== null,
    client: said?.client ?? false,
    tool: isToolEntry(obj),
    text: (said?.text ?? '').slice(0, MAX_TEXT_PER_ENTRY),
  };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

// A line of pretty-printed JSON: a bracket, or a `"key": value` pair.
const JSON_FRAGMENT = /^\s*(?:[{}[\],]+|"(?:[^"\\]|\\.)*"\s*:.*)$/;

/** The `messages` of a session document, or of a top-level array; null for anything else. */
function documentMessages(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const messages = field(value, 'messages');
  return Array.isArray(messages) ? messages : null;
}

const isObject = (v: unknown): v is object => v !== null && typeof v === 'object';

/**
 * Parses transcript text. A transcript that is one JSON document, on one line or pretty-printed
 * (Gemini CLI is believed to keep its session that way; unverified), is read from its
 * `messages` array, or from the document when it is an array; one cut by the tail is not read at
 * all. JSONL (Claude Code, Codex): one entry per line, and a line that does not parse (cut off
 * by the tail, or still being written) is not an entry. Text that is not JSON at all is read one
 * line per entry.
 */
export function parseTranscriptTail(tail: string): TranscriptEntry[] {
  const first = tail.trimStart()[0];
  if (first === '{' || first === '[') {
    const doc = parseJson(tail);
    const messages = doc.ok ? documentMessages(doc.value) : null;
    if (messages) return messages.slice(-MAX_ENTRIES).map(entryOf);
  }
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const parsed = lines.map((l) => parseJson(l));
  if (parsed.some((r) => r.ok && isObject(r.value))) {
    return parsed
      .flatMap((r) => {
        if (!r.ok || !isObject(r.value) || Array.isArray(r.value)) return [];
        const messages = documentMessages(r.value);
        return messages ?? [r.value];
      })
      .slice(-MAX_ENTRIES)
      .map(entryOf);
  }
  const fragments = lines.filter((l) => JSON_FRAGMENT.test(l)).length;
  if (lines.length > 0 && fragments * 2 >= lines.length) return [];
  return lines.slice(-MAX_ENTRIES).map((l) => ({
    ts: null,
    user: false,
    agent: true,
    client: false,
    tool: false,
    text: l.slice(0, MAX_TEXT_PER_ENTRY),
  }));
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
 * The entries of the turn that started at `since`, in file order, without the ones that carry
 * nothing (no text, no tool). An entry without a timestamp belongs to the turn when it comes
 * after the last entry known to be older. In a transcript without any timestamps the turn
 * starts after the last prompt.
 */
export function turnEntries(entries: readonly TranscriptEntry[], since: number): TranscriptEntry[] {
  const anyTs = entries.some((e) => e.ts !== null);
  let start = 0;
  entries.forEach((e, i) => {
    const before = anyTs ? e.ts !== null && e.ts < since : e.user && !e.tool;
    if (before) start = i + 1;
  });
  return entries
    .slice(start)
    .filter((e) => !e.user || e.tool)
    .filter((e) => e.tool || (e.agent && e.text.trim() !== ''));
}

/** Something the model said, not a tool call and not an error of the client. */
function isAnswer(e: TranscriptEntry): boolean {
  return e.agent && !e.client && !e.tool;
}

/**
 * The entries a turn ended with: the errors the client reported last, and what the agent said
 * just before them. Anything else after a notice (a tool call, an answer) means the agent got
 * past it.
 */
function turnEnding(turn: readonly TranscriptEntry[]): TranscriptEntry[] {
  const isClientError = (e: TranscriptEntry | undefined) => !!e && e.agent && e.client && !e.tool;
  let k = turn.length;
  while (isClientError(turn[k - 1])) k--;
  const before = turn[k - 1];
  if (before && isAnswer(before)) k--;
  return turn.slice(k);
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
   * carried on: a turn that started after the handoff, in which the agent ran tools or changed
   * a file or gave an answer longer than any notice, and that the caller found to have ended
   * normally. A turn that shows no work proves nothing: the notice may be worded in a way no
   * signature knows, and cancelling then would lose the handoff exactly when it is needed.
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
   *
   * A usage limit ends the turn, so only the end of the turn is read: the last thing the agent
   * said or its client reported, and the last message the hook passed on. A notice with a tool
   * call or an answer after it was a hiccup the agent got past, not the limit.
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

    const lastMessage = p.lastMessage?.slice(0, MAX_TEXT_PER_ENTRY) ?? '';
    const said: string[] = lastMessage.trim() ? [lastMessage] : [];
    const path = p.transcriptPath ?? session.transcriptPath;
    let transcriptRead = true;
    let ranTools = false;
    // How the turn ended: the last entry, and the entries that make up its ending.
    let last: TranscriptEntry | null = null;
    let ending: TranscriptEntry[] = [];
    if (path) {
      const tail = readTranscriptTail(path, this.homeDir);
      if (tail === null) transcriptRead = false;
      else {
        const turn = turnEntries(parseTranscriptTail(tail), since);
        // The transcript holds every tool call of the turn, whatever the tool was.
        ranTools = turn.some((e) => e.tool);
        said.push(...turn.filter(isAnswer).map((e) => e.text));
        last = turn[turn.length - 1] ?? null;
        ending = turnEnding(turn);
      }
    }
    const signature =
      ending
        .map((e) => detectRateLimit(session.agentKind, [e.text], e.client ? 'client' : 'assistant'))
        .find((id) => id !== null) ??
      (lastMessage ? detectRateLimit(session.agentKind, [lastMessage]) : null);
    if (!signature) {
      // The handoff an earlier limit left is withdrawn only by a turn the transcript shows ended
      // normally: with an answer, not with an error of any wording and not cut off after a tool
      // call. The last message the hook passes on does not count for this: it may be a limit
      // worded in a way no signature knows, or text from earlier in the turn. Without the
      // transcript the turn was not really looked at.
      const endedNormally = last ? isAnswer(last) : !path && said.length > 0;
      if (lastPrompt && transcriptRead && endedNormally) {
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
