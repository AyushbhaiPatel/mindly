import { existsSync, readFileSync, rmSync } from 'node:fs';
import {
  describeError,
  type HomePaths,
  homePaths,
  type Logger,
  MINDLY_VERSION,
  MindlyError,
  daemonHomeId,
  probeDaemon,
  writeJsonFile,
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
/**
 * How long a daemon that says it is shutting down is believed: the grace period and some room
 * for closing sockets and the database. Past that, the mark says nothing any more.
 */
export const STOPPING_MARK_MS = SHUTDOWN_GRACE_MS + 5000;

const MINUTE = 60_000;

/** Contents of `$MINDLY_HOME/daemon.json`. */
export interface DaemonState {
  pid: number;
  port: number;
  startedAt: number;
  version: string;
  /**
   * Set (wall-clock ms) by a daemon the moment it starts shutting down, before it closes its
   * port: until it removes the file it may still be finishing a job. Absent otherwise, and
   * always absent after a crash.
   */
  stoppingAt?: number;
}

/** True while the daemon `state` names says it is shutting down and can be believed. */
export function isStopping(state: DaemonState, now: number = Date.now()): boolean {
  return (
    state.stoppingAt !== undefined &&
    now - state.stoppingAt < STOPPING_MARK_MS &&
    // A clock set back must not make a mark last for ever.
    state.stoppingAt - now < STOPPING_MARK_MS
  );
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
  /**
   * Start even when the recorded daemon's port is held open without an answer. The recorded
   * process is never signalled; if it is a daemon on the same port, `listen()` still fails.
   */
  force?: boolean;
  /**
   * How long to wait for a daemon that is shutting down before giving up (default
   * `STOPPING_MARK_MS`, which outlasts its grace period).
   */
  stopWaitMs?: number;
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

/**
 * Builds a daemon without listening: opens Mindly, loads or creates the token, builds the HTTP
 * app. Refuses to proceed when `daemon.json` names a live process, unless that file is provably
 * left over: after a crash or a restart its PID can belong to another program, and then nothing
 * of this home's is on the recorded port (see `probeDaemon`). A port that is held open without
 * an answer may be a daemon blocked for a while, and starting a second one next to it would
 * cancel its runs and schedule the same jobs on the same database; that needs `force`.
 *
 * A daemon that is shutting down has closed its port but may still be inside a job. It says so
 * in the file (`stoppingAt`) before closing, and this waits for it to finish. A daemon that was
 * killed leaves no such mark, so its file is stale at once.
 *
 * The port is `daemon.port` from the config (7878 unless changed) or `options.port`; tests and
 * embedders may pass 0 for an ephemeral one. So two daemons do not always compete for one port,
 * and this check is what keeps a second one out. `listen()` failing on a taken port is the last
 * line of defence, which is why nothing that touches shared state runs before it.
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
    const home = daemonHomeId(paths.home);
    const giveUpAt = Date.now() + Math.max(0, options.stopWaitMs ?? STOPPING_MARK_MS);
    for (;;) {
      const existing = readDaemonState(paths.daemonState);
      if (!existing || !pidAlive(existing.pid)) break;
      if (isStopping(existing)) {
        if (Date.now() >= giveUpAt) {
          throw new MindlyError(
            'conflict',
            `the Mindly daemon (pid ${existing.pid}) is shutting down and still finishing a job; try again when it has stopped`,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const probe = await probeDaemon(existing.port);
      // Every home defaults to the same port: a daemon that says it serves another home is not
      // the one this file is about. One that does not say (an older version) is taken to be.
      const ours = probe.owner === 'daemon' && (probe.home === null || probe.home === home);
      if (ours) {
        throw new MindlyError(
          'conflict',
          `a Mindly daemon is already running (pid ${existing.pid}, port ${existing.port})`,
        );
      }
      if (probe.owner === 'silent' && options.force !== true) {
        throw new MindlyError(
          'conflict',
          `process ${existing.pid} holds port ${existing.port} and is not answering: it may be a busy Mindly daemon or another program (start with --force to discard the recorded state)`,
        );
      }
      mindly.kernel.logger.warn('ignoring a stale daemon.json', {
        forced: probe.owner === 'silent',
        otherHome: probe.owner === 'daemon',
        pid: existing.pid,
        port: existing.port,
      });
      break;
    }
  } catch (err) {
    // The background daemon's stderr goes nowhere: the log is where the reason is found.
    mindly.kernel.logger.error('daemon did not start', { error: describeError(err) });
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
        let failure: unknown = err;
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          const holder = await probeDaemon(listener.port);
          const who =
            holder.owner !== 'daemon'
              ? 'by another program'
              : holder.home !== null && holder.home !== daemonHomeId(paths.home)
                ? "by another Mindly home's daemon (a different MINDLY_HOME)"
                : 'by a Mindly daemon';
          failure = new MindlyError(
            'conflict',
            `port ${listener.port} is already in use ${who}; choose another with: mindly config set daemon.port <port>`,
          );
        }
        logger.error('daemon did not start', { error: describeError(failure) });
        throw failure;
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
        // Say so before the port closes: from here on nothing answers there, and without this
        // mark a daemon started meanwhile would take the file for a crashed daemon's while
        // this one is still finishing a job on the same database.
        if (listening) {
          try {
            const state = readDaemonState(paths.daemonState);
            if (state && state.pid === process.pid && state.port === listener.port) {
              writeJsonFile(paths.daemonState, {
                ...state,
                stoppingAt: Date.now(),
              } satisfies DaemonState);
            }
          } catch (err) {
            logger.warn('could not mark daemon.json as stopping', { error: describeError(err) });
          }
        }
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
