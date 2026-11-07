import { codename, type Save, type SaveStatus } from '@mindly/core';
import type { SavesSummary } from '@mindly/engine';
import {
  count,
  relativeTime,
  spanWords,
  type Column,
  type Row,
  type Screen,
  type Step,
  type TableRow,
} from '../present/index.js';
import { clean } from '../util.js';

/** Plain words for a save's status (docs/output-style.md). */
export function saveStatusWord(status: SaveStatus): string {
  switch (status) {
    case 'caught':
      return 'pending';
    case 'confirmed':
      return 'counted';
    case 'expired':
      return 'not confirmed in time';
    case 'rejected':
      return 'not a save';
  }
}

/** `2 saves`, `1 save`. */
export function savesWord(n: number): string {
  return count(n, 'save');
}

/** Everything `mindly saves` shows. */
export interface SavesData {
  projectName: string;
  since: number;
  summary: Pick<SavesSummary, 'total'>;
  saves: Save[];
  all: boolean;
}

function row(sc: Screen, s: Save, marker: Row['marker']): TableRow {
  // Where it happened: the files and the command, under the sentence (it wraps there, so long
  // paths are shown in full).
  const where: string[] = [];
  if (s.paths.length) {
    const shown = s.paths.slice(0, 2).map((p) => clean(p, 100));
    where.push(`${shown.join(', ')}${s.paths.length > 2 ? ` +${s.paths.length - 2} more` : ''}`);
  }
  if (s.refs.command) where.push(`\`${clean(s.refs.command, 60)}\``);
  const status = s.status === 'expired' || s.status === 'rejected' ? saveStatusWord(s.status) : '';
  return {
    cells: [
      `${sc.mark(marker)} ${relativeTime(s.createdAt, sc.now)}`,
      clean(s.title, 160),
      status,
      sc.ref(s.id),
    ],
    ...(where.length > 0 ? { note: where.join(` ${sc.sym.dot} `) } : {}),
  };
}

const SAVE_COLUMNS: Column[] = [
  { header: 'When' },
  { header: 'What', fill: true, min: 36 },
  { header: 'Status', drop: 1 },
  { header: 'Name', keep: true },
];

const MAX_ROWS = 20;

/** Renders `mindly saves`. */
export function renderSaves(sc: Screen, d: SavesData): void {
  const sep = sc.sym.dot;
  const span = `in the last ${spanWords(sc.now - d.since)}`;
  const head = `Mindly ${sep} ${clean(d.projectName, 60)}`;
  const confirmed = d.saves.filter((s) => s.status === 'confirmed');
  const pending = d.saves.filter((s) => s.status === 'caught');
  const dropped = d.saves.filter((s) => s.status === 'expired' || s.status === 'rejected');
  if (d.summary.total === 0) {
    sc.summary(`${head} ${sep} No saves ${span} yet.`);
  } else {
    sc.summary(`${head} ${sep} ${savesWord(d.summary.total)} ${span}`);
  }
  if (d.saves.length === 0) {
    sc.note(
      'A save is counted when Mindly warned or stopped an agent and what happened next shows the problem was avoided.',
    );
    return;
  }
  const section = (title: string, list: Save[], marker: Row['marker']): void => {
    if (list.length === 0) return;
    sc.section(title);
    sc.table(
      SAVE_COLUMNS,
      list.slice(0, MAX_ROWS).map((s) => row(sc, s, marker)),
    );
    if (list.length > MAX_ROWS) sc.note(`  ${sc.sym.ellipsis} and ${list.length - MAX_ROWS} more`);
  };
  section('Saves', confirmed, 'ok');
  section('Pending (waiting for evidence, not counted yet)', pending, 'item');
  if (d.all) section('Not counted', dropped, 'idle');
  const steps: Step[] = [];
  const first = confirmed[0] ?? pending[0];
  if (first) {
    steps.push({
      cmd: `mindly saves reject ${codename(first.id)}`,
      why: 'not a save? remove it from every total',
    });
  }
  if (confirmed.length > 0)
    steps.push({ cmd: 'mindly saves card --out card.svg', why: 'a card of your week to share' });
  sc.next(steps);
}

/** The `Saves` section of `mindly standup`: "Mindly saved you 4 times". */
export function renderStandupSaves(sc: Screen, summary: SavesSummary): void {
  if (summary.total === 0) return;
  sc.section('Saves');
  sc.text(`  Mindly saved you ${summary.total === 1 ? 'once' : `${summary.total} times`}:`);
  sc.rows(
    summary.recent.slice(0, 3).map((s) => ({ marker: 'ok', text: clean(s.title, 140), id: s.id })),
  );
  if (summary.total > 3)
    sc.note(`  ${sc.sym.ellipsis} and ${summary.total - 3} more (mindly saves)`);
}
