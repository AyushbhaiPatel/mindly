/*
 * In-memory fixtures for `VITE_MINDLY_MOCK=1`. Implements the same MindlyClient and LiveFeed
 * interfaces as the real daemon client so the UI can be built and screenshotted without one.
 */
import { ApiError, type MindlyClient } from './api';
import type { LiveFactory } from './live';
import type {
  Conflict,
  ContextItem,
  ContextPacket,
  Contract,
  Delivery,
  EventType,
  Handoff,
  Intent,
  Memory,
  MemoryDetail,
  MemoryEvidence,
  MemoryKind,
  MemoryVersion,
  Overview,
  Project,
  Run,
  Session,
  Snapshot,
  MindlyEvent,
  Task,
  Trust,
} from './types';

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
let idCounter = 0x1a2b;
function uid(): string {
  idCounter += 1;
  const hex = (NOW + idCounter).toString(16).padStart(12, '0');
  const tail = idCounter.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(0, 3)}-a${tail.slice(3, 6)}-${tail.slice(0, 12)}`;
}

const P1 = uid();
const P2 = uid();

const projects: Project[] = [
  {
    id: P1,
    root: '/Users/dev/code/payments-api',
    name: 'payments-api',
    trustedConfigHash: 'b1946ac92492d2347c6235b4d2611184',
    createdAt: NOW - 30 * 24 * HOUR,
    updatedAt: NOW - 5 * MIN,
  },
  {
    id: P2,
    root: '/Users/dev/code/marketing-site',
    name: 'marketing-site',
    trustedConfigHash: null,
    createdAt: NOW - 3 * 24 * HOUR,
    updatedAt: NOW - 2 * HOUR,
  },
];

function session(
  projectId: string,
  agentKind: string,
  label: string,
  status: Session['status'],
  branch: string,
  startedAgo: number,
  seenAgo: number,
): Session {
  return {
    id: uid(),
    projectId,
    agentKind,
    externalId: uid(),
    status,
    label,
    branch,
    worktree: `${projects.find((p) => p.id === projectId)!.root}${branch === 'main' ? '' : `-wt/${label}`}`,
    currentTaskId: null,
    transcriptPath: null,
    startedAt: NOW - startedAgo,
    lastSeenAt: NOW - seenAgo,
    endedAt: status === 'ended' ? NOW - seenAgo : null,
  };
}

const sClaude = session(
  P1,
  'claude-code',
  'auth-refactor',
  'active',
  'feat/session-tokens',
  2 * HOUR,
  12_000,
);
const sCodex = session(
  P1,
  'codex',
  'billing-webhooks',
  'active',
  'feat/stripe-webhooks',
  90 * MIN,
  40_000,
);
const sCursor = session(P1, 'cursor', 'docs', 'idle', 'main', 4 * HOUR, 18 * MIN);
const sCodexOld = session(
  P1,
  'codex',
  'rate-limiter',
  'ended',
  'feat/rate-limit',
  6 * HOUR,
  70 * MIN,
);
const sP2Claude = session(P2, 'claude-code', 'landing', 'active', 'main', 30 * MIN, 50_000);
const sessions: Session[] = [sClaude, sCodex, sCursor, sCodexOld, sP2Claude];

function task(
  projectId: string,
  title: string,
  status: Task['status'],
  owner: Session | null,
  plan: [string, boolean][] = [],
  blockers: string[] = [],
): Task {
  return {
    id: uid(),
    projectId,
    title,
    description: '',
    status,
    ownerSessionId: owner?.id ?? null,
    parentId: null,
    plan: plan.map(([text, done]) => ({ text, done })),
    blockers,
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 20 * MIN,
  };
}

const tAuth = task(P1, 'Replace opaque session ids with signed tokens', 'in_progress', sClaude, [
  ['Add token signer in src/auth/tokens.ts', true],
  ['Migrate session middleware', false],
  ['Update login + refresh handlers', false],
]);
const tHooks = task(P1, 'Verify Stripe webhook signatures', 'in_progress', sCodex, [
  ['Add raw body middleware for /webhooks', true],
  ['Verify signature with endpoint secret', true],
  ['Idempotency keys for retries', false],
]);
const tRate = task(
  P1,
  'Per-tenant rate limiting',
  'blocked',
  sCodexOld,
  [
    ['Token bucket in Redis', true],
    ['Wire into API gateway middleware', false],
  ],
  ['Agent hit its usage limit'],
);
const tDocs = task(P1, 'Document webhook retry semantics', 'open', null);
const tLint = task(P1, 'Fix flaky invoice rounding test', 'done', sCursor);
sClaude.currentTaskId = tAuth.id;
sCodex.currentTaskId = tHooks.id;
sCodexOld.currentTaskId = tRate.id;
const tasks: Task[] = [
  tAuth,
  tHooks,
  tRate,
  tDocs,
  tLint,
  task(P2, 'Rebuild pricing page hero', 'in_progress', sP2Claude),
];

function intent(
  s: Session,
  t: Task | null,
  summary: string,
  files: string[],
  symbols: string[] = [],
): Intent {
  return {
    id: uid(),
    projectId: s.projectId,
    sessionId: s.id,
    taskId: t?.id ?? null,
    summary,
    targets: { files, symbols },
    status: 'active',
    createdAt: NOW - 14 * MIN,
    updatedAt: NOW - 2 * MIN,
    expiresAt: NOW + 20 * MIN,
  };
}

const intents: Intent[] = [
  intent(
    sClaude,
    tAuth,
    'Migrate session middleware to signed tokens',
    ['src/auth/session.ts', 'src/middleware/requireUser.ts'],
    ['requireUser'],
  ),
  intent(sCodex, tHooks, 'Attach tenant from webhook metadata', [
    'src/webhooks/stripe.ts',
    'src/auth/session.ts',
  ]),
  intent(sCodex, tHooks, 'Idempotency store', ['src/webhooks/idempotency.ts']),
  intent(sP2Claude, null, 'Pricing hero layout', ['app/pricing/page.tsx']),
];

let memVersion = 0;
function memory(
  projectId: string,
  kind: MemoryKind,
  trust: Trust,
  title: string,
  body: string,
  opts: Partial<Memory> & { from?: Session | null; paths?: string[]; branch?: string | null } = {},
): Memory {
  memVersion += 1;
  const { from, paths, branch, ...rest } = opts;
  return {
    id: uid(),
    projectId,
    kind,
    title,
    body,
    tags: [],
    scope: { paths: paths ?? [], branch: branch ?? null },
    trust,
    status: 'active',
    source: from
      ? { type: 'agent', sessionId: from.id, agentKind: from.agentKind }
      : { type: 'user', sessionId: null, agentKind: null },
    enforce: false,
    pinned: false,
    version: 1,
    supersedesId: null,
    createdAt: NOW - (memVersion * 7 + 30) * HOUR,
    updatedAt: NOW - memVersion * 37 * MIN,
    lastVerifiedAt: trust === 'verified' ? NOW - 25 * MIN : null,
    ...rest,
  };
}

const mPnpm = memory(
  P1,
  'rule',
  'approved',
  'Always use pnpm, never npm or yarn',
  'This repo is a pnpm workspace. Use `pnpm add`, `pnpm --filter <pkg>`; never commit package-lock.json or yarn.lock.',
  {
    enforce: true,
    pinned: true,
    tags: ['tooling'],
    version: 2,
  },
);
const mMoney = memory(
  P1,
  'fact',
  'verified',
  'Money is stored as integer cents',
  'All amounts in the `invoices` and `payments` tables are integer minor units (cents). Convert only at the API boundary with `formatMoney()`.',
  {
    tags: ['billing', 'db'],
    paths: ['src/billing/**', 'src/db/schema.ts'],
  },
);
const mWebhookRule = memory(
  P1,
  'rule',
  'proposed',
  'Webhook handlers must be idempotent',
  'Stripe retries deliveries for up to 3 days. Every handler under src/webhooks/ must look up the event id in `processed_events` before acting.',
  {
    from: sCodex,
    paths: ['src/webhooks/**'],
    tags: ['webhooks'],
  },
);
const mDecision = memory(
  P1,
  'decision',
  'proposed',
  'Session tokens use Ed25519 signatures',
  'Chose Ed25519 over HMAC so the edge workers can verify without the signing secret. Keys rotate weekly via KMS.',
  {
    from: sClaude,
    branch: 'feat/session-tokens',
    paths: ['src/auth/**'],
  },
);
const mStale = memory(
  P1,
  'fact',
  'stale',
  'requireUser() returns { user, tenantId }',
  'The middleware attaches `req.auth = { user, tenantId }`. Evidence changed in src/middleware/requireUser.ts.',
  {
    from: sCursor,
    paths: ['src/middleware/requireUser.ts'],
  },
);
const mMistake = memory(
  P1,
  'mistake',
  'approved',
  'Don’t mock the database in billing tests',
  'Mocked Prisma calls hid a rounding bug in invoice totals. Use the test container (`pnpm test:db`) for anything under src/billing.',
  {
    paths: ['src/billing/**', 'test/billing/**'],
  },
);
const mRejected = memory(
  P1,
  'note',
  'rejected',
  'Use moment.js for dates',
  'Suggested moment.js for timezone handling.',
  { from: sCodexOld },
);
const mNote = memory(
  P1,
  'note',
  'approved',
  'Staging deploys from the release/* branches',
  'CI deploys `release/*` to staging automatically; production needs a manual approval in the deploy workflow.',
  {
    tags: ['ci'],
  },
);
const mP2 = memory(
  P2,
  'rule',
  'approved',
  'Use next/image for every raster image',
  'Lighthouse budget requires optimised images; plain <img> tags fail the CI check.',
  {},
);
const memories: Memory[] = [
  mPnpm,
  mMoney,
  mWebhookRule,
  mDecision,
  mStale,
  mMistake,
  mRejected,
  mNote,
  mP2,
];

const versions = new Map<string, MemoryVersion[]>();
for (const m of memories) {
  const v1: MemoryVersion = {
    memoryId: m.id,
    version: 1,
    title: m.title,
    body: m.body,
    tags: m.tags,
    scope: m.scope,
    trust: m.source.type === 'user' ? 'approved' : 'proposed',
    status: 'active',
    changedBy: m.source,
    reason: 'created',
    createdAt: m.createdAt,
  };
  versions.set(m.id, [v1]);
}
versions.set(mPnpm.id, [
  {
    ...versions.get(mPnpm.id)![0]!,
    title: 'Use pnpm',
    body: 'Use pnpm for installs.',
    trust: 'proposed',
    changedBy: { type: 'agent', sessionId: sCursor.id, agentKind: 'cursor' },
    reason: 'captured from correction “no, we use pnpm”',
  },
  {
    ...versions.get(mPnpm.id)![0]!,
    version: 2,
    trust: 'approved',
    changedBy: { type: 'user', sessionId: null, agentKind: null },
    reason: 'approved and expanded by user',
    createdAt: mPnpm.updatedAt,
  },
]);
versions.set(mStale.id, [
  versions.get(mStale.id)![0]!,
  {
    ...versions.get(mStale.id)![0]!,
    version: 2,
    trust: 'stale',
    changedBy: { type: 'system', sessionId: null, agentKind: null },
    reason: 'evidence hash changed: src/middleware/requireUser.ts',
    createdAt: NOW - 9 * MIN,
  },
]);
mStale.version = 2;

const evidence: MemoryEvidence[] = [
  {
    id: uid(),
    memoryId: mMoney.id,
    type: 'file',
    ref: 'src/db/schema.ts',
    excerpt: 'amountCents: integer("amount_cents").notNull()',
    contentHash: '9f2c…',
    createdAt: NOW - 50 * HOUR,
    checkedAt: NOW - 25 * MIN,
    valid: true,
  },
  {
    id: uid(),
    memoryId: mMoney.id,
    type: 'test',
    ref: 'test/billing/money.test.ts',
    excerpt: null,
    contentHash: null,
    createdAt: NOW - 50 * HOUR,
    checkedAt: NOW - 25 * MIN,
    valid: true,
  },
  {
    id: uid(),
    memoryId: mStale.id,
    type: 'file',
    ref: 'src/middleware/requireUser.ts',
    excerpt: 'req.auth = { user, tenantId }',
    contentHash: '1c0e…',
    createdAt: NOW - 20 * HOUR,
    checkedAt: NOW - 9 * MIN,
    valid: false,
  },
  {
    id: uid(),
    memoryId: mDecision.id,
    type: 'commit',
    ref: '4be81d2',
    excerpt: null,
    contentHash: null,
    createdAt: NOW - 2 * HOUR,
    checkedAt: null,
    valid: true,
  },
];

const contracts: Contract[] = [
  {
    id: uid(),
    projectId: P1,
    memoryId: mMoney.id,
    kind: 'pattern_absent',
    spec: { path: 'src/billing/invoice.ts', pattern: 'parseFloat\\(' },
    approvedHash: null,
    state: 'passing',
    lastMessage: 'pattern not found',
    lastRunAt: NOW - 25 * MIN,
    createdAt: NOW - 40 * HOUR,
  },
  {
    id: uid(),
    projectId: P1,
    memoryId: mPnpm.id,
    kind: 'file_exists',
    spec: { path: 'pnpm-lock.yaml' },
    approvedHash: null,
    state: 'passing',
    lastMessage: null,
    lastRunAt: NOW - 3 * HOUR,
    createdAt: NOW - 70 * HOUR,
  },
  {
    id: uid(),
    projectId: P1,
    memoryId: mStale.id,
    kind: 'export_present',
    spec: { path: 'src/middleware/requireUser.ts', symbol: 'requireUser' },
    approvedHash: null,
    state: 'failing',
    lastMessage: 'export `requireUser` now returns Promise<AuthContext>',
    lastRunAt: NOW - 9 * MIN,
    createdAt: NOW - 20 * HOUR,
  },
];

function conflict(
  c: Partial<Conflict> & Pick<Conflict, 'kind' | 'severity' | 'title' | 'detail'>,
): Conflict {
  return {
    id: uid(),
    projectId: P1,
    status: 'open',
    sessionIds: [],
    paths: [],
    fingerprint: uid(),
    createdAt: NOW - 11 * MIN,
    updatedAt: NOW - 3 * MIN,
    resolvedAt: null,
    ...c,
  };
}

const conflicts: Conflict[] = [
  conflict({
    kind: 'intent_overlap',
    severity: 'critical',
    title: 'claude-code and codex are both editing src/auth/session.ts',
    detail:
      'claude-code is migrating the session middleware to signed tokens while codex is attaching tenant ids from webhook metadata in the same function (createSession).',
    sessionIds: [sClaude.id, sCodex.id],
    paths: ['src/auth/session.ts'],
  }),
  conflict({
    kind: 'contract_broken',
    severity: 'warning',
    title: 'Contract failing: requireUser() return shape changed',
    detail:
      'export `requireUser` now returns Promise<AuthContext>; 3 callers in src/routes still destructure { user, tenantId } synchronously.',
    sessionIds: [sClaude.id],
    paths: ['src/middleware/requireUser.ts', 'src/routes/invoices.ts'],
    createdAt: NOW - 9 * MIN,
  }),
  conflict({
    kind: 'impact',
    severity: 'info',
    title: 'Exported type `WebhookEvent` changed',
    detail: 'codex added a required field `tenantId`; cursor’s open docs task references it.',
    sessionIds: [sCodex.id, sCursor.id],
    paths: ['src/webhooks/types.ts'],
    status: 'acknowledged',
    createdAt: NOW - 50 * MIN,
  }),
];

const deliveries: Delivery[] = [
  {
    id: uid(),
    projectId: P1,
    targetSessionId: sCodex.id,
    targetAgentKind: null,
    kind: 'conflict',
    priority: 2,
    title: 'claude-code is editing createSession() too',
    body: 'Coordinate before changing the session shape.',
    status: 'pending',
    dedupeKey: null,
    sourceSessionId: sClaude.id,
    createdAt: NOW - 3 * MIN,
    deliveredAt: null,
    ackedAt: null,
    expiresAt: NOW + 4 * HOUR,
  },
  {
    id: uid(),
    projectId: P1,
    targetSessionId: sClaude.id,
    targetAgentKind: null,
    kind: 'impact',
    priority: 1,
    title: 'WebhookEvent gained required tenantId',
    body: 'src/webhooks/types.ts changed its exported surface.',
    status: 'delivered',
    dedupeKey: null,
    sourceSessionId: sCodex.id,
    createdAt: NOW - 40 * MIN,
    deliveredAt: NOW - 38 * MIN,
    ackedAt: null,
    expiresAt: NOW + 3 * HOUR,
  },
  {
    id: uid(),
    projectId: P1,
    targetSessionId: null,
    targetAgentKind: 'cursor',
    kind: 'rule',
    priority: 1,
    title: 'New rule: Always use pnpm',
    body: '',
    status: 'acked',
    dedupeKey: null,
    sourceSessionId: null,
    createdAt: NOW - 3 * HOUR,
    deliveredAt: NOW - 2 * HOUR,
    ackedAt: NOW - 2 * HOUR,
    expiresAt: NOW + HOUR,
  },
  {
    id: uid(),
    projectId: P1,
    targetSessionId: null,
    targetAgentKind: 'claude-code',
    kind: 'handoff',
    priority: 3,
    title: 'Handoff: Per-tenant rate limiting',
    body: '',
    status: 'pending',
    dedupeKey: null,
    sourceSessionId: sCodexOld.id,
    createdAt: NOW - 70 * MIN,
    deliveredAt: null,
    ackedAt: null,
    expiresAt: NOW + 20 * HOUR,
  },
];

const handoffs: Handoff[] = [
  {
    id: uid(),
    projectId: P1,
    fromSessionId: sCodexOld.id,
    toAgentKind: 'claude-code',
    taskId: tRate.id,
    reason: 'rate_limit',
    summary: 'Per-tenant rate limiting: bucket done, gateway wiring left',
    packet: {
      goal: 'Limit each tenant to 100 req/s with bursts of 200.',
      plan: tRate.plan,
      filesChanged: ['src/ratelimit/bucket.ts', 'src/ratelimit/redis.ts'],
      recentPrompts: ['use the existing redis client, not a new pool'],
      decisions: ['Token bucket stored as a Redis hash with Lua script'],
      blockers: [],
      nextSteps: [
        'Register middleware in src/gateway/index.ts',
        'Add 429 response with Retry-After',
      ],
      branch: 'feat/rate-limit',
      headCommit: 'a91f03c',
    },
    status: 'pending',
    claimedBySessionId: null,
    createdAt: NOW - 70 * MIN,
    claimedAt: null,
  },
];

const tail = (lines: string[]) => lines.join('\n');
const runs: Run[] = [
  {
    id: uid(),
    projectId: P1,
    kind: 'shadow_merge',
    status: 'failed',
    title: 'Shadow merge of 3 sessions',
    input: { sessionIds: [sClaude.id, sCodex.id, sCursor.id] },
    result: {
      sessionIds: [sClaude.id, sCodex.id, sCursor.id],
      mergedTree: null,
      conflictedPaths: ['src/auth/session.ts'],
      checks: [
        {
          name: 'typecheck',
          ok: false,
          exitCode: 2,
          durationMs: 8400,
          outputTail: tail([
            "src/routes/invoices.ts:41:11 - error TS2339: Property 'tenantId' does not exist on type 'Promise<AuthContext>'.",
            '',
            '41   const { user, tenantId } = requireUser(req);',
            '             ~~~~~~~~',
            '',
            'Found 3 errors in 2 files.',
          ]),
        },
        {
          name: 'test',
          ok: true,
          exitCode: 0,
          durationMs: 21_300,
          outputTail:
            ' Test Files  48 passed (48)\n      Tests  412 passed (412)\n   Duration  21.3s',
        },
      ],
    },
    startedAt: NOW - 4 * MIN,
    finishedAt: NOW - 3 * MIN,
    createdAt: NOW - 4 * MIN,
  },
  {
    id: uid(),
    projectId: P1,
    kind: 'review',
    status: 'passed',
    title: 'codex reviews claude-code: session tokens',
    input: { sessionId: sClaude.id, reviewer: 'codex' },
    result: {
      reviewer: 'codex',
      summary: 'Token signing is sound. Two issues worth fixing before merge.',
      findings: [
        {
          severity: 'critical',
          file: 'src/auth/tokens.ts',
          line: 58,
          message:
            'Token expiry is compared with `<=` against seconds while `exp` is set in milliseconds; tokens never expire.',
        },
        {
          severity: 'warning',
          file: 'src/auth/session.ts',
          line: 112,
          message:
            'Refresh path swallows verification errors and falls back to the cookie session.',
        },
        {
          severity: 'info',
          file: 'src/auth/tokens.ts',
          line: 12,
          message: 'Consider exporting the key id so edge workers can cache public keys.',
        },
      ],
    },
    startedAt: NOW - 34 * MIN,
    finishedAt: NOW - 29 * MIN,
    createdAt: NOW - 34 * MIN,
  },
  {
    id: uid(),
    projectId: P1,
    kind: 'replay',
    status: 'passed',
    title: 'Replay: “add pagination to GET /invoices”',
    input: {
      prompt: 'add cursor pagination to GET /invoices',
      agents: ['claude-code', 'codex'],
      baseCommit: '7d1e2aa',
    },
    result: {
      agents: [
        {
          agent: 'claude-code',
          status: 'passed',
          filesChanged: 4,
          addedLines: 128,
          removedLines: 17,
          checksPassed: 2,
          checksTotal: 2,
          durationMs: 182_000,
          costUsd: 0.41,
        },
        {
          agent: 'codex',
          status: 'failed',
          filesChanged: 3,
          addedLines: 96,
          removedLines: 9,
          checksPassed: 1,
          checksTotal: 2,
          durationMs: 141_000,
          costUsd: 0.27,
        },
      ],
    },
    startedAt: NOW - 5 * HOUR,
    finishedAt: NOW - 5 * HOUR + 4 * MIN,
    createdAt: NOW - 5 * HOUR,
  },
  {
    id: uid(),
    projectId: P1,
    kind: 'shadow_merge',
    status: 'passed',
    title: 'Shadow merge of 2 sessions',
    input: {},
    result: {
      conflictedPaths: [],
      checks: [
        { name: 'typecheck', ok: true, exitCode: 0, durationMs: 7900, outputTail: '' },
        {
          name: 'test',
          ok: true,
          exitCode: 0,
          durationMs: 20_100,
          outputTail: 'Tests  409 passed (409)',
        },
      ],
    },
    startedAt: NOW - 40 * MIN,
    finishedAt: NOW - 39 * MIN,
    createdAt: NOW - 40 * MIN,
  },
];

function item(
  ref: Memory | Task | Intent | Conflict | Delivery | Handoff,
  kind: ContextItem['kind'],
  score: number,
  tokens: number,
  reason: string,
): ContextItem {
  const title = 'title' in ref ? ref.title : 'summary' in ref ? ref.summary : '';
  return { ref: ref.id, kind, title, score, tokens, reason };
}

const packets: ContextPacket[] = [
  {
    id: uid(),
    projectId: P1,
    sessionId: sClaude.id,
    trigger: 'session_start',
    query: null,
    included: [
      item(mPnpm, 'memory', 0.98, 42, 'approved rule, pinned'),
      item(mMistake, 'memory', 0.71, 55, 'mistake, path scope matches src/**'),
      item(intents[1]!, 'intent', 0.88, 38, 'other session editing overlapping file'),
      item(tAuth, 'task', 0.93, 61, 'owned by this session'),
      item(mMoney, 'memory', 0.62, 47, 'verified fact, recent'),
    ],
    omitted: [
      item(mNote, 'memory', 0.31, 40, 'below score threshold'),
      item(mRejected, 'memory', 0, 18, 'rejected: never injected'),
      item(mWebhookRule, 'memory', 0.44, 52, 'path scope src/webhooks/** does not match'),
    ],
    tokenBudget: 1200,
    tokensUsed: 243,
    createdAt: NOW - 2 * HOUR,
  },
  {
    id: uid(),
    projectId: P1,
    sessionId: sClaude.id,
    trigger: 'pre_tool',
    query: 'Edit src/auth/session.ts',
    included: [
      item(conflicts[0]!, 'conflict', 0.97, 64, 'open critical conflict on target file'),
      item(mDecision, 'memory', 0.82, 58, 'branch feat/session-tokens, path match'),
      item(deliveries[1]!, 'delivery', 0.77, 33, 'pending impact notice'),
    ],
    omitted: [item(mStale, 'memory', 0.58, 44, 'stale: evidence changed')],
    tokenBudget: 600,
    tokensUsed: 155,
    createdAt: NOW - 3 * MIN,
  },
  {
    id: uid(),
    projectId: P1,
    sessionId: sCodex.id,
    trigger: 'prompt',
    query: 'verify the stripe signature before parsing the body',
    included: [
      item(
        mWebhookRule,
        'memory',
        0.91,
        52,
        'path scope src/webhooks/** matches, proposed by this agent',
      ),
      item(mPnpm, 'memory', 0.98, 42, 'approved rule, pinned'),
      item(tHooks, 'task', 0.9, 48, 'owned by this session'),
    ],
    omitted: [item(mMoney, 'memory', 0.39, 47, 'token budget exhausted')],
    tokenBudget: 400,
    tokensUsed: 142,
    createdAt: NOW - 16 * MIN,
  },
];

const snapshots: Snapshot[] = [
  {
    id: uid(),
    projectId: P1,
    label: 'before session-token migration',
    gitRef: 'refs/mindly/snapshots/0193a1',
    commit: '7d1e2aa',
    createdAt: NOW - 3 * HOUR,
  },
  {
    id: uid(),
    projectId: P1,
    label: 'nightly',
    gitRef: 'refs/mindly/snapshots/0193a0',
    commit: '52ce019',
    createdAt: NOW - 20 * HOUR,
  },
];

let seq = 0;
const events: MindlyEvent[] = [];
function emit(
  projectId: string,
  s: Session | null,
  type: EventType,
  payload: Record<string, unknown>,
  ago = 0,
): MindlyEvent {
  seq += 1;
  const ev: MindlyEvent = {
    seq,
    id: uid(),
    projectId,
    sessionId: s?.id ?? null,
    type,
    payload,
    createdAt: NOW - ago,
  };
  events.push(ev);
  return ev;
}
emit(P1, sCodexOld, 'session.started', { branch: 'feat/rate-limit' }, 6 * HOUR);
emit(P1, sCursor, 'session.started', { branch: 'main' }, 4 * HOUR);
emit(P1, sCursor, 'rule.captured', { title: 'Always use pnpm' }, 3 * HOUR);
emit(P1, sClaude, 'session.started', { branch: 'feat/session-tokens' }, 2 * HOUR);
emit(P1, sClaude, 'context.served', { items: 5 }, 2 * HOUR - 5000);
emit(P1, sCodex, 'session.started', { branch: 'feat/stripe-webhooks' }, 90 * MIN);
emit(P1, sCodexOld, 'session.rate_limited', {}, 70 * MIN);
emit(
  P1,
  sCodexOld,
  'handoff.created',
  { title: 'Per-tenant rate limiting', toAgentKind: 'claude-code' },
  70 * MIN - 2000,
);
emit(P1, sCodex, 'memory.created', { kind: 'rule', title: mWebhookRule.title }, 50 * MIN);
emit(P1, null, 'conflict.opened', { title: conflicts[2]!.title, severity: 'info' }, 50 * MIN);
emit(P1, null, 'run.finished', { kind: 'shadow_merge', status: 'passed' }, 39 * MIN);
emit(P1, sClaude, 'memory.created', { kind: 'decision', title: mDecision.title }, 30 * MIN);
emit(P1, null, 'run.finished', { kind: 'review', status: 'passed' }, 29 * MIN);
emit(P1, sCursor, 'session.idle', {}, 18 * MIN);
emit(
  P1,
  sCodex,
  'intent.declared',
  { summary: intents[1]!.summary, files: intents[1]!.targets.files },
  14 * MIN,
);
emit(
  P1,
  sClaude,
  'intent.declared',
  { summary: intents[0]!.summary, files: intents[0]!.targets.files },
  12 * MIN,
);
emit(P1, null, 'conflict.opened', { title: conflicts[0]!.title, severity: 'critical' }, 11 * MIN);
emit(
  P1,
  sClaude,
  'file.changed',
  { path: 'src/middleware/requireUser.ts', addedLines: 14, removedLines: 6 },
  10 * MIN,
);
emit(P1, null, 'memory.stale', { title: mStale.title }, 9 * MIN);
emit(P1, null, 'contract.result', { state: 'failing', title: 'requireUser export shape' }, 9 * MIN);
emit(P1, null, 'run.finished', { kind: 'shadow_merge', status: 'failed' }, 3 * MIN);
emit(
  P1,
  sCodex,
  'file.changed',
  { path: 'src/webhooks/stripe.ts', addedLines: 31, removedLines: 2 },
  2 * MIN,
);
emit(P1, sClaude, 'tool.after', { tool: 'Bash', summary: 'pnpm test auth' }, 50_000);
emit(P2, sP2Claude, 'session.started', { branch: 'main' }, 30 * MIN);
emit(P2, sP2Claude, 'intent.declared', { files: ['app/pricing/page.tsx'] }, 20 * MIN);

/* ------------------------------------------------------------------------------------------ */

type Listener = (projectId: string, evs: MindlyEvent[]) => void;
const listeners = new Set<Listener>();
function publish(
  projectId: string,
  s: Session | null,
  type: EventType,
  payload: Record<string, unknown>,
) {
  const ev = emit(projectId, s, type, payload);
  ev.createdAt = Date.now();
  for (const l of listeners) l(projectId, [ev]);
}

const delay = <T>(v: T, ms = 120 + Math.random() * 160): Promise<T> =>
  new Promise((r) => setTimeout(() => r(structuredClone(v)), ms));
const notFound = () =>
  Promise.reject(new ApiError(404, 'not_found', 'That item no longer exists.'));
const byProject = <T extends { projectId: string }>(xs: T[], id: string) =>
  xs.filter((x) => x.projectId === id);
const LIVE_STATUSES = new Set(['active', 'idle', 'rate_limited']);

function findMemory(id: string): Memory | undefined {
  return memories.find((m) => m.id === id);
}

function bumpMemory(m: Memory, reason: string, patch: Partial<Memory>) {
  Object.assign(m, patch, { version: m.version + 1, updatedAt: Date.now() });
  const list = versions.get(m.id) ?? [];
  list.push({
    memoryId: m.id,
    version: m.version,
    title: m.title,
    body: m.body,
    tags: m.tags,
    scope: m.scope,
    trust: m.trust,
    status: m.status,
    changedBy: { type: 'user', sessionId: null, agentKind: null },
    reason,
    createdAt: Date.now(),
  });
  versions.set(m.id, list);
  publish(m.projectId, null, 'memory.updated', { title: m.title });
}

function queueRun(
  projectId: string,
  kind: Run['kind'],
  title: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  finalStatus: Run['status'],
): Run {
  const run: Run = {
    id: uid(),
    projectId,
    kind,
    status: 'queued',
    title,
    input,
    result: null,
    startedAt: null,
    finishedAt: null,
    createdAt: Date.now(),
  };
  runs.unshift(run);
  setTimeout(() => {
    run.status = 'running';
    run.startedAt = Date.now();
    publish(projectId, null, 'run.started', { kind });
  }, 600);
  setTimeout(() => {
    run.status = finalStatus;
    run.finishedAt = Date.now();
    run.result = result;
    publish(projectId, null, 'run.finished', { kind, status: finalStatus });
  }, 3200);
  return run;
}

export function createMockClient(): MindlyClient {
  return {
    mock: true,
    health: () => delay({ ok: true as const, version: '0.1.0-mock' }),
    exchangeLogin: () => delay(undefined),
    logout: () => delay(undefined),
    projects: () => delay(projects),
    overview: (id) => {
      const project = projects.find((p) => p.id === id);
      if (!project) return notFound();
      const pm = byProject(memories, id);
      const counts = { verified: 0, approved: 0, proposed: 0, stale: 0, rejected: 0 } as Record<
        Trust,
        number
      >;
      for (const m of pm) counts[m.trust] += 1;
      const pc = byProject(conflicts, id).filter(
        (c) => c.status === 'open' || c.status === 'acknowledged',
      );
      const ov: Overview = {
        project,
        sessions: byProject(sessions, id).filter((s) => LIVE_STATUSES.has(s.status)),
        tasks: byProject(tasks, id).filter((t) =>
          ['open', 'in_progress', 'blocked'].includes(t.status),
        ),
        intents: byProject(intents, id).filter((i) => i.status === 'active'),
        conflicts: pc,
        memoryCounts: counts,
        pendingDeliveries: byProject(deliveries, id).filter((d) => d.status === 'pending').length,
        lastShadowMerge: byProject(runs, id).find((r) => r.kind === 'shadow_merge') ?? null,
        needsYou: {
          proposedRules: pm.filter(
            (m) => m.trust === 'proposed' && m.kind === 'rule' && m.status === 'active',
          ).length,
          proposedMemories: pm.filter(
            (m) => m.trust === 'proposed' && m.kind !== 'rule' && m.status === 'active',
          ).length,
          criticalConflicts: pc.filter((c) => c.severity === 'critical' && c.status === 'open')
            .length,
          pendingHandoffs: byProject(handoffs, id).filter((h) => h.status === 'pending').length,
        },
        lastSeq: seq,
      };
      return delay(ov);
    },
    sessions: (id, limit = 50) =>
      delay(
        [...byProject(sessions, id)].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, limit),
      ),
    events: (id, q = {}) => {
      let xs = byProject(events, id);
      if (q.afterSeq !== undefined) xs = xs.filter((e) => e.seq > q.afterSeq!);
      if (q.beforeSeq !== undefined) xs = xs.filter((e) => e.seq < q.beforeSeq!);
      if (q.types?.length) xs = xs.filter((e) => q.types!.includes(e.type));
      if (q.sessionId) xs = xs.filter((e) => e.sessionId === q.sessionId);
      xs = q.order === 'asc' ? xs : [...xs].reverse();
      return delay(xs.slice(0, q.limit ?? 100));
    },
    memories: (id, q = {}) => {
      let xs = byProject(memories, id);
      xs = xs.filter((m) => m.status === (q.status || 'active'));
      if (q.kind) xs = xs.filter((m) => m.kind === q.kind);
      if (q.trust) xs = xs.filter((m) => m.trust === q.trust);
      if (q.branch) xs = xs.filter((m) => m.scope.branch === q.branch);
      if (q.q) {
        const terms = q.q.toLowerCase().split(/\s+/).filter(Boolean);
        xs = xs.filter((m) =>
          terms.every((t) => `${m.title} ${m.body} ${m.tags.join(' ')}`.toLowerCase().includes(t)),
        );
      }
      return delay(
        [...xs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt),
      );
    },
    createMemory: (id, input) => {
      const m = memory(id, input.kind, 'approved', input.title, input.body, {
        tags: input.tags ?? [],
        paths: input.scopePaths ?? [],
        enforce: input.kind === 'rule' && !!input.enforce,
        pinned: !!input.pinned,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      memories.unshift(m);
      versions.set(m.id, [
        {
          memoryId: m.id,
          version: 1,
          title: m.title,
          body: m.body,
          tags: m.tags,
          scope: m.scope,
          trust: m.trust,
          status: m.status,
          changedBy: m.source,
          reason: 'created by user',
          createdAt: m.createdAt,
        },
      ]);
      publish(id, null, input.kind === 'rule' ? 'rule.captured' : 'memory.created', {
        kind: m.kind,
        title: m.title,
      });
      return delay(m);
    },
    memory: (id) => {
      const m = findMemory(id);
      if (!m) return notFound();
      const detail: MemoryDetail = {
        memory: m,
        versions: versions.get(id) ?? [],
        evidence: evidence.filter((e) => e.memoryId === id),
        contracts: contracts.filter((c) => c.memoryId === id),
        xray: packets.filter(
          (p) => p.included.some((i) => i.ref === id) || p.omitted.some((i) => i.ref === id),
        ),
      };
      return delay(detail);
    },
    updateMemory: (id, patch) => {
      const m = findMemory(id);
      if (!m) return notFound();
      const { scopePaths, ...rest } = patch;
      bumpMemory(m, 'edited by user', {
        ...rest,
        ...(scopePaths ? { scope: { ...m.scope, paths: scopePaths } } : {}),
      });
      return delay(m);
    },
    approveMemory: (id) => {
      const m = findMemory(id);
      if (!m) return notFound();
      bumpMemory(m, 'approved by user', { trust: 'approved' });
      return delay(m);
    },
    rejectMemory: (id) => {
      const m = findMemory(id);
      if (!m) return notFound();
      bumpMemory(m, 'rejected by user', { trust: 'rejected' });
      return delay(m);
    },
    archiveMemory: (id) => {
      const m = findMemory(id);
      if (!m) return notFound();
      bumpMemory(m, 'archived by user', { status: 'archived' });
      return delay(m);
    },
    deleteMemory: (id) => {
      const i = memories.findIndex((m) => m.id === id);
      if (i < 0) return notFound();
      const [m] = memories.splice(i, 1);
      publish(m!.projectId, null, 'memory.archived', { title: m!.title });
      return delay(undefined);
    },
    conflicts: (id, status) =>
      delay(byProject(conflicts, id).filter((c) => !status || c.status === status)),
    setConflictStatus: (id, status) => {
      const c = conflicts.find((x) => x.id === id);
      if (!c) return notFound();
      c.status = status;
      c.updatedAt = Date.now();
      if (status !== 'acknowledged') c.resolvedAt = Date.now();
      publish(c.projectId, null, 'conflict.updated', { title: c.title, status });
      return delay(c);
    },
    tasks: (id, status) =>
      delay(byProject(tasks, id).filter((t) => !status || t.status === status)),
    intents: (id) => delay(byProject(intents, id).filter((i) => i.status === 'active')),
    deliveries: (id, status) =>
      delay(byProject(deliveries, id).filter((d) => !status || d.status === status)),
    handoffs: (id) => delay(byProject(handoffs, id)),
    runs: (id, kind, limit = 50) =>
      delay(
        byProject(runs, id)
          .filter((r) => !kind || r.kind === kind)
          .slice(0, limit),
      ),
    shadowMerge: (id) => {
      const live = byProject(sessions, id).filter((s) => s.status === 'active');
      return delay(
        queueRun(
          id,
          'shadow_merge',
          `Shadow merge of ${live.length} sessions`,
          { sessionIds: live.map((s) => s.id) },
          {
            sessionIds: live.map((s) => s.id),
            conflictedPaths: [],
            checks: [
              { name: 'typecheck', ok: true, exitCode: 0, durationMs: 7600, outputTail: '' },
              {
                name: 'test',
                ok: true,
                exitCode: 0,
                durationMs: 19_800,
                outputTail: 'Tests  414 passed (414)',
              },
            ],
          },
          'passed',
        ),
      );
    },
    review: (id, sessionId, reviewer) => {
      const s = sessions.find((x) => x.id === sessionId);
      return delay(
        queueRun(
          id,
          'review',
          `${reviewer} reviews ${s?.agentKind ?? 'session'}${s?.label ? `: ${s.label}` : ''}`,
          { sessionId, reviewer },
          {
            reviewer,
            summary: 'No blocking issues found.',
            findings: [
              {
                severity: 'info',
                file: 'src/webhooks/stripe.ts',
                line: 22,
                message: 'Log the Stripe event id on signature failure to ease debugging.',
              },
            ],
          },
          'passed',
        ),
      );
    },
    replay: (id, input) =>
      delay(
        queueRun(
          id,
          'replay',
          `Replay: “${input.prompt.slice(0, 60)}”`,
          { ...input },
          {
            agents: input.agents.map((a, i) => ({
              agent: a,
              status: 'passed',
              filesChanged: 2 + i,
              addedLines: 40 + 25 * i,
              removedLines: 4 + i,
              checksPassed: 2,
              checksTotal: 2,
              durationMs: 90_000 + 30_000 * i,
            })),
          },
          'passed',
        ),
      ),
    xray: (sessionId, limit = 20) =>
      delay(
        packets
          .filter((p) => p.sessionId === sessionId)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit),
      ),
    provenance: (_id, file, line) => {
      if (!file.includes('auth') && !file.includes('webhook')) {
        return delay({ file, line, found: false });
      }
      const s = file.includes('webhook') ? sCodex : sClaude;
      return delay({
        file,
        line,
        found: true,
        sessionId: s.id,
        agentKind: s.agentKind,
        createdAt: NOW - 10 * MIN,
        tool: 'Edit',
        promptSummary:
          s === sClaude
            ? 'migrate requireUser to verify signed session tokens'
            : 'verify the stripe signature before parsing the body',
        memories: s === sClaude ? [mDecision, mStale] : [mWebhookRule],
      });
    },
    standup: (id) => {
      const p = projects.find((x) => x.id === id);
      return delay({
        digest: {},
        markdown: [
          `# Standup for ${p?.name ?? 'project'}`,
          '',
          '## Done',
          '- cursor fixed the flaky invoice rounding test',
          '- codex added signature verification for Stripe webhooks (2 of 3 steps)',
          '- Review: codex reviewed claude-code’s session tokens, 1 critical finding',
          '',
          '## In progress',
          '- claude-code: Replace opaque session ids with signed tokens (1/3)',
          '- codex: Verify Stripe webhook signatures (2/3)',
          '',
          '## Needs you',
          '- **Critical conflict**: both agents are editing `src/auth/session.ts`',
          '- 1 proposed rule and 1 proposed decision waiting for approval',
          '- Unclaimed handoff: Per-tenant rate limiting (codex hit its usage limit)',
          '',
          '## Memory',
          '1. 1 memory went stale (requireUser return shape)',
          '2. Shadow merge failed: typecheck, 3 errors',
        ].join('\n'),
      });
    },
    snapshots: (id) => delay(byProject(snapshots, id)),
    createSnapshot: (id, label) => {
      const s: Snapshot = {
        id: uid(),
        projectId: id,
        label,
        gitRef: `refs/mindly/snapshots/${uid().slice(0, 6)}`,
        commit: 'e3b0c44',
        createdAt: Date.now(),
      };
      snapshots.unshift(s);
      publish(id, null, 'snapshot.created', { label });
      return delay(s);
    },
    snapshotDiff: (id) => {
      if (!snapshots.some((s) => s.id === id)) return notFound();
      return delay({
        files: [
          { path: 'src/auth/session.ts', status: 'modified', added: 48, removed: 21 },
          { path: 'src/auth/tokens.ts', status: 'added', added: 112, removed: 0 },
          { path: 'src/webhooks/stripe.ts', status: 'modified', added: 31, removed: 2 },
        ],
        memories: { added: 2, changed: 2, removed: 0 },
        tasks: { added: 1, changed: 2, removed: 0 },
      });
    },
    restoreSnapshot: (id, branch) => {
      const s = snapshots.find((x) => x.id === id);
      if (!s) return notFound();
      const b = branch || `mindly/restore-${s.id.slice(-6)}`;
      publish(s.projectId, null, 'snapshot.restored', { branch: b });
      return delay({ branch: b, commit: s.commit });
    },
    trust: (id) => {
      const p = projects.find((x) => x.id === id);
      if (!p) return notFound();
      return delay({
        trusted: p.trustedConfigHash !== null,
        configHash: 'b1946ac92492d2347c6235b4d2611184',
        configError: null,
        checks:
          id === P1
            ? [
                { name: 'typecheck', argv: ['pnpm', 'typecheck'] },
                { name: 'test', argv: ['pnpm', 'vitest', 'run', '--reporter=dot'] },
                { name: 'lint', argv: ['pnpm', 'eslint', '.'] },
              ]
            : [{ name: 'build', argv: ['npx', 'next', 'build'] }],
      });
    },
    trustConfig: (id) => {
      const p = projects.find((x) => x.id === id);
      if (!p) return notFound();
      p.trustedConfigHash = 'b1946ac92492d2347c6235b4d2611184';
      return createMockClient().trust(id);
    },
  };
}

/** Fake live feed: replays mock mutations and adds ambient agent activity every few seconds. */
export const createMockLiveFeed: LiveFactory = (handlers) => {
  let projectId: string | null = null;
  const listener: Listener = (pid, evs) => {
    if (pid === projectId) handlers.onEvents(pid, evs);
  };
  listeners.add(listener);
  setTimeout(() => handlers.onStatus('live'), 300);
  const ambient: [Session, EventType, Record<string, unknown>][] = [
    [sClaude, 'tool.after', { tool: 'Read', path: 'src/auth/tokens.ts' }],
    [
      sCodex,
      'file.changed',
      { path: 'src/webhooks/idempotency.ts', addedLines: 22, removedLines: 0 },
    ],
    [sClaude, 'file.changed', { path: 'src/auth/session.ts', addedLines: 9, removedLines: 4 }],
    [sCodex, 'tool.after', { tool: 'Bash', summary: 'pnpm vitest run webhooks' }],
    [sClaude, 'context.served', { items: 3 }],
    [sCodex, 'intent.declared', { files: ['src/webhooks/idempotency.ts'] }],
  ];
  let i = 0;
  const timer = setInterval(() => {
    if (projectId !== P1) return;
    const [s, type, payload] = ambient[i % ambient.length]!;
    i += 1;
    s.lastSeenAt = Date.now();
    publish(P1, s, type, payload);
  }, 7000);
  return {
    subscribe(id) {
      projectId = id;
    },
    close() {
      listeners.delete(listener);
      clearInterval(timer);
    },
  };
};
