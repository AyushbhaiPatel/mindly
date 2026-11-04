import { createInterface } from 'node:readline/promises';

/** A writable text stream (process stdout/stderr or a test buffer). */
export interface TextOut {
  write(text: string): void;
  /** True when the stream is an interactive terminal (enables colour). */
  readonly isTTY?: boolean;
}

/**
 * Everything a command may touch in its environment. `main.ts` builds one from the real process;
 * tests pass buffers, a temp `MINDLY_HOME`/`HOME` and a temp working directory.
 */
export interface CliIo {
  stdout: TextOut;
  stderr: TextOut;
  /** Raw standard input (only the `hook` command reads it). */
  stdin: AsyncIterable<Buffer | string>;
  env: NodeJS.ProcessEnv;
  /** Absolute working directory. */
  cwd: string;
  /** Asks the user a question on a terminal; null when not interactive (no prompts possible). */
  prompt: ((question: string) => Promise<string>) | null;
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
