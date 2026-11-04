import { isUuid, MindlyError, sanitizeForContext, sanitizeLine } from '@mindly/core';
import { styleFor, type CliIo, type Style } from './io.js';

/** Exit codes of the `mindly` command. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** Wrong arguments or options: printed with a usage hint and exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Per-command helpers bound to one `CliIo`. */
export interface Out {
  readonly io: CliIo;
  readonly style: Style;
  /** Writes one line to stdout. */
  line(text?: string): void;
  /** Writes one line to stderr. */
  warn(text: string): void;
  /** Writes `value` as pretty JSON to stdout. */
  json(value: unknown): void;
}

/** Creates the output helpers for `io`. */
export function outFor(io: CliIo): Out {
  return {
    io,
    style: styleFor(io.stdout, io.env),
    line: (text = '') => io.stdout.write(`${text}\n`),
    warn: (text) => io.stderr.write(`${text}\n`),
    json: (value) => io.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
  };
}

/**
 * One line of stored (possibly agent-written) text, safe to print on a terminal: control and
 * escape characters are removed so content can never drive the terminal.
 */
export function clean(text: string | null | undefined, max = 200): string {
  return text ? sanitizeLine(text, max) : '';
}

/** Multi-line variant of {@link clean}. */
export function cleanBlock(text: string | null | undefined, max = 4000): string {
  return text ? sanitizeForContext(text, max) : '';
}

/** Removes terminal control characters (keeps newlines and tabs). */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}

/** Validates an id argument. */
export function requireId(value: string, what = 'id'): string {
  const v = value.trim().toLowerCase();
  if (!isUuid(v)) throw new UsageError(`${what} must be a full id (UUID)`);
  return v;
}

/** `2026-11-04 09:30` in local time. */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `3m ago`, `2h ago`, `5d ago`. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const DURATION_RE = /^(\d{1,6})\s*(s|m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses `90m`, `24h`, `7d`, `2w` into milliseconds. */
export function parseDuration(value: string): number {
  const m = DURATION_RE.exec(value.trim());
  if (!m) throw new UsageError('duration must look like 30m, 24h, 7d or 2w');
  const unit = UNIT_MS[(m[2] as string).toLowerCase()] as number;
  return Number(m[1]) * unit;
}

/** Splits `a,b , c` into trimmed non-empty parts. */
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Commander collector for repeatable options. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** Commander parser for a positive integer option. */
export function positiveInt(max: number): (value: string) => number {
  return (value: string) => {
    if (!/^\d{1,9}$/.test(value)) throw new UsageError(`expected a positive integer`);
    const n = Number(value);
    if (n < 1 || n > max) throw new UsageError(`expected an integer between 1 and ${max}`);
    return n;
  };
}

/** Pads `cells` into aligned columns (cells must already be clean). */
export function table(rows: readonly (readonly string[])[], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + gap)))
      .join('')
      .trimEnd(),
  );
}

/** Plural helper: `1 memory`, `2 memories`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Throws a `not_found` error unless `cond`. */
export function ensureFound(cond: boolean, what: string): void {
  if (!cond) throw new MindlyError('not_found', `${what} not found in this project`);
}
