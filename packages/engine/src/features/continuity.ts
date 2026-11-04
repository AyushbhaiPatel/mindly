/*
 * Continuity features: rate-limit failover and handoffs, the multi-agent time machine, memory
 * branches and the morning standup. Each module is a `SynapseModule`; `continuityModules`
 * registers all of them.
 */
import type { SynapseModule } from '../synapse.js';
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
  HandoffService,
  MAX_TRANSCRIPT_TAIL_BYTES,
  parseTranscriptTail,
  RATE_LIMIT_SIGNATURES,
  readTranscriptTail,
  recentAgentTexts,
  signaturesFor,
  type FailoverOptions,
  type HandoffExtras,
  type ManualHandoffInput,
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

/** Registers every continuity module: `synapse.use(continuityModules)`. */
export const continuityModules: SynapseModule = (synapse) => {
  synapse.use(failoverModule).use(snapshotsModule).use(branchesModule).use(standupModule);
};
