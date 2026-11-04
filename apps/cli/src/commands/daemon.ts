import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureHome,
  homePaths,
  mindlyHome,
  MindlyError,
  resolveLayout,
  type HomePaths,
} from '@mindly/core';
import type { DaemonState } from '@mindly/daemon';
import { ago, type Out } from '../util.js';

const HOST = '127.0.0.1';
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function paths(env: NodeJS.ProcessEnv): HomePaths {
  return homePaths(mindlyHome(env));
}

/** Same as `pidAlive` in `@mindly/daemon`, without loading the daemon module. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads `daemon.json` (null when missing or malformed). Mirrors `readDaemonState`. */
export function readState(env: NodeJS.ProcessEnv): DaemonState | null {
  try {
    const raw = JSON.parse(readFileSync(paths(env).daemonState, 'utf8')) as Partial<DaemonState>;
    if (
      typeof raw.pid !== 'number' ||
      typeof raw.port !== 'number' ||
      !Number.isInteger(raw.port) ||
      raw.port < 1 ||
      raw.port > 65_535 ||
      typeof raw.startedAt !== 'number' ||
      typeof raw.version !== 'string'
    ) {
      return null;
    }
    return { pid: raw.pid, port: raw.port, startedAt: raw.startedAt, version: raw.version };
  } catch {
    return null;
  }
}

/** True when a Mindly daemon answers `GET /api/health` on `port`. */
export async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** The running daemon (state file present, process alive and answering), or null. */
export async function runningDaemon(env: NodeJS.ProcessEnv): Promise<DaemonState | null> {
  const state = readState(env);
  if (!state || !pidAlive(state.pid)) return null;
  return (await healthy(state.port)) ? state : null;
}

function readToken(env: NodeJS.ProcessEnv): string {
  try {
    const token = readFileSync(paths(env).token, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) return token;
  } catch {
    // fall through
  }
  throw new MindlyError('unavailable', 'the daemon token is missing; restart the daemon');
}

/**
 * Calls the daemon API with the bearer token. Throws a `MindlyError` with the API's error code
 * and message on failure.
 */
export async function daemonRequest<T>(
  env: NodeJS.ProcessEnv,
  state: DaemonState,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`http://${HOST}:${state.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${readToken(env)}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code === 'not_found' || err?.code === 'conflict' ? err.code : 'unavailable';
    throw new MindlyError(code, `daemon: ${err?.message ?? `HTTP ${res.status}`}`);
  }
  return json as T;
}

/**
 * Absolute path of the daemon's entry point: `dist/daemon.js` of the installed `mindly`
 * package, or `apps/daemon/dist/main.js` in a monorepo checkout.
 */
export function daemonMainPath(): string {
  const layout = resolveLayout(import.meta.url);
  if (!existsSync(layout.daemonMain)) {
    throw new MindlyError(
      'unavailable',
      layout.kind === 'dev'
        ? 'the Mindly daemon is not built (run pnpm build)'
        : 'the Mindly daemon entry point is missing; reinstall mindly',
    );
  }
  return layout.daemonMain;
}

/** Starts the daemon in the background and waits until it answers. */
export async function startBackground(env: NodeJS.ProcessEnv): Promise<DaemonState> {
  ensureHome(mindlyHome(env));
  const main = daemonMainPath();
  const child = spawn(process.execPath, [main], {
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: true,
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new MindlyError('unavailable', 'could not start the daemon');
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readState(env);
    if (state && state.pid === pid && (await healthy(state.port))) return state;
    if (!pidAlive(pid)) break;
    await sleep(100);
  }
  throw new MindlyError(
    'unavailable',
    `the daemon did not start; see ${join(paths(env).logs, 'mindly.log')}`,
  );
}

/** `mindly daemon start [--foreground]`. */
export async function daemonStart(out: Out, o: { foreground?: boolean }): Promise<number> {
  const env = out.io.env;
  const running = await runningDaemon(env);
  if (running) {
    out.line(
      `The daemon is already running at http://${HOST}:${running.port} (pid ${running.pid}).`,
    );
    return 0;
  }
  if (o.foreground) {
    const { startDaemon } = await import('@mindly/daemon');
    const daemon = await startDaemon({ env });
    out.line(`Mindly daemon listening on ${daemon.url} (Ctrl-C to stop)`);
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        void daemon.stop().finally(resolve);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    return 0;
  }
  const state = await startBackground(env);
  out.line(`Mindly daemon started at http://${HOST}:${state.port} (pid ${state.pid}).`);
  return 0;
}

/** `mindly daemon stop`: SIGTERM after checking the pid is alive and the port is a Mindly daemon. */
export async function daemonStop(out: Out): Promise<number> {
  const env = out.io.env;
  const state = readState(env);
  if (!state) {
    out.line('The daemon is not running.');
    return 0;
  }
  if (!pidAlive(state.pid)) {
    out.line('The daemon is not running (stale state file).');
    return 0;
  }
  if (!(await healthy(state.port))) {
    throw new MindlyError(
      'conflict',
      `pid ${state.pid} from daemon.json does not answer as a Mindly daemon on port ${state.port}; not stopping it`,
    );
  }
  process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) {
      out.line('Mindly daemon stopped.');
      return 0;
    }
    await sleep(100);
  }
  throw new MindlyError('timeout', `the daemon (pid ${state.pid}) did not stop in time`);
}

/** `mindly daemon status`. */
export async function daemonStatus(out: Out, o: { json?: boolean }): Promise<number> {
  const env = out.io.env;
  const state = readState(env);
  const alive = state !== null && pidAlive(state.pid);
  const answering = alive && state !== null && (await healthy(state.port));
  if (o.json) {
    out.json({ running: answering, ...(state ? { state } : {}) });
    return 0;
  }
  if (answering && state) {
    out.line(
      `Running at http://${HOST}:${state.port} (pid ${state.pid}, version ${state.version}, started ${ago(state.startedAt)}).`,
    );
  } else if (alive && state) {
    out.line(`daemon.json names pid ${state.pid}, but nothing answers on port ${state.port}.`);
  } else {
    out.line('Not running. Start it with: mindly daemon start');
  }
  return 0;
}

/** Opens `url` in the default browser without a shell. Never throws. */
export function openInBrowser(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['explorer.exe', [url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err) => {
        // explorer.exe exits with 1 even when it opened the URL.
        resolve(!err || process.platform === 'win32');
      });
    } catch {
      resolve(false);
    }
  });
}

/** `mindly dashboard`: starts the daemon if needed and opens Mission Control with a login code. */
export async function dashboard(out: Out, o: { open?: boolean }): Promise<number> {
  const env = out.io.env;
  let state = await runningDaemon(env);
  if (!state) {
    out.warn('Starting the Mindly daemon...');
    state = await startBackground(env);
  }
  const { code } = await daemonRequest<{ code: string; expiresAt: number }>(
    env,
    state,
    'POST',
    '/api/auth/codes',
    {},
  );
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) {
    throw new MindlyError('unavailable', 'the daemon returned an invalid login code');
  }
  const url = `http://${HOST}:${state.port}/#login=${code}`;
  out.line(`Mission Control: ${url}`);
  out.line(out.style.dim('The login code works once and expires in 60 seconds.'));
  if (o.open !== false && !(await openInBrowser(url))) {
    out.warn('Could not open a browser; open the URL above yourself.');
  }
  return 0;
}
