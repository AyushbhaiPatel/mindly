import { isRepoFileSource, type Conflict, type Memory, type Session } from '@mindly/core';
import type { Store } from '@mindly/store';
import {
  agentName,
  capitalise,
  humanizeText,
  memoryKindWord,
  relativeTime,
  sourceWord,
  trustWord,
  type Column,
  type Marker,
  type Row,
  type Screen,
  type TableRow,
} from '../present/index.js';
import { clean } from '../util.js';

/** Looks up a session by id (null when unknown or deleted). */
export type SessionLookup = (id: string) => Session | null;

/** Session lookup for views, cached for one command. */
export function sessionLookup(store: Store): SessionLookup {
  const cache = new Map<string, Session | null>();
  return (id) => {
    if (!cache.has(id)) cache.set(id, store.sessions.find(id));
    return cache.get(id) ?? null;
  };
}

/**
 * One plain sentence for a conflict, e.g. "Claude Code - 4409d433 changed the exports of
 * src/auth.ts; Codex's src/dash.ts uses them".
 */
export function conflictText(c: Conflict, sessionOf: SessionLookup): string {
  const title = humanizeText(clean(c.title, 160));
  if (c.kind === 'impact' && c.paths.length > 1) {
    const other = c.sessionIds[1] !== undefined ? sessionOf(c.sessionIds[1]) : null;
    const users = c.paths.slice(1, 4).map((p) => clean(p, 100));
    const more = c.paths.length > 4 ? ` and ${c.paths.length - 4} more` : '';
    const owner = other ? `${agentName(other.agentKind)}'s ` : '';
    const verb = users.length === 1 && !more ? 'uses' : 'use';
    return `${title}; ${owner}${users.join(', ')}${more} ${verb} them`;
  }
  return title;
}

/** Marker for a conflict by severity: urgent `x`, check this `!`, FYI `-`. */
export function conflictMarker(c: Conflict): Marker {
  return c.severity === 'critical' ? 'fail' : c.severity === 'warning' ? 'warn' : 'item';
}

/** Marker for a memory by trust. */
export function memoryMarker(m: Memory): Marker {
  if (m.trust === 'approved' || m.trust === 'verified') return 'ok';
  if (m.trust === 'rejected') return 'fail';
  return 'warn';
}

/** Extra facts about a memory: enforced, always sent, archived. */
export function memoryFlags(m: Memory): string[] {
  const f: string[] = [];
  if (m.enforce) f.push('enforced: blocks edits that break it');
  if (m.pinned) f.push('always sent to agents');
  if (m.status === 'archived') f.push('archived');
  return f;
}

/** `Suggested rule from Claude Code: "Don't use default exports"`. */
export function suggestionText(m: Memory): string {
  const who = sourceWord(m.source);
  const kind = memoryKindWord(m.kind);
  const from = who === 'you' ? (m.source.agentKind ? agentName(m.source.agentKind) : 'you') : who;
  return `Suggested ${kind} from ${from}: "${clean(m.title, 120)}"`;
}

/** Trust in two or three words for a table cell: approved / waiting for you / may be outdated. */
export function trustShort(m: Memory): string {
  switch (m.trust) {
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
  }
}

/** Who a memory came from, short: you / Claude Code / AGENTS.md / the code. */
export function fromShort(m: Memory): string {
  if (isRepoFileSource(m.source)) return 'a repository file';
  const who = sourceWord(m.source);
  if (who === 'you' && m.trust === 'proposed' && m.source.agentKind) {
    return `you, in ${agentName(m.source.agentKind)}`;
  }
  return who;
}

/** Columns of a memory table; `kind` adds the Kind column. */
export function memoryColumns(opts: { kind?: boolean } = {}): Column[] {
  return [
    { header: 'Status' },
    ...(opts.kind === false ? [] : [{ header: 'Kind', drop: 1 }]),
    { header: opts.kind === false ? 'Rule' : 'Title', fill: true, min: 24 },
    { header: 'From', max: 22, drop: 2 },
    { header: 'Updated', right: true, drop: 3 },
    { header: '' },
  ];
}

/** A memory as table cells matching {@link memoryColumns}. */
export function memoryTableRow(sc: Screen, m: Memory, opts: { kind?: boolean } = {}): TableRow {
  const flags = memoryFlags(m).map((f) => f.split(':')[0] as string);
  const status = [trustShort(m), ...flags].join(` ${sc.sym.dot} `);
  return {
    cells: [
      `${sc.mark(memoryMarker(m))} ${status}`,
      ...(opts.kind === false ? [] : [memoryKindWord(m.kind)]),
      clean(m.title, 160),
      fromShort(m),
      relativeTime(m.updatedAt, sc.now),
      sc.ref(m.id),
    ],
  };
}

/** A memory as a list row: `rule: Use pnpm   approved by you   [5aa7b7d3]`. */
export function memoryRow(m: Memory, opts: { showKind?: boolean } = {}): Row {
  const kind = opts.showKind === false ? '' : `${capitalise(memoryKindWord(m.kind))}: `;
  const facts = [trustWord(m.trust, m.source), ...memoryFlags(m)].join('; ');
  return { marker: memoryMarker(m), text: `${kind}${clean(m.title, 120)} (${facts})`, id: m.id };
}
