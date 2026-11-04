import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { MindlyError } from '@mindly/core';

/** Default cap on captured stdout (the head is kept). */
export const DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
/** Default cap on captured stderr (the tail is kept). */
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
/** Default delay between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 5_000;
/** Upper bound for any single agent run. */
export const MAX_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Variables every agent child receives when they are set (besides `TERM=dumb`). */
export const BASE_ENV_ALLOW_LIST: readonly string[] = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'];

const WINDOWS_ENV_ALLOW_LIST: readonly string[] = [
  'SYSTEMROOT',
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'COMSPEC',
];

/**
 * Builds the minimal environment for an agent child: the base allow-list, `TERM=dumb`,
 * `NO_COLOR=1`, and only the agent's own authentication/config variables that are set in `base`.
 * Everything else (other secrets, `GIT_*`, `NODE_OPTIONS`, ...) is dropped.
 */
export function buildAgentEnv(
  passThrough: readonly string[],
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { TERM: 'dumb', NO_COLOR: '1' };
  const keys = [
    ...BASE_ENV_ALLOW_LIST,
    ...(process.platform === 'win32' ? WINDOWS_ENV_ALLOW_LIST : []),
    ...passThrough,
  ];
  for (const key of keys) {
    const v = base[key];
    if (typeof v === 'string' && v !== '' && !v.includes('\0')) env[key] = v;
  }
  return env;
}

/** Input for `runProcess`. */
export interface RunProcessOptions {
  /** Absolute path (or bare name resolved on `env.PATH`) of the program. */
  bin: string;
  /** Arguments, passed as an array; never interpreted by a shell. */
  argv: readonly string[];
  /** Existing absolute working directory. */
  cwd: string;
  /** Complete environment for the child (see `buildAgentEnv`). */
  env: Readonly<Record<string, string>>;
  /** Text written to stdin, which is then closed. */
  input?: string;
  /** Wall-clock limit in milliseconds. */
  timeoutMs: number;
  /** Delay between SIGTERM and SIGKILL (default 5 s). */
  killGraceMs?: number;
  /** Bytes of stdout kept from the start (default 2 MiB). */
  maxStdoutBytes?: number;
  /** Bytes of stderr kept from the end (default 64 KiB). */
  maxStderrBytes?: number;
  /** Aborting kills the process tree like a timeout. */
  signal?: AbortSignal;
}

/** Outcome of `runProcess`. Never rejects for child failures; check the fields. */
export interface ProcessResult {
  /** Exit code, or null when killed by a signal or the program could not start. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the program could not be started (errno code such as `ENOENT`). */
  spawnError: string | null;
  startedAt: number;
  durationMs: number;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
}

/** Keeps the first `max` bytes. */
class HeadBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.size;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }
  toString(): string {
    return Buffer.concat(this.chunks)
      .toString('utf8')
      .replace(/\uFFFD+$/, '');
  }
}

/** Keeps the last `max` bytes. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 0) {
      const head = this.chunks[0] as Buffer;
      const excess = this.size - this.max;
      this.truncated = true;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }
  toString(): string {
    return Buffer.concat(this.chunks)
      .toString('utf8')
      .replace(/^\uFFFD+/, '');
  }
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // Negative pid targets the whole process group; the child leads its own group on POSIX.
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function assertCwd(cwd: string): void {
  if (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0') || !isAbsolute(cwd)) {
    throw new MindlyError('invalid_input', 'runner cwd must be an absolute path');
  }
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    // handled below
  }
  if (!isDir) throw new MindlyError('not_found', 'runner cwd is not an existing directory');
}

/**
 * Runs a program with `spawn` (argument array, `shell: false`, its own process group on POSIX),
 * writes `input` to stdin, enforces a hard timeout (SIGTERM to the group, SIGKILL after the grace
 * period) and caps captured output. Rejects only for invalid arguments.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  assertCwd(options.cwd);
  if (typeof options.bin !== 'string' || options.bin === '' || options.bin.includes('\0')) {
    throw new MindlyError('invalid_input', 'invalid program');
  }
  if (
    !Array.isArray(options.argv) ||
    options.argv.some((a) => typeof a !== 'string' || a.includes('\0'))
  ) {
    throw new MindlyError('invalid_input', 'invalid argv');
  }
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_RUN_TIMEOUT_MS
  ) {
    throw new MindlyError('invalid_input', 'invalid timeout');
  }
  const killGraceMs = Math.max(0, Math.floor(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  const stdout = new HeadBuffer(
    Math.max(1024, Math.floor(options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES)),
  );
  const stderr = new TailBuffer(
    Math.max(256, Math.floor(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES)),
  );

  return new Promise<ProcessResult>((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError: string | null = null;
    const timers: NodeJS.Timeout[] = [];

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal,
        timedOut,
        aborted,
        spawnError,
        startedAt,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString(),
        stdoutTruncated: stdout.truncated,
        stderr: stderr.toString(),
        stderrTruncated: stderr.truncated,
      });
    };

    const child = spawn(options.bin, [...options.argv], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const terminate = (): void => {
      killTree(child.pid, 'SIGTERM');
      timers.push(setTimeout(() => killTree(child.pid, 'SIGKILL'), killGraceMs));
    };
    function onAbort(): void {
      if (settled || aborted || timedOut) return;
      aborted = true;
      terminate();
    }

    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    // The child may exit without reading stdin; EPIPE is expected then.
    child.stdin.on('error', () => undefined);

    timers.push(
      setTimeout(() => {
        if (settled || aborted) return;
        timedOut = true;
        terminate();
      }, options.timeoutMs),
    );
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err.code ?? 'error';
      finish(null, null);
    });
    child.on('exit', () => {
      if (settled) return;
      // Grandchildren may hold the pipes open; reap the group and stop waiting shortly after.
      timers.push(
        setTimeout(() => {
          killTree(child.pid, 'SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
        }, 1000),
      );
    });
    child.on('close', (code, signal) => finish(code, signal));

    if (child.pid !== undefined) {
      child.stdin.end(options.input ?? '');
    }
  });
}
