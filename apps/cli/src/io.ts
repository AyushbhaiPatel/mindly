import { createInterface } from 'node:readline/promises';

/** A writable text stream (process stdout/stderr or a test buffer). */
export interface TextOut {
  write(text: string): void;
  /** True when the stream is an interactive terminal (enables colour). */
  readonly isTTY?: boolean;
  /** Width of the terminal in columns, when it is one. */
  readonly columns?: number;
}

/**
 * Everything a command may touch in its environment. `main.ts` builds one from the real process;
 * tests pass buffers, a temp `MINDLY_HOME`/`HOME` and a temp working directory.
 */
export interface CliIo {
  stdout: TextOut;
  stderr: TextOut;
  /** Raw standard input (only the `hook` and `statusline` commands read it). */
  stdin: AsyncIterable<Buffer | string>;
  env: NodeJS.ProcessEnv;
  /** Absolute working directory. */
  cwd: string;
  /** Asks the user a question on a terminal; null when not interactive (no prompts possible). */
  prompt: ((question: string) => Promise<string>) | null;
}

/**
 * Thrown by {@link readStdin} when the input exceeds its limit. `toolName` is the value of the
 * payload's top-level tool name key, wherever it comes in the payload; null when there is none or
 * it was not found.
 */
export class StdinTooLarge extends Error {
  constructor(
    message: string,
    readonly toolName: string | null = null,
  ) {
    super(message);
  }
}

/** How much of an input that is too large is still read, looking for the tool's name. */
const SCAN_BYTES = 256 * 1024 * 1024;

/** Keys a hook payload names its tool with, at its top level. */
const TOOL_KEYS = new Set(['tool_name', 'toolName', 'tool']);

/**
 * Finds the string value of a top-level tool name key in JSON read piece by piece, without
 * keeping or parsing the rest: only the nesting depth and whether a string is open are followed,
 * so a key of the same name inside the tool's input is not mistaken for it. Works on bytes: no
 * character of the JSON structure is ever part of a multi-byte UTF-8 sequence.
 */
export class ToolNameScan {
  name: string | null = null;
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** At the top level of an object: the next string is a key. */
  private expectKey = false;
  /** The top-level string being read (a key, or the value of a tool key), as bytes. */
  private current: number[] | null = null;
  private currentIsKey = false;
  private lastKey: string | null = null;

  /** Reads more of the input; true once the name is known. */
  feed(chunk: Uint8Array): boolean {
    if (this.name !== null) return true;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i] as number;
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          this.current = null;
        } else if (c === 0x5c) {
          // An escape in a key or name: not one of the plain names looked for.
          this.escaped = true;
          this.current = null;
        } else if (c === 0x22) {
          this.inString = false;
          if (this.current !== null) {
            const text = Buffer.from(this.current).toString('utf8');
            if (this.currentIsKey) this.lastKey = text;
            else if (this.lastKey !== null && TOOL_KEYS.has(this.lastKey)) {
              this.name = text;
              return true;
            }
          } else if (this.currentIsKey) this.lastKey = null;
          this.current = null;
        } else if (this.current !== null) {
          if (this.current.length < 200) this.current.push(c);
          else this.current = null;
        }
        continue;
      }
      switch (c) {
        case 0x22: // "
          this.inString = true;
          if (this.depth === 1) {
            this.currentIsKey = this.expectKey;
            const wanted = this.expectKey || (this.lastKey !== null && TOOL_KEYS.has(this.lastKey));
            this.current = wanted ? [] : null;
          }
          break;
        case 0x7b: // {
        case 0x5b: // [
          this.depth++;
          if (this.depth === 1) this.expectKey = c === 0x7b;
          break;
        case 0x7d: // }
        case 0x5d: // ]
          this.depth--;
          break;
        case 0x3a: // :
          if (this.depth === 1) this.expectKey = false;
          break;
        case 0x2c: // ,
          if (this.depth === 1) {
            this.expectKey = true;
            this.lastKey = null;
          }
          break;
        default:
          break;
      }
    }
    return false;
  }
}

/**
 * Reads stdin completely, refusing more than `max` bytes. What is beyond the limit is still read
 * (up to a bound) only to find the payload's top-level tool name, for {@link StdinTooLarge}.
 */
export async function readStdin(
  stdin: AsyncIterable<Buffer | string>,
  max: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let scan: ToolNameScan | null = null;
  for await (const chunk of stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += buf.length;
    if (scan === null && total > max) {
      scan = new ToolNameScan();
      for (const c of chunks) scan.feed(c);
      chunks.length = 0;
    }
    if (scan === null) {
      chunks.push(buf);
      continue;
    }
    if (scan.feed(buf) || total > SCAN_BYTES) break;
  }
  if (scan !== null) throw new StdinTooLarge('payload too large', scan.name);
  return Buffer.concat(chunks).toString('utf8');
}

/** The `CliIo` of the current process. */
export function processIo(): CliIo {
  const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    prompt: interactive
      ? async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        }
      : null,
  };
}

/** Text styling that is a no-op without a TTY or with `NO_COLOR` set. */
export interface Style {
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

/** Builds the style for `out` honouring `NO_COLOR` (https://no-color.org) and `TERM=dumb`. */
export function styleFor(out: TextOut, env: NodeJS.ProcessEnv): Style {
  const noColor = env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '';
  const enabled = out.isTTY === true && !noColor && env['TERM'] !== 'dumb';
  const wrap =
    (open: number, close: number) =>
    (s: string): string =>
      enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s;
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/**
 * Asks for a yes/no confirmation (default no). `yes` skips the question. Without a terminal the
 * answer is "no" and the user is told to re-run with `--yes`.
 */
export async function confirm(io: CliIo, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!io.prompt) {
    io.stderr.write('Not confirmed: no terminal to ask on. Re-run with --yes to proceed.\n');
    return false;
  }
  const answer = (await io.prompt(`${question} [y/N] `)).trim();
  return /^y(es)?$/i.test(answer);
}
