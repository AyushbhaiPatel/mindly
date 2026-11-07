import { shortId, type Conflict, type ContextItem, type Session } from '@mindly/core';
import type {
  ProvenanceResult,
  SavesSummary,
  StandupDigest,
  XRayMissing,
  XRayMissingItem,
  XRaySession,
} from '@mindly/engine';
import {
  absoluteTime,
  agentName,
  capitalise,
  conflictStatusWord,
  count,
  handoffStatusWord,
  humanizeText,
  memoryKindWord,
  relativeTime,
  sessionName,
  severityWord,
  spanWords,
  trustWord,
  type Marker,
  type Row,
  type TableRow,
  type Screen,
  type Step,
} from '../present/index.js';
import { clean } from '../util.js';
import { conflictMarker, conflictText, type SessionLookup } from './common.js';
import { renderStandupSaves } from './saves.js';

// ---------------------------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------------------------

/** A conflict's stored detail, cleaned and in human words ("1 file imports it"). */
export function plainDetail(detail: string): string {
  return humanizeText(clean(detail, 300))
    .replace(/\b1 file\(s\) import\b/g, '1 file imports')
    .replace(/\bfile\(s\)/g, 'files');
}

/** Renders `mindly conflicts [--all]`. */
export function renderConflicts(
  sc: Screen,
  list: Conflict[],
  sessionOf: SessionLookup,
  all: boolean,
): void {
  const open = list.filter((c) => c.status === 'open' || c.status === 'acknowledged');
  if (list.length === 0) {
    sc.summary(all ? 'No conflicts recorded.' : 'No open conflicts.');
    sc.note(
      "Mindly reports a conflict when one agent's change breaks or overlaps another agent's work.",
    );
    return;
  }
  sc.summary(
    all
      ? `${count(list.length, 'conflict')} ${sc.sym.dot} ${open.length} open`
      : `${count(open.length, 'open conflict')}`,
  );
  sc.blank();
  sc.table(
    [
      { header: 'Severity' },
      { header: 'What', fill: true, min: 30 },
      { header: 'Status', drop: 2 },
      { header: 'When', right: true, drop: 1 },
      { header: 'Id' },
    ],
    list.map((c): TableRow => ({
      cells: [
        `${sc.mark(c.status === 'resolved' || c.status === 'dismissed' ? 'ok' : conflictMarker(c))} ${severityWord(c.severity)}`,
        conflictText(c, sessionOf),
        conflictStatusWord(c.status),
        relativeTime(c.createdAt, sc.now),
        sc.ref(c.id),
      ],
      ...(c.detail ? { note: plainDetail(c.detail) } : {}),
    })),
  );
  const first = open[0];
  if (first) {
    sc.next([
      { cmd: `mindly conflict ${shortId(first.id)} resolve`, why: 'mark it resolved once fixed' },
      { cmd: `mindly conflict ${shortId(first.id)} dismiss`, why: 'if it is not a real problem' },
    ]);
  }
}

// ---------------------------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------------------------

/** Renders `mindly why <file>:<line>`. */
export function renderWhy(sc: Screen, r: ProvenanceResult): void {
  sc.summary(`${clean(r.path, 300)}:${r.line}`);
  sc.text(clean(r.text, 160), 2);
  sc.blank();
  if (r.changes.length === 0) {
    sc.text('No agent edit is on record for this line: a person wrote it, or it predates Mindly.');
  }
  for (const [i, c] of r.changes.entries()) {
    // The stored label is the engine's (`claude-code #4409d433`); rebuild the human one.
    const who = c.agentKind
      ? sessionName({ id: c.sessionId, agentKind: c.agentKind, label: null })
      : 'an unknown agent';
    const when = `${absoluteTime(c.at)} (${relativeTime(c.at, sc.now)})`;
    sc.text(
      `${i === 0 ? 'Written by' : 'Before that, changed by'} ${who} with its ${clean(c.tool, 40)} tool, ${when}`,
    );
    if (c.prompt) sc.text(`Asked to: "${clean(c.prompt, 200)}"`, 2);
  }
  if (r.memories.length) {
    sc.section('Related memories');
    sc.rows(
      r.memories.map((m) => ({
        marker: m.evidenceValid ? 'ok' : 'warn',
        text: `${capitalise(memoryKindWord(m.kind))}: ${clean(m.title, 100)} (${trustWord(m.trust)}${m.evidenceValid ? '' : '; the code changed since'})`,
        id: m.id,
      })),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// xray
// ---------------------------------------------------------------------------------------------

const TRIGGERS: Record<XRaySession['packets'][number]['trigger'], string> = {
  session_start: 'at session start',
  prompt: 'with a prompt',
  pre_tool: 'before an edit',
  post_tool: 'after a tool ran',
  mcp: 'when it asked Mindly',
};

/** One context item in words. */
export function itemWords(it: ContextItem): string {
  const title = humanizeText(clean(it.title, 100));
  switch (it.kind) {
    case 'session':
      return `${title} is working in this project too`;
    case 'memory': {
      const kind = /^(fact|decision|rule|mistake|note)\//.exec(it.reason)?.[1] as
        Parameters<typeof memoryKindWord>[0] | undefined;
      return `${kind ? memoryKindWord(kind) : 'memory'} "${title}"`;
    }
    case 'conflict':
      return `conflict: ${title}`;
    case 'delivery':
      return `update: ${title}`;
    case 'task':
      return `its task "${title}"`;
    case 'handoff':
      return `handoff: ${title}`;
    case 'intent':
      return `warning: ${title}`;
  }
}

/** Renders `mindly xray` for one session. */
export function renderXray(sc: Screen, session: Session, r: XRaySession): void {
  const name = sessionName(session);
  const agent = agentName(session.agentKind);
  sc.summary(`Context sent to ${name}`);
  if (r.packets.length === 0) {
    sc.note(
      `Mindly has not sent ${agent} anything yet. It sends context at session start, with prompts and before edits.`,
    );
    return;
  }
  for (const p of r.packets) {
    sc.blank();
    const when = `${TRIGGERS[p.trigger]} (${relativeTime(p.at, sc.now)})`;
    const n = p.included.length;
    const query = p.query ? `, for "${clean(p.query, 80)}"` : '';
    if (n === 0) sc.text(`${capitalise(when)}${query}, ${agent} received nothing new.`);
    else {
      sc.text(`${capitalise(when)}${query}, ${agent} received ${count(n, 'item')}:`);
      sc.rows(p.included.map((it) => ({ marker: 'ok', text: capitalise(itemWords(it)) })));
    }
    if (p.omitted.length) {
      sc.text(`Left out (no room left in the context): ${count(p.omitted.length, 'item')}`);
      sc.rows(p.omitted.map((it) => ({ marker: 'warn', text: capitalise(itemWords(it)) })));
    } else if (n > 0) {
      sc.note('Left out: nothing.');
    }
  }
  sc.next([
    {
      cmd: `mindly xray --session ${shortId(session.id)} --query "<words>"`,
      why: 'find out why a memory did or did not reach it',
    },
  ]);
}

function missingWords(it: XRayMissingItem): { marker: Marker; why: string } {
  switch (it.reason) {
    case 'included':
      return { marker: 'ok', why: 'would be sent' };
    case 'budget':
      return { marker: 'warn', why: 'would be left out: no room left in the context' };
    case 'already_served':
      return { marker: 'item', why: 'already sent to this session recently' };
    case 'trust_filter':
      return {
        marker: 'warn',
        why:
          it.trust === 'proposed'
            ? 'not sent: waiting for your approval'
            : `not sent: ${trustWord(it.trust)}`,
      };
    case 'branch_filter':
      return { marker: 'warn', why: 'not sent: it belongs to another branch' };
    case 'rank_limit':
      return { marker: 'item', why: 'not sent: other memories matched better' };
  }
}

/** Renders `mindly xray --query`. */
export function renderXrayQuery(sc: Screen, session: Session, r: XRayMissing): void {
  sc.summary(`Would memories about "${clean(r.query, 80)}" reach ${sessionName(session)}?`);
  if (r.items.length === 0) {
    sc.note('No memory matches those words.');
    return;
  }
  sc.blank();
  sc.rows(
    r.items.map((it) => {
      const w = missingWords(it);
      return {
        marker: w.marker,
        text: `${capitalise(memoryKindWord(it.kind))} "${clean(it.title, 100)}": ${w.why}`,
        id: it.memoryId,
      };
    }),
  );
  const waiting = r.items.find((it) => it.reason === 'trust_filter' && it.trust === 'proposed');
  if (waiting) {
    sc.next([
      { cmd: `mindly memory approve ${shortId(waiting.memoryId)}`, why: 'let it reach agents' },
    ]);
  }
}

// ---------------------------------------------------------------------------------------------
// standup
// ---------------------------------------------------------------------------------------------

/** Renders `mindly standup` from the engine's digest. */
export function renderStandup(sc: Screen, d: StandupDigest, saves?: SavesSummary): void {
  const sep = sc.sym.dot;
  sc.summary(
    `Standup ${sep} ${clean(d.projectName, 60)} ${sep} last ${spanWords(d.until - d.since)} (since ${relativeTime(d.since, sc.now)})`,
  );
  const n = d.needsYou;
  if (d.agents.length) {
    sc.section('Agents');
    sc.rows(
      d.agents.map((a) => {
        const parts = [count(a.sessions, 'session')];
        if (a.turns) parts.push(count(a.turns, 'turn'));
        parts.push(
          a.filesChanged
            ? `changed ${count(a.filesChanged, 'file')}${
                a.topFiles.length
                  ? ` (${a.topFiles
                      .slice(0, 3)
                      .map((f) => clean(f, 80))
                      .join(', ')})`
                  : ''
              }`
            : 'no file changes',
        );
        if (a.rateLimits) {
          parts.push(
            `hit its usage limit ${a.rateLimits === 1 ? 'once' : `${a.rateLimits} times`}`,
          );
        }
        return { marker: 'item', text: `${agentName(a.agentKind)}: ${parts.join(', ')}` };
      }),
    );
  } else {
    sc.blank();
    sc.note('No agent worked in this project in that time.');
  }
  if (saves) renderStandupSaves(sc, saves);
  const mem: Row[] = [];
  const titles = (items: { title: string }[]): string =>
    items
      .slice(0, 3)
      .map((i) => `"${clean(i.title, 80)}"`)
      .join(', ') + (items.length > 3 ? ` and ${items.length - 3} more` : '');
  if (d.memories.decisions.length) {
    mem.push({
      marker: 'item',
      text: `${count(d.memories.decisions.length, 'new decision')}: ${titles(d.memories.decisions)}`,
    });
  }
  if (d.memories.rules.length) {
    mem.push({
      marker: 'item',
      text: `${count(d.memories.rules.length, 'new rule')}: ${titles(d.memories.rules)}`,
    });
  }
  if (d.memories.facts.length) {
    mem.push({
      marker: 'item',
      text: `${count(d.memories.facts.length, 'new fact')}: ${titles(d.memories.facts)}`,
    });
  }
  if (mem.length) {
    sc.section('Learned');
    sc.rows(mem);
  }
  const coord: Row[] = [];
  const c = d.conflicts;
  if (c.opened || c.resolved || c.open) {
    coord.push({
      marker: c.open ? 'warn' : 'ok',
      text: `${count(c.opened, 'conflict')} opened, ${c.resolved} resolved, ${c.open} still open`,
    });
  }
  if (d.handoffs.length) {
    const claimed = d.handoffs.filter((h) => h.status !== 'pending').length;
    coord.push({
      marker: 'item',
      text: `${count(d.handoffs.length, 'handoff')} between agents, ${claimed} picked up`,
    });
  }
  if (d.blockedTasks.length) {
    coord.push({
      marker: 'warn',
      text: `${count(d.blockedTasks.length, 'blocked task')}: ${titles(d.blockedTasks)}`,
    });
  }
  if (coord.length) {
    sc.section('Coordination');
    sc.rows(coord);
  }
  const needs: Row[] = [
    ...n.criticalConflicts.map((x) => ({
      marker: 'fail' as const,
      text: `Urgent conflict: ${humanizeText(clean(x.title, 120))}`,
      id: x.id,
    })),
    ...n.proposedRules.map((x) => ({
      marker: 'item' as const,
      text: `Suggested rule: "${clean(x.title, 120)}"`,
      id: x.id,
    })),
    ...n.proposedMemories.map((x) => ({
      marker: 'item' as const,
      text: `Suggested memory: "${clean(x.title, 120)}"`,
      id: x.id,
    })),
    ...n.unclaimedHandoffs.map((h) => ({
      marker: 'item' as const,
      text: `Handoff from ${h.fromAgentKind ? agentName(h.fromAgentKind) : 'an agent'} ${handoffStatusWord('pending', h.toAgentKind)}`,
      id: h.id,
    })),
  ];
  if (needs.length) {
    sc.section('Needs you');
    sc.rows(needs);
  }
  const steps: Step[] = [];
  if (n.proposedRules[0]) {
    steps.push({ cmd: 'mindly rules', why: 'review the suggested rules' });
  }
  if (needs.length) steps.push({ cmd: 'mindly status', why: 'see everything that needs you' });
  sc.next(steps.slice(0, 2));
}
