import {
  describeError,
  fingerprint,
  matchesAnyGlob,
  sanitizeLine,
  type Conflict,
  type EventType,
  type MindlyEvent,
  type Save,
  type SaveKind,
  type SaveRefs,
  type Session,
} from '@mindly/core';
import type { Kernel } from '../kernel.js';
import type { Mindly } from '../mindly.js';
import { attachService, SENTINEL_FINGERPRINT_PREFIX } from './shared.js';

/*
 * Saves: every time Mindly demonstrably helped, with the events that prove it. Saves are a
 * projection of the event log: the service follows the events this process appends (hooks, CLI,
 * daemon) and settles each save on evidence only. A save starts `caught` when Mindly intervened
 * and becomes `confirmed` only when later events show the problem did not happen; without that
 * evidence it expires. Only confirmed saves count. The MCP server never installs this module, so
 * nothing an agent calls through MCP can create or change a save.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** How long a caught save waits for its evidence before it expires. */
export const SAVE_WINDOW_MS: Readonly<Record<SaveKind, number>> = {
  impact_warned: 2 * HOUR,
  overlap_avoided: 10 * MIN,
  rule_enforced: 2 * HOUR,
  mistake_avoided: 10 * MIN,
  merge_conflict_early: 24 * HOUR,
  check_broken_early: 24 * HOUR,
  limit_handoff: 24 * HOUR,
};

const ALL_KINDS = Object.keys(SAVE_WINDOW_MS) as SaveKind[];

/** Tool calls of a session as the hook handler records them (`pre_tool`, `post_tool`). */
const TOOL_TYPES: readonly EventType[] = ['tool.before', 'tool.after'];

/** Kinds settled by the helped session's later tool calls. */
const WATCHED_KINDS: readonly SaveKind[] = ['overlap_avoided', 'mistake_avoided', 'rule_enforced'];

/** Why a save was rejected (payload of `save.rejected`). */
export type SaveRejectReason = 'user' | 'conflict_dismissed' | 'problem_occurred';

/** Confirmed saves of a period (`summary`). */
export interface SavesSummary {
  since: number;
  total: number;
  byKind: Partial<Record<SaveKind, number>>;
  /** Agent kind of the helped session -> confirmed saves. */
  byAgent: Record<string, number>;
  /** Most recent confirmed saves first (at most 10). */
  recent: Save[];
}

const PRODUCT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  generic: 'An agent',
};

/** Product name of an agent kind (`claude-code` -> `Claude Code`), for plain sentences. */
export function agentProductName(kind: string | null | undefined): string {
  if (!kind) return 'An agent';
  const known = PRODUCT_NAMES[kind];
  if (known) return known;
  const words = sanitizeLine(kind, 32)
    .split('-')
    .filter(Boolean)
    .map((w) => `${w[0]?.toUpperCase() ?? ''}${w.slice(1)}`);
  return words.length ? words.join(' ') : 'An agent';
}

interface SaveInput {
  kind: SaveKind;
  title: string;
  sessionIds: string[];
  paths: string[];
  fingerprint: string;
  refs: SaveRefs;
}

const UUID_IN_KEY_RE = /^impact:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/;

const strings = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Records, confirms and drops saves. Every method is synchronous apart from the merge-conflict
 * producer (it asks git which branches are merged) and never throws into its caller.
 */
export class SavesService {
  constructor(private readonly k: Kernel) {}

  // ------------------------------------------------------------------ the event log

  /** Follows one appended event. Called by the store for every event of this process. */
  observe(e: MindlyEvent): void {
    try {
      switch (e.type) {
        case 'tool.before':
          this.onAdvice(e);
          return this.onToolCall(e);
        case 'tool.after':
          return this.onToolCall(e);
        case 'file.changed':
          return this.onFilesChanged(e);
        case 'turn.completed':
          this.onTurnCompleted(e);
          return void this.sweep(e.projectId);
        case 'delivery.delivered':
          return this.onDelivered(e);
        case 'conflict.updated':
          return this.onConflictUpdated(e);
        case 'contract.result':
          return this.onContractResult(e);
        case 'session.ended':
          return this.onSessionEnded(e);
        case 'handoff.created':
          return this.onHandoffCreated(e);
        case 'handoff.claimed':
          return this.onHandoffClaimed(e);
        default:
          return;
      }
    } catch (err) {
      this.k.logger.error('saves: event not followed', { type: e.type, error: describeError(err) });
    }
  }

  /** `pre_tool` told a session about another agent's work, an enforced rule or a known pitfall. */
  private onAdvice(e: MindlyEvent): void {
    const helped = e.sessionId ? this.k.store.sessions.find(e.sessionId) : null;
    if (!helped) return;
    const p = e.payload;
    const ruleId = text(p.deniedBy);
    // A write a rule blocked is the rule's save; it says nothing about the other agent's work.
    const overlaps =
      !ruleId && Array.isArray(p.overlaps) ? (p.overlaps as Record<string, unknown>[]) : [];
    for (const o of overlaps.slice(0, 10)) {
      const intentId = text(o.intentId);
      const other = text(o.sessionId) ? this.k.store.sessions.find(o.sessionId as string) : null;
      const files = strings(o.files, 20);
      if (!intentId || !other || files.length === 0) continue;
      this.record(e, {
        kind: 'overlap_avoided',
        title: `${this.name(helped)} stopped before overwriting ${this.name(other)}'s work`,
        sessionIds: [helped.id, other.id],
        paths: files,
        fingerprint: fingerprint('overlap_avoided', intentId),
        refs: { intentId, ...(text(o.conflictId) ? { conflictId: o.conflictId as string } : {}) },
      });
    }
    // A call is denied as a whole when one of its files is protected. The save is about the
    // protected files only: the rest of the call may be written later without breaking the rule.
    const paths = ruleId ? this.protectedBy(ruleId, strings(p.paths, 50)).slice(0, 20) : [];
    if (ruleId && paths.length > 0) {
      // Saves used to be recorded with every path of the call. The same denial again is still
      // that save, not a new one.
      const before = fingerprint('rule_enforced', ruleId, ...strings(p.paths, 20).sort());
      const now = fingerprint('rule_enforced', ruleId, ...[...paths].sort());
      const known = before !== now && this.k.store.saves.findByFingerprint(e.projectId, before);
      this.record(e, {
        kind: 'rule_enforced',
        title: `A write by ${this.name(helped)} was blocked by your rule`,
        sessionIds: [helped.id],
        paths,
        fingerprint: known ? before : now,
        refs: { ruleId },
      });
    }
    const command = text(p.command);
    const mistakes = strings(p.mistakes, 5);
    if (command && mistakes.length > 0) {
      const line = text(p.line);
      this.record(e, {
        kind: 'mistake_avoided',
        title: `${this.name(helped)} was warned about a command that failed before`,
        sessionIds: [helped.id],
        paths: [],
        fingerprint: fingerprint('mistake_avoided', mistakes[0], command),
        refs: { memoryId: mistakes[0] as string, command, ...(line ? { commandLine: line } : {}) },
      });
    }
  }

  /**
   * The paths of a denied call that the rule's scope covers. When the rule cannot be read any more
   * (or its scope names none of them), every path of the call is kept, as the denial reported it.
   */
  private protectedBy(ruleId: string, paths: string[]): string[] {
    const rule = this.k.store.memories.find(ruleId);
    if (!rule || rule.scope.paths.length === 0) return paths;
    try {
      const covered = paths.filter((p) => matchesAnyGlob(p, rule.scope.paths));
      return covered.length > 0 ? covered : paths;
    } catch {
      return paths;
    }
  }

  /**
   * A later tool call of a session with saves waiting for evidence (the hook handler records them
   * only then). Decides what can be decided now; whether the agent kept working is decided when
   * the window ends (`sweep`).
   */
  private onToolCall(e: MindlyEvent): void {
    if (!e.sessionId) return;
    const now = this.k.clock.now();
    const p = e.payload;
    const touched = strings(p.touched, 20);
    const paths = strings(p.paths, 50);
    for (const s of this.k.store.saves.caughtFor(e.projectId, e.sessionId, WATCHED_KINDS)) {
      // The warning itself is not a later call; events past the window are the sweep's.
      if (s.evidence[0] === e.id || now - s.createdAt > SAVE_WINDOW_MS[s.kind]) continue;
      switch (s.kind) {
        case 'overlap_avoided': {
          if (!this.intentActive(s)) break;
          if (touched.some((f) => s.paths.includes(f))) {
            // A shell command that may have written the file while the other agent works on it.
            this.reject(s, 'problem_occurred', [e.id]);
          } else if (
            e.type === 'tool.after' &&
            p.failed === true &&
            paths.some((f) => s.paths.includes(f))
          ) {
            // It tried to write the file anyway (the write failed or was refused): not stopped.
            this.expire(s, [e.id]);
          }
          break;
        }
        case 'rule_enforced':
          if (touched.some((f) => s.paths.includes(f))) this.reject(s, 'problem_occurred', [e.id]);
          break;
        case 'mistake_avoided': {
          if (e.type !== 'tool.after' || text(p.command) !== s.refs.command) break;
          const line = text(p.line);
          if (p.failed === true) {
            this.reject(s, 'problem_occurred', [e.id]);
          } else if (s.refs.commandLine && line && line !== s.refs.commandLine) {
            // A changed command line succeeded where the warned one would have been repeated.
            this.confirm(s, [e.id], {
              title: `${this.helpedName(s)} changed a command it was warned about, and it succeeded`,
            });
          } else {
            // The warned command line itself ran and passed: the warning did not change it.
            this.expire(s, [e.id]);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private onFilesChanged(e: MindlyEvent): void {
    const changed = new Set(strings(e.payload.paths, 50));
    if (!e.sessionId || changed.size === 0) return;
    const now = this.k.clock.now();
    for (const s of this.caughtOf(e.projectId, null, e.sessionId)) {
      if (!s.paths.some((p) => changed.has(p))) continue;
      switch (s.kind) {
        case 'impact_warned':
          // It went back to the code it was told about: the warning was acted on.
          this.confirm(s, [e.id]);
          break;
        case 'overlap_avoided': {
          if (now - s.createdAt > SAVE_WINDOW_MS.overlap_avoided) break;
          if (this.intentActive(s)) {
            this.reject(s, 'problem_occurred', [e.id]);
            break;
          }
          // Written only after the other agent's intent closed. It counts when the agent first
          // did something else (a later call not about the file); the warned write itself
          // landing late shows nothing.
          const later = this.laterToolCall(s, now);
          if (later) this.confirm(s, [later.id, e.id]);
          else this.expire(s, [e.id]);
          break;
        }
        case 'rule_enforced':
          // The blocked file was written anyway.
          this.reject(s, 'problem_occurred', [e.id]);
          break;
        default:
          break;
      }
    }
  }

  /**
   * The turn ended without the blocked write happening: the rule held. Unless a later shell
   * command of the session may have written a denied file (`cp x src/generated/api.ts`).
   */
  private onTurnCompleted(e: MindlyEvent): void {
    if (!e.sessionId) return;
    for (const s of this.caughtOf(e.projectId, 'rule_enforced', e.sessionId)) {
      const bypass = this.k.store.events
        .query(s.projectId, {
          sessionId: e.sessionId,
          types: TOOL_TYPES,
          since: s.createdAt,
          limit: 500,
        })
        .find((t) => strings(t.payload.touched, 20).some((f) => s.paths.includes(f)));
      if (bypass) this.reject(s, 'problem_occurred', [bypass.id]);
      else this.confirm(s, [e.id]);
    }
  }

  /** An impact warning reached the session (hook context) before it wrote dependent code. */
  private onDelivered(e: MindlyEvent): void {
    if (!e.sessionId) return;
    const helped = this.k.store.sessions.find(e.sessionId);
    if (!helped) return;
    const now = this.k.clock.now();
    // What the helped session is working on: read once, on the first impact delivery.
    let working: Set<string> | null = null;
    const workingOn = (): Set<string> => {
      if (working) return working;
      working = new Set<string>();
      for (const i of this.k.store.intents.activeForSession(helped.id)) {
        for (const f of i.targets.files) working.add(f);
      }
      for (const c of this.k.store.fileChanges.forSession(helped.id, now - 2 * HOUR)) {
        working.add(c.path);
      }
      return working;
    };
    for (const id of strings(e.payload.ids, 50)) {
      const d = this.k.store.deliveries.find(id);
      if (!d || d.kind !== 'impact' || !d.dedupeKey) continue;
      const conflictId = UUID_IN_KEY_RE.exec(d.dedupeKey)?.[1];
      const conflict = conflictId ? this.k.store.conflicts.find(conflictId) : null;
      if (!conflict || conflict.kind !== 'impact' || conflict.status === 'dismissed') continue;
      const changedFile = conflict.paths[0];
      if (changedFile === undefined) continue;
      const mine = workingOn();
      let told = conflict.paths.slice(1).filter((p) => mine.has(p));
      if (told.length === 0 && mine.has(changedFile)) told = [changedFile];
      if (told.length === 0) continue;
      // Wrote one of those files after the change but before hearing about it: too late.
      const wroteFirst = this.k.store.fileChanges
        .forSession(helped.id, d.createdAt)
        .some((c) => told.includes(c.path));
      if (wroteFirst) continue;
      const changer = d.sourceSessionId ? this.k.store.sessions.find(d.sourceSessionId) : null;
      this.record(e, {
        kind: 'impact_warned',
        title: `${this.name(helped)} was told ${changer ? `${this.name(changer)} changed` : 'about a change to'} code it uses before it wrote code using it`,
        sessionIds: changer ? [helped.id, changer.id] : [helped.id],
        paths: told.slice(0, 20),
        fingerprint: fingerprint('impact_warned', conflict.id),
        refs: { conflictId: conflict.id, deliveryId: d.id },
      });
    }
  }

  /** A dismissed conflict was not a real problem, so neither was its save. */
  private onConflictUpdated(e: MindlyEvent): void {
    const conflictId = text(e.payload.conflictId);
    const status = text(e.payload.status);
    if (!conflictId) return;
    for (const s of this.linkedTo(e.projectId, conflictId)) {
      if (status === 'dismissed') this.reject(s, 'conflict_dismissed', [e.id]);
      else if (status === 'resolved' && s.kind === 'impact_warned' && s.status === 'caught') {
        if (this.k.clock.now() - s.createdAt <= SAVE_WINDOW_MS.impact_warned)
          this.confirm(s, [e.id]);
      }
    }
  }

  /** A check broke during a session (caught), or passed again (confirmed if it still runs). */
  private onContractResult(e: MindlyEvent): void {
    const contractId = text(e.payload.contractId);
    if (!contractId) return;
    const state = e.payload.state;
    const previous = e.payload.previous;
    if (previous === 'passing' && state === 'failing' && e.sessionId) {
      const breaker = this.k.store.sessions.find(e.sessionId);
      if (!breaker) return;
      const path = this.contractPath(contractId);
      this.record(e, {
        kind: 'check_broken_early',
        title: `A check ${this.name(breaker)} broke was caught and fixed before merging`,
        sessionIds: [breaker.id],
        paths: path ? [path] : [],
        fingerprint: fingerprint('check_broken_early', 'contract', contractId, breaker.id),
        refs: { contractId },
      });
    } else if (previous === 'failing' && state === 'passing') {
      for (const s of this.caughtOf(e.projectId, 'check_broken_early', null)) {
        if (s.refs.contractId !== contractId) continue;
        const breaker = this.k.store.sessions.find(s.sessionIds[0] ?? '');
        if (breaker && breaker.status !== 'ended') this.confirm(s, [e.id]);
      }
    }
  }

  /** The session that broke a check ended with the check still failing. */
  private onSessionEnded(e: MindlyEvent): void {
    if (!e.sessionId) return;
    for (const s of this.caughtOf(e.projectId, 'check_broken_early', e.sessionId)) {
      if (s.refs.contractId) {
        const state = this.contractState(s.refs.contractId);
        if (state === 'failing') this.reject(s, 'problem_occurred', [e.id]);
        continue;
      }
      // A break the sentinel pinned on this session, still open when it ended.
      const conflict = s.refs.conflictId ? this.k.store.conflicts.find(s.refs.conflictId) : null;
      if (
        conflict?.fingerprint.startsWith(SENTINEL_FINGERPRINT_PREFIX) &&
        (conflict.status === 'open' || conflict.status === 'acknowledged')
      ) {
        this.reject(s, 'problem_occurred', [e.id]);
      }
    }
  }

  private onHandoffCreated(e: MindlyEvent): void {
    const handoffId = text(e.payload.handoffId);
    if (e.payload.reason !== 'rate_limit' || !handoffId || !e.sessionId) return;
    const from = this.k.store.sessions.find(e.sessionId);
    if (!from) return;
    this.record(e, {
      kind: 'limit_handoff',
      title: `Work continued in another agent after ${this.name(from)} hit its usage limit`,
      sessionIds: [from.id],
      paths: [],
      fingerprint: fingerprint('limit_handoff', from.id),
      refs: { handoffId },
    });
  }

  /** Picked up by another agent: confirmed. Picked up by the same agent again: not a save. */
  private onHandoffClaimed(e: MindlyEvent): void {
    const handoffId = text(e.payload.handoffId);
    if (!handoffId || !e.sessionId) return;
    const claimer = this.k.store.sessions.find(e.sessionId);
    if (!claimer) return;
    for (const s of this.caughtOf(e.projectId, 'limit_handoff', null)) {
      if (s.refs.handoffId !== handoffId) continue;
      const from = this.k.store.sessions.find(s.sessionIds[0] ?? '');
      if (!from || from.agentKind === claimer.agentKind) {
        this.reject(s, 'problem_occurred', [e.id]);
        continue;
      }
      this.confirm(s, [e.id], {
        title: `Work continued in ${this.name(claimer)} after ${this.name(from)} hit its usage limit`,
        sessionIds: [claimer.id, from.id],
      });
    }
  }

  // ------------------------------------------------------------------ daemon producers

  /**
   * The shadow merge found a new merge conflict between live sessions. Confirmed at once when the
   * conflicting work of every side is still unmerged (uncommitted in its worktree, or on a branch
   * not merged into the base branch); dropped when a side's change was already merged; left
   * caught (and so expiring) when that cannot be told.
   */
  async mergeConflictFound(input: {
    conflict: Conflict;
    eventId: string;
    sides: { session: Session; changed: readonly string[]; branch: string | null }[];
    repoRoot: string;
    baseBranch: string | null;
  }): Promise<Save | null> {
    try {
      const { conflict } = input;
      const states: ('pending' | 'merged' | 'unknown')[] = [];
      for (const side of input.sides) {
        states.push(await this.sideState(side, conflict.paths, input.repoRoot, input.baseBranch));
      }
      const names = [...new Set(input.sides.map((s) => this.name(s.session)))];
      const saved = this.recordWith(conflict.projectId, input.eventId, {
        kind: 'merge_conflict_early',
        title: `A merge conflict between ${names.join(' and ') || 'two agents'} was found before either branch was merged`,
        sessionIds: input.sides.map((s) => s.session.id),
        paths: conflict.paths.slice(0, 20),
        fingerprint: fingerprint('merge_conflict_early', conflict.fingerprint),
        refs: { conflictId: conflict.id },
      });
      if (!saved) return null;
      if (states.includes('merged')) return this.reject(saved, 'problem_occurred', []);
      if (states.length >= 2 && states.every((s) => s === 'pending')) {
        return this.confirm(saved, [input.eventId]);
      }
      return saved;
    } catch (err) {
      this.k.logger.error('saves: merge conflict not recorded', { error: describeError(err) });
      return null;
    }
  }

  private async sideState(
    side: { changed: readonly string[]; branch: string | null },
    paths: readonly string[],
    repoRoot: string,
    baseBranch: string | null,
  ): Promise<'pending' | 'merged' | 'unknown'> {
    if (side.changed.some((p) => paths.includes(p))) return 'pending';
    if (side.branch === null || baseBranch === null) return 'unknown';
    if (side.branch === baseBranch) return 'merged';
    const isMerged = this.k.ports.git.isMerged;
    if (!isMerged) return 'unknown';
    return (await isMerged(repoRoot, side.branch, baseBranch)) ? 'merged' : 'pending';
  }

  /** A check failed on the shadow merge of live sessions' work (a new `check_failed` conflict). */
  mergeCheckFailed(conflict: Conflict, eventId: string): Save | null {
    const sessions = conflict.sessionIds
      .map((id) => this.k.store.sessions.find(id))
      .filter((s): s is Session => s !== null);
    const names = [...new Set(sessions.map((s) => this.name(s)))];
    return this.recordWith(conflict.projectId, eventId, {
      kind: 'check_broken_early',
      title: `A check broken by ${names.join(' and ') || 'an agent'} was caught and fixed before merging`,
      sessionIds: sessions.map((s) => s.id),
      paths: conflict.paths.slice(0, 20),
      fingerprint: fingerprint(
        'check_broken_early',
        'merge',
        conflict.id,
        ...[...conflict.sessionIds].sort(),
      ),
      refs: { conflictId: conflict.id },
    });
  }

  /**
   * A shadow merge of live sessions ran its checks: failing checks whose conflict it resolved
   * pass again before anything was merged.
   */
  mergeChecksPassed(projectId: string, conflictIds: readonly string[], eventId: string): void {
    this.brokenChecksFixed(projectId, conflictIds, eventId);
  }

  /**
   * The sentinel found the agent edit that broke a check (a new `check_failed` conflict naming
   * that session). Confirmed when the check passes again while the session is still working;
   * dropped when the session ends with the check still failing.
   */
  sentinelCaught(conflict: Conflict, eventId: string, culprit: Session): Save | null {
    return this.recordWith(conflict.projectId, eventId, {
      kind: 'check_broken_early',
      title: `A check ${this.name(culprit)} broke was found right after the edit and fixed`,
      sessionIds: [culprit.id],
      paths: conflict.paths.slice(0, 20),
      fingerprint: fingerprint('check_broken_early', 'sentinel', conflict.id, culprit.id),
      refs: { conflictId: conflict.id },
    });
  }

  /**
   * Failing checks whose `check_failed` conflicts were resolved because the checks pass again
   * (shadow merge, sentinel): their saves are confirmed while every session involved still works.
   */
  brokenChecksFixed(projectId: string, conflictIds: readonly string[], eventId: string): void {
    const ids = new Set(conflictIds);
    for (const s of this.caughtOf(projectId, 'check_broken_early', null)) {
      if (!s.refs.conflictId || !ids.has(s.refs.conflictId)) continue;
      const live = s.sessionIds.every((id) => this.k.store.sessions.find(id)?.status !== 'ended');
      if (live) this.confirm(s, [eventId]);
    }
  }

  // ------------------------------------------------------------------ housekeeping

  /**
   * Settles caught saves whose window passed: an overlap or mistake save is confirmed only when
   * the helped agent made a later tool call that was not about the problem (and nothing dropped
   * it already); everything else expires. Also drops saves whose
   * conflict was dismissed. Returns how many saves changed. Never throws.
   */
  sweep(projectId?: string): { confirmed: number; expired: number; rejected: number } {
    const out = { confirmed: 0, expired: 0, rejected: 0 };
    try {
      const projects = projectId ? [projectId] : this.k.store.projects.list().map((p) => p.id);
      const now = this.k.clock.now();
      for (const pid of projects.slice(0, 200)) {
        for (const s of this.k.store.saves.list(pid, { statuses: ['caught'], limit: 500 })) {
          const conflict = s.refs.conflictId
            ? this.k.store.conflicts.find(s.refs.conflictId)
            : null;
          if (conflict?.status === 'dismissed') {
            if (this.reject(s, 'conflict_dismissed', [])) out.rejected++;
            continue;
          }
          const window = SAVE_WINDOW_MS[s.kind];
          if (now - s.createdAt < window) continue;
          if (s.kind === 'overlap_avoided' || s.kind === 'mistake_avoided') {
            const until = s.createdAt + window;
            const later = this.laterToolCall(s, until);
            const ran = s.kind === 'mistake_avoided' && this.commandRan(s, until);
            if (later && !ran && this.confirm(s, [later.id], this.finalTitle(s))) {
              out.confirmed++;
              continue;
            }
          }
          if (this.expire(s, [])) out.expired++;
        }
      }
    } catch (err) {
      this.k.logger.error('saves: sweep failed', { error: describeError(err) });
    }
    return out;
  }

  /**
   * A tool call of the helped session after the warning, up to `until`, that is not about the
   * problem: for an overlap, a call that does not write (or name, in a shell command) the warned
   * file; for a mistake, anything but the warned command line again.
   */
  private laterToolCall(s: Save, until: number): MindlyEvent | null {
    const sessionId = s.sessionIds[0];
    if (!sessionId) return null;
    return (
      this.k.store.events
        .query(s.projectId, {
          sessionId,
          types: TOOL_TYPES,
          since: s.createdAt,
          until: until + 1,
          limit: 200,
        })
        .find((e) => {
          if (e.id === s.evidence[0]) return false;
          if (s.kind === 'overlap_avoided') {
            const about = [...strings(e.payload.paths, 50), ...strings(e.payload.touched, 20)];
            return !about.some((f) => s.paths.includes(f));
          }
          return !s.refs.commandLine || text(e.payload.line) !== s.refs.commandLine;
        }) ?? null
    );
  }

  /** Whether a command with the warned command's key ran (a `post_tool`) up to `until`. */
  private commandRan(s: Save, until: number): boolean {
    const sessionId = s.sessionIds[0];
    if (!sessionId || !s.refs.command) return false;
    return this.k.store.events
      .query(s.projectId, {
        sessionId,
        types: ['tool.after'],
        since: s.createdAt,
        until: until + 1,
        limit: 200,
      })
      .some((e) => text(e.payload.command) === s.refs.command);
  }

  /** The sentence of a save confirmed by the sweep, when it differs from the caught one. */
  private finalTitle(s: Save): { title?: string } {
    if (s.kind !== 'mistake_avoided') return {};
    return { title: `${this.helpedName(s)} didn't run a command that failed before` };
  }

  private helpedName(s: Save): string {
    const helped = this.k.store.sessions.find(s.sessionIds[0] ?? '');
    return helped ? this.name(helped) : 'An agent';
  }

  // ------------------------------------------------------------------ the user

  /** `mindly saves reject`: "not a save". Removes it from every total. */
  rejectByUser(id: string): Save {
    const s = this.k.store.saves.get(id);
    return this.reject(s, 'user', []) ?? this.k.store.saves.get(id);
  }

  // ------------------------------------------------------------------ reading

  /** Saves of a project, newest first. */
  list(
    projectId: string,
    opts: { since?: number; statuses?: readonly Save['status'][]; limit?: number } = {},
  ): Save[] {
    return this.k.store.saves.list(projectId, opts);
  }

  /** Confirmed saves caught at or after `since`: totals by kind and by helped agent. */
  summary(projectId: string, since: number): SavesSummary {
    const confirmed = this.k.store.saves.list(projectId, {
      since,
      statuses: ['confirmed'],
      limit: 1000,
    });
    const byKind: Partial<Record<SaveKind, number>> = {};
    const byAgent: Record<string, number> = {};
    for (const s of confirmed) {
      byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
      const kind = this.k.store.sessions.find(s.sessionIds[0] ?? '')?.agentKind;
      if (kind) byAgent[kind] = (byAgent[kind] ?? 0) + 1;
    }
    return { since, total: confirmed.length, byKind, byAgent, recent: confirmed.slice(0, 10) };
  }

  // ------------------------------------------------------------------ helpers

  private name(s: Session): string {
    return agentProductName(s.agentKind);
  }

  private record(e: MindlyEvent, input: SaveInput): Save | null {
    return this.recordWith(e.projectId, e.id, input);
  }

  /**
   * Records a caught save proven by `eventId`. Returns it while it is still caught; null when the
   * same problem was already settled (counted once).
   */
  private recordWith(projectId: string, eventId: string, input: SaveInput): Save | null {
    const { save, created } = this.k.store.saves.record({
      projectId,
      ...input,
      title: sanitizeLine(input.title, 200),
      evidence: [eventId],
    });
    if (!created) return save.status === 'caught' ? save : null;
    this.k.store.events.append({
      projectId,
      sessionId: null,
      type: 'save.caught',
      payload: { saveId: save.id, kind: save.kind, title: save.title },
    });
    return save;
  }

  private confirm(
    s: Save,
    evidence: string[],
    change: { title?: string; sessionIds?: string[] } = {},
  ): Save | null {
    const saved = this.k.store.saves.settle(s.id, 'confirmed', { evidence, ...change });
    if (!saved) return null;
    this.k.store.events.append({
      projectId: saved.projectId,
      sessionId: null,
      type: 'save.confirmed',
      payload: { saveId: saved.id, kind: saved.kind, title: saved.title, evidence: saved.evidence },
    });
    return saved;
  }

  /** No evidence either way, or none that the warning changed anything: not counted. */
  private expire(s: Save, evidence: string[]): Save | null {
    return this.k.store.saves.settle(s.id, 'expired', { evidence });
  }

  private reject(s: Save, reason: SaveRejectReason, evidence: string[]): Save | null {
    const saved = this.k.store.saves.settle(s.id, 'rejected', { evidence });
    if (!saved) return null;
    this.k.store.events.append({
      projectId: saved.projectId,
      sessionId: null,
      type: 'save.rejected',
      payload: { saveId: saved.id, kind: saved.kind, title: saved.title, reason },
    });
    return saved;
  }

  /** Caught saves of a project, optionally of one kind and helped session (indexed by status). */
  private caughtOf(projectId: string, kind: SaveKind | null, sessionId: string | null): Save[] {
    if (sessionId !== null) {
      return this.k.store.saves.caughtFor(projectId, sessionId, kind ? [kind] : ALL_KINDS, 500);
    }
    return this.k.store.saves.list(projectId, {
      statuses: ['caught'],
      ...(kind ? { kinds: [kind] } : {}),
      limit: 500,
    });
  }

  /** Caught or confirmed saves about a conflict. */
  private linkedTo(projectId: string, conflictId: string): Save[] {
    return this.k.store.saves
      .list(projectId, { statuses: ['caught', 'confirmed'], limit: 1000 })
      .filter((s) => s.refs.conflictId === conflictId);
  }

  /** Whether the other agent's intent an overlap save is about is still active now. */
  private intentActive(s: Save): boolean {
    const intent = s.refs.intentId ? this.findIntent(s.refs.intentId) : null;
    return intent !== null && intent.status === 'active' && intent.expiresAt >= this.k.clock.now();
  }

  private findIntent(id: string): { status: string; expiresAt: number } | null {
    try {
      return this.k.store.intents.get(id);
    } catch {
      return null;
    }
  }

  private contractPath(id: string): string | null {
    try {
      return this.k.store.contracts.get(id).spec.path ?? null;
    } catch {
      return null;
    }
  }

  private contractState(id: string): string | null {
    try {
      return this.k.store.contracts.get(id).state;
    } catch {
      return null;
    }
  }
}

/**
 * Feature module: follows the event log of this process. Installed by every entry point except
 * the MCP server (agents must not be able to create or change saves).
 */
export const savesModule = (mindly: Mindly): void => {
  const service = attachService(mindly, 'saves', new SavesService(mindly.kernel));
  mindly.store.events.subscribe((e) => service.observe(e));
};
