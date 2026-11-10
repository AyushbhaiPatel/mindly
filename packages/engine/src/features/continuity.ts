/*
 * Continuity features: rate-limit failover and handoffs, the multi-agent time machine, memory
 * branches and the morning standup. Each module is a `MindlyModule`; `continuityModules`
 * registers all of them.
 */
import type { MindlyModule } from '../mindly.js';
import { branchesModule } from './branches.js';
import { failoverModule } from './failover.js';
import { snapshotsModule } from './snapshots.js';
import { standupModule } from './standup.js';

export {
  BranchService,
  branchService,
  branchesModule,
  MAX_BRANCH_CHECKS,
  MERGE_CHECK_TTL_MS,
  type BranchCheckResult,
} from './branches.js';
export {
  buildHandoffPacket,
  createFailoverModule,
  detectRateLimit,
  FailoverService,
  failoverModule,
  failoverService,
  HANDOFF_SUMMARY_MAX_CHARS,
  HandoffService,
  MAX_TRANSCRIPT_TAIL_BYTES,
  noticeLines,
  parseTranscriptTail,
  RATE_LIMIT_HANDOFF_MAX_AGE_MS,
  RATE_LIMIT_SIGNATURES,
  readTranscriptTail,
  recentAgentTexts,
  signaturesFor,
  turnEntries,
  type FailoverOptions,
  type HandoffExtras,
  type ManualHandoffInput,
  type NoticeSource,
  type PendingLaunch,
  type RateLimitSignature,
  type TranscriptEntry,
} from './failover.js';
export {
  AUTO_SNAPSHOT_INTERVAL_MS,
  isValidBranchName,
  SnapshotService,
  snapshotService,
  snapshotsModule,
  type RestoreResult,
  type SnapshotDiff,
  type SnapshotState,
} from './snapshots.js';
export {
  needsYouCount,
  renderStandup,
  standupDueAt,
  StandupService,
  standupService,
  standupModule,
  type StandupAgent,
  type StandupDigest,
  type StandupHandoff,
  type StandupItem,
} from './standup.js';

/** Registers every continuity module: `mindly.use(continuityModules)`. */
export const continuityModules: MindlyModule = (mindly) => {
  mindly.use(failoverModule).use(snapshotsModule).use(branchesModule).use(standupModule);
};
