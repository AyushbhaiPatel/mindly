# Synapse daemon API (v1)

Local-only HTTP + WebSocket API served by `apps/daemon` on `127.0.0.1:<port>` (default 7878, see
`UserConfig.daemon.port`; port 0 = random, the chosen port is written to `$SYNAPSE_HOME/daemon.json`
as `{ pid, port, startedAt, version }` with mode 0600). It backs the Mission Control dashboard and
the CLI. All bodies are JSON (`application/json`, max 256 KB). All ids are UUIDv7 strings.

## Authentication

- **CLI**: `Authorization: Bearer <token>` where token = contents of `$SYNAPSE_HOME/daemon.token`
  (32 random bytes, base64url, mode 0600, created on first start). Constant-time comparison.
- **Dashboard**: `synapse dashboard` asks the daemon for a one-time login code
  (`POST /api/auth/codes` with the bearer token → `{ code, expiresAt }`, 60 s, single use) and opens
  `http://127.0.0.1:<port>/#login=<code>`. The SPA reads the fragment, removes it from the URL with
  `history.replaceState`, and calls `POST /api/auth/exchange { code }` → sets cookie
  `synapse_session` (`HttpOnly; SameSite=Strict; Path=/`; random 32 bytes; 12 h; in-memory server-side
  session table). `POST /api/auth/logout` clears it.
- Every request must have `Host` equal to `127.0.0.1:<port>` or `localhost:<port>` → else 421.
- State-changing requests (POST/PATCH/DELETE) authenticated by cookie must carry
  `Origin: http://127.0.0.1:<port>` (or `localhost`) and header `X-Synapse-CSRF: 1` → else 403.
- WebSocket upgrade requires a valid cookie or bearer token and a matching `Origin` (cookie case).
- Unauthenticated: `GET /api/health`, static dashboard assets, `POST /api/auth/exchange`.

## Errors

`{ "error": { "code": "<ErrorCode from @synapse/core>", "message": "..." } }` with status
400 invalid_input · 401 unauthenticated · 403 forbidden/untrusted_project · 404 not_found ·
409 conflict · 413 too large · 421 bad host · 500 internal (generic message only).

## Endpoints

| Method | Path                                                                             | Response                                                                                                          |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                                                                    | `{ ok: true, version }`                                                                                           |
| GET    | `/api/projects`                                                                  | `Project[]`                                                                                                       |
| GET    | `/api/projects/:projectId/overview`                                              | `Overview` (below)                                                                                                |
| GET    | `/api/projects/:projectId/sessions?limit`                                        | `Session[]` (most recent first)                                                                                   |
| GET    | `/api/projects/:projectId/events?afterSeq&beforeSeq&types&sessionId&limit&order` | `SynapseEvent[]` (`types` comma-separated)                                                                        |
| GET    | `/api/projects/:projectId/memories?q&kind&trust&branch&status&limit`             | `Memory[]` (`q` uses FTS search)                                                                                  |
| POST   | `/api/projects/:projectId/memories`                                              | create user memory `{ kind, title, body, tags?, scopePaths?, enforce?, pinned? }` → `Memory`                      |
| GET    | `/api/memories/:id`                                                              | `{ memory, versions: MemoryVersion[], evidence: MemoryEvidence[], contracts: Contract[], xray: ContextPacket[] }` |
| PATCH  | `/api/memories/:id`                                                              | `{ title?, body?, tags?, scopePaths?, pinned?, enforce? }` → `Memory`                                             |
| POST   | `/api/memories/:id/approve` · `/reject` · `/archive`                             | `Memory`                                                                                                          |
| DELETE | `/api/memories/:id`                                                              | hard delete → `204`                                                                                               |
| GET    | `/api/projects/:projectId/conflicts?status`                                      | `Conflict[]`                                                                                                      |
| POST   | `/api/conflicts/:id/status`                                                      | `{ status: 'acknowledged'                                                                                         | 'resolved' | 'dismissed' }`→`Conflict` |
| GET    | `/api/projects/:projectId/tasks?status`                                          | `Task[]`                                                                                                          |
| GET    | `/api/projects/:projectId/intents`                                               | active `Intent[]`                                                                                                 |
| GET    | `/api/projects/:projectId/deliveries?status`                                     | `Delivery[]`                                                                                                      |
| GET    | `/api/projects/:projectId/handoffs`                                              | `Handoff[]`                                                                                                       |
| GET    | `/api/projects/:projectId/runs?kind&limit`                                       | `Run[]`                                                                                                           |
| POST   | `/api/projects/:projectId/shadow-merge`                                          | queue a shadow merge → `Run` (202)                                                                                |
| POST   | `/api/projects/:projectId/review`                                                | `{ sessionId, reviewer }` queue cross-agent review → `Run` (202)                                                  |
| POST   | `/api/projects/:projectId/replay`                                                | `{ prompt, baseCommit?, agents: string[] }` → `Run` (202)                                                         |
| GET    | `/api/sessions/:id/xray?limit`                                                   | `ContextPacket[]`                                                                                                 |
| GET    | `/api/projects/:projectId/provenance?file&line`                                  | provenance result (`ProvenanceService.why`)                                                                       |
| GET    | `/api/projects/:projectId/standup?since`                                         | `{ digest, markdown }`                                                                                            |
| GET    | `/api/projects/:projectId/snapshots`                                             | `Snapshot[]`                                                                                                      |
| POST   | `/api/projects/:projectId/snapshots`                                             | `{ label }` → `Snapshot`                                                                                          |
| GET    | `/api/snapshots/:id/diff`                                                        | snapshot diff                                                                                                     |
| POST   | `/api/snapshots/:id/restore`                                                     | `{ branch? }` → result                                                                                            |
| GET    | `/api/projects/:projectId/trust`                                                 | `{ trusted, configHash, configError, checks: {name, argv}[] }`                                                    |
| POST   | `/api/projects/:projectId/trust`                                                 | trust current config (cookie/bearer + CSRF) → same shape                                                          |

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
  needsYou: { proposedRules: number; proposedMemories: number; criticalConflicts: number; pendingHandoffs: number };
  lastSeq: number;                // highest event seq, for the live feed
}
```

## Live feed

`GET /api/live` upgrades to WebSocket. Server → client messages:

```ts
{ type: 'hello', lastSeq: number }
{ type: 'events', projectId: string, events: SynapseEvent[] }   // new events, in seq order
{ type: 'ping' }
```

The server polls `events.maxSeq()` every 500 ms (cheap) and pushes new rows. Client → server:
`{ type: 'subscribe', projectId: string, afterSeq?: number }`. Max 16 connections; idle sockets are
pinged every 25 s and closed if they don't answer.
