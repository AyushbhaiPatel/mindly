import type { Run, Session, Severity, MindlyEvent } from './types';

export function relTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
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
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

export function absTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 10 ? id.slice(-8) : id;
}

export function agentName(session: Pick<Session, 'agentKind' | 'label'> | undefined): string {
  if (!session) return 'an agent';
  return session.label ? `${session.agentKind} (${session.label})` : session.agentKind;
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

function files(payload: Record<string, unknown>): string | null {
  const fs = [...list(payload, 'files'), ...list(payload, 'paths')];
  const single = str(payload, 'path', 'file');
  if (single) fs.unshift(single);
  if (fs.length === 0) return null;
  return fs.length === 1 ? fs[0]! : `${fs[0]} and ${fs.length - 1} more`;
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent';

export interface EventLine {
  actor: string | null;
  text: string;
  tone: Tone;
}

/**
 * Renders an event as a short human sentence ("codex started editing src/auth.ts"). Payload
 * fields are untrusted and optional; every branch has a generic fallback.
 */
export function describeEvent(ev: MindlyEvent, sessions: ReadonlyMap<string, Session>): EventLine {
  const p = ev.payload ?? {};
  const s = ev.sessionId ? sessions.get(ev.sessionId) : undefined;
  const actor = s
    ? agentName(s)
    : (str(p, 'agentKind', 'agent') ?? (ev.sessionId ? `session ${shortId(ev.sessionId)}` : null));
  const title = str(p, 'title', 'summary');
  const f = files(p);
  const line = (text: string, tone: Tone = 'neutral'): EventLine => ({ actor, text, tone });

  switch (ev.type) {
    case 'session.started':
      return line(`started a session${str(p, 'branch') ? ` on ${str(p, 'branch')}` : ''}`, 'good');
    case 'session.ended':
      return line('ended the session');
    case 'session.idle':
      return line('went idle');
    case 'session.rate_limited':
      return line('hit a rate limit', 'warn');
    case 'prompt.submitted':
      return line(`was prompted${title ? `: “${title}”` : ''}`);
    case 'tool.before':
      return line(`is running ${str(p, 'tool') ?? 'a tool'}${f ? ` on ${f}` : ''}`);
    case 'tool.after':
      return line(`ran ${str(p, 'tool') ?? 'a tool'}${f ? ` on ${f}` : ''}`);
    case 'file.changed': {
      const add = typeof p.addedLines === 'number' ? ` (+${p.addedLines}` : '';
      const rem = typeof p.removedLines === 'number' ? ` −${p.removedLines})` : add ? ')' : '';
      return line(`changed ${f ?? 'a file'}${add}${rem}`);
    }
    case 'memory.created':
      return line(
        `${actor ? 'proposed' : 'new'} ${str(p, 'kind') ?? 'memory'}: ${title ?? 'untitled'}`,
        'info',
      );
    case 'memory.updated':
      return line(`memory updated: ${title ?? 'untitled'}`);
    case 'memory.stale':
      return line(`memory went stale: ${title ?? 'untitled'}`, 'warn');
    case 'memory.archived':
      return line(`memory archived: ${title ?? 'untitled'}`);
    case 'rule.captured':
      return line(`rule captured: ${title ?? str(p, 'body') ?? 'untitled'}`, 'accent');
    case 'task.created':
      return line(`created task “${title ?? 'untitled'}”`);
    case 'task.updated':
      return line(
        `updated task “${title ?? 'untitled'}”${str(p, 'status') ? ` → ${str(p, 'status')}` : ''}`,
      );
    case 'intent.declared':
      return line(f ? `started editing ${f}` : `declared intent: ${title ?? 'untitled'}`, 'info');
    case 'intent.closed':
      return line(f ? `finished editing ${f}` : 'closed an intent');
    case 'conflict.opened': {
      const sev = str(p, 'severity');
      return line(
        `conflict${sev ? ` (${sev})` : ''}: ${title ?? 'untitled'}`,
        sev === 'critical' ? 'bad' : 'warn',
      );
    }
    case 'conflict.updated':
      return line(`conflict ${str(p, 'status') ?? 'updated'}: ${title ?? 'untitled'}`);
    case 'delivery.queued':
      return line(
        `message queued${str(p, 'targetAgentKind') ? ` for ${str(p, 'targetAgentKind')}` : ''}: ${title ?? ''}`.trim(),
      );
    case 'delivery.delivered':
      return line(`received: ${title ?? 'a message'}`);
    case 'delivery.acked':
      return line(`acknowledged: ${title ?? 'a message'}`);
    case 'handoff.created':
      return line(
        `handed off${str(p, 'toAgentKind') ? ` to ${str(p, 'toAgentKind')}` : ''}: ${title ?? 'a task'}`,
        'warn',
      );
    case 'handoff.claimed':
      return line(`claimed a handoff${title ? `: ${title}` : ''}`, 'good');
    case 'contract.result': {
      const state = str(p, 'state');
      return line(
        `contract ${state ?? 'checked'}${title ? `: ${title}` : ''}`,
        state === 'passing' ? 'good' : state === 'failing' || state === 'error' ? 'bad' : 'neutral',
      );
    }
    case 'context.served': {
      const n = typeof p.items === 'number' ? p.items : null;
      return line(`received context${n !== null ? ` (${n} items)` : ''}`);
    }
    case 'snapshot.created':
      return line(`snapshot created: ${str(p, 'label') ?? 'untitled'}`);
    case 'snapshot.restored':
      return line(`snapshot restored${str(p, 'branch') ? ` to ${str(p, 'branch')}` : ''}`, 'warn');
    case 'run.started':
      return line(`${runKindLabel(str(p, 'kind'))} started`);
    case 'run.finished': {
      const st = str(p, 'status');
      return line(
        `${runKindLabel(str(p, 'kind'))} ${st ?? 'finished'}`,
        st === 'passed' ? 'good' : st === 'failed' || st === 'error' ? 'bad' : 'neutral',
      );
    }
    case 'turn.completed':
      return line(`finished a turn${title ? `: ${title}` : ''}`);
    default:
      return line(String(ev.type).replace(/[._]/g, ' '));
  }
}

export function runKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'shadow_merge':
      return 'shadow merge';
    case 'replay':
      return 'replay';
    case 'review':
      return 'review';
    case 'contract_sweep':
      return 'contract sweep';
    default:
      return 'run';
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Run result parsing. The contract types `Run.result` as an open record; these readers pick   */
/* out known fields defensively so a daemon change never crashes the UI.                        */
/* ------------------------------------------------------------------------------------------ */

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface CheckOutcome {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number | null;
  outputTail: string;
}

export interface ShadowMergeView {
  conflictedPaths: string[];
  checks: CheckOutcome[];
  sessions: string[];
  mergedTree: string | null;
}

export function readShadowMerge(run: Run): ShadowMergeView {
  const r = rec(run.result);
  return {
    conflictedPaths: arr(r.conflictedPaths ?? r.conflicts).filter(
      (x): x is string => typeof x === 'string',
    ),
    checks: arr(r.checks).map((c) => {
      const o = rec(c);
      const exitCode = num(o.exitCode);
      return {
        name: text(o.name) ?? 'check',
        ok: typeof o.ok === 'boolean' ? o.ok : exitCode === 0,
        exitCode,
        durationMs: num(o.durationMs),
        outputTail: text(o.outputTail ?? o.output ?? o.stderr) ?? '',
      };
    }),
    sessions: arr(r.sessionIds ?? r.sessions).filter((x): x is string => typeof x === 'string'),
    mergedTree: text(r.mergedTree ?? r.tree),
  };
}

export interface Finding {
  severity: Severity;
  file: string | null;
  line: number | null;
  message: string;
}

export function readReview(run: Run): {
  summary: string | null;
  findings: Finding[];
  reviewer: string | null;
} {
  const r = rec(run.result);
  return {
    summary: text(r.summary),
    reviewer: text(r.reviewer ?? rec(run.input).reviewer),
    findings: arr(r.findings).map((f) => {
      const o = rec(f);
      const sev = text(o.severity);
      return {
        severity: sev === 'critical' || sev === 'warning' ? sev : 'info',
        file: text(o.file ?? o.path),
        line: num(o.line),
        message: text(o.message ?? o.text) ?? '',
      };
    }),
  };
}

export interface ReplayRow {
  agent: string;
  status: string | null;
  filesChanged: number | null;
  added: number | null;
  removed: number | null;
  checksPassed: number | null;
  checksTotal: number | null;
  durationMs: number | null;
  costUsd: number | null;
}

export function readReplay(run: Run): ReplayRow[] {
  const r = rec(run.result);
  return arr(r.agents ?? r.results).map((a) => {
    const o = rec(a);
    return {
      agent: text(o.agent ?? o.agentKind) ?? '?',
      status: text(o.status),
      filesChanged: num(o.filesChanged),
      added: num(o.addedLines ?? o.added),
      removed: num(o.removedLines ?? o.removed),
      checksPassed: num(o.checksPassed),
      checksTotal: num(o.checksTotal),
      durationMs: num(o.durationMs),
      costUsd: num(o.costUsd ?? o.cost),
    };
  });
}

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Splits a comma/newline separated text field into trimmed non-empty values. */
export function splitList(s: string): string[] {
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}
