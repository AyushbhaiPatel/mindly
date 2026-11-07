import { codename } from '@mindly/core';
import { styleFor, type Style, type TextOut } from '../io.js';

/** Status markers of docs/output-style.md. */
export type Marker = 'ok' | 'warn' | 'fail' | 'item' | 'agent' | 'idle';

/** The characters used for markers and separators. */
export interface Symbols {
  ok: string;
  warn: string;
  fail: string;
  item: string;
  next: string;
  agent: string;
  idle: string;
  /** Separator between facts on one line (`working - main`). */
  dot: string;
  ellipsis: string;
  /** Table borders: corners, edges and junctions. */
  box: {
    tl: string;
    tr: string;
    bl: string;
    br: string;
    h: string;
    v: string;
    tj: string;
    bj: string;
    lj: string;
    rj: string;
    x: string;
  };
}

const UTF8: Symbols = {
  ok: '\u2713',
  warn: '!',
  fail: '\u2717',
  item: '\u2022',
  next: '\u2192',
  agent: '\u25CF',
  idle: '\u25CB',
  dot: '\u00B7',
  ellipsis: '\u2026',
  box: {
    tl: '\u250C',
    tr: '\u2510',
    bl: '\u2514',
    br: '\u2518',
    h: '\u2500',
    v: '\u2502',
    tj: '\u252C',
    bj: '\u2534',
    lj: '\u251C',
    rj: '\u2524',
    x: '\u253C',
  },
};

const ASCII: Symbols = {
  ok: '[ok]',
  warn: '[!]',
  fail: '[x]',
  item: '-',
  next: '->',
  agent: '*',
  idle: 'o',
  dot: '-',
  ellipsis: '...',
  box: {
    tl: '+',
    tr: '+',
    bl: '+',
    br: '+',
    h: '-',
    v: '|',
    tj: '+',
    bj: '+',
    lj: '+',
    rj: '+',
    x: '+',
  },
};

/**
 * True when output must stay ASCII: `MINDLY_ASCII=1`, or a locale (`LC_ALL`, `LC_CTYPE`, `LANG`,
 * first one set wins) that is not UTF-8, or no locale at all (the POSIX "C" locale).
 */
export function useAscii(env: NodeJS.ProcessEnv): boolean {
  const forced = env['MINDLY_ASCII'];
  if (forced !== undefined && forced !== '' && forced !== '0') return true;
  const locale = [env['LC_ALL'], env['LC_CTYPE'], env['LANG']].find(
    (v) => v !== undefined && v !== '',
  );
  if (locale === undefined) return process.platform !== 'win32';
  return !/utf-?8/i.test(locale);
}

/** Replaces the typographic characters Mindly itself prints with ASCII look-alikes. */
export function toAscii(text: string): string {
  return text
    .replace(/\u00B7/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2192/g, '->')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
}

/** The marker characters for `env`. */
export function symbolsFor(env: NodeJS.ProcessEnv): Symbols {
  return useAscii(env) ? ASCII : UTF8;
}

/** Default and bounds of the wrapping width. */
export const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 40;
const MAX_WIDTH = 200;

/** Wrapping width: `COLUMNS`, else the terminal's width on a TTY, else 100. */
export function widthFor(out: TextOut, env: NodeJS.ProcessEnv): number {
  const fromEnv = Number.parseInt(env['COLUMNS'] ?? '', 10);
  const raw =
    Number.isFinite(fromEnv) && fromEnv > 0
      ? fromEnv
      : out.isTTY === true && typeof out.columns === 'number' && out.columns > 0
        ? out.columns
        : DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, raw));
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/*
 * Code points a terminal shows two columns wide: East Asian Wide and Fullwidth (Hangul Jamo, CJK,
 * Hiragana, Katakana, Hangul syllables, fullwidth forms) and emoji. Sorted pairs of first, last.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];
/** Combining marks take no column. */
const MARK_RE = /^[\p{Mn}\p{Me}]$/u;
/** Zero-width spaces and joiners, word joiner, variation selectors: no column either. */
const ZERO_WIDTH: readonly (readonly [number, number])[] = [
  [0x200b, 0x200f],
  [0x2060, 0x2060],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
];
const within = (cp: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Columns one code point takes in a terminal: 0, 1 or 2. */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (within(cp, ZERO_WIDTH) || MARK_RE.test(ch)) return 0;
  return within(cp, WIDE) ? 2 : 1;
}

/**
 * Printed width of `text` in terminal columns: colour codes do not count, wide characters (CJK,
 * emoji) count 2, combining marks and joiners 0.
 */
export function visibleLength(text: string): number {
  let n = 0;
  for (const ch of text.replace(ANSI_RE, '')) n += charWidth(ch);
  return n;
}

/**
 * Cuts `text` (colour codes removed) into pieces at most `width` columns wide, at code-point
 * boundaries. The last piece may be shorter.
 */
function cutByWidth(text: string, width: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of text.replace(ANSI_RE, '')) {
    const w = charWidth(ch);
    if (used + w > width && current !== '') {
      pieces.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += w;
  }
  if (current !== '' || pieces.length === 0) pieces.push(current);
  return pieces;
}

/**
 * Like {@link wrap} without a prefix, but a word wider than `width` (a long path or URL) is broken
 * into pieces of `width` columns, so a table cell shows all of it instead of cutting it off.
 */
function wrapCell(text: string, width: number): string[] {
  const words = text
    .split(/ +/)
    .flatMap((w) => (visibleLength(w) > width ? cutByWidth(w, Math.max(1, width)) : [w]));
  return wrap(words.join(' '), width);
}

/**
 * Word-wraps `text` to `width` columns. The first line starts with `first`, later lines with
 * `rest`. Words longer than a line (ids, paths, URLs) are never cut: they get a line of their own.
 */
export function wrap(text: string, width: number, first = '', rest = first): string[] {
  const words = text.split(/ +/).filter((w) => w !== '');
  const lines: string[] = [];
  let current = first;
  let empty = true;
  for (const word of words) {
    const candidate = empty ? `${current}${word}` : `${current} ${word}`;
    if (!empty && visibleLength(candidate) > width) {
      lines.push(current);
      current = `${rest}${word}`;
    } else {
      current = candidate;
    }
    empty = false;
  }
  lines.push(current);
  return lines.map((l) => l.trimEnd());
}

/** A list row: marker, text and an optional id shown at the end as `[9f02a0c3]`. */
export interface Row {
  marker: Marker;
  text: string;
  /** Full id; shown as its short id. */
  id?: string;
  /** Extra lines under the row (indented, dimmed). */
  details?: readonly string[];
}

/** A next step: an exact command and what it does, or only advice. */
export interface Step {
  cmd?: string;
  why: string;
}

/** One column of a {@link Screen.table}. */
export interface Column {
  header: string;
  /**
   * The column that takes the remaining width and wraps its text. At most one per table; the
   * others are as wide as their widest cell (up to `max`).
   */
  fill?: boolean;
  /** Widest a non-fill column may be; longer cells end with an ellipsis. */
  max?: number;
  /** Narrowest the fill column may get before other columns are dropped. */
  min?: number;
  /** Right-aligned (numbers, times). */
  right?: boolean;
  /**
   * Dropped first on a narrow terminal (higher goes first). The first column and the fill
   * column are never dropped.
   */
  drop?: number;
  /**
   * Never cut or dropped, whatever the width: the column of record names, which are what people
   * type to refer to a record.
   */
  keep?: boolean;
}

/** One row of a table: its cells, and an optional dimmed note under the row. */
export interface TableRow {
  cells: readonly string[];
  note?: string;
}

/** Writes human output in the style of docs/output-style.md. */
export interface Screen {
  readonly style: Style;
  readonly sym: Symbols;
  readonly width: number;
  /** `Date.now()` of the command (fixed in tests). */
  readonly now: number;
  /** The coloured marker character. */
  mark(marker: Marker): string;
  /** The record's readable name, dimmed: `quiet-otter-17`. */
  ref(id: string): string;
  /** The first line of a screen: the answer. */
  summary(text: string): void;
  /** A blank line and a bold section heading. */
  section(title: string): void;
  /** A wrapped paragraph with an optional indent. */
  text(text: string, indent?: number): void;
  /** A dimmed wrapped paragraph. */
  note(text: string, indent?: number): void;
  /** Rows with aligned ids. */
  rows(rows: readonly Row[]): void;
  /** Two aligned columns (`left` must already be short): wraps the right column. */
  pairs(pairs: readonly (readonly [string, string])[], indent?: number): void;
  /**
   * An aligned table with a dimmed header row. Cells may carry colour codes. The fill column
   * wraps (breaking words too long for it); on a narrow terminal the least important columns are
   * left out rather than squeezed, and if it still does not fit, long cells are cut with an
   * ellipsis and the fill column gets narrower than its `min`. `keep` columns are never cut.
   */
  table(columns: readonly Column[], rows: readonly (TableRow | readonly string[])[]): void;
  /** A blank line, then the next steps with aligned commands. */
  next(steps: readonly Step[]): void;
  /** A blank line. */
  blank(): void;
}

/** Creates a {@link Screen} writing to `out`. */
export function screenFor(
  writeLine: (line: string) => void,
  out: TextOut,
  env: NodeJS.ProcessEnv,
  now: number,
): Screen {
  const style = styleFor(out, env);
  const sym = symbolsFor(env);
  const width = widthFor(out, env);
  // Names and stored text may carry the UTF-8 separator; keep ASCII output ASCII.
  const write = sym === ASCII ? (line: string): void => writeLine(toAscii(line)) : writeLine;
  const colour: Record<Marker, (s: string) => string> = {
    ok: style.green,
    warn: style.yellow,
    fail: style.red,
    item: (s) => s,
    agent: style.green,
    idle: style.dim,
  };
  const mark = (m: Marker): string => colour[m](sym[m]);
  const ref = (id: string): string => style.dim(codename(id));
  const para = (text: string, indent: number, dim: boolean): void => {
    const pad = ' '.repeat(indent);
    for (const l of text.split('\n')) {
      for (const w of wrap(l, width, pad)) write(dim ? style.dim(w) : w);
    }
  };

  return {
    style,
    sym,
    width,
    now,
    mark,
    ref,
    summary: (text) => {
      for (const l of wrap(text, width)) write(style.bold(l));
    },
    section: (title) => {
      write('');
      for (const l of wrap(title, width)) write(style.bold(l));
    },
    text: (text, indent = 0) => para(text, indent, false),
    note: (text, indent = 0) => para(text, indent, true),
    rows: (rows) => {
      const lead = (r: Row): string => `  ${sym[r.marker]} `;
      // Width of the name column: two spaces and the longest name among the rows.
      const idWidth =
        2 + Math.max(0, ...rows.map((r) => (r.id === undefined ? 0 : visibleLength(ref(r.id)))));
      // Align ids on the longest text that still fits on one line with its id.
      let col = 0;
      for (const r of rows) {
        const len = visibleLength(lead(r)) + visibleLength(r.text);
        if (r.id !== undefined && len + idWidth + 1 <= width) col = Math.max(col, len);
      }
      for (const r of rows) {
        const head = `  ${mark(r.marker)} `;
        const hang = ' '.repeat(visibleLength(lead(r)));
        const len = visibleLength(lead(r)) + visibleLength(r.text);
        if (r.id === undefined) {
          for (const l of wrap(r.text, width, head, hang)) write(l);
        } else if (len + idWidth + 1 <= width) {
          write(`${head}${r.text}${' '.repeat(Math.max(0, col - len))}  ${ref(r.id)}`);
        } else {
          // Wrap the text short of the id column, then end the last line with the id.
          const lines = wrap(r.text, width - idWidth, head, hang);
          const last = lines.pop() ?? head;
          for (const l of lines) write(l);
          write(`${last}  ${ref(r.id)}`);
        }
        for (const d of r.details ?? []) {
          for (const l of wrap(d, width, hang, `${hang}  `)) write(style.dim(l));
        }
      }
    },
    pairs: (pairs, indent = 2) => {
      const left = Math.max(0, ...pairs.map(([l]) => visibleLength(l)));
      const pad = ' '.repeat(indent);
      for (const [l, r] of pairs) {
        const head = `${pad}${l}${' '.repeat(left - visibleLength(l))}   `;
        if (visibleLength(head) > width / 2) {
          write(`${pad}${l}`);
          for (const w of wrap(r, width, `${pad}    `)) write(w);
        } else {
          for (const w of wrap(r, width, head, ' '.repeat(visibleLength(head)))) write(w);
        }
      }
    },
    table: (columns, rows) => {
      const indent = 2;
      const padCells = 1; // spaces inside a cell, each side
      const box = sym.box;
      // In ASCII mode convert first, so cells are measured as they are printed (… is 3 wide).
      const plain = sym === ASCII ? toAscii : (t: string): string => t;
      const heads = columns.map((c) => plain(c.header));
      const normalised: TableRow[] = rows.map((r) => {
        const row = Array.isArray(r) ? { cells: r as readonly string[] } : (r as TableRow);
        return {
          cells: row.cells.map(plain),
          ...(row.note !== undefined ? { note: plain(row.note) } : {}),
        };
      });
      // Width of each column: its widest cell or header, capped at `max`.
      const widths = columns.map((c, i) =>
        Math.min(
          c.max ?? Infinity,
          Math.max(
            visibleLength(heads[i] ?? ''),
            ...normalised.map((r) => visibleLength(r.cells[i] ?? '')),
          ),
        ),
      );
      const fillAt = columns.findIndex((c) => c.fill === true);
      // A column nobody has anything in is left out (its header would only add noise).
      let shown = columns
        .map((_, i) => i)
        .filter((i) => i === fillAt || normalised.some((r) => (r.cells[i] ?? '') !== ''));
      // Total printed width: indent, one border per gap plus the outer two, padding in each cell.
      const widthOf = (idx: readonly number[], fillWidth: number): number =>
        indent +
        idx.reduce((n, i) => n + (i === fillAt ? fillWidth : (widths[i] ?? 0)) + 2 * padCells, 0) +
        idx.length +
        1;
      // Shrink the fill column to its minimum, then drop columns until the table fits.
      let fillMin = fillAt >= 0 ? Math.min(widths[fillAt] ?? 0, columns[fillAt]?.min ?? 24) : 0;
      for (;;) {
        if (widthOf(shown, fillMin) <= width) break;
        const droppable = shown
          .filter(
            (i) =>
              i !== 0 && i !== fillAt && columns[i]?.keep !== true && (columns[i]?.drop ?? 0) > 0,
          )
          .sort((a, b) => (columns[b]?.drop ?? 0) - (columns[a]?.drop ?? 0));
        const drop = droppable[0];
        if (drop === undefined) break;
        shown = shown.filter((i) => i !== drop);
      }
      // Still too wide: cut the widest columns that may be cut (never a `keep` column), one
      // column at a time, down to `limit`; or let the fill column wrap narrower, down to `limit`.
      const narrow = (limit: number): void => {
        while (widthOf(shown, fillMin) > width) {
          const widest = shown
            .filter((i) => i !== fillAt && columns[i]?.keep !== true && (widths[i] ?? 0) > limit)
            .sort((a, b) => (widths[b] ?? 0) - (widths[a] ?? 0))[0];
          if (widest === undefined) return;
          widths[widest] = (widths[widest] ?? 0) - 1;
        }
      };
      const narrowFill = (limit: number): void => {
        const over = shown.includes(fillAt) ? widthOf(shown, fillMin) - width : 0;
        if (over > 0) fillMin = Math.max(Math.min(fillMin, limit), fillMin - over);
      };
      // Long labels go first, then the fill column wraps narrower (nothing is lost), then labels
      // are cut further, and so on until the table fits next to its whole names.
      narrow(24);
      narrowFill(16);
      narrow(8);
      narrowFill(8);
      narrow(4);
      narrowFill(1);
      const fillWidth =
        fillAt >= 0 && shown.includes(fillAt)
          ? Math.max(fillMin, Math.min(widths[fillAt] ?? 0, width - widthOf(shown, 0)))
          : 0;
      const colWidth = (i: number): number => (i === fillAt ? fillWidth : (widths[i] ?? 0));
      const fit = (text: string, i: number): string => {
        const w = colWidth(i);
        const len = visibleLength(text);
        if (len > w) {
          // Truncate a non-fill cell (the fill column wraps instead), with an ellipsis when the
          // column has room for one.
          const mark = w > visibleLength(sym.ellipsis) ? sym.ellipsis : '';
          const room = w - visibleLength(mark);
          const kept = room > 0 ? (cutByWidth(text, room)[0] ?? '') : '';
          return `${kept}${' '.repeat(Math.max(0, room - visibleLength(kept)))}${mark}`;
        }
        const fillBy = ' '.repeat(w - len);
        return columns[i]?.right ? `${fillBy}${text}` : `${text}${fillBy}`;
      };
      const lead = ' '.repeat(indent);
      const side = ' '.repeat(padCells);
      const edge = style.dim(box.v);
      const line = (cells: readonly string[]): string =>
        `${lead}${edge}${cells.map((c) => `${side}${c}${side}`).join(edge)}${edge}`;
      const rule = (l: string, j: string, r: string): string =>
        style.dim(
          `${lead}${l}${shown.map((i) => box.h.repeat(colWidth(i) + 2 * padCells)).join(j)}${r}`,
        );
      write(rule(box.tl, box.tj, box.tr));
      write(line(shown.map((i) => style.dim(fit(heads[i] ?? '', i)))));
      write(rule(box.lj, box.x, box.rj));
      const fillPos = shown.indexOf(fillAt);
      normalised.forEach((r, rowIndex) => {
        if (rowIndex > 0) write(rule(box.lj, box.x, box.rj));
        const cells = shown.map((i) => r.cells[i] ?? '');
        // The fill column wraps; a note continues under it, dimmed, inside the same row.
        const fillLines = fillPos >= 0 ? wrapCell(cells[fillPos] ?? '', fillWidth) : [];
        const noteLines =
          fillPos >= 0 && r.note !== undefined && r.note !== ''
            ? wrapCell(r.note, fillWidth).map((l) => style.dim(l))
            : [];
        const body = [...fillLines, ...noteLines];
        const lineCount = Math.max(1, body.length);
        for (let n = 0; n < lineCount; n++) {
          write(
            line(
              shown.map((i, k) => {
                if (k === fillPos) return fit(body[n] ?? '', i);
                return n === 0 ? fit(cells[k] ?? '', i) : ' '.repeat(colWidth(i));
              }),
            ),
          );
        }
        if (fillPos < 0 && r.note) {
          for (const l of wrap(r.note, width, `${lead} `)) write(style.dim(l));
        }
      });
      write(rule(box.bl, box.bj, box.br));
    },
    next: (steps) => {
      if (steps.length === 0) return;
      write('');
      const cmdWidth = Math.max(0, ...steps.map((s) => (s.cmd ? s.cmd.length : 0)));
      for (const s of steps) {
        const arrow = style.cyan(sym.next);
        if (s.cmd === undefined) {
          for (const l of wrap(s.why, width, `${arrow} `, ' '.repeat(sym.next.length + 1))) {
            write(l);
          }
        } else if (sym.next.length + 1 + cmdWidth + 3 + s.why.length <= width) {
          write(`${arrow} ${style.bold(s.cmd)}${' '.repeat(cmdWidth - s.cmd.length)}   ${s.why}`);
        } else {
          write(`${arrow} ${style.bold(s.cmd)}`);
          for (const l of wrap(s.why, width, ' '.repeat(sym.next.length + 3))) write(l);
        }
      }
    },
    blank: () => write(''),
  };
}
