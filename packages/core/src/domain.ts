import { z } from 'zod';

/*
 * Domain model shared by every Mindly package. Enumerations are declared once as `as const`
 * tuples so they can drive runtime validation (zod), SQL CHECK constraints and TypeScript types
 * from a single definition.
 *
 * Timestamps are integer Unix milliseconds. Ids are UUIDv7 strings.
 */

/** Agent kind slugs. `repo-file` is reserved for {@link REPO_FILE_SOURCE}. */
export const AGENT_KIND_RE = /^(?!repo-file$)[a-z][a-z0-9-]{1,31}$/;
export const KNOWN_AGENT_KINDS = ['claude-code', 'codex', 'cursor', 'generic'] as const;
/** Agent kinds are open-ended so community adapters can add their own, but must be slug-shaped. */
export const AgentKindSchema = z.string().regex(AGENT_KIND_RE, 'invalid agent kind');
export type AgentKind = string;

export const SESSION_STATUSES = ['active', 'idle', 'ended', 'rate_limited'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const MEMORY_KINDS = ['fact', 'decision', 'rule', 'mistake', 'note'] as const;
export const MemoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const TRUST_LEVELS = ['verified', 'approved', 'proposed', 'stale', 'rejected'] as const;
export const TrustSchema = z.enum(TRUST_LEVELS);
export type Trust = (typeof TRUST_LEVELS)[number];

export const MEMORY_STATUSES = ['active', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const SOURCE_TYPES = ['user', 'agent', 'code', 'system'] as const;
export const SourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = (typeof SOURCE_TYPES)[number];

export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'abandoned'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const INTENT_STATUSES = ['active', 'completed', 'abandoned', 'expired'] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const CONFLICT_KINDS = [
  'intent_overlap',
  'file_overlap',
  'contract_broken',
  'impact',
  'merge_conflict',
  'check_failed',
  'decision_contradiction',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = (typeof SEVERITIES)[number];

export const CONFLICT_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export const ConflictStatusSchema = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

export const DELIVERY_KINDS = [
  'impact',
  'conflict',
  'handoff',
  'message',
  'rule',
  'stale_memory',
  'review',
] as const;
export const DeliveryKindSchema = z.enum(DELIVERY_KINDS);
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export const DELIVERY_STATUSES = ['pending', 'delivered', 'acked', 'expired'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const HANDOFF_STATUSES = ['pending', 'claimed', 'completed', 'cancelled'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const CONTRACT_KINDS = [
  'file_exists',
  'pattern_present',
  'pattern_absent',
  'json_key',
  'export_present',
  'command',
] as const;
export const ContractKindSchema = z.enum(CONTRACT_KINDS);
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export const CONTRACT_STATES = ['unknown', 'passing', 'failing', 'error'] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];

export const RUN_KINDS = [
  'shadow_merge',
  'replay',
  'review',
  'contract_sweep',
  'bisect',
  'sentinel',
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  'queued',
  'running',
  'passed',
  'failed',
  'error',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Kinds of save: a moment Mindly demonstrably helped. Each kind has its own
 * trigger and confirmation rule in `engine/features/saves.ts`.
 */
export const SAVE_KINDS = [
  'impact_warned',
  'overlap_avoided',
  'rule_enforced',
  'mistake_avoided',
  'merge_conflict_early',
  'check_broken_early',
  'limit_handoff',
] as const;
export const SaveKindSchema = z.enum(SAVE_KINDS);
export type SaveKind = (typeof SAVE_KINDS)[number];

/**
 * `caught`: Mindly intervened; `confirmed`: evidence the problem was avoided (the only status that
 * counts); `expired`: no evidence in time; `rejected`: not a save (the problem happened anyway, its
 * conflict was dismissed, or the user said so).
 */
export const SAVE_STATUSES = ['caught', 'confirmed', 'expired', 'rejected'] as const;
export const SaveStatusSchema = z.enum(SAVE_STATUSES);
export type SaveStatus = (typeof SAVE_STATUSES)[number];

export const EVENT_TYPES = [
  'session.started',
  'session.ended',
  'session.idle',
  'session.rate_limited',
  'prompt.submitted',
  'tool.before',
  'tool.after',
  'file.changed',
  'memory.created',
  'memory.updated',
  'memory.stale',
  'memory.archived',
  'rule.captured',
  'task.created',
  'task.updated',
  'intent.declared',
  'intent.closed',
  'conflict.opened',
  'conflict.updated',
  'delivery.queued',
  'delivery.delivered',
  'delivery.acked',
  'handoff.created',
  'handoff.claimed',
  'contract.result',
  'context.served',
  'snapshot.created',
  'snapshot.restored',
  'run.started',
  'run.finished',
  'turn.completed',
  'save.caught',
  'save.confirmed',
  'save.rejected',
  'split.created',
  'split.merged',
  'split.aborted',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export interface Project {
  id: string;
  root: string;
  name: string;
  /** sha256 of the repository's `.mindly/config.json` the user trusted, or null if untrusted. */
  trustedConfigHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  agentKind: AgentKind;
  /** The agent's own session identifier (e.g. Claude Code `session_id`). */
  externalId: string;
  status: SessionStatus;
  label: string | null;
  branch: string | null;
  /** Absolute path of the working tree the agent runs in (may differ from project root). */
  worktree: string;
  currentTaskId: string | null;
  transcriptPath: string | null;
  startedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
}

export interface MemoryScope {
  /** Glob patterns relative to project root. Empty means the whole project. */
  paths: string[];
  /** Git branch the memory belongs to; null means all branches (the "main" memory branch). */
  branch: string | null;
}

export interface MemorySource {
  type: SourceType;
  sessionId: string | null;
  agentKind: AgentKind | null;
}

/** Agent kind recorded for rules imported from a repository's instruction files. Reserved. */
export const REPO_FILE_AGENT_KIND = 'repo-file';

/**
 * Source of rules imported from a repository's instruction files (AGENTS.md, CLAUDE.md, …). The
 * repository is untrusted until the user approves a rule, so these are stored like agent proposals
 * (never approved on creation), but no agent may edit them: only the user approves, edits or
 * rejects them.
 */
export const REPO_FILE_SOURCE: MemorySource = Object.freeze({
  type: 'agent',
  sessionId: null,
  agentKind: REPO_FILE_AGENT_KIND,
});

/** True for {@link REPO_FILE_SOURCE}. */
export function isRepoFileSource(source: MemorySource): boolean {
  return (
    source.type === 'agent' &&
    source.sessionId === null &&
    source.agentKind === REPO_FILE_AGENT_KIND
  );
}

export interface Memory {
  id: string;
  projectId: string;
  kind: MemoryKind;
  title: string;
  body: string;
  tags: string[];
  scope: MemoryScope;
  trust: Trust;
  status: MemoryStatus;
  source: MemorySource;
  /** Rules only: when true the PreToolUse hook may deny a tool call that violates the rule. */
  enforce: boolean;
  pinned: boolean;
  version: number;
  supersedesId: string | null;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt: number | null;
}

export interface MemoryVersion {
  memoryId: string;
  version: number;
  title: string;
  body: string;
  tags: string[];
  scope: MemoryScope;
  trust: Trust;
  status: MemoryStatus;
  changedBy: MemorySource;
  reason: string | null;
  createdAt: number;
}

export const EVIDENCE_TYPES = ['file', 'commit', 'test', 'event', 'url'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface MemoryEvidence {
  id: string;
  memoryId: string;
  type: EvidenceType;
  /** File path relative to project root, commit sha, event id, … */
  ref: string;
  /** Optional excerpt the memory relies on; its hash is used for self-healing checks. */
  excerpt: string | null;
  contentHash: string | null;
  createdAt: number;
  checkedAt: number | null;
  valid: boolean;
}

export interface TaskPlanStep {
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  ownerSessionId: string | null;
  parentId: string | null;
  plan: TaskPlanStep[];
  blockers: string[];
  createdAt: number;
  updatedAt: number;
}

export interface IntentTargets {
  files: string[];
  symbols: string[];
}

export interface Intent {
  id: string;
  projectId: string;
  sessionId: string;
  taskId: string | null;
  summary: string;
  targets: IntentTargets;
  status: IntentStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface FileChange {
  id: string;
  projectId: string;
  sessionId: string;
  path: string;
  tool: string;
  /** sha256 of normalised added lines, used to map current lines back to this change. */
  hunkHashes: string[];
  addedLines: number;
  removedLines: number;
  /** Event id of the prompt that triggered this turn, for provenance. */
  promptEventId: string | null;
  createdAt: number;
}

export interface Conflict {
  id: string;
  projectId: string;
  kind: ConflictKind;
  severity: Severity;
  status: ConflictStatus;
  title: string;
  detail: string;
  sessionIds: string[];
  paths: string[];
  /** Stable key so the same underlying problem is not reported twice. */
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface Delivery {
  id: string;
  projectId: string;
  /** Specific session to deliver to; null means "next session of `targetAgentKind`". */
  targetSessionId: string | null;
  targetAgentKind: AgentKind | null;
  kind: DeliveryKind;
  priority: number;
  title: string;
  body: string;
  status: DeliveryStatus;
  dedupeKey: string | null;
  sourceSessionId: string | null;
  createdAt: number;
  deliveredAt: number | null;
  ackedAt: number | null;
  expiresAt: number;
}

export interface Handoff {
  id: string;
  projectId: string;
  fromSessionId: string;
  toAgentKind: AgentKind | null;
  taskId: string | null;
  reason: 'manual' | 'rate_limit' | 'crash';
  summary: string;
  packet: HandoffPacket;
  status: HandoffStatus;
  claimedBySessionId: string | null;
  createdAt: number;
  claimedAt: number | null;
}

export interface HandoffPacket {
  goal: string;
  plan: TaskPlanStep[];
  filesChanged: string[];
  recentPrompts: string[];
  decisions: string[];
  blockers: string[];
  nextSteps: string[];
  branch: string | null;
  headCommit: string | null;
  /** Set on the brief of a split part (`mindly split`); absent on ordinary handoffs. */
  split?: HandoffSplitBrief;
}

/** What a split part's brief tells the agent that claims it. */
export interface HandoffSplitBrief {
  splitId: string;
  goal: string;
  partKey: string;
  title: string;
  owns: string[];
  reads: string[];
  dependsOn: string[];
  /** Shared contract items: `name — definition (owned by part key)`. */
  contract: string[];
  strict: boolean;
}

export interface ContractSpec {
  /** Project-relative path the check reads (not used by `command`). */
  path?: string;
  /** ECMAScript regex source for pattern checks. */
  pattern?: string;
  /** Dot path for `json_key`, e.g. `scripts.test`. */
  key?: string;
  /** Exported identifier for `export_present`. */
  symbol?: string;
  /** argv for `command` contracts; never run through a shell. */
  argv?: string[];
  timeoutSec?: number;
}

export interface Contract {
  id: string;
  projectId: string;
  memoryId: string;
  kind: ContractKind;
  spec: ContractSpec;
  /** For `command`: sha256 of the approved spec; the contract will not run if it changes. */
  approvedHash: string | null;
  state: ContractState;
  lastMessage: string | null;
  lastRunAt: number | null;
  createdAt: number;
}

export interface ContextItem {
  ref: string;
  kind: 'memory' | 'delivery' | 'task' | 'intent' | 'conflict' | 'handoff' | 'session';
  title: string;
  score: number;
  tokens: number;
  reason: string;
}

export interface ContextPacket {
  id: string;
  projectId: string;
  sessionId: string;
  trigger: 'session_start' | 'prompt' | 'pre_tool' | 'post_tool' | 'mcp';
  query: string | null;
  included: ContextItem[];
  omitted: ContextItem[];
  tokenBudget: number;
  tokensUsed: number;
  createdAt: number;
}

export interface Snapshot {
  id: string;
  projectId: string;
  label: string;
  /** Hidden ref under refs/mindly/snapshots/ capturing tracked + untracked work. */
  gitRef: string | null;
  commit: string | null;
  createdAt: number;
}

/**
 * Kinds of checkpoint (`mindly bisect`): `agent` holds exactly what one agent edit changed,
 * `outside` holds changes no agent edit explains (the user, a formatter, a shell command) found
 * by a full rescan, and `baseline` is the first checkpoint of a working tree.
 */
export const CHECKPOINT_KINDS = ['agent', 'outside', 'baseline'] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

/** Most paths one checkpoint lists (the tree itself holds every file). */
export const CHECKPOINT_MAX_PATHS = 50;

/**
 * A copy of a working tree as it was after one agent edit (or after changes made outside any
 * agent), stored as a git commit under `refs/mindly/steps/<worktree id>/<seq>`. Each checkpoint's
 * parent is the previous checkpoint of the same working tree, so one step's diff is
 * `git diff <parent> <commit>`.
 */
export interface Checkpoint {
  id: string;
  projectId: string;
  /** Absolute, symlink-resolved path of the working tree. */
  worktree: string;
  /** Step number, increasing per working tree; what `mindly bisect` shows and takes. */
  seq: number;
  commit: string;
  parentCommit: string | null;
  kind: CheckpointKind;
  /** The agent session that made the edit; null for `outside` and `baseline`. */
  sessionId: string | null;
  /** The `file_changes` row of the edit, when one was recorded. */
  fileChangeId: string | null;
  /** The `prompt.submitted` event of the turn that made the edit. */
  promptEventId: string | null;
  tool: string | null;
  /** Project-relative paths the step changed (at most {@link CHECKPOINT_MAX_PATHS}). */
  paths: string[];
  /** True when at least one checkpoint before this one was skipped, so it may hold several edits. */
  gap: boolean;
  createdAt: number;
}

/**
 * What the sentinel knows about one check in one working tree: `passing` since the newest step it
 * passed at, or `failing` since the first step it was seen failing (and, once `mindly bisect`
 * found it, the step that broke it).
 */
export const SENTINEL_CHECK_STATES = ['passing', 'failing'] as const;
export type SentinelCheckState = (typeof SENTINEL_CHECK_STATES)[number];

export interface SentinelCheck {
  /** sha256 of the check's argv; when the command changes, what was known about it is dropped. */
  argvHash: string;
  state: SentinelCheckState;
  /** Newest step the check passed at, or null when it never passed while watched. */
  goodSeq: number | null;
  /** Step the sentinel first saw failing (the newest step of that pass). */
  failingSeq: number | null;
  /** The step the bisect blamed, when it found one. */
  brokeAt: number | null;
  /** The agent session that made the blamed step, when it was one agent edit. */
  culpritSessionId: string | null;
  /** The `check_failed` conflict opened for this break, if any. */
  conflictId: string | null;
  /** Why nobody is blamed while failing, when that is the case. */
  note: string | null;
  /** When the check last changed state. */
  since: number;
}

/**
 * The sentinel's watch over one working tree: the newest step it checked and, per check, what it
 * knows. One row per (project, working tree).
 */
export interface SentinelWatch {
  projectId: string;
  /** Absolute, symlink-resolved path of the working tree (as in its checkpoints). */
  worktree: string;
  /** Newest step the checks ran at, or null before the first pass. */
  checkedSeq: number | null;
  checkedAt: number | null;
  /** Commit the warm scratch tree last ran the setup command at, or null. */
  setupCommit: string | null;
  /** Per check name. */
  checks: Record<string, SentinelCheck>;
  updatedAt: number;
}

export interface Run {
  id: string;
  projectId: string;
  kind: RunKind;
  status: RunStatus;
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

/** Records a save refers to, used to confirm or drop it (never shown). */
export interface SaveRefs {
  conflictId?: string;
  intentId?: string;
  ruleId?: string;
  memoryId?: string;
  /** Comparable key of the warned command (program and subcommand), redacted. */
  command?: string;
  /** Fingerprint of the warned command's normalized command line (never the text itself). */
  commandLine?: string;
  contractId?: string;
  handoffId?: string;
  deliveryId?: string;
}

export interface Save {
  id: string;
  projectId: string;
  kind: SaveKind;
  status: SaveStatus;
  /** One plain sentence with agent names; never paths or code. */
  title: string;
  /** The session that was helped first, then the other sessions involved. */
  sessionIds: string[];
  /** Project-relative paths involved (shown only in detail views, never on the share card). */
  paths: string[];
  /** Ids of the events that prove the intervention and its outcome, oldest first. */
  evidence: string[];
  /** Same underlying problem, same fingerprint: counted once. */
  fingerprint: string;
  refs: SaveRefs;
  createdAt: number;
  confirmedAt: number | null;
}

export interface MindlyEvent {
  seq: number;
  id: string;
  projectId: string;
  sessionId: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

/**
 * Whether a conflict should be listed under "Needs you": it is open (nobody has marked it seen)
 * and it is more than an FYI. Shared by the CLI, the daemon and Mission Control so they agree.
 */
export function conflictNeedsUser(c: Pick<Conflict, 'status' | 'severity'>): boolean {
  return c.status === 'open' && c.severity !== 'info';
}

// ---------------------------------------------------------------------------------------------
// Splits (`mindly split`): one goal divided into non-overlapping parts, each in its own worktree.
// ---------------------------------------------------------------------------------------------

export const SPLIT_STATUSES = ['active', 'merged', 'aborted'] as const;
export type SplitStatus = (typeof SPLIT_STATUSES)[number];

/** Minimum and maximum number of parts in a split plan. */
export const SPLIT_MIN_PARTS = 2;
export const SPLIT_MAX_PARTS = 6;

/** Part keys name branches and folders, so they are short lowercase slugs. */
export const SPLIT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const SplitGlob = z.string().trim().min(1).max(300);
const SplitKey = z.string().regex(SPLIT_KEY_RE, 'must be a short lowercase slug (a-z, 0-9, -)');

export const SplitPlanPartSchema = z.strictObject({
  key: SplitKey,
  title: z.string().trim().min(1).max(120),
  agent: AgentKindSchema,
  owns: z.array(SplitGlob).min(1).max(20),
  reads: z.array(SplitGlob).max(20).default([]),
  dependsOn: z.array(SplitKey).max(SPLIT_MAX_PARTS).default([]),
  brief: z.string().trim().min(1).max(4000),
});

export const SplitPlanContractSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  owner: SplitKey,
  definition: z.string().trim().min(1).max(2000),
});

/** A split plan, hand-written (`--plan`) or produced by a planning agent. Structure only. */
export const SplitPlanSchema = z.strictObject({
  goal: z.string().trim().min(1).max(500),
  parts: z.array(SplitPlanPartSchema).min(SPLIT_MIN_PARTS).max(SPLIT_MAX_PARTS),
  contract: z.array(SplitPlanContractSchema).max(20).default([]),
});
export type SplitPlan = z.infer<typeof SplitPlanSchema>;
export type SplitPlanPart = z.infer<typeof SplitPlanPartSchema>;
export type SplitPlanContract = z.infer<typeof SplitPlanContractSchema>;

/** A contract item as stored on the split, with the decision memory it became. */
export interface SplitContractItem extends SplitPlanContract {
  memoryId: string | null;
}

export interface Split {
  id: string;
  projectId: string;
  /** Short slug used in branch names (`mindly/<slug>/<key>`) and folder names. */
  slug: string;
  goal: string;
  status: SplitStatus;
  /** Parent task holding one child task per part. */
  taskId: string;
  /** Commit every part branch started from. */
  baseCommit: string;
  baseBranch: string | null;
  /** Writes to files owned by another part are denied instead of warned. */
  strict: boolean;
  /** Folder holding the part worktrees (`../<repo>.mindly`). */
  worktreeRoot: string;
  /** Branch `split merge` produced, once it ran. */
  integrationBranch: string | null;
  contract: SplitContractItem[];
  /** Agent kind that planned the split, or `plan-file` for a hand-written plan. */
  plannedBy: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface SplitPart {
  id: string;
  splitId: string;
  projectId: string;
  key: string;
  /** Position in the plan (0-based). */
  position: number;
  title: string;
  agentKind: AgentKind;
  owns: string[];
  reads: string[];
  dependsOn: string[];
  brief: string;
  /** Absolute path of the part's worktree. */
  worktree: string;
  branch: string;
  /** Child task of the split's task; its owner session is the agent working on the part. */
  taskId: string;
  handoffId: string | null;
  createdAt: number;
}
