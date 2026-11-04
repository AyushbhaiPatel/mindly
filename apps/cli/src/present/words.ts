import type {
  ConflictStatus,
  ContractKind,
  ContractSpec,
  ContractState,
  Handoff,
  HandoffStatus,
  MemoryKind,
  MemorySource,
  RunKind,
  RunStatus,
  SessionStatus,
  Severity,
  TaskStatus,
  Trust,
} from '@mindly/core';
import { agentName } from './agents.js';

/*
 * The vocabulary of docs/output-style.md: every internal enum value is translated here and only
 * here, so human output never shows `proposed`, `session_start` or `intent_overlap`.
 */

/** working / idle / hit its usage limit / finished. */
export function sessionStatusWord(status: SessionStatus): string {
  const words: Record<SessionStatus, string> = {
    active: 'working',
    idle: 'idle',
    rate_limited: 'hit its usage limit',
    ended: 'finished',
  };
  return words[status];
}

/** to do / in progress / blocked / done / dropped. */
export function taskStatusWord(status: TaskStatus): string {
  const words: Record<TaskStatus, string> = {
    open: 'to do',
    in_progress: 'in progress',
    blocked: 'blocked',
    done: 'done',
    abandoned: 'dropped',
  };
  return words[status];
}

/** FYI / check this / urgent. */
export function severityWord(severity: Severity): string {
  const words: Record<Severity, string> = {
    info: 'FYI',
    warning: 'check this',
    critical: 'urgent',
  };
  return words[severity];
}

/** open / seen / resolved / dismissed. */
export function conflictStatusWord(status: ConflictStatus): string {
  const words: Record<ConflictStatus, string> = {
    open: 'open',
    acknowledged: 'seen',
    resolved: 'resolved',
    dismissed: 'dismissed',
  };
  return words[status];
}

/** Who a memory came from, in words: "you", "Claude Code", "the code", "Mindly". */
export function sourceWord(source: MemorySource): string {
  if (source.type === 'user') return 'you';
  if (source.type === 'code') return 'the code';
  if (source.type === 'system') return 'Mindly';
  return source.agentKind ? agentName(source.agentKind) : 'an agent';
}

/**
 * approved by you / confirmed in the code / suggested by Codex, waiting for you / may be outdated
 * (code changed) / rejected.
 */
export function trustWord(trust: Trust, source?: MemorySource): string {
  switch (trust) {
    case 'approved':
      return 'approved by you';
    case 'verified':
      return 'confirmed in the code';
    case 'proposed': {
      const who = source ? sourceWord(source) : 'an agent';
      if (who !== 'you') return `suggested by ${who}, waiting for you`;
      // Rules the user stated in an agent session are captured as suggestions to confirm.
      return source?.agentKind
        ? `you said it in ${agentName(source.agentKind)}, waiting for you`
        : 'waiting for you';
    }
    case 'stale':
      return 'may be outdated (code changed)';
    case 'rejected':
      return 'rejected';
  }
}

/** rule / decision / fact / known pitfall / note. */
export function memoryKindWord(kind: MemoryKind, plural = false): string {
  const one: Record<MemoryKind, string> = {
    rule: 'rule',
    decision: 'decision',
    fact: 'fact',
    mistake: 'known pitfall',
    note: 'note',
  };
  const word = one[kind];
  return plural ? `${word}s` : word;
}

/** The same word with a capital first letter ("Known pitfall"). */
export function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

/** waiting for Cursor / picked up by Codex / done / cancelled. */
export function handoffStatusWord(
  status: HandoffStatus,
  to: string | null,
  claimedBy: string | null = null,
): string {
  switch (status) {
    case 'pending':
      return `waiting for ${to ? agentName(to) : 'any agent'}`;
    case 'claimed':
      return `picked up by ${claimedBy ?? (to ? agentName(to) : 'an agent')}`;
    case 'completed':
      return 'done';
    case 'cancelled':
      return 'cancelled';
  }
}

/** Why a handoff was made. */
export function handoffReasonWord(reason: Handoff['reason']): string {
  const words: Record<Handoff['reason'], string> = {
    manual: 'handed over by you',
    rate_limit: 'the agent hit its usage limit',
    crash: 'the session stopped unexpectedly',
  };
  return words[reason];
}

/** merge check / review / replay / check sweep. */
export function runKindWord(kind: RunKind): string {
  const words: Record<RunKind, string> = {
    shadow_merge: 'merge check',
    review: 'review',
    replay: 'replay',
    contract_sweep: 'check sweep',
  };
  return words[kind];
}

/** waiting / running / passed / failed / could not finish / cancelled. */
export function runStatusWord(status: RunStatus): string {
  const words: Record<RunStatus, string> = {
    queued: 'waiting to start',
    running: 'running',
    passed: 'passed',
    failed: 'failed',
    error: 'could not finish',
    cancelled: 'cancelled',
  };
  return words[status];
}

/** passing / failing / could not run / not run yet. */
export function contractStateWord(state: ContractState): string {
  const words: Record<ContractState, string> = {
    passing: 'passing',
    failing: 'failing',
    error: 'could not run',
    unknown: 'not run yet',
  };
  return words[state];
}

/** Quotes one argv element for display when it needs it (display only, never executed). */
function displayArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/** An argv as a person would type it: `pnpm run typecheck`. */
export function argvWords(argv: readonly string[]): string {
  return argv.map(displayArg).join(' ');
}

/** What a contract (a "check") verifies, in words. */
export function contractWords(kind: ContractKind, spec: ContractSpec): string {
  const path = spec.path ?? '?';
  switch (kind) {
    case 'file_exists':
      return `${path} exists`;
    case 'pattern_present':
      return `${path} contains /${spec.pattern ?? ''}/`;
    case 'pattern_absent':
      return `${path} does not contain /${spec.pattern ?? ''}/`;
    case 'json_key':
      return `${path} has the key ${spec.key ?? '?'}`;
    case 'export_present':
      return `${path} exports ${spec.symbol ?? '?'}`;
    case 'command':
      return `\`${argvWords(spec.argv ?? [])}\` succeeds`;
  }
}

/** `1 memory`, `2 memories`. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `a`, `a and b`, `a, b and c`. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}
