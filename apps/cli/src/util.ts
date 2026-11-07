import { MindlyError, sanitizeForContext, sanitizeLine } from '@mindly/core';
import { styleFor, type CliIo, type Style } from './io.js';
import { screenFor, type Screen } from './present/terminal.js';

/**
 * Stands in for the `--` marker of `mindly bisect -- <command>`, which the option parser drops:
 * put right after it, it keeps a command named like a subcommand (`mindly bisect -- list`) from
 * being taken for that subcommand.
 */
export const LITERAL_MARK = '\0literal';

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

/** A Mindly error that also says how to fix it (printed as a `->` line). */
export class HintedError extends MindlyError {
  constructor(
    code: MindlyError['code'],
    message: string,
    readonly hint: string,
  ) {
    super(code, message);
    this.name = 'HintedError';
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
  /** Human output helpers for stdout (markers, wrapping, next steps), at the current time. */
  screen(): Screen;
}

/** Creates the output helpers for `io`. */
export function outFor(io: CliIo): Out {
  return {
    io,
    style: styleFor(io.stdout, io.env),
    line: (text = '') => io.stdout.write(`${text}\n`),
    warn: (text) => io.stderr.write(`${text}\n`),
    json: (value) => io.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    screen: () => screenFor((l) => io.stdout.write(`${l}\n`), io.stdout, io.env, Date.now()),
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

/** Plural helper: `1 memory`, `2 memories`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
