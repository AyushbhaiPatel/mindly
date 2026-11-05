import { sanitizeLine, SAVE_KINDS, type SaveKind } from '@mindly/core';
import { agentProductName, type SavesSummary } from './saves.js';

/*
 * The weekly share card: a self-contained SVG in Mission Control's style (light sky, Newsreader
 * and DM Sans). By default it shows only counts by kind and agent names, never a project name, a
 * path or code, so it is safe to post. `details` adds the project name and each save's sentence
 * and files, for the user's own eyes.
 */

/** What each kind of save is called on the card and in summaries (counts go in front). */
export const SAVE_KIND_LABELS: Readonly<Record<SaveKind, string>> = {
  impact_warned: 'Told about a change before building on it',
  overlap_avoided: "Stopped before overwriting another agent's work",
  rule_enforced: 'Writes blocked by your rules',
  mistake_avoided: 'Known pitfalls avoided',
  merge_conflict_early: 'Merge conflicts found before merging',
  check_broken_early: 'Broken checks fixed before merging',
  limit_handoff: 'Work continued after a usage limit',
};

const AGENT_COLOURS: Record<string, string> = {
  'claude-code': '#b28cff',
  codex: '#6aa8ff',
  cursor: '#f27bb0',
};
const KIND_COLOURS = ['#3fd9a8', '#6aa8ff', '#b28cff', '#ffc94d', '#f27bb0', '#ff8a4c', '#c8643f'];

export interface SavesCardDetails {
  projectName: string;
  /** Confirmed saves to list: their sentence and files. */
  saves: { title: string; paths: string[] }[];
}

export interface SavesCardInput {
  summary: SavesSummary;
  /** End of the period (exclusive), usually now. */
  until: number;
  /** Only with `--details`. */
  details?: SavesCardDetails;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `3 Nov` in local time. */
function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''}`;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Monday 00:00 local time of the week containing `ms`. */
export function startOfLocalWeek(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/**
 * The period of `[since, until)` in words, as the card says it: `this week` when it starts on
 * this week's Monday, otherwise `in the last 7 days`, `in the last 30 days`, `in the last 12 hours`.
 */
export function savesPeriodWords(since: number, until: number): string {
  if (since === startOfLocalWeek(until - 1)) return 'this week';
  const span = Math.max(0, until - since);
  if (span >= DAY_MS) {
    const days = Math.round(span / DAY_MS);
    return days === 1 ? 'in the last day' : `in the last ${days} days`;
  }
  const hours = Math.max(1, Math.round(span / HOUR_MS));
  return hours === 1 ? 'in the last hour' : `in the last ${hours} hours`;
}

/** Escapes text for SVG content and attributes. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SERIF = "Newsreader, 'Newsreader Variable', Georgia, serif";
const SANS = "'DM Sans', 'DM Sans Variable', system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Renders the card as a standalone SVG document. */
export function renderSavesCard(input: SavesCardInput): string {
  const { summary } = input;
  const W = 1200;
  const kinds = SAVE_KINDS.filter((k) => (summary.byKind[k] ?? 0) > 0).sort(
    (a, b) => (summary.byKind[b] ?? 0) - (summary.byKind[a] ?? 0),
  );
  const agents = Object.entries(summary.byAgent)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6);
  const details = input.details;
  const detailRows = details ? details.saves.slice(0, 8) : [];
  const X = 64;
  const parts: string[] = [];
  const t = (x: number, y: number, size: number, body: string, attrs = ''): void => {
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" ${attrs}>${body}</text>`);
  };

  // Header: brand, period, and (details only) the project.
  parts.push(`<circle cx="${X + 6}" cy="86" r="6" fill="#3fd9a8"/>`);
  t(X + 22, 94, 30, 'Mindly', `font-family="${SERIF}" fill="#141413"`);
  const period = `${day(summary.since)} – ${day(input.until - 1)}`;
  t(W - X, 94, 22, esc(period), `font-family="${SANS}" fill="#6b6a64" text-anchor="end"`);
  if (details) {
    t(
      X + 132,
      94,
      22,
      esc(`· ${sanitizeLine(details.projectName, 60)}`),
      `font-family="${SANS}" fill="#6b6a64"`,
    );
  }

  // The number.
  const noun = summary.total === 1 ? 'save' : 'saves';
  const when = savesPeriodWords(summary.since, input.until);
  t(X, 250, 132, String(summary.total), `font-family="${SERIF}" fill="#141413"`);
  const numberWidth = String(summary.total).length * 66 + 24;
  t(
    X + numberWidth,
    250,
    40,
    `${noun} ${when}`,
    `font-family="${SERIF}" font-style="italic" fill="#3d3d3a"`,
  );
  t(
    X,
    300,
    22,
    summary.total === 0
      ? 'No confirmed saves yet. Mindly counts one only when it has the evidence.'
      : 'Times Mindly demonstrably kept my coding agents out of trouble.',
    `font-family="${SANS}" fill="#6b6a64"`,
  );

  // By kind.
  let y = 368;
  kinds.slice(0, 7).forEach((k, i) => {
    const colour = KIND_COLOURS[i % KIND_COLOURS.length] as string;
    parts.push(`<circle cx="${X + 4}" cy="${y - 7}" r="5" fill="${colour}"/>`);
    t(
      X + 22,
      y,
      26,
      String(summary.byKind[k] ?? 0),
      `font-family="${SANS}" font-weight="600" fill="#141413"`,
    );
    t(X + 74, y, 24, esc(SAVE_KIND_LABELS[k]), `font-family="${SANS}" fill="#3d3d3a"`);
    y += 36;
  });

  // By agent.
  if (agents.length > 0) {
    let x = W - X;
    const items: string[] = [];
    for (const [kind, n] of [...agents].reverse()) {
      const label = `${agentProductName(kind)} ${n}`;
      const width = label.length * 12 + 34;
      x -= width;
      items.push(
        `<circle cx="${x + 6}" cy="${360 - 7}" r="6" fill="${AGENT_COLOURS[kind] ?? '#c9c6bb'}"/>`,
        `<text x="${x + 20}" y="360" font-size="22" font-family="${SANS}" fill="#3d3d3a">${esc(label)}</text>`,
      );
    }
    parts.push(...items);
    t(W - X, 320, 18, 'Agents helped', `font-family="${SANS}" fill="#6b6a64" text-anchor="end"`);
  }

  // Details: sentences and files (never without --details), below the counts.
  let H = 630;
  if (details) {
    let dy = Math.max(y, 404) + 40;
    t(X, dy, 22, 'Details', `font-family="${SERIF}" fill="#141413"`);
    dy += 44;
    for (const s of detailRows) {
      t(X, dy, 20, esc(sanitizeLine(s.title, 110)), `font-family="${SANS}" fill="#3d3d3a"`);
      if (s.paths.length > 0) {
        const files = s.paths
          .slice(0, 3)
          .map((p) => sanitizeLine(p, 80))
          .join(', ');
        t(X + 16, dy + 22, 16, esc(files), `font-family="${MONO}" fill="#6b6a64"`);
      }
      dy += s.paths.length > 0 ? 56 : 34;
    }
    H = Math.max(630, dy + 70);
  }

  t(
    X,
    H - 48,
    18,
    'Counted only with evidence: every save links to the recorded events that prove it.',
    `font-family="${SANS}" fill="#6b6a64"`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Mindly: ${summary.total} ${noun} ${when}`)}">`,
    '<defs>',
    '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfdff"/><stop offset=".38" stop-color="#edf8ff"/><stop offset=".66" stop-color="#e8f4fb"/><stop offset="1" stop-color="#fbfdff"/></linearGradient>',
    '<radialGradient id="glow"><stop offset="0" stop-color="#93d2f8" stop-opacity=".5"/><stop offset=".52" stop-color="#bae6fd" stop-opacity=".3"/><stop offset=".76" stop-color="#bae6fd" stop-opacity="0"/></radialGradient>',
    '</defs>',
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>`,
    `<ellipse cx="${W * 0.62}" cy="${H * 0.5}" rx="${W * 0.6}" ry="${H * 0.45}" fill="url(#glow)"/>`,
    `<rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="#ffffff" fill-opacity=".72" stroke="#e2dfd4"/>`,
    ...parts,
    '</svg>',
    '',
  ].join('\n');
}
