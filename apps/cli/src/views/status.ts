import {
  conflictNeedsUser,
  shortId,
  type Conflict,
  type Handoff,
  type Intent,
  type Memory,
  type Session,
  type Task,
} from '@mindly/core';
import {
  agentName,
  count,
  handoffStatusWord,
  relativeTime,
  sessionName,
  sessionStatusWord,
  taskStatusWord,
  type Marker,
  type Row,
  type Screen,
  type Step,
} from '../present/index.js';
import { clean } from '../util.js';
import { conflictMarker, conflictText, suggestionText, type SessionLookup } from './common.js';

/** What one live agent is doing. */
export interface AgentActivity {
  session: Session;
  /** Files it declared it is about to edit (active intents). */
  editing: string[];
  /** Intent summaries without files. */
  plans: string[];
  lastEdit: { path: string; at: number } | null;
  task: Task | null;
}

/** Everything `mindly status` shows. */
export interface StatusData {
  projectName: string;
  agents: AgentActivity[];
  conflicts: Conflict[];
  proposed: Memory[];
  handoffs: Handoff[];
  tasks: Task[];
  /** Active intents of sessions that are not in `agents` (e.g. a session that went quiet). */
  otherIntents: Intent[];
  /** The project has a `.mindly/config.json` that is not trusted (or is invalid). */
  config: 'none' | 'trusted' | 'untrusted' | 'invalid';
  sessionOf: SessionLookup;
}

/** Number of items in "Needs you". */
export function needsYouCount(d: StatusData): number {
  return (
    d.conflicts.filter(conflictNeedsUser).length +
    d.proposed.length +
    d.handoffs.length +
    (d.config === 'untrusted' || d.config === 'invalid' ? 1 : 0)
  );
}

function files(list: readonly string[], max = 2): string {
  const shown = list.slice(0, max).map((f) => clean(f, 100));
  return `${shown.join(', ')}${list.length > max ? ` +${list.length - max} more` : ''}`;
}

function activity(a: AgentActivity, now: number): string {
  const s = a.session;
  const parts = [sessionStatusWord(s.status)];
  if (s.branch) parts.push(clean(s.branch, 60));
  if (a.editing.length) parts.push(`editing ${files(a.editing)}`);
  else if (a.plans[0] !== undefined) parts.push(`plans to ${clean(a.plans[0], 80).toLowerCase()}`);
  else if (a.lastEdit) {
    parts.push(`edited ${clean(a.lastEdit.path, 100)} ${relativeTime(a.lastEdit.at, now)}`);
  } else parts.push(`last active ${relativeTime(s.lastSeenAt, now)}`);
  if (a.task) parts.push(`task: ${clean(a.task.title, 80)}`);
  return parts.join(' \u00B7 ');
}

function agentMarker(s: Session): Marker {
  return s.status === 'active' ? 'agent' : s.status === 'rate_limited' ? 'warn' : 'idle';
}

function summary(d: StatusData, sep: string): string {
  const working = d.agents.filter((a) => a.session.status === 'active').length;
  const other = d.agents.length - working;
  const needs = needsYouCount(d);
  const head = `Mindly ${sep} ${clean(d.projectName, 60)}`;
  if (d.agents.length === 0 && needs === 0) return `${head} ${sep} All quiet.`;
  const agents =
    d.agents.length === 0
      ? 'no agents running'
      : working > 0
        ? `${count(working, 'agent')} working${other ? `, ${other} idle` : ''}`
        : `${count(other, 'agent')} idle`;
  const you =
    needs === 0
      ? 'nothing needs you'
      : `${count(needs, 'thing')} ${needs === 1 ? 'needs' : 'need'} you`;
  return `${head} ${sep} ${agents} ${sep} ${you}`;
}

const MAX_ITEMS = 8;

/** Renders `mindly status` (docs/output-style.md, "Shape of a screen"). */
export function renderStatus(sc: Screen, d: StatusData): void {
  const sep = sc.sym.dot;
  sc.summary(summary(d, sep));
  if (d.agents.length === 0 && needsYouCount(d) === 0 && d.tasks.length === 0) {
    sc.note('No agent is working in this project right now. Agents appear here when they start.');
    return;
  }

  if (d.agents.length) {
    sc.section('Agents');
    sc.pairs(
      d.agents.map(
        (a) =>
          [
            `${sc.mark(agentMarker(a.session))} ${sessionName(a.session)}`,
            activity(a, sc.now),
          ] as const,
      ),
    );
  }

  const needs: Row[] = [];
  if (d.config === 'invalid') {
    needs.push({ marker: 'fail', text: "This project's .mindly/config.json is invalid" });
  } else if (d.config === 'untrusted') {
    needs.push({
      marker: 'warn',
      text: "This project's .mindly/config.json is not trusted yet, so its checks do not run",
    });
  }
  const conflicts = d.conflicts
    .filter(conflictNeedsUser)
    .sort((a, b) => (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0));
  for (const c of conflicts) {
    needs.push({
      marker: conflictMarker(c),
      text: `Conflict: ${conflictText(c, d.sessionOf)}`,
      id: c.id,
    });
  }
  for (const m of d.proposed) {
    needs.push({ marker: 'item', text: suggestionText(m), id: m.id });
  }
  for (const h of d.handoffs) {
    needs.push({
      marker: 'item',
      text: `Handoff ${handoffStatusWord(h.status, h.toAgentKind)}: "${clean(h.summary, 100)}"`,
      id: h.id,
    });
  }
  if (needs.length) {
    sc.section('Needs you');
    sc.rows(needs.slice(0, MAX_ITEMS));
    if (needs.length > MAX_ITEMS) {
      sc.note(`  ${sc.sym.ellipsis} and ${needs.length - MAX_ITEMS} more`);
    }
  }

  if (d.tasks.length) {
    sc.section('Tasks');
    sc.rows(
      d.tasks.slice(0, MAX_ITEMS).map((t) => {
        const owner = t.ownerSessionId ? d.sessionOf(t.ownerSessionId) : null;
        const who = owner ? ` ${sc.sym.dot} ${agentName(owner.agentKind)}` : '';
        return {
          marker: t.status === 'blocked' ? 'warn' : 'item',
          text: `${clean(t.title, 100)} (${taskStatusWord(t.status)}${who})`,
        };
      }),
    );
  }

  if (d.otherIntents.length) {
    sc.section('Planned edits');
    sc.rows(
      d.otherIntents.slice(0, MAX_ITEMS).map((i) => {
        const s = d.sessionOf(i.sessionId);
        const who = s ? agentName(s.agentKind) : 'An agent';
        const what = i.targets.files.length
          ? `plans to edit ${files(i.targets.files, 3)}`
          : `plans to ${clean(i.summary, 100).toLowerCase()}`;
        return { marker: 'item', text: `${who} ${what}` };
      }),
    );
  }

  sc.next(statusSteps(d));
}

/** The one or two most useful next commands. */
export function statusSteps(d: StatusData): Step[] {
  const steps: Step[] = [];
  const add = (s: Step): void => {
    if (steps.length < 2) steps.push(s);
  };
  if (d.config === 'invalid' || d.config === 'untrusted') {
    add({ cmd: 'mindly trust', why: 'review the project config and its commands' });
  }
  const urgent = [...d.conflicts].sort(
    (a, b) => (b.severity === 'critical' ? 1 : 0) - (a.severity === 'critical' ? 1 : 0),
  )[0];
  if (urgent)
    add({
      cmd: `mindly conflict ${shortId(urgent.id)} resolve`,
      why: 'mark the conflict resolved',
    });
  const rule = d.proposed.find((m) => m.kind === 'rule');
  if (rule)
    add({
      cmd: `mindly rules --approve ${shortId(rule.id)}`,
      why: 'make the rule apply to every agent',
    });
  const mem = d.proposed.find((m) => m.kind !== 'rule');
  if (mem)
    add({ cmd: `mindly memory approve ${shortId(mem.id)}`, why: 'share it with every agent' });
  if (d.handoffs.length)
    add({ cmd: 'mindly handoffs', why: 'see what is waiting to be picked up' });
  return steps;
}
