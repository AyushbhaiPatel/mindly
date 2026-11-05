import {
  CONFLICT_STATUSES,
  EVENT_TYPES,
  isUuid,
  MEMORY_KINDS,
  RUN_KINDS,
  TASK_STATUSES,
  TRUST_LEVELS,
  DELIVERY_STATUSES,
  SAVE_STATUSES,
  type EventType,
} from '@mindly/core';
import { isValidBranchName } from '@mindly/engine';
import { isRunnerAgentKind } from '@mindly/runners';
import { z } from 'zod';

/*
 * Zod schemas for every external input of the HTTP API (params, query strings, bodies).
 * Query values arrive as strings; an empty value is treated as absent.
 */

const blankToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);
/** Optional query parameter where `?x=` means "not given". */
function opt<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema.optional());
}
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const IdSchema = z.string().refine(isUuid, 'must be a UUID');
export const IdParams = z.object({ id: IdSchema });
export const ProjectParams = z.object({ projectId: IdSchema });

export const LimitQuery = z.object({ limit: opt(int(1, 500)) });

export const EventsQuery = z.object({
  afterSeq: opt(int(0, Number.MAX_SAFE_INTEGER)),
  beforeSeq: opt(int(0, Number.MAX_SAFE_INTEGER)),
  types: opt(
    z
      .string()
      .max(2000)
      .transform((s) =>
        s
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length))
      .transform((a) => a as EventType[]),
  ),
  sessionId: opt(IdSchema),
  limit: opt(int(1, 1000)),
  order: opt(z.enum(['asc', 'desc'])),
});

export const MemoriesQuery = z.object({
  q: opt(z.string().max(500)),
  kind: opt(z.enum(MEMORY_KINDS)),
  trust: opt(z.enum(TRUST_LEVELS)),
  branch: opt(z.string().max(200)),
  status: opt(z.enum(['active', 'archived'])),
  limit: opt(int(1, 500)),
});

const Tags = z.array(z.string().min(1).max(60)).max(20);
const ScopePaths = z.array(z.string().min(1).max(300)).max(20);

export const NewMemoryBody = z.strictObject({
  kind: z.enum(MEMORY_KINDS),
  title: z.string().trim().min(1).max(500),
  body: z.string().max(20_000),
  tags: Tags.optional(),
  scopePaths: ScopePaths.optional(),
  enforce: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

export const MemoryPatchBody = z
  .strictObject({
    title: z.string().trim().min(1).max(500).optional(),
    body: z.string().max(20_000).optional(),
    tags: Tags.optional(),
    scopePaths: ScopePaths.optional(),
    pinned: z.boolean().optional(),
    enforce: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'nothing to update');

export const ConflictsQuery = z.object({ status: opt(z.enum(CONFLICT_STATUSES)) });
export const ConflictStatusBody = z.strictObject({
  status: z.enum(['acknowledged', 'resolved', 'dismissed']),
});
export const TasksQuery = z.object({ status: opt(z.enum(TASK_STATUSES)) });
export const DeliveriesQuery = z.object({ status: opt(z.enum(DELIVERY_STATUSES)) });
export const RunsQuery = z.object({ kind: opt(z.enum(RUN_KINDS)), limit: opt(int(1, 200)) });

const RunnerAgent = z.string().refine(isRunnerAgentKind, 'unsupported agent');

export const ReviewBody = z.strictObject({ sessionId: IdSchema, reviewer: RunnerAgent });

export const ReplayBody = z.strictObject({
  prompt: z.string().trim().min(1).max(20_000),
  baseCommit: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/^~-]{0,199}$/, 'invalid revision')
    .refine((s) => !s.includes('..'), 'invalid revision')
    .optional(),
  agents: z
    .array(RunnerAgent)
    .min(1)
    .max(4)
    .refine((a) => new Set(a).size === a.length, 'agents must be distinct'),
});

export const XrayQuery = z.object({ limit: opt(int(1, 100)) });

export const ProvenanceQuery = z.object({
  file: z.string().min(1).max(1000),
  line: int(1, 10_000_000),
});

export const StandupQuery = z.object({ since: opt(int(0, Number.MAX_SAFE_INTEGER)) });

/** `GET …/saves`: `status` is one status or `all`; default confirmed and caught (pending). */
export const SavesQuery = z.object({
  since: opt(int(0, Number.MAX_SAFE_INTEGER)),
  status: opt(z.enum([...SAVE_STATUSES, 'all'])),
});

/** `GET …/saves/card.svg`: `details=1` adds the project name, sentences and files. */
export const SavesCardQuery = z.object({
  since: opt(int(0, Number.MAX_SAFE_INTEGER)),
  details: opt(z.enum(['0', '1'])),
});

export const SnapshotBody = z.strictObject({ label: z.string().trim().min(1).max(80) });

export const RestoreBody = z.strictObject({
  branch: z.string().refine(isValidBranchName, 'invalid branch name').optional(),
});

/** Body of `POST .../trust`: the config hash the user reviewed. */
export const TrustBody = z.strictObject({
  configHash: z.string().regex(/^[0-9a-f]{1,128}$/i, 'must be a hex hash'),
});

export const ExchangeBody = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) });

/** Messages a live-feed client may send. */
export const LiveClientMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('subscribe'),
    projectId: IdSchema,
    afterSeq: z.number().int().min(0).optional(),
  }),
  z.strictObject({ type: z.literal('pong') }),
]);
