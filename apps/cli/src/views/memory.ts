import {
  shortId,
  type Contract,
  type Memory,
  type MemoryEvidence,
  type MemoryVersion,
} from '@mindly/core';
import {
  capitalise,
  contractStateWord,
  contractWords,
  count,
  humanizeText,
  memoryKindWord,
  relativeTime,
  sourceWord,
  trustWord,
  type Marker,
  type Screen,
  type Step,
} from '../present/index.js';
import { clean, cleanBlock } from '../util.js';
import { memoryColumns, memoryFlags, memoryTableRow } from './common.js';

/** Renders `mindly rules`. */
export function renderRules(sc: Screen, approved: Memory[], proposed: Memory[]): void {
  if (approved.length === 0 && proposed.length === 0) {
    sc.summary('No rules yet.');
    sc.note(
      'Agents suggest a rule when you say something like "always use pnpm". You can also add one yourself.',
    );
    sc.next([
      {
        cmd: 'mindly memory add --kind rule --title "Use pnpm, never npm"',
        why: 'add a rule every agent follows',
      },
    ]);
    return;
  }
  const parts: string[] = [];
  if (approved.length) parts.push(`${count(approved.length, 'rule')} every agent follows`);
  if (proposed.length) parts.push(`${proposed.length} waiting for you`);
  sc.summary(`Rules ${sc.sym.dot} ${parts.join(` ${sc.sym.dot} `)}`);
  if (approved.length) {
    sc.section('Every agent follows');
    sc.table(
      memoryColumns({ kind: false }),
      approved.map((m) => memoryTableRow(sc, m, { kind: false })),
    );
  }
  if (proposed.length) {
    sc.section('Waiting for you');
    sc.table(
      memoryColumns({ kind: false }),
      proposed.map((m) => memoryTableRow(sc, m, { kind: false })),
    );
    const first = proposed[0] as Memory;
    sc.next([
      {
        cmd: `mindly rules --approve ${shortId(first.id)}`,
        why: 'make the rule apply to every agent',
      },
      { cmd: `mindly memory reject ${shortId(first.id)}`, why: 'drop the suggestion' },
    ]);
  }
}

/** Renders `mindly memory list` / `memory search`. */
export function renderMemoryList(
  sc: Screen,
  memories: Memory[],
  opts: { query?: string; archived?: boolean; filtered?: boolean } = {},
): void {
  if (memories.length === 0) {
    if (opts.query !== undefined) sc.summary(`No memory matches "${clean(opts.query, 80)}".`);
    else if (opts.archived) sc.summary('No archived memories.');
    else if (opts.filtered) sc.summary('No memories match these filters.');
    else {
      sc.summary('No memories yet.');
      sc.note(
        'Mindly remembers rules, decisions and known pitfalls from your agent sessions and shares them with every agent.',
      );
      sc.next([
        {
          cmd: 'mindly memory add --kind decision --title "..."',
          why: 'record a decision yourself',
        },
      ]);
    }
    return;
  }
  const waiting = memories.filter((m) => m.trust === 'proposed');
  const head =
    opts.query !== undefined
      ? `${count(memories.length, 'memory', 'memories')} match "${clean(opts.query, 80)}"`
      : `${count(memories.length, 'memory', 'memories')}${opts.archived ? ' (archived)' : ''}`;
  sc.summary(
    waiting.length ? `${head} ${sc.sym.dot} ${waiting.length} waiting for you` : `${head}`,
  );
  sc.blank();
  sc.table(
    memoryColumns(),
    memories.map((m) => memoryTableRow(sc, m)),
  );
  const steps: Step[] = [];
  const first = waiting[0];
  if (first) {
    steps.push({
      cmd: `mindly memory approve ${shortId(first.id)}`,
      why: 'share it with every agent',
    });
  }
  steps.push({
    cmd: `mindly memory show ${shortId((first ?? (memories[0] as Memory)).id)}`,
    why: 'see the details and history',
  });
  sc.next(steps);
}

/** Everything `mindly memory show` prints. */
export interface MemoryDetail {
  memory: Memory;
  versions: MemoryVersion[];
  evidence: MemoryEvidence[];
  contracts: Contract[];
}

function contractMarker(c: Contract): Marker {
  return c.state === 'passing' ? 'ok' : c.state === 'unknown' ? 'item' : 'fail';
}

/** Renders `mindly memory show`. */
export function renderMemoryShow(sc: Screen, d: MemoryDetail): void {
  const m = d.memory;
  const s = sc.style;
  sc.summary(`${capitalise(memoryKindWord(m.kind))}: ${clean(m.title, 160)}  ${sc.ref(m.id)}`);
  const facts = [capitalise(trustWord(m.trust, m.source)), ...memoryFlags(m)];
  if (m.trust !== 'proposed') facts.push(`from ${sourceWord(m.source)}`);
  facts.push(`updated ${relativeTime(m.updatedAt, sc.now)}`);
  sc.text(facts.join(` ${sc.sym.dot} `));
  const where: string[] = [];
  if (m.scope.paths.length)
    where.push(`files ${m.scope.paths.map((p) => clean(p, 100)).join(', ')}`);
  if (m.scope.branch) where.push(`branch ${clean(m.scope.branch, 100)}`);
  sc.text(`Applies to: ${where.length ? where.join(` ${sc.sym.dot} `) : 'the whole project'}`);
  if (m.tags.length) sc.note(`Tags: ${m.tags.map((t) => clean(t, 60)).join(', ')}`);
  if (m.body) {
    sc.blank();
    sc.text(humanizeText(cleanBlock(m.body)));
  }
  if (d.evidence.length) {
    sc.section('Based on');
    sc.rows(
      d.evidence.map((e) => ({
        marker: e.valid ? 'ok' : 'warn',
        text: `${clean(e.ref, 160)} (${e.valid ? 'still matches' : 'changed since'})`,
      })),
    );
  }
  if (d.contracts.length) {
    sc.section('Checks');
    sc.rows(
      d.contracts.map((c) => ({
        marker: contractMarker(c),
        text: `${clean(contractWords(c.kind, c.spec), 200)}: ${contractStateWord(c.state)}`,
        id: c.id,
        ...(c.lastMessage && c.state !== 'passing' ? { details: [clean(c.lastMessage, 200)] } : {}),
      })),
    );
  }
  if (d.versions.length > 1) {
    sc.section('History');
    sc.rows(
      d.versions.map((v) => ({
        marker: 'item',
        text: `v${v.version} ${relativeTime(v.createdAt, sc.now)}: ${trustWord(v.trust, v.changedBy)}, changed by ${sourceWord(v.changedBy)}${v.reason ? s.dim(` (${clean(v.reason, 100)})`) : ''}`,
      })),
    );
  }
  const steps: Step[] = [];
  if (m.trust === 'proposed' || m.trust === 'stale') {
    steps.push({
      cmd:
        m.kind === 'rule'
          ? `mindly rules --approve ${shortId(m.id)}`
          : `mindly memory approve ${shortId(m.id)}`,
      why: m.trust === 'stale' ? 'confirm it is still true' : 'share it with every agent',
    });
    steps.push({ cmd: `mindly memory reject ${shortId(m.id)}`, why: 'drop it' });
  }
  sc.next(steps);
}
