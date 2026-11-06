import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { MindlyError } from '@mindly/core';

/** A command to run against a materialized tree. */
export interface CheckSpec {
  /** Display name (1-64 characters). */
  name: string;
  /** Program and arguments; executed directly, never through a shell. */
  argv: readonly string[];
  /** Wall-clock limit in seconds (1-3600). */
  timeoutSec: number;
}

/** `pass`: exit 0; `fail`: non-zero exit; `timeout`: killed after its limit; `error`: could not start. */
export type CheckStatus = 'pass' | 'fail' | 'timeout' | 'error';

/** Outcome of one check. */
export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** Exit code, or null when killed by a signal or the process could not start. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  /** Tail of the combined stdout/stderr (at most `maxOutputBytes`). */
  output: string;
  /** True when earlier output was dropped. */
  truncated: boolean;
}

/** Options for `runChecks`. */
export interface RunChecksOptions {
  /** Bytes of combined output kept per check (default 16 KiB). */
  maxOutputBytes?: number;
  /** Delay between SIGTERM and SIGKILL on timeout (default 3 s). */
  killGraceMs?: number;
  /** Stop after the first check that does not pass. */
  stopOnFailure?: boolean;
  /** Kills the running check (its whole process group) and reports it as `error`. */
  signal?: AbortSignal;
}

type ResolvedOptions = Required<Omit<RunChecksOptions, 'signal'>> & { signal?: AbortSignal };

/** Default bytes of combined output kept per check. */
export const DEFAULT_CHECK_OUTPUT_BYTES = 16 * 1024;

/** Minimal environment for checks: PATH, HOME, LANG plus `CI=1`. */
export function checkEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { CI: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'SystemRoot'] as const) {
    const v = base[key];
    if (typeof v === 'string' && v !== '') env[key] = v;
  }
  return env;
}

function validateCheck(check: CheckSpec): void {
  if (
    typeof check.name !== 'string' ||
    check.name.length === 0 ||
    check.name.length > 64 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001F\u007F]/.test(check.name)
  ) {
    throw new MindlyError('invalid_input', 'invalid check name');
  }
  if (
    !Array.isArray(check.argv) ||
    check.argv.length === 0 ||
    check.argv.length > 256 ||
    check.argv.some((a) => typeof a !== 'string' || a.includes('\0')) ||
    check.argv[0] === ''
  ) {
    throw new MindlyError('invalid_input', 'invalid check argv');
  }
  if (!Number.isFinite(check.timeoutSec) || check.timeoutSec <= 0 || check.timeoutSec > 3600) {
    throw new MindlyError('invalid_input', 'invalid check timeout');
  }
}

/** Keeps only the last `max` bytes written to it. */
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
    // A cut may land inside a multi-byte character; drop the replacement char it produces.
    return Buffer.concat(this.chunks)
      .toString('utf8')
      .replace(/^\uFFFD+/, '');
  }
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // Negative pid: the whole process group (the child is a group leader on POSIX).
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function runOne(dir: string, check: CheckSpec, opts: ResolvedOptions) {
  return new Promise<CheckResult>((resolve) => {
    const started = Date.now();
    const tail = new TailBuffer(opts.maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    let onAbort = (): void => undefined;

    const finish = (partial: Pick<CheckResult, 'status' | 'exitCode' | 'signal'>): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        name: check.name,
        ...partial,
        durationMs: Date.now() - started,
        output: tail.toString(),
        truncated: tail.truncated,
      });
    };

    const [cmd, ...args] = check.argv as [string, ...string[]];
    const child = spawn(cmd, args, {
      cwd: dir,
      env: checkEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child.stdout.on('data', (c: Buffer) => tail.push(c));
    child.stderr.on('data', (c: Buffer) => tail.push(c));

    const stop = (): void => {
      killTree(child.pid, 'SIGTERM');
      timers.push(setTimeout(() => killTree(child.pid, 'SIGKILL'), opts.killGraceMs));
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, check.timeoutSec * 1000),
    );
    onAbort = (): void => {
      aborted = true;
      stop();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err: NodeJS.ErrnoException) => {
      tail.push(Buffer.from(`failed to start: ${err.code ?? 'error'}\n`));
      finish({ status: 'error', exitCode: null, signal: null });
    });
    child.on('exit', () => {
      if (settled) return;
      // Background grandchildren may keep the pipes open; do not wait for them forever.
      timers.push(
        setTimeout(() => {
          killTree(child.pid, 'SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
        }, 1000),
      );
    });
    child.on('close', (code, signal) => {
      if (aborted) finish({ status: 'error', exitCode: code, signal });
      else if (timedOut) finish({ status: 'timeout', exitCode: code, signal });
      else finish({ status: code === 0 ? 'pass' : 'fail', exitCode: code, signal });
    });
  });
}

/**
 * Runs each check sequentially in `dir` (normally a `materializeTree` path) with `spawn` and an
 * argument array, never a shell, a minimal environment (PATH, HOME, LANG, `CI=1`), a per-check
 * timeout (SIGTERM to the process group, then SIGKILL) and a capped output tail.
 *
 * Security: this executes arbitrary programs. Callers must only pass checks the user explicitly
 * trusted (for example from a project config whose hash the user approved); never pass commands
 * that come from repository content, memory or agent output without that approval.
 */
export async function runChecks(
  dir: string,
  checks: readonly CheckSpec[],
  options: RunChecksOptions = {},
): Promise<CheckResult[]> {
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0')) {
    throw new MindlyError('invalid_input', 'check directory must be an absolute path');
  }
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // treated as missing below
  }
  if (!isDir) throw new MindlyError('not_found', 'check directory does not exist');
  if (!Array.isArray(checks) || checks.length > 100) {
    throw new MindlyError('invalid_input', 'invalid checks list');
  }
  for (const c of checks) validateCheck(c);
  const opts: ResolvedOptions = {
    maxOutputBytes: Math.max(256, Math.floor(options.maxOutputBytes ?? DEFAULT_CHECK_OUTPUT_BYTES)),
    killGraceMs: Math.max(0, Math.floor(options.killGraceMs ?? 3000)),
    stopOnFailure: options.stopOnFailure ?? false,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await runOne(dir, check, opts);
    results.push(result);
    if (opts.stopOnFailure && result.status !== 'pass') break;
  }
  return results;
}
