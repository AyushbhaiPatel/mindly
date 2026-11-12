# Mindly daemon API (v1)

Local-only HTTP + WebSocket API served by `apps/daemon` on `127.0.0.1:<port>` (default 7878, see
`UserConfig.daemon.port`; port 0 = random, the chosen port is written to `$MINDLY_HOME/daemon.json`
as `{ pid, port, startedAt, version }` with mode 0600). It backs the Mission Control dashboard and
the CLI. All bodies are JSON (`application/json`, max 256 KB). All ids are UUIDv7 strings.

## Authentication

- **CLI**: `Authorization: Bearer <token>` where token = contents of `$MINDLY_HOME/daemon.token`
  (32 random bytes, base64url, mode 0600, created on first start). Constant-time comparison.
- **Dashboard**: `mindly dashboard` asks the daemon for a one-time login code
  (`POST /api/auth/codes` with the bearer token → `{ code, expiresAt }`, 60 s, single use) and opens
  `http://127.0.0.1:<port>/#login=<code>`. The SPA reads the fragment, removes it from the URL with
  `history.replaceState`, and calls `POST /api/auth/exchange { code }` → sets cookie
  `mindly_session` (`HttpOnly; SameSite=Strict; Path=/`; random 32 bytes; 12 h; in-memory server-side
  session table). `POST /api/auth/logout` clears it.
- Every request must have `Host` equal to `127.0.0.1:<port>` or `localhost:<port>` → else 421.
- State-changing requests (POST/PATCH/DELETE) authenticated by cookie must carry
  `Origin: http://127.0.0.1:<port>` (or `localhost`) and header `X-Mindly-CSRF: 1` → else 403.
- WebSocket upgrade requires a valid cookie or bearer token and a matching `Origin` (cookie case).
- Unauthenticated: `GET /api/health`, static dashboard assets, `POST /api/auth/exchange`.
- Any request that carries an `Origin` header must carry an allowed one (else 403), whatever the
  authentication. `POST /api/auth/exchange` also needs `X-Mindly-CSRF: 1`.
- `POST /api/auth/codes` is only honoured for the bearer token (403 for a cookie session).
  `POST /api/auth/exchange` answers `{ ok: true, expiresAt }` plus the cookie, or 401 for an
  unknown, expired or already used code. `POST /api/auth/logout` answers 204.
- Request bodies must be `application/json` (any other content type is a 400); an empty body is
  treated as `{}`. Unknown body keys are rejected.

## Errors

`{ "error": { "code": "<ErrorCode from @mindly/core>", "message": "..." } }` with status
400 invalid_input/path_outside_project · 401 unauthenticated · 403 forbidden/untrusted_project ·
404 not_found · 409 conflict · 413 too_large · 421 bad_host · 500 internal (generic message only) ·
503 unavailable (e.g. restoring a snapshot that has no git ref) · 504 timeout.

## Endpoints

| Method | Path                                                                             | Response                                                                                                          |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                                                                    | `{ ok: true, version }`                                                                                           |
| GET    | `/api/projects`                                                                  | `Project[]`                                                                                                       |
| GET    | `/api/projects/:projectId/overview`                                              | `Overview` (below)                                                                                                |
| GET    | `/api/projects/:projectId/sessions?limit`                                        | `Session[]` (most recent first)                                                                                   |
| GET    | `/api/projects/:projectId/events?afterSeq&beforeSeq&types&sessionId&limit&order` | `MindlyEvent[]` (`types` comma-separated)                                                                         |
| GET    | `/api/projects/:projectId/memories?q&kind&trust&branch&status&limit`             | `Memory[]` (`q` uses FTS search)                                                                                  |
| POST   | `/api/projects/:projectId/memories`                                              | create user memory `{ kind, title, body, tags?, scopePaths?, enforce?, pinned? }` → `Memory`                      |
| GET    | `/api/memories/:id`                                                              | `{ memory, versions: MemoryVersion[], evidence: MemoryEvidence[], contracts: Contract[], xray: ContextPacket[] }` |
| PATCH  | `/api/memories/:id`                                                              | `{ title?, body?, tags?, scopePaths?, pinned?, enforce? }` → `Memory`                                             |
| POST   | `/api/memories/:id/approve` · `/reject` · `/archive`                             | `Memory`                                                                                                          |
| DELETE | `/api/memories/:id`                                                              | hard delete → `204`                                                                                               |
| GET    | `/api/projects/:projectId/conflicts?status`                                      | `Conflict[]`                                                                                                      |
| POST   | `/api/conflicts/:id/status`                                                      | `{ status: 'acknowledged' \| 'resolved' \| 'dismissed' }` → `Conflict`                                            |
| GET    | `/api/projects/:projectId/tasks?status`                                          | `Task[]`                                                                                                          |
| GET    | `/api/projects/:projectId/intents`                                               | active `Intent[]`                                                                                                 |
| GET    | `/api/projects/:projectId/deliveries?status`                                     | `Delivery[]`                                                                                                      |
| GET    | `/api/projects/:projectId/handoffs`                                              | `Handoff[]`                                                                                                       |
| GET    | `/api/projects/:projectId/splits?status&limit`                                   | `Split[]` (newest first)                                                                                          |
| GET    | `/api/splits/:id`                                                                | `SplitStatus` (below)                                                                                             |
| GET    | `/api/projects/:projectId/runs?kind&limit`                                       | `Run[]`                                                                                                           |
| POST   | `/api/projects/:projectId/shadow-merge`                                          | queue a shadow merge → `Run` (202)                                                                                |
| POST   | `/api/projects/:projectId/review`                                                | `{ sessionId, reviewer }` queue cross-agent review → `Run` (202)                                                  |
| POST   | `/api/projects/:projectId/replay`                                                | `{ prompt, baseCommit?, agents: string[] }` → `Run` (202)                                                         |
| GET    | `/api/sessions/:id/xray?limit`                                                   | `ContextPacket[]`                                                                                                 |
| GET    | `/api/projects/:projectId/provenance?file&line`                                  | provenance result (`ProvenanceService.why`)                                                                       |
| GET    | `/api/projects/:projectId/standup?since`                                         | `{ digest, markdown }`                                                                                            |
| GET    | `/api/projects/:projectId/saves?since&status`                                    | `SavesResult` (below)                                                                                             |
| POST   | `/api/saves/:id/reject`                                                          | "not a save": removes it from every total → `Save`; 404 if unknown                                                |
| GET    | `/api/projects/:projectId/saves/card.svg?since&details`                          | the share card as `image/svg+xml` (below)                                                                         |
| GET    | `/api/projects/:projectId/track?since&area&agent&minEdits`                       | `TrackReport` (below); read-only                                                                                  |
| GET    | `/api/projects/:projectId/sentinel`                                              | `SentinelStatus` (below); read-only                                                                               |
| GET    | `/api/projects/:projectId/snapshots`                                             | `Snapshot[]`                                                                                                      |
| POST   | `/api/projects/:projectId/snapshots`                                             | `{ label }` → `Snapshot`                                                                                          |
| GET    | `/api/snapshots/:id/diff`                                                        | snapshot diff                                                                                                     |
| POST   | `/api/snapshots/:id/restore`                                                     | `{ branch? }` → result                                                                                            |
| GET    | `/api/projects/:projectId/trust`                                                 | `{ trusted, configHash, configError, checks: {name, argv}[] }`                                                    |
| POST   | `/api/projects/:projectId/trust`                                                 | `{ configHash }` (the hash the user reviewed) → trust that config → same shape; 409 if the file changed           |

`Overview`:

```ts
{
  project: Project;
  sessions: Session[];            // live (active/idle/rate_limited, seen in last 30 min)
  tasks: Task[];                  // open/in_progress/blocked
  intents: Intent[];
  conflicts: Conflict[];          // open/acknowledged
  memoryCounts: Record<Trust, number>;
  pendingDeliveries: number;
  lastShadowMerge: Run | null;
  needsYou: { proposedRules: number; proposedMemories: number; criticalConflicts: number; openConflicts: number; pendingHandoffs: number; blockedParts: number; failedMergeChecks: number };
                                  // pendingHandoffs leaves out split briefs (they wait for a session in their worktree)
  split: {                        // the active split, or null
    id: string; goal: string;
    blockedParts: { key: string; title: string }[];
    mergeCheck: { runId: string; status: RunStatus; conflictedPaths: string[] } | null;
  } | null;
  lastSeq: number;                // highest event seq, for the live feed
}
```

`SplitStatus` (`GET /api/splits/:id`; `Split` and `SplitPart` are the core entities):

```ts
{
  split: Split;                   // goal, slug, status: active | merged | aborted, baseCommit, strict, worktreeRoot, integrationBranch, contract
  parts: {
    part: SplitPart;              // key, title, agentKind, owns, reads, dependsOn, brief, worktree, branch, taskId
    task: Task;                   // the part's child task
    session: Session | null;      // the agent working on the part
    state: 'waiting' | 'working' | 'done' | 'blocked';
    filesChanged: string[];       // paths changed in the worktree since the split's base commit
    lastActivityAt: number | null;
    conflicts: Conflict[];        // open conflicts involving the part's session
  }[];
  contract: { name, owner, definition, memoryId }[];  // items still approved as decisions, with their current text
  mergeCheck: Run | null;         // latest shadow_merge run of this split (result below, with splitId/parts/merged)
}
```

### Result shapes

These are the shapes the dashboard (`apps/dashboard/src/format.ts`, `views/Insight.tsx`) reads.

`Run.result` by kind (`null` while queued or running):

```ts
// shadow_merge: passed | failed (conflicts or failing checks) | cancelled (< 2 live worktrees) | error
{
  clean: boolean;
  conflictedPaths: string[];
  conflicts: { sessionIds: string[]; paths: string[] }[];
  checks: {
    name: string;
    ok: boolean;
    status: 'pass' | 'fail' | 'timeout' | 'error';
    exitCode: number | null;
    durationMs: number;
    outputTail: string; // redacted, last 4000 characters
  }[];
  checksSkipped: 'untrusted' | 'none_configured' | 'conflicts' | null;
  sessionIds: string[];
  merged: string[];
  skipped: string[];
  mergedTree: string | null;
  note?: string;
}
// review: passed (review completed) | error
{
  reviewer: string;
  sessionId: string;
  summary: string;
  findings: { severity: 'critical' | 'warning' | 'info'; file: string | null; line: number | null; message: string }[];
  parsed: boolean; status: string; redactions: number; diffTruncated: boolean;
  durationMs: number; costUsd: number | null; error: string | null;
}
// replay: passed (every agent completed) | failed | error
{
  baseCommit: string;
  checksSkipped: 'untrusted' | null;
  agents: {
    agent: string; status: string; filesChanged: number; addedLines: number; removedLines: number;
    checksPassed: number | null; checksTotal: number | null; durationMs: number; costUsd: number | null;
    summary: string; shortstat: string; resultRef: string | null; resultCommit: string | null; error: string | null;
  }[];
}
// contract_sweep (approved command contracts of trusted projects)
{ contracts: { contractId: string; memoryId: string; state: string; exitCode: number | null; durationMs: number; outputTail: string }[] }
// bisect: passed (found) | failed (anything else) | cancelled | error. `input.trigger` is
// 'sentinel' (with `input.check`) for the bisects the sentinel starts.
{
  status: 'found' | 'unreliable' | 'inconclusive' | 'good_fails' | 'bad_passes' | 'good_skipped' | 'bad_skipped' | 'cancelled';
  checks: StepCheck[]; firstBad: number | null; lastGood: number | null;
  blame: { checkpointId: string; kind: string; gap: boolean; sessionId: string | null; paths: string[]; at: number } | null;
  flaky: boolean; skipped: number[]; output: string | null; runs: number; durationMs: number; mistakeId: string | null;
}
// sentinel: passed (every check passes) | failed (one fails) | error (setup failed, nothing could
// run, or an internal error) | cancelled. Input: { trigger: 'schedule' | 'user', worktree, step, checks: string[] }
{
  step: number;
  setupFailed?: boolean;
  error?: string;
  checks: SentinelCheckReport[]; // as in SentinelStatus below
}
```

Provenance (`GET …/provenance`): `{ file, line, text, found, sessionId, agentKind, createdAt, tool,
promptSummary, memories: Memory[], changes: ProvenanceChange[] }`. The flat fields describe the
most recent recorded edit (`found: false` and nulls when none is on record).

Snapshot diff: `{ snapshot, memories: { added, changed, removed }, tasks: { added, changed, removed },
conflicts: { opened, closed }, files?: { path, status: 'changed', added?, removed? }[], details }`.
The counts are numbers, `details` holds the engine's full lists, and `files` compares the snapshot
commit with the project's current working tree (omitted when git cannot answer).

Restore: the engine's `RestoreResult` `{ snapshot, memoriesRestored, memoriesArchived,
memoriesMissing, tasksRestored, branch: string | null }`.

### Saves

A save is a time Mindly demonstrably helped, with the events that prove it. Saves are recorded and settled
by Mindly itself from the event log; the API only reads them and lets the user reject one. There is
no endpoint (and no MCP tool) that creates, confirms or edits a save.

```ts
type SaveKind =
  | 'impact_warned'
  | 'overlap_avoided'
  | 'rule_enforced'
  | 'mistake_avoided'
  | 'merge_conflict_early'
  | 'check_broken_early'
  | 'limit_handoff';
type SaveStatus = 'caught' | 'confirmed' | 'expired' | 'rejected';

interface Save {
  id: string;
  projectId: string;
  kind: SaveKind;
  status: SaveStatus; // caught: waiting for evidence; only confirmed saves count
  title: string; // plain sentence, no code
  sessionIds: string[]; // the helped session first
  paths: string[];
  evidence: string[]; // ids of the events that prove it (the intervention first)
  fingerprint: string; // one underlying problem is one save
  refs: {
    conflictId?;
    intentId?;
    ruleId?;
    memoryId?;
    command?;
    contractId?;
    handoffId?;
    deliveryId?;
  };
  createdAt: number; // when it was caught (ms)
  confirmedAt: number | null;
}

// GET …/saves: since defaults to 7 days ago; status is one SaveStatus or `all`
// (default: confirmed and caught). saves are newest first, at most 500.
interface SavesResult {
  since: number;
  summary: {
    total: number; // confirmed saves since `since`
    byKind: Partial<Record<SaveKind, number>>; // confirmed only
    byAgent: Record<string, number>; // agent kind of the helped session
  };
  saves: Save[];
}
```

A fingerprint names the underlying problem (the overlapping intent, the rule and paths, the
conflict, the command and pitfall, …) and is decided once: after a problem's save was confirmed,
expired or rejected, the same problem never creates another save, so a rejected first attempt
also blocks later ones. This under-counts rather than inflates.

`GET …/saves/card.svg` renders the confirmed saves since `since` (default 7 days ago) as a 1200×630
SVG: counts by kind and agent names only. `details=1` adds the project name and each save's sentence
and files; without it the card contains no project name, path or code. The card is taller than 630
when it shows details or all seven kinds of save.

### Track record

`GET …/track` is the track record of `mindly track`: per folder (area) and agent, counts of edits
and of outcomes stored evidence ties to exactly one session of that agent. It only reads; line
survival is computed by the daemon's background job. `since` is a duration as in the CLI (`90m`,
`24h`, `30d`, `12w`; default `30d`, at most 3650 days), `area` a folder prefix at any depth (or
`(root)`), `agent` an agent kind, `minEdits` overrides `track.minEdits`. Unknown projects give 404,
malformed values 400.

```ts
interface TrackRate {
  count: number;
  of: number; // denominator: edits in the area (tracked lines for `kept`)
  rate: number | null; // null below the minimum data, and when count > of
  interval: { low: number; high: number } | null; // 95% Wilson score interval; null when rate is
}

interface TrackReport {
  window: { since: string; from: number; to: number };
  areaDepth: number; // track.areaDepth (1-4)
  filter: { area: string | null; agent: string | null };
  minimum: { edits: number; sessions: number };
  totals: { agents: number; edits: number; areas: number }; // areas: all, before the 200 cap
  areas: {
    area: string; // `src/api`, or `(root)`; most edits first, at most 200
    edits: number;
    agents: {
      agent: string;
      edits: number;
      sessions: number; // sessions with at least one edit in the area
      linesAdded: number;
      linesRemoved: number;
      enoughData: boolean; // at least minimum.edits and minimum.sessions
      breakages: TrackRate; // bisect + contracts + mergeChecks
      breakageSessions: number; // distinct sessions behind the breakages
      bisect: TrackRate; // reliable bisect results whose first bad step is one edit of this agent (once per step)
      contracts: TrackRate; // contract breaks right after its edit in the project's own checkout
      mergeChecks: TrackRate; // merge conflicts (shadow merge, split merge check) naming only its session
      ruleAttempts: TrackRate; // sessions an enforced rule stopped that did not write those files afterwards, once per session and rule; a count only (rate and interval always null)
      kept: TrackRate; // tracked lines (added or changed) still present, of those from edits at least 7 days old
      keptFrom: { edits: number; sessions: number }; // checked edits behind `kept`; its own minimum
    }[];
    // pairs on breakages whose intervals do not overlap, among agents with enough data, when the
    // higher count comes from at least 2 sessions; empty: no clear difference
    clearDifference: {
      measure: 'breakages';
      better: { agent: string; count: number; of: number };
      worse: { agent: string; count: number; of: number };
    }[];
  }[];
  usageLimits: { agent: string; limited: number; sessions: number }[]; // per agent, not per area
  survival: { pending: number; checkedNow: number }; // edits in the window still waiting for their check
  truncated: boolean; // a query hit its row limit: the record is partial
  // set when the window is longer than the kept event log (retention.eventsDays): when the kept
  // events start. Outcomes read from events before it are missing, so their counts are too low
  // (equal to window.to when no event of the window is kept)
  eventsSince: number | null;
}
```

Outcomes are counted in the window by when they happened: a bisect blame at the time of the
blamed edit, a conflict at each time it opened, with the sessions recorded then. Dismissed
conflicts do not count. Outcomes naming several sessions, `outside` steps and gap steps count for
nobody, and failing checks are not counted (a merge check cannot tell whose change made one fail).

### Sentinel

`GET …/sentinel` is what `mindly sentinel` shows: whether it is on, what it would run, and per
watched checkout what is known about each check. It only reads; passes run in the daemon's job or
with `mindly sentinel run`.

```ts
interface SentinelStatus {
  enabled: boolean; // sentinel.enabled
  readiness: {
    ready: boolean;
    reason:
      | 'no_git'
      | 'checkpoints_off'
      | 'config_error'
      | 'no_checks'
      | 'unknown_checks'
      | 'untrusted'
      | null;
    checks: { name: string; argv: string[]; timeoutSec: number }[];
    setup: { name: 'setup'; argv: string[]; timeoutSec: number } | null;
    unknown: string[]; // names in sentinel.checks that are not checks of the project
  };
  watches: {
    worktree: string;
    latestSeq: number | null; // newest step of the checkout
    checkedSeq: number | null; // newest step the checks ran at
    checkedAt: number | null;
    pending: number; // steps since
    checks: {
      name: string;
      state: 'passing' | 'failing';
      goodSeq: number | null; // newest step it passed at
      failingSeq: number | null; // step it was first seen failing
      brokeAt: number | null; // the step the bisect blamed
      culpritSessionId: string | null;
      culprit: { sessionId: string; label: string; agentKind: string } | null;
      conflictId: string | null; // the `check_failed` conflict of this break
      note: string | null; // why nobody is blamed, when nobody is
      since: number;
      argvHash: string;
    }[];
  }[];
  recent: Run[]; // the last 10 sentinel runs
}

interface SentinelCheckReport {
  name: string;
  outcome: 'pass' | 'fail' | 'skip'; // at the step checked
  exitCode: number | null;
  durationMs: number;
  transition:
    | 'baseline_pass'
    | 'baseline_fail'
    | 'still_passing'
    | 'still_failing'
    | 'broke'
    | 'fixed'
    | 'flaky'
    | 'skipped';
  output: string | null; // failing output tail, redacted
  bisect: {
    runId: string | null; // the `bisect` run, null when none was started
    status: BisectStatus | 'cancelled' | 'over_budget';
    runs: number;
    firstBad: StepInfo | null; // as `mindly bisect show --json` prints a step
    lastGood: StepInfo | null;
  } | null;
  conflictId: string | null;
  told: string[]; // sessions sent the break
  note: string | null;
}
```

The conflicts the sentinel opens are `check_failed` conflicts whose fingerprint starts with
`sentinel:`; it closes them itself when the check passes again (a shadow merge leaves them alone).
`mindly sentinel --json` prints `SentinelStatus` plus `daemon: boolean`, and `mindly sentinel run
--json` prints one pass: `{ status, worktree, step, runId, checks: SentinelCheckReport[], reason,
setupFailed }`.

## CLI `--json`

`mindly saves [--since 7d] [--all] --json` prints the same object as `GET …/saves`:
`{ since, summary: { total, byKind, byAgent }, saves: Save[] }`. Without `--all` it lists confirmed
and caught saves; with it every status. `mindly saves card` writes SVG (stdout, or `--out card.svg`),
not JSON. The `--json` output of existing commands (`status`, `standup`, …) does not include saves.

`mindly track [--since 30d] [--area <folder>] [--agent <kind>] [--min-edits 20] --json` prints a
`TrackReport` (above), after checking the lines of up to 200 edits that turned 7 days old.

Review requests need a runner agent (`claude-code`, `codex`) different from the session's agent;
replay takes 1-4 distinct runner agents. Replay checks only come from a trusted project config.

## Live feed

`GET /api/live` upgrades to WebSocket. Server → client messages:

```ts
{ type: 'hello', lastSeq: number }
{ type: 'events', projectId: string, events: MindlyEvent[] }   // new events, in seq order
{ type: 'ping' }
```

The server polls `events.maxSeq()` every 500 ms (cheap) and pushes new rows. Client → server:
`{ type: 'subscribe', projectId: string, afterSeq?: number }`. Max 16 connections; idle sockets are
pinged every 25 s (a JSON `ping` message plus a protocol ping) and closed if they don't answer. A
connection beyond the limit is closed with code 1013; shutdown closes sockets with 1001.
