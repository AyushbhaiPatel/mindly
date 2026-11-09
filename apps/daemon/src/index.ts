/**
 * `@mindly/daemon`: the optional long-running local process. Serves the Mission Control dashboard
 * and the API in docs/api.md on 127.0.0.1 only, pushes the live event feed over WebSocket and runs
 * background jobs (shadow merge, command contracts, the sentinel, self-healing sweeps,
 * housekeeping, standup, review/replay queue, opt-in failover launch).
 */
export {
  createDaemon,
  DAEMON_HOST,
  pidAlive,
  probeDaemonPort,
  readDaemonState,
  registerJobs,
  SHUTDOWN_GRACE_MS,
  startDaemon,
  stopDaemon,
  type Daemon,
  type DaemonOptions,
  type DaemonState,
  type PortOwner,
} from './daemon.js';
export {
  AuthState,
  loadOrCreateToken,
  LOGIN_CODE_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from './auth.js';
export { CSP, SECURITY_HEADERS } from './http/security.js';
export { BODY_LIMIT, buildServer, defaultDashboardDir } from './server.js';
export { LiveFeed, MAX_LIVE_SOCKETS, PING_INTERVAL_MS, POLL_INTERVAL_MS } from './live.js';
export { Scheduler, type JobSpec } from './jobs/scheduler.js';
export type { JobContext } from './jobs/context.js';
export {
  createShadowMergeRun,
  executeShadowMerge,
  mergeCandidates,
  shadowMergeTick,
  type ShadowMergeRunResult,
} from './jobs/shadow-merge.js';
export { runCommandContracts, runnableCommandContracts, contractsTick } from './jobs/contracts.js';
export {
  checkpointPruneTick,
  housekeepingTick,
  selfHealingTick,
  standupTick,
  SURVIVAL_PER_TICK,
  trackSurvivalTick,
  type HousekeepingResult,
} from './jobs/maintenance.js';
export { executeReplay, executeReview, failoverTick, queueRun, resumePrompt } from './jobs/runs.js';
export { sentinelPruneTick, sentinelTick } from './jobs/sentinel.js';
