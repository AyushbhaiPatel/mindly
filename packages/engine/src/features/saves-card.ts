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

/**
 * Width of an average character as a share of the font size, per family. The card is laid out
 * with these estimates (no font metrics are available where it is drawn), so they are generous.
 */
export const CARD_CHAR_WIDTH_EM = { sans: 0.55, serif: 0.5, mono: 0.6 } as const;

/** Width of a wide character (CJK, Hangul, kana, fullwidth forms), in em. */
export const CARD_WIDE_CHAR_EM = 1;
/** Width of an emoji, in em: colour emoji fonts draw them a little wider than square. */
export const CARD_EMOJI_EM = 1.25;

type CardFont = keyof typeof CARD_CHAR_WIDTH_EM;

/**
 * Characters that take a full em in any font, the East Asian Wide and Fullwidth ranges: Hangul
 * Jamo, CJK radicals and symbols, kana, CJK ideographs and their extensions, Yi, Hangul
 * syllables, compatibility ideographs, vertical and small forms, fullwidth forms.
 */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
/** Marks (variation selectors among them) and format characters such as joiners: no width. */
const ZERO_WIDTH = /^(?:\p{M}|\p{Cf})+$/u;
const PICTOGRAPHS = /\p{Extended_Pictographic}/gu;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The user-perceived characters of `text` (an emoji sequence or a letter with marks is one). */
function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

function graphemeEm(g: string, font: CardFont): number {
  // A joined emoji is one glyph where the font has it and one per part where it does not.
  const pictographs = g.match(PICTOGRAPHS)?.length ?? 0;
  if (pictographs > 0) return pictographs * CARD_EMOJI_EM;
  if (WIDE.test(g)) return CARD_WIDE_CHAR_EM;
  if (ZERO_WIDTH.test(g)) return 0;
  return CARD_CHAR_WIDTH_EM[font];
}

function textWidth(text: string, size: number, font: CardFont): number {
  let em = 0;
  for (const g of graphemes(text)) em += graphemeEm(g, font);
  return em * size;
}

/** The leading graphemes of `gs` that fit in `maxWidth`. */
function takeWidth(
  gs: readonly string[],
  size: number,
  font: CardFont,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  let width = 0;
  for (const g of gs) {
    width += graphemeEm(g, font) * size;
    if (width > maxWidth) break;
    out.push(g);
  }
  return out;
}

/** `text`, cut at the end with an ellipsis when it is wider than `maxWidth`. */
function fitEnd(text: string, size: number, font: CardFont, maxWidth: number): string {
  if (textWidth(text, size, font) <= maxWidth) return text;
  const room = maxWidth - textWidth('…', size, font);
  return `${takeWidth(graphemes(text), size, font, room).join('').trimEnd()}…`;
}

/** `path` no wider than `maxWidth`: its start and its file name, the middle elided. */
function elideMiddle(path: string, size: number, font: CardFont, maxWidth: number): string {
  if (textWidth(path, size, font) <= maxWidth) return path;
  const room = Math.max(0, maxWidth - textWidth('…', size, font));
  const gs = graphemes(path);
  const tail = takeWidth([...gs].reverse(), size, font, room * 0.6).reverse();
  const head = takeWidth(gs, size, font, room - textWidth(tail.join(''), size, font));
  return `${head.join('')}…${tail.join('')}`;
}

/** Widest path shown on a details line, in average characters, so two fit next to "+N more". */
const PATH_MAX_CHARS = 48;

/**
 * The files of one save on a line no wider than `maxWidth`: up to three paths, long ones
 * shortened in the middle, and "+N more" for the ones that do not fit.
 */
function filesLine(paths: readonly string[], size: number, maxWidth: number): string {
  const font = 'mono';
  const pathMax = PATH_MAX_CHARS * CARD_CHAR_WIDTH_EM[font] * size;
  const all = paths.map((p) => elideMiddle(sanitizeLine(p, 200), size, font, pathMax));
  const more = (n: number): string => (n > 0 ? `+${n} more` : '');
  const join = (shown: string[], rest: number): string =>
    [...shown, more(rest)].filter(Boolean).join(', ');
  const shown: string[] = [];
  for (const p of all.slice(0, 3)) {
    const next = [...shown, p];
    if (textWidth(join(next, all.length - next.length), size, font) > maxWidth) break;
    shown.push(p);
  }
  if (shown.length === 0) {
    const suffix = all.length > 1 ? `, ${more(all.length - 1)}` : '';
    const room = maxWidth - textWidth(suffix, size, font);
    return `${elideMiddle(all[0] ?? '', size, font, room)}${suffix}`;
  }
  return join(shown, all.length - shown.length);
}

const CARD_HEIGHT = 630;
/** Baseline of the first kind (and agent) row. */
const FIRST_ROW = 368;
const KIND_ROW_HEIGHT = 36;
/** Least space between the end of the longest kind label and the agent column. */
const COLUMN_GAP = 32;
/** Baseline of the footer line, measured from the bottom edge. */
const FOOTER_FROM_BOTTOM = 48;
/** Least distance between the baseline of the last kind row and the footer's. */
const FOOTER_CLEARANCE = 34;

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
      esc(
        fitEnd(
          `· ${sanitizeLine(details.projectName, 60)}`,
          22,
          'sans',
          W - X - textWidth(period, 22, 'sans') - 24 - (X + 132),
        ),
      ),
      `font-family="${SANS}" fill="#6b6a64"`,
    );
  }

  // The number.
  const noun = summary.total === 1 ? 'save' : 'saves';
  const when = savesPeriodWords(summary.since, input.until);
  t(X, 250, 132, String(summary.total), `font-family="${SERIF}" fill="#141413"`);
  // Old-style figures in the serif run to about 0.6 em at this size.
  const numberWidth = Math.ceil(String(summary.total).length * 132 * 0.6) + 24;
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

  // By kind, on the left. Each row ends where its label does.
  const shownKinds = kinds.slice(0, 7);
  const kindsEnd = Math.max(
    0,
    ...shownKinds.map((k) => X + 74 + textWidth(SAVE_KIND_LABELS[k], 24, 'sans')),
  );
  let y = FIRST_ROW;
  shownKinds.forEach((k, i) => {
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
    y += KIND_ROW_HEIGHT;
  });

  // By agent: a column of its own on the right, one agent per row level with the kind rows, so
  // the two lists never share a line. The dot sits at the right edge and the label ends next to
  // it; a name that would reach the kind labels is shortened.
  if (agents.length > 0) {
    const labelEnd = W - X - 20;
    const room = labelEnd - Math.max(kindsEnd + COLUMN_GAP, W / 2);
    agents.forEach(([kind, n], i) => {
      const ay = FIRST_ROW + i * KIND_ROW_HEIGHT;
      const count = ` ${n}`;
      const nameRoom = room - textWidth(count, 22, 'sans');
      const label = `${fitEnd(agentProductName(kind), 22, 'sans', nameRoom)}${count}`;
      parts.push(
        `<circle cx="${W - X - 6}" cy="${ay - 7}" r="6" fill="${AGENT_COLOURS[kind] ?? '#c9c6bb'}"/>`,
      );
      t(labelEnd, ay, 22, esc(label), `font-family="${SANS}" fill="#3d3d3a" text-anchor="end"`);
    });
    t(W - X, 320, 18, 'Agents helped', `font-family="${SANS}" fill="#6b6a64" text-anchor="end"`);
  }
  const rows = Math.max(shownKinds.length, agents.length);
  y = FIRST_ROW + rows * KIND_ROW_HEIGHT;

  // The card is 1200x630 (the size link previews expect) and grows only when it has to: the
  // footer sits 48 px above the bottom edge, and the last row keeps the same distance from it
  // that six rows have on the standard card. A seventh row would otherwise be drawn over it.
  const lastRow = y - KIND_ROW_HEIGHT;
  let H = Math.max(CARD_HEIGHT, lastRow + FOOTER_CLEARANCE + FOOTER_FROM_BOTTOM);
  // Details: sentences and files (never without --details), below the counts.
  if (details) {
    let dy = Math.max(y, 404) + 40;
    t(X, dy, 22, 'Details', `font-family="${SERIF}" fill="#141413"`);
    dy += 44;
    for (const s of detailRows) {
      const title = fitEnd(sanitizeLine(s.title, 200), 20, 'sans', W - 2 * X);
      t(X, dy, 20, esc(title), `font-family="${SANS}" fill="#3d3d3a"`);
      if (s.paths.length > 0) {
        const files = filesLine(s.paths, 16, W - 2 * X - 16);
        t(X + 16, dy + 22, 16, esc(files), `font-family="${MONO}" fill="#6b6a64"`);
      }
      dy += s.paths.length > 0 ? 56 : 34;
    }
    H = Math.max(H, dy + 70);
  }

  t(
    X,
    H - FOOTER_FROM_BOTTOM,
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
