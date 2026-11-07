import {
  ROOT_AREA,
  TRACK_EXPLAIN,
  trackMinimumRule,
  type TrackAgentArea,
  type TrackArea,
  type TrackBreakageMeasure,
  type TrackDifference,
  type TrackReport,
} from '@mindly/engine';
import { listWords, spanWords, type Screen } from '../present/index.js';
import { clean } from '../util.js';

/** Areas shown without `--area`. */
export const MAX_SHOWN_AREAS = 12;

/** `1,284`. */
export function thousands(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** `0.5%`, `3.7%`, `91%`. */
export function percent(rate: number): string {
  const p = rate * 100;
  if (p === 0) return '0%';
  if (p < 0.1) return '<0.1%';
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

const PHRASE: Record<TrackBreakageMeasure, string> = {
  breakages: 'breaks less often per edit',
  bisect: 'breaks checks less often per edit',
  contracts: 'breaks decisions less often per edit',
  mergeChecks: 'fails merge checks less often per edit',
};

/**
 * What an agent did in an area, after its name and edit count: counts first, rates only with
 * enough data.
 */
export function agentFacts(r: TrackAgentArea, minEdits: number, dot: string): string {
  if (!r.enoughData) {
    // Enough edits but too few sessions: say which one is missing.
    const why =
      r.edits >= minEdits ? ` (${r.sessions} ${r.sessions === 1 ? 'session' : 'sessions'})` : '';
    return `not enough data yet${why}`;
  }
  const facts: string[] = [];
  const b = r.breakages;
  facts.push(`broke ${thousands(b.count)}${b.rate === null ? '' : ` (${percent(b.rate)})`}`);
  if (r.ruleAttempts.count > 0) {
    facts.push(
      `tried to break a rule ${r.ruleAttempts.count === 1 ? 'once' : `${thousands(r.ruleAttempts.count)} times`}`,
    );
  }
  if (r.kept.rate !== null) {
    facts.push(
      `kept ${thousands(r.kept.count)} of ${thousands(r.kept.of)} tracked lines (${percent(r.kept.rate)})`,
    );
  }
  return facts.join(` ${dot} `);
}

/** `codex        212 edits`: the name, then the edit count aligned on the right. */
function agentLead(r: TrackAgentArea, nameWidth: number, editWidth: number): string {
  const edits = thousands(r.edits).padStart(editWidth);
  return `${clean(r.agent, 40).padEnd(nameWidth)}  ${edits} ${r.edits === 1 ? 'edit ' : 'edits'}`;
}

/** The breakdown under an agent in the one-area view: each source and the interval. */
function breakdownLine(r: TrackAgentArea, dot: string): string {
  const parts = [
    `checks ${r.bisect.count}`,
    `decisions ${r.contracts.count}`,
    `merge checks ${r.mergeChecks.count}`,
  ];
  const i = r.breakages.interval;
  if (i) parts.push(`95% interval ${percent(i.low)} to ${percent(i.high)}`);
  return parts.join(` ${dot} `);
}

/** The `→` lines of an area: one per pair of agents with a clear difference. */
export function differenceLines(area: TrackArea): string[] {
  const eligible = area.agents.filter((r) => r.enoughData);
  if (eligible.length < 2) return [];
  if (area.clearDifference.length === 0) return ['no clear difference yet'];
  const pairs = new Map<string, TrackDifference[]>();
  for (const d of area.clearDifference) {
    const key = `${d.better.agent}\u0000${d.worse.agent}`;
    pairs.set(key, [...(pairs.get(key) ?? []), d]);
  }
  const lines: string[] = [];
  for (const diffs of pairs.values()) {
    const first = diffs[0] as TrackDifference;
    const than = eligible.length > 2 ? ` than ${clean(first.worse.agent, 40)}` : '';
    const what = listWords(diffs.map((d) => PHRASE[d.measure]));
    lines.push(`${clean(first.better.agent, 40)} ${what} here${than} (clear difference)`);
  }
  return lines;
}

function areaName(area: string): string {
  return area === ROOT_AREA ? ROOT_AREA : clean(area, 120);
}

/** Renders `mindly track`. */
export function renderTrack(
  sc: Screen,
  r: TrackReport,
  o: { explain: boolean; windowMs: number },
): void {
  const dot = sc.sym.dot;
  const head = ['Track record'];
  if (r.filter.area !== null) head.push(areaName(r.filter.area));
  if (r.filter.agent !== null) head.push(clean(r.filter.agent, 40));
  head.push(`last ${spanWords(o.windowMs)}`);
  if (r.totals.edits === 0) {
    sc.summary(`${head.join(` ${dot} `)} ${dot} no agent edits recorded yet`);
    sc.note(
      'Mindly builds the track record from the edits agents make through their hooks, and from what went wrong afterwards.',
    );
  } else {
    head.push(
      `${thousands(r.totals.agents)} ${r.totals.agents === 1 ? 'agent' : 'agents'}`,
      `${thousands(r.totals.edits)} ${r.totals.edits === 1 ? 'edit' : 'edits'}`,
    );
    sc.summary(head.join(` ${dot} `));
  }

  const one = r.filter.area !== null;
  const shown = one ? r.areas : r.areas.slice(0, MAX_SHOWN_AREAS);
  for (const area of shown) {
    sc.blank();
    sc.text(areaName(area.area));
    const nameWidth = Math.max(...area.agents.map((a) => clean(a.agent, 40).length));
    const editWidth = Math.max(...area.agents.map((a) => thousands(a.edits).length));
    sc.pairs(
      area.agents.map(
        (a) => [agentLead(a, nameWidth, editWidth), agentFacts(a, r.minimum.edits, dot)] as const,
      ),
    );
    if (one) {
      for (const a of area.agents.filter((x) => x.enoughData)) {
        sc.note(`${clean(a.agent, 40)}: ${breakdownLine(a, dot)}`, 4);
      }
    }
    for (const l of differenceLines(area)) sc.text(`${sc.sym.next} ${l}`, 2);
  }
  const more = r.totals.areas - shown.length;
  if (more > 0) {
    sc.note(
      `${sc.sym.ellipsis} and ${thousands(more)} more ${more === 1 ? 'area' : 'areas'} (mindly track --area <folder>)`,
    );
  }
  if (r.truncated) {
    sc.note(
      'This is a partial record: there was more data than Mindly reads at once. Use a shorter --since or one --area.',
    );
  }

  if (r.usageLimits.length > 0) {
    sc.blank();
    sc.text(
      `Usage limits: ${r.usageLimits
        .map(
          (u, i) =>
            `${clean(u.agent, 40)} ${thousands(u.limited)} of ${thousands(u.sessions)}${i === 0 ? ` ${u.sessions === 1 ? 'session' : 'sessions'}` : ''}`,
        )
        .join(` ${dot} `)}`,
    );
  }
  if (r.survival.pending > 0) {
    sc.note(
      `Kept lines: ${thousands(r.survival.pending)} ${r.survival.pending === 1 ? 'edit is' : 'edits are'} still waiting to be checked; run mindly track again, or leave the daemon running.`,
    );
  }

  if (o.explain) {
    sc.section('What each number counts');
    for (const line of Object.values(TRACK_EXPLAIN)) sc.text(line, 2);
    sc.text(trackMinimumRule(r.minimum.edits, r.minimum.sessions), 2);
    return;
  }
  if (r.totals.edits === 0) return;
  sc.next([
    {
      cmd: `mindly track${areaArg(r.filter.area ?? r.areas[0]?.area)} --explain`,
      why: 'what each number counts',
    },
  ]);
}

/**
 * ` --area <folder>` for a copy-pasteable command, or nothing when the folder name has characters
 * a shell would interpret (folder names come from agent edits and are not trusted).
 */
export function areaArg(area: string | undefined): string {
  if (area === undefined) return '';
  if (area === ROOT_AREA) return " --area '(root)'";
  return /^[\w./@+-]+$/.test(area) && !area.startsWith('-') ? ` --area ${area}` : '';
}
