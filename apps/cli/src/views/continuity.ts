import { shortId, type Handoff, type Snapshot } from '@mindly/core';
import {
  agentName,
  count,
  handoffReasonWord,
  handoffStatusWord,
  relativeTime,
  sessionName,
  type Screen,
  type TableRow,
} from '../present/index.js';
import { clean } from '../util.js';
import type { SessionLookup } from './common.js';

/** Renders `mindly handoffs`. */
export function renderHandoffs(sc: Screen, list: Handoff[], sessionOf: SessionLookup): void {
  if (list.length === 0) {
    sc.summary('No handoffs.');
    sc.note(
      'A handoff passes a task from one agent to another, e.g. when one hits its usage limit. Create one with: mindly handoff --summary "..." --to codex',
    );
    return;
  }
  const waiting = list.filter((h) => h.status === 'pending');
  sc.summary(
    `${count(list.length, 'handoff')}${waiting.length ? ` ${sc.sym.dot} ${waiting.length} waiting to be picked up` : ''}`,
  );
  sc.blank();
  sc.table(
    [
      { header: 'Status' },
      { header: 'Work', fill: true, min: 24 },
      { header: 'From', max: 26, drop: 1 },
      { header: 'Why', max: 30, drop: 3 },
      { header: 'When', right: true, drop: 2 },
      { header: 'Id' },
    ],
    list.map((h): TableRow => {
      const from = sessionOf(h.fromSessionId);
      const claimer = h.claimedBySessionId ? sessionOf(h.claimedBySessionId) : null;
      const marker = h.status === 'pending' ? 'warn' : h.status === 'cancelled' ? 'item' : 'ok';
      const next = h.packet.nextSteps
        .slice(0, 3)
        .map((x) => clean(x, 100))
        .join('; ');
      return {
        cells: [
          `${sc.mark(marker)} ${handoffStatusWord(h.status, h.toAgentKind, claimer ? agentName(claimer.agentKind) : null)}`,
          clean(h.summary, 120),
          from ? agentName(from.agentKind) : 'an agent',
          handoffReasonWord(h.reason),
          relativeTime(h.createdAt, sc.now),
          sc.ref(h.id),
        ],
        ...(next ? { note: `Next: ${next}` } : {}),
      };
    }),
  );
  const first = waiting[0];
  if (first) {
    const who = first.toAgentKind ? agentName(first.toAgentKind) : 'any agent';
    sc.next([
      {
        why: `Start ${who} in this project: it picks the handoff up at the start of its session.`,
      },
    ]);
  }
}

/** Renders `mindly snapshot list`. */
export function renderSnapshots(sc: Screen, list: Snapshot[]): void {
  if (list.length === 0) {
    sc.summary('No snapshots.');
    sc.note(
      'A snapshot saves the code, memory and task state so you can see or undo what agents changed since.',
    );
    sc.next([{ cmd: 'mindly snapshot create "before refactor"', why: 'take one now' }]);
    return;
  }
  sc.summary(count(list.length, 'snapshot'));
  sc.blank();
  sc.rows(
    list.map((s) => ({
      marker: 'item',
      text: `"${clean(s.label, 80)}" ${sc.sym.dot} ${relativeTime(s.createdAt, sc.now)}${s.commit ? ` ${sc.sym.dot} code at commit ${s.commit.slice(0, 8)}` : ` ${sc.sym.dot} memory and tasks only`}`,
      id: s.id,
    })),
  );
  const first = list[0] as Snapshot;
  sc.next([
    { cmd: `mindly snapshot diff ${shortId(first.id)}`, why: 'see what changed since' },
    {
      cmd: `mindly snapshot restore ${shortId(first.id)}`,
      why: 'go back to it (nothing is deleted)',
    },
  ]);
}

/** What changed since a snapshot (the engine's diff). */
export interface SnapshotDiffView {
  snapshot: { id: string; label: string; createdAt: number };
  memories: {
    added: { title: string }[];
    updated: { title: string; from: number; to: number }[];
    archived: { title: string }[];
  };
  tasks: { added: { title: string }[]; changed: { title: string }[] };
  conflicts: { opened: unknown[]; closed: unknown[] };
}

/** Renders `mindly snapshot diff`. */
export function renderSnapshotDiff(sc: Screen, d: SnapshotDiffView): void {
  const name = `"${clean(d.snapshot.label, 80)}"`;
  const sections: [string, string[]][] = [
    ['Memories added', d.memories.added.map((m) => clean(m.title, 100))],
    [
      'Memories changed',
      d.memories.updated.map((m) => `${clean(m.title, 100)} (version ${m.from} to ${m.to})`),
    ],
    ['Memories archived', d.memories.archived.map((m) => clean(m.title, 100))],
    ['Tasks added', d.tasks.added.map((t) => clean(t.title, 100))],
    ['Tasks changed', d.tasks.changed.map((t) => clean(t.title, 100))],
  ];
  const total =
    sections.reduce((n, [, rows]) => n + rows.length, 0) +
    d.conflicts.opened.length +
    d.conflicts.closed.length;
  sc.summary(
    `Since snapshot ${name} (${relativeTime(d.snapshot.createdAt, sc.now)}): ${total === 0 ? 'nothing changed' : count(total, 'change')}`,
  );
  for (const [title, rows] of sections) {
    if (rows.length === 0) continue;
    sc.section(`${title} (${rows.length})`);
    sc.rows(rows.slice(0, 20).map((text) => ({ marker: 'item', text })));
    if (rows.length > 20) sc.note(`  ${sc.sym.ellipsis} and ${rows.length - 20} more`);
  }
  if (d.conflicts.opened.length || d.conflicts.closed.length) {
    sc.section('Conflicts');
    sc.text(`${d.conflicts.opened.length} opened, ${d.conflicts.closed.length} closed`, 2);
  }
  if (total > 0) {
    sc.next([
      {
        cmd: `mindly snapshot restore ${shortId(d.snapshot.id)}`,
        why: 'go back to it (newer memories are archived, not deleted)',
      },
    ]);
  }
}
