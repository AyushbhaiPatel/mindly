import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  MINDLY_VERSION,
  MindlyError,
  describeError,
  homePaths,
  writeJsonFile,
  type HomePaths,
  type Logger,
} from '@mindly/core';
import type { Mindly } from '@mindly/engine';
import { createRunners, type RunnerPort } from '@mindly/runners';
import { openMindly, type RuntimeOptions } from '@mindly/runtime';
import type { FastifyInstance } from 'fastify';
import { AuthState, loadOrCreateToken } from './auth.js';
import type { Listener } from './http/security.js';
import type { JobContext } from './jobs/context.js';
import { contractsTick } from './jobs/contracts.js';
import {
  checkpointPruneTick,
  housekeepingTick,
  selfHealingTick,
  standupTick,
  trackSurvivalTick,
} from './jobs/maintenance.js';
import { failoverTick } from './jobs/runs.js';
import { Scheduler } from './jobs/scheduler.js';
import { sentinelPruneTick, sentinelTick } from './jobs/sentinel.js';
import { shadowMergeTick } from './jobs/shadow-merge.js';
import { LiveFeed } from './live.js';
import { buildServer, defaultDashboardDir } from './server.js';

/** The only interface the daemon binds to. */
export const DAEMON_HOST = '127.0.0.1';
/** How long shutdown waits for a running job. */
export const SHUTDOWN_GRACE_MS = 10_000;

const MINUTE = 60_000;

/** Contents of `$MINDLY_HOME/daemon.json`. */
export interface DaemonState {
  pid: number;
  port: number;
  startedAt: number;
  version: string;
}

/** Options for `createDaemon` / `startDaemon`. */
export interface DaemonOptions {
  /** Mindly home (default `$MINDLY_HOME` or `~/.mindly`). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Port to listen on; default `config.daemon.port` (0 picks a random free port). */
  port?: number;
  /** Must be `127.0.0.1` when given; any other interface is refused. */
  host?: string;
  /** Built dashboard directory; default `apps/dashboard/dist`; null disables static serving. */
  dashboardDir?: string | null;
  /** Run background jobs (default true). */
  jobs?: boolean;
  /** Headless agent runners (default `createRunners()`); injectable for tests. */
  runners?: RunnerPort;
  /** Options passed to `openMindly` (e.g. `disableNotify`). */
  runtime?: Omit<RuntimeOptions, 'home' | 'env'>;
}

/** A running (or ready-to-listen) daemon. */
export interface Daemon {
  readonly app: FastifyInstance;
  readonly mindly: Mindly;
  readonly auth: AuthState;
  readonly scheduler: Scheduler;
  readonly jobs: JobContext;
  readonly live: LiveFeed;
  readonly paths: HomePaths;
  readonly logger: Logger;
  /** Bearer token of this daemon (contents of `daemon.token`). */
  readonly token: string;
  /** Port being listened on (the configured port before `listen`). */
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** Starts listening on 127.0.0.1, writes `daemon.json` and starts background jobs. */
  listen(): Promise<void>;
  /** Graceful shutdown (idempotent). */
  stop(): Promise<void>;
}

/** Whether a process with `pid` exists. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads `daemon.json`; null when missing or malformed. */
export function readDaemonState(path: string): DaemonState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DaemonState>;
    if (
      typeof raw.pid !== 'number' ||
      typeof raw.port !== 'number' ||
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

const HEALTH_ATTEMPTS = 2;
const HEALTH_TIMEOUT_MS = 1500;

/**
 * True when a Mindly daemon answers `GET /api/health` on `port`. Asked twice, so a daemon that
 * is busy for a moment is not taken for a dead one.
 */
export async function daemonAnswers(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`http://${DAEMON_HOST}:${port}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { ok?: unknown; version?: unknown };
        return body.ok === true && typeof body.version === 'string';
      }
      return false;
    } catch (err) {
      // Nothing listens there: no need to ask again.
      const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
      if (code === 'ECONNREFUSED') return false;
    }
  }
  return false;
}

/**
 * Builds a daemon without listening: opens Mindly, loads or creates the token, builds the HTTP
 * app. Refuses to proceed when another live daemon owns `daemon.json`: its process exists and
 * answers on the recorded port. A file left by a daemon that crashed (or by a machine that
 * restarted) can name a PID that belongs to another program by now; that file is stale and is
 * replaced when this daemon listens.
 */
export async function createDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  if (options.host !== undefined && options.host !== DAEMON_HOST) {
    throw new MindlyError('invalid_input', 'the daemon only binds to 127.0.0.1');
  }
  const env = options.env ?? process.env;
  const mindly = openMindly({
    ...(options.runtime ?? {}),
    ...(options.home !== undefined ? { home: options.home } : {}),
    env,
  });
  let paths: HomePaths;
  try {
    paths = mindly.paths ?? homePaths(options.home ?? '');
    const existing = readDaemonState(paths.daemonState);
    if (existing && pidAlive(existing.pid)) {
      if (await daemonAnswers(existing.port)) {
        throw new MindlyError(
          'conflict',
          `a Mindly daemon is already running (pid ${existing.pid}, port ${existing.port})`,
        );
      }
      mindly.kernel.logger.warn('ignoring a stale daemon.json', {
        pid: existing.pid,
        port: existing.port,
      });
    }
  } catch (err) {
    mindly.close();
    throw err;
  }
  const port = options.port ?? mindly.config.daemon.port;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    mindly.close();
    throw new MindlyError('invalid_input', 'invalid port');
  }

  const logger = mindly.kernel.logger.child({ component: 'daemon' });
  const token = loadOrCreateToken(paths.token);
  const auth = new AuthState(token, mindly.kernel.clock);
  const scheduler = new Scheduler(logger);
  const jobs: JobContext = {
    mindly,
    logger,
    scheduler,
    runners: options.runners ?? createRunners(),
  };
  const live = new LiveFeed(mindly.store, logger);
  const listener: Listener = { port };
  const app = await buildServer({
    mindly,
    auth,
    listener,
    jobs,
    live,
    dashboardDir: options.dashboardDir === undefined ? defaultDashboardDir() : options.dashboardDir,
  });

  let listening = false;
  let stopping: Promise<void> | null = null;

  const daemon: Daemon = {
    app,
    mindly,
    auth,
    scheduler,
    jobs,
    live,
    paths,
    logger,
    token,
    get port() {
      return listener.port;
    },
    get url() {
      return `http://${DAEMON_HOST}:${listener.port}`;
    },
    async listen() {
      if (listening) return;
      try {
        await app.listen({ host: DAEMON_HOST, port: listener.port });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          throw new MindlyError('conflict', `port ${listener.port} is already in use`);
        }
        throw err;
      }
      listening = true;
      // Only now is this the one daemon: a second one that lost the port never gets here, so it
      // cannot cancel the runs of the daemon that holds it.
      cancelStaleRuns(jobs);
      const addr = app.server.address();
      if (addr && typeof addr === 'object') listener.port = addr.port;
      writeJsonFile(paths.daemonState, {
        pid: process.pid,
        port: listener.port,
        startedAt: mindly.kernel.clock.now(),
        version: MINDLY_VERSION,
      } satisfies DaemonState);
      if (options.jobs !== false) registerJobs(jobs);
      logger.info('daemon listening', { port: listener.port });
    },
    stop() {
      stopping ??= (async () => {
        live.close();
        try {
          await app.close();
        } catch (err) {
          logger.warn('server close failed', { error: describeError(err) });
        }
        const finished = await scheduler.stop(SHUTDOWN_GRACE_MS);
        if (!finished) logger.warn('shutdown: a job was still running after the grace period');
        if (listening) {
          const state = readDaemonState(paths.daemonState);
          if (state && state.pid === process.pid && state.port === listener.port) {
            rmSync(paths.daemonState, { force: true });
          }
        }
        auth.clear();
        mindly.close();
        logger.info('daemon stopped');
      })();
      return stopping;
    },
  };
  return daemon;
}

/** Creates a daemon, listens on 127.0.0.1 and starts its background jobs. */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const daemon = await createDaemon(options);
  try {
    await daemon.listen();
  } catch (err) {
    await daemon.stop();
    throw err;
  }
  return daemon;
}

/** Stops a daemon started with `startDaemon` (closes sockets, waits for jobs, removes daemon.json). */
export async function stopDaemon(daemon: Daemon): Promise<void> {
  await daemon.stop();
}

/** Registers the periodic background jobs. */
export function registerJobs(jobs: JobContext): void {
  const { scheduler, mindly } = jobs;
  const config = mindly.config;
  if (config.shadowMerge.enabled) {
    scheduler.every({
      name: 'shadow-merge',
      intervalMs: config.shadowMerge.intervalSec * 1000,
      run: () => shadowMergeTick(jobs),
    });
  }
  scheduler.every({
    name: 'command-contracts',
    intervalMs: 10 * MINUTE,
    initialDelayMs: 2 * MINUTE,
    run: () => contractsTick(jobs),
  });
  scheduler.every({
    name: 'self-healing',
    intervalMs: 10 * MINUTE,
    initialDelayMs: MINUTE,
    run: () => selfHealingTick(jobs),
  });
  scheduler.every({
    name: 'housekeeping',
    intervalMs: 60 * MINUTE,
    initialDelayMs: MINUTE,
    run: () => {
      housekeepingTick(jobs);
    },
  });
  scheduler.every({
    name: 'checkpoint-prune',
    intervalMs: 60 * MINUTE,
    initialDelayMs: 3 * MINUTE,
    run: () => checkpointPruneTick(jobs),
  });
  scheduler.every({
    name: 'track-survival',
    intervalMs: 30 * MINUTE,
    initialDelayMs: 4 * MINUTE,
    run: async () => {
      await trackSurvivalTick(jobs);
    },
  });
  // Always scheduled: the tick reads `sentinel.*` from the config file, so turning it on or off
  // with `mindly config set` needs no restart.
  scheduler.every({
    name: 'sentinel',
    intervalMs: 15_000,
    initialDelayMs: 30_000,
    run: async () => {
      await sentinelTick(jobs);
    },
  });
  scheduler.every({
    name: 'sentinel-prune',
    intervalMs: 60 * MINUTE,
    initialDelayMs: 5 * MINUTE,
    run: () => sentinelPruneTick(jobs),
  });
  if (config.standup.time) {
    scheduler.every({ name: 'standup', intervalMs: MINUTE, run: () => standupTick(jobs) });
  }
  if (config.failover.autoLaunch) {
    scheduler.every({ name: 'failover', intervalMs: 30_000, run: () => failoverTick(jobs) });
  }
}

/** Runs left queued or running by a previous daemon process can never finish: cancel them. */
function cancelStaleRuns(jobs: JobContext): void {
  const store = jobs.mindly.store;
  try {
    for (const p of store.projects.list().slice(0, 500)) {
      for (const run of store.runs.list(p.id, { limit: 200 })) {
        if (run.status === 'queued' || run.status === 'running') {
          store.runs.finish(run.id, 'cancelled', { error: 'the daemon restarted' });
        }
      }
    }
  } catch (err) {
    jobs.logger.warn('could not cancel stale runs', { error: describeError(err) });
  }
}
