import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  daemonHomeId,
  ensureHome,
  type HomePaths,
  homePaths,
  MINDLY_VERSION,
  MindlyError,
  mindlyHome,
  probeDaemon,
  resolveLayout,
} from '@mindly/core';
import type { DaemonState } from '@mindly/daemon';
import { relativeTime } from '../present/index.js';
import { HintedError, type Out } from '../util.js';

const HOST = '127.0.0.1';
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 20_000;
/** Same as `STOPPING_MARK_MS` in `@mindly/daemon`: how long a "shutting down" mark is believed. */
const STOPPING_MARK_MS = 15_000;
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
    return {
      pid: raw.pid,
      port: raw.port,
      startedAt: raw.startedAt,
      version: raw.version,
      ...(typeof raw.stoppingAt === 'number' ? { stoppingAt: raw.stoppingAt } : {}),
    };
  } catch {
    return null;
  }
}

/** True when `daemon.json` names a live process (no request is made). */
export function daemonAlive(env: NodeJS.ProcessEnv): boolean {
  const state = readState(env);
  return state !== null && pidAlive(state.pid);
}

/**
 * What `daemon.json` says about this home's service, checked against the machine:
 * - `none`: no file, or its process is gone;
 * - `running`: the recorded process answers on the recorded port as this home's daemon;
 * - `stopping`: it said it is shutting down and may still be finishing a job;
 * - `silent`: the port is held open without an answer (a busy service, or another program);
 * - `other`: a Mindly daemon answers there, but not this one: another home's, which uses the
 *   same default port, or another process;
 * - `leftover`: nothing of Mindly's is there; the file outlived its daemon.
 */
export type Recorded = 'none' | 'running' | 'stopping' | 'silent' | 'other' | 'leftover';

function isStopping(state: DaemonState): boolean {
  const age = state.stoppingAt === undefined ? null : Date.now() - state.stoppingAt;
  return age !== null && age < STOPPING_MARK_MS && age > -STOPPING_MARK_MS;
}

/** Reads `daemon.json` and finds out what is really there (see {@link Recorded}). */
export async function recordedDaemon(
  env: NodeJS.ProcessEnv,
): Promise<{ kind: Recorded; state: DaemonState | null }> {
  const state = readState(env);
  if (!state || !pidAlive(state.pid)) return { kind: 'none', state };
  if (isStopping(state)) return { kind: 'stopping', state };
  const probe = await probeDaemon(state.port);
  if (probe.owner === 'silent') return { kind: 'silent', state };
  if (probe.owner === 'absent') return { kind: 'leftover', state };
  // "A Mindly daemon answers" is not yet "the recorded one does": it says which it is. One that
  // does not say (an older version, still running after an upgrade) is taken to be ours.
  const sameHome = probe.home === null || probe.home === daemonHomeId(mindlyHome(env));
  const samePid = probe.pid === null || probe.pid === state.pid;
  return { kind: sameHome && samePid ? 'running' : 'other', state };
}

/** True when a Mindly daemon answers `GET /api/health` on `port`. */
export async function healthy(port: number): Promise<boolean> {
  return (await probeDaemon(port)).owner === 'daemon';
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

/**
 * Said when the running service is another version than this CLI (typically: Mindly was
 * upgraded and the service still runs the old code, serving the new dashboard from its old API).
 */
function versionNote(state: DaemonState): string | null {
  if (state.version === MINDLY_VERSION) return null;
  return `It runs Mindly ${state.version}, and this is ${MINDLY_VERSION}: restart it to use this version (mindly daemon stop && mindly daemon start).`;
}

/** The running daemon of this home (recorded, alive and answering as itself), or null. */
export async function runningDaemon(env: NodeJS.ProcessEnv): Promise<DaemonState | null> {
  const { kind, state } = await recordedDaemon(env);
  return kind === 'running' ? state : null;
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

const MAX_START_ERROR_BYTES = 64 * 1024;

/**
 * Why the daemon process said it could not start (its last `mindly daemon:` line), read from
 * the start of the open file `fd`, or null.
 */
function startFailure(fd: number): string | null {
  try {
    const buf = Buffer.alloc(MAX_START_ERROR_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString('utf8').split(/\r?\n/);
    const said = lines.filter((l) => l.startsWith('mindly daemon: ')).pop();
    return said === undefined ? null : said.slice('mindly daemon: '.length).trim().slice(0, 500);
  } catch {
    return null;
  }
}

/**
 * A file the daemon's stderr goes to while it starts. On POSIX its name is removed as soon as
 * the child holds it open: both processes keep their descriptors, and nothing is left behind
 * however the CLI ends (Ctrl-C included). Windows cannot remove an open file, so there it is
 * removed on release, and on Ctrl-C.
 */
function startErrorFile(logs: string): { fd: number; spawned(): void; release(): void } {
  const file = join(logs, `daemon-start-${process.pid}-${Date.now()}.err`);
  const fd = openSync(file, 'w+', 0o600);
  let named = true;
  const unlink = (): void => {
    if (!named) return;
    try {
      rmSync(file, { force: true });
      named = false;
    } catch {
      // Still open elsewhere (Windows): tried again on release.
    }
  };
  const onInterrupt = (): void => {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    unlink();
    process.exit(130);
  };
  if (process.platform === 'win32') process.once('SIGINT', onInterrupt);
  return {
    fd,
    spawned: () => {
      if (process.platform !== 'win32') unlink();
    },
    release: () => {
      process.off('SIGINT', onInterrupt);
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      unlink();
    },
  };
}

/**
 * Starts the daemon in the background and waits until it answers. `started` is false when this
 * home's daemon turned out to be running already (another `start` won the race).
 */
async function launch(
  env: NodeJS.ProcessEnv,
  o: { force?: boolean } = {},
): Promise<{ state: DaemonState; started: boolean }> {
  const home = ensureHome(mindlyHome(env));
  const before = await recordedDaemon(env);
  // A port held without an answer makes the daemon refuse to start: say why, and how to insist.
  if (before.kind === 'silent' && before.state && o.force !== true)
    throw notAnswering(before.state);
  const main = daemonMainPath();
  // The daemon says why it cannot start on stderr, and a detached process has no terminal:
  // keep that for the length of the start.
  const errors = startErrorFile(home.logs);
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, o.force === true ? [main, '--force'] : [main], {
      detached: true,
      stdio: ['ignore', 'ignore', errors.fd],
      env,
      windowsHide: true,
    });
    child.unref();
    pid = child.pid;
  } catch (err) {
    errors.release();
    throw err;
  }
  errors.spawned();
  try {
    if (pid === undefined) throw new MindlyError('unavailable', 'could not start the daemon');
    // A service that is shutting down is waited for by the new one before it starts.
    const wait = START_TIMEOUT_MS + (before.kind === 'stopping' ? STOPPING_MARK_MS : 0);
    const deadline = Date.now() + wait;
    while (Date.now() < deadline) {
      const state = readState(env);
      if (state && state.pid === pid && (await healthy(state.port)))
        return { state, started: true };
      if (!pidAlive(pid)) break;
      await sleep(100);
    }
    // Ours did not come up. If that is because this home's service is running after all (two
    // starts at once: the other one won), there is nothing wrong.
    for (let attempt = 0; attempt < 10; attempt++) {
      const now = await recordedDaemon(env);
      if (now.kind === 'running' && now.state) return { state: now.state, started: false };
      if (now.kind !== 'none' && now.kind !== 'stopping') break;
      await sleep(100);
    }
    const why = startFailure(errors.fd);
    const portClash = why !== null && /already in use/.test(why);
    throw new HintedError(
      'unavailable',
      why === null
        ? "Mindly's background service did not start"
        : `Mindly's background service did not start: ${why}`,
      portClash
        ? 'Pick a free port and start again: mindly config set daemon.port <port>, then mindly daemon start'
        : `See what went wrong in ${join(home.logs, 'mindly.log')}, or run it in this terminal: mindly daemon start --foreground`,
    );
  } finally {
    errors.release();
  }
}

/** Starts the daemon in the background and waits until it answers. */
export async function startBackground(
  env: NodeJS.ProcessEnv,
  o: { force?: boolean } = {},
): Promise<DaemonState> {
  return (await launch(env, o)).state;
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
  const alreadyRunning = (state: DaemonState): number => {
    out.line(`The background service is already running at http://${HOST}:${state.port}.`);
    const note = versionNote(state);
    if (note !== null) out.warn(note);
    return 0;
  };
  const running = await runningDaemon(env);
  if (running) return alreadyRunning(running);
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
  const { state, started } = await launch(env, o.force === true ? { force: true } : {});
  if (!started) return alreadyRunning(state);
  const sc = out.screen();
  sc.text(`${sc.mark('ok')} Started Mindly's background service at http://${HOST}:${state.port}.`);
  sc.next([{ cmd: 'mindly dashboard', why: 'open Mission Control in your browser' }]);
  return 0;
}

async function waitUntilGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

/**
 * `mindly daemon stop`: SIGTERM to the recorded process, and only once it has answered on the
 * recorded port as this home's daemon with that PID. Anything else on that port, another home's
 * Mindly daemon included, is never signalled.
 */
export async function daemonStop(out: Out): Promise<number> {
  const env = out.io.env;
  const { kind, state } = await recordedDaemon(env);
  if (kind === 'none' || state === null) {
    out.line('The background service is not running: nothing to stop.');
    return 0;
  }
  if (kind === 'silent') throw notAnswering(state);
  if (kind === 'leftover' || kind === 'other') {
    out.line('The background service is not running: nothing to stop.');
    out.line(
      out.style.dim(
        kind === 'other'
          ? `Port ${state.port} is used by the Mindly service of another home (a different MINDLY_HOME); it was left alone. ${paths(env).daemonState} is left over from an earlier run.`
          : `${paths(env).daemonState} is left over from an earlier run (process ${state.pid} is not Mindly's service); mindly daemon start replaces it.`,
      ),
    );
    return 0;
  }
  // Already on its way out: nothing to signal, only to wait for.
  if (kind === 'running') process.kill(state.pid, 'SIGTERM');
  if (await waitUntilGone(state.pid)) {
    out.line("Stopped Mindly's background service.");
    return 0;
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
  const { kind, state } = await recordedDaemon(env);
  if (o.json) {
    out.json({
      running: kind === 'running',
      ...(state ? { state } : {}),
      ...(kind === 'running' && state && state.version !== MINDLY_VERSION
        ? { outdated: true, cliVersion: MINDLY_VERSION }
        : {}),
    });
    return 0;
  }
  const sc = out.screen();
  if (kind === 'running' && state) {
    sc.summary(
      `${sc.mark('ok')} Mindly's background service is running at http://${HOST}:${state.port}`,
    );
    sc.note(
      `Version ${state.version}, started ${relativeTime(state.startedAt, sc.now)}. It serves Mission Control and runs checks in the background.`,
      2,
    );
    const note = versionNote(state);
    if (note !== null) {
      sc.text(`${sc.mark('warn')} ${note}`, 2);
      sc.next([{ cmd: 'mindly daemon stop && mindly daemon start', why: `run ${MINDLY_VERSION}` }]);
    } else {
      sc.next([{ cmd: 'mindly dashboard', why: 'open Mission Control in your browser' }]);
    }
  } else if (kind === 'stopping' && state) {
    sc.summary(`${sc.mark('warn')} Mindly's background service is shutting down.`);
    sc.note('It no longer answers and may still be finishing a job. This takes a few seconds.', 2);
    sc.next([
      { cmd: 'mindly daemon start', why: 'start it again (waits for the old one to finish)' },
    ]);
  } else if (kind === 'silent' && state) {
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
  } else if (kind === 'other' && state) {
    sc.summary("Mindly's background service is not running.");
    sc.note(
      `Port ${state.port}, where it last ran, is now used by the Mindly service of another home (a different MINDLY_HOME). Two homes cannot share a port.`,
      2,
    );
    sc.next([
      { cmd: 'mindly config set daemon.port <port>', why: 'give this home its own port' },
      { cmd: 'mindly daemon start', why: 'then start its service' },
    ]);
  } else if (kind === 'leftover' && state) {
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
  } else {
    const note = versionNote(state);
    if (note !== null) out.warn(note);
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
