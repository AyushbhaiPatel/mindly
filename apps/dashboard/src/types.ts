/*
 * Response shapes of the daemon API (see docs/api.md). Entity types come from @mindly/core as
 * types only; nothing from core is bundled into the browser build.
 */
import type {
  ConflictStatus,
  Conflict,
  ContextPacket,
  Contract,
  Intent,
  Memory,
  MemoryEvidence,
  MemoryKind,
  MemoryVersion,
  Project,
  Run,
  Save,
  SaveKind,
  RunStatus,
  Session,
  Split,
  SplitContractItem,
  SplitPart,
  Task,
  Trust,
} from '@mindly/core';

export type {
  AgentKind,
  Conflict,
  ConflictStatus,
  ContextItem,
  ContextPacket,
  Contract,
  Delivery,
  DeliveryKind,
  DeliveryStatus,
  EventType,
  Handoff,
  Intent,
  Memory,
  MemoryEvidence,
  MemoryKind,
  MemorySource,
  MemoryVersion,
  Project,
  Run,
  RunKind,
  RunStatus,
  Save,
  SaveKind,
  SaveStatus,
  Session,
  Severity,
  Snapshot,
  Split,
  SplitContractItem,
  SplitPart,
  SplitStatus,
  MindlyEvent,
  Task,
  TaskStatus,
  Trust,
} from '@mindly/core';

/** One part of a split as `GET /api/splits/:id` reports it. */
export interface SplitPartDetail {
  part: SplitPart;
  task: Task;
  session: Session | null;
  state: 'waiting' | 'working' | 'done' | 'blocked';
  filesChanged: string[];
  lastActivityAt: number | null;
  conflicts: Conflict[];
}

/** `GET /api/splits/:id`: the split, its parts, the contract and the latest merge check. */
export interface SplitDetail {
  split: Split;
  parts: SplitPartDetail[];
  contract: SplitContractItem[];
  mergeCheck: Run | null;
}

/* Duplicated as runtime values because core runtime code must never reach the bundle. */
export const TRUST_LEVELS: readonly Trust[] = [
  'verified',
  'approved',
  'proposed',
  'stale',
  'rejected',
];
export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'decision', 'rule', 'mistake', 'note'];
export const CONFLICT_ACTIONS: readonly Exclude<ConflictStatus, 'open'>[] = [
  'acknowledged',
  'resolved',
  'dismissed',
];

/** `GET /api/projects/:id/saves`: confirmed totals of the period and the saves themselves. */
export interface SavesResult {
  since: number;
  summary: {
    total: number;
    byKind: Partial<Record<SaveKind, number>>;
    byAgent: Record<string, number>;
  };
  saves: Save[];
}

export interface Health {
  ok: true;
  version: string;
}

export interface Overview {
  project: Project;
  sessions: Session[];
  tasks: Task[];
  intents: Intent[];
  conflicts: Conflict[];
  memoryCounts: Record<Trust, number>;
  pendingDeliveries: number;
  lastShadowMerge: Run | null;
  needsYou: {
    proposedRules: number;
    proposedMemories: number;
    criticalConflicts: number;
    /** Open conflicts that are more than FYI (same rule as `conflictNeedsUser` in core). */
    openConflicts: number;
    pendingHandoffs: number;
    /** Parts of the active split whose task is blocked. */
    blockedParts: number;
    /** 1 when the active split's latest merge check failed or could not run. */
    failedMergeChecks: number;
  };
  /** The active split, if any: what of it needs the user. */
  split: {
    id: string;
    goal: string;
    blockedParts: { key: string; title: string }[];
    mergeCheck: { runId: string; status: RunStatus; conflictedPaths: string[] } | null;
  } | null;
  lastSeq: number;
}

export interface MemoryDetail {
  memory: Memory;
  versions: MemoryVersion[];
  evidence: MemoryEvidence[];
  contracts: Contract[];
  xray: ContextPacket[];
}

export interface MemoryQuery {
  q?: string;
  kind?: MemoryKind | '';
  trust?: Trust | '';
  branch?: string;
  status?: 'active' | 'archived' | '';
  limit?: number;
}

export interface NewMemoryInput {
  kind: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  scopePaths?: string[];
  enforce?: boolean;
  pinned?: boolean;
}

export interface MemoryPatch {
  title?: string;
  body?: string;
  tags?: string[];
  scopePaths?: string[];
  pinned?: boolean;
  enforce?: boolean;
}

export interface EventQuery {
  afterSeq?: number;
  beforeSeq?: number;
  types?: string[];
  sessionId?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

/**
 * The contract leaves provenance, snapshot diff and restore results loosely specified, so these
 * are best-effort shapes; the UI renders unknown fields as plain JSON text.
 */
export interface ProvenanceResult {
  file?: string;
  line?: number;
  found?: boolean;
  sessionId?: string | null;
  agentKind?: string | null;
  createdAt?: number | null;
  tool?: string | null;
  promptSummary?: string | null;
  memories?: Memory[];
  [key: string]: unknown;
}

export interface StandupResult {
  digest: unknown;
  markdown: string;
}

export interface SnapshotDiff {
  files?: { path: string; status?: string; added?: number; removed?: number }[];
  memories?: { added?: number; changed?: number; removed?: number };
  tasks?: { added?: number; changed?: number; removed?: number };
  [key: string]: unknown;
}

export interface RestoreResult {
  branch?: string;
  [key: string]: unknown;
}

export interface TrustStatus {
  trusted: boolean;
  configHash: string | null;
  configError: string | null;
  checks: { name: string; argv: string[] }[];
}

export interface ReplayInput {
  prompt: string;
  baseCommit?: string;
  agents: string[];
}
