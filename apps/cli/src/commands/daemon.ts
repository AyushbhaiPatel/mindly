import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureHome,
  type HomePaths,
  homePaths,
  MindlyError,
  mindlyHome,
  probeDaemonPort,
  resolveLayout,
} from '@mindly/core';
import type { DaemonState } from '@mindly/daemon';
import { relativeTime } from '../present/index.js';
import { HintedError, type Out } from '../util.js';

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

/** True when `daemon.json` names a live process (no request is made). */
export function daemonAlive(env: NodeJS.ProcessEnv): boolean {
  const state = readState(env);
  return state !== null && pidAlive(state.pid);
}

/** True when a Mindly daemon answers `GET /api/health` on `port`. */
export async function healthy(port: number): Promise<boolean> {
  return (await probeDaemonPort(port)) === 'daemon';
}

/**
 * The recorded process exists and its port is held open, but nothing answers. Mindly cannot tell
 * a busy service from another program there, so it neither signals the process nor starts next
 * to it unless asked to.
 */
function notAnswering(state: DaemonState): HintedError {
  return new HintedError(
    'unavailable',
    `Process ${state.pid} holds port ${state.port} and is not answering: it may be Mindly's background service, busy, or another program`,
    `Wait a moment and try again. To discard the recorded state and start a new service anyway (process ${state.pid} is left alone): mindly daemon start --force`,
  );
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
  throw new HintedError(
    'unavailable',
    "The background service's access token is missing",
    'Restart it: mindly daemon stop, then mindly daemon start',
  );
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
 * Absolute path of the daemon's entry point: `dist/daemon.js` of the installed `mindly-cli`
 * package, or `apps/daemon/dist/main.js` in a monorepo checkout.
 */
export function daemonMainPath(): string {
  const layout = resolveLayout(import.meta.url);
  if (!existsSync(layout.daemonMain)) {
    throw new MindlyError(
      'unavailable',
      layout.kind === 'dev'
        ? 'the Mindly daemon is not built (run pnpm build)'
        : 'the Mindly daemon entry point is missing; reinstall mindly-cli',
    );
  }
  return layout.daemonMain;
}

/** Starts the daemon in the background and waits until it answers. */
export async function startBackground(
  env: NodeJS.ProcessEnv,
  o: { force?: boolean } = {},
): Promise<DaemonState> {
  ensureHome(mindlyHome(env));
  // A port held without an answer makes the daemon refuse to start: say why, and how to insist.
  const recorded = readState(env);
  if (
    o.force !== true &&
    recorded &&
    pidAlive(recorded.pid) &&
    (await probeDaemonPort(recorded.port)) === 'silent'
  ) {
    throw notAnswering(recorded);
  }
  const main = daemonMainPath();
  const child = spawn(process.execPath, o.force === true ? [main, '--force'] : [main], {
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
  throw new HintedError(
    'unavailable',
    "Mindly's background service did not start",
    `See what went wrong in ${join(paths(env).logs, 'mindly.log')}, or run it in this terminal: mindly daemon start --foreground`,
  );
}

/**
 * `mindly daemon start [--foreground] [--force]`. `--force` discards a recorded state whose port
 * is held without an answer and starts anyway; it never signals the recorded process.
 */
export async function daemonStart(
  out: Out,
  o: { foreground?: boolean; force?: boolean },
): Promise<number> {
  const env = out.io.env;
  const running = await runningDaemon(env);
  if (running) {
    out.line(`The background service is already running at http://${HOST}:${running.port}.`);
    return 0;
  }
  if (o.foreground) {
    const { startDaemon } = await import('@mindly/daemon');
    const daemon = await startDaemon({ env, ...(o.force === true ? { force: true } : {}) });
    out.line(`Mindly's background service is running at ${daemon.url} (Ctrl-C to stop).`);
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
  const state = await startBackground(env, o.force === true ? { force: true } : {});
  const sc = out.screen();
  sc.text(`${sc.mark('ok')} Started Mindly's background service at http://${HOST}:${state.port}.`);
  sc.next([{ cmd: 'mindly dashboard', why: 'open Mission Control in your browser' }]);
  return 0;
}

/** `mindly daemon stop`: SIGTERM after checking the pid is alive and the port is a Mindly daemon. */
export async function daemonStop(out: Out): Promise<number> {
  const env = out.io.env;
  const state = readState(env);
  if (!state || !pidAlive(state.pid)) {
    out.line('The background service is not running: nothing to stop.');
    return 0;
  }
  const owner = await probeDaemonPort(state.port);
  // Only a process whose port answers as Mindly is ever signalled.
  if (owner === 'silent') throw notAnswering(state);
  if (owner === 'absent') {
    // The file outlived its daemon (a crash, a restart); the PID is another program's by now.
    out.line('The background service is not running: nothing to stop.');
    out.line(
      out.style.dim(
        `${paths(env).daemonState} is left over from an earlier run (process ${state.pid} is not Mindly's service); mindly daemon start replaces it.`,
      ),
    );
    return 0;
  }
  process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) {
      out.line("Stopped Mindly's background service.");
      return 0;
    }
    await sleep(100);
  }
  throw new HintedError(
    'timeout',
    `The background service (process ${state.pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} seconds`,
    `Try again, or stop the process yourself: kill ${state.pid}`,
  );
}

/** `mindly daemon status`. */
export async function daemonStatus(out: Out, o: { json?: boolean }): Promise<number> {
  const env = out.io.env;
  const state = readState(env);
  const alive = state !== null && pidAlive(state.pid);
  const owner = alive && state !== null ? await probeDaemonPort(state.port) : 'absent';
  const answering = owner === 'daemon';
  if (o.json) {
    out.json({ running: answering, ...(state ? { state } : {}) });
    return 0;
  }
  const sc = out.screen();
  if (answering && state) {
    sc.summary(
      `${sc.mark('ok')} Mindly's background service is running at http://${HOST}:${state.port}`,
    );
    sc.note(
      `Version ${state.version}, started ${relativeTime(state.startedAt, sc.now)}. It serves Mission Control and runs checks in the background.`,
      2,
    );
    sc.next([{ cmd: 'mindly dashboard', why: 'open Mission Control in your browser' }]);
  } else if (alive && state && owner === 'silent') {
    sc.summary(
      `${sc.mark('warn')} Process ${state.pid} holds port ${state.port} and is not answering.`,
    );
    sc.note(
      "It may be Mindly's background service, busy, or another program. Wait a moment and ask again.",
      2,
    );
    sc.next([
      {
        cmd: 'mindly daemon start --force',
        why: `discard the recorded state and start a new service (process ${state.pid} is left alone)`,
      },
    ]);
  } else if (alive && state) {
    sc.summary("Mindly's background service is not running.");
    sc.note(
      `Its state file is left over from an earlier run: process ${state.pid} is running, but it is not Mindly's service and nothing of Mindly's is on port ${state.port}.`,
      2,
    );
    sc.next([{ cmd: 'mindly daemon start', why: 'start it (replaces the leftover file)' }]);
  } else {
    sc.summary("Mindly's background service is not running.");
    sc.note(
      'It is optional: hooks and the CLI work without it. It serves Mission Control (the browser view) and runs checks in the background.',
      2,
    );
    sc.next([{ cmd: 'mindly daemon start', why: 'start it' }]);
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
    out.warn("Starting Mindly's background service...");
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
  out.line(
    out.style.dim(
      'The live view of your agents, conflicts and memory in the browser. This link logs you in once and expires in 60 seconds.',
    ),
  );
  if (o.open !== false && !(await openInBrowser(url))) {
    out.warn('Could not open a browser: open the link above yourself.');
  }
  return 0;
}
