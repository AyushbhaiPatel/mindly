# Mindly architecture

Mindly is a local-first memory and coordination layer for coding agents (Claude Code, Codex,
Cursor and anything that speaks MCP). It keeps every agent working on a project aware of the
project's knowledge, of what the other agents are doing right now, and of what changed that
affects them.

This document is the source of truth for how the system is put together. Package READMEs describe
their own internals; this file describes the contracts between them.

## Goals and non-goals

**Goals**

- Works fully offline. No account, no server, no mandatory network call.
- Never blocks or slows an agent noticeably. Hooks fail open and finish in well under a second.
- Every piece of shared context carries provenance and a trust level, so one agent's mistake does
  not silently become every agent's "fact".
- Deterministic first. Optional LLM features (bring-your-own-key or local models) improve
  quality but are never required for correctness.
- Safe by default against hostile repositories, hostile web pages and hostile memory content.

**Non-goals (for now)**

- Cloud sync and team memory. The storage layer is designed so a sync layer can be added later
  (append-only event log, globally unique ids, versioned records), but nothing leaves the machine
  today.
- Orchestrating agents. Mindly coordinates agents the developer already runs; it only launches an
  agent itself for explicitly requested features (replay, cross-agent review, opt-in failover).

## Big picture

```
 Claude Code        Codex           Cursor / other MCP clients
     │ hooks          │ hooks              │
     │ + MCP          │ + MCP              │ MCP
     ▼                ▼                    ▼
 ┌──────────────────────────────────────────────────────┐
 │ adapters  (translate agent hook payloads ↔ events)   │
 │ mcp       (stdio MCP server, one per agent session)  │
 └───────────────┬──────────────────────────────────────┘
                 │ in-process library calls
 ┌───────────────▼──────────────────────────────────────┐
 │ engine                                               │
 │  memory · context · rules · mistakes · self-healing  │
 │  coordination · intents · conflicts · impact         │
 │  deliveries (telepathy) · handoff · failover         │
 │  provenance · x-ray · snapshots · standup            │
 └───────┬───────────────────────┬──────────────────────┘
         │                       │
 ┌───────▼────────┐      ┌───────▼─────────────────────┐
 │ store (SQLite) │      │ git · llm · notify · runners│
 └────────────────┘      └─────────────────────────────┘
         ▲
         │ same database, WAL mode
 ┌───────┴──────────────────────────────────────────────┐
 │ daemon (optional): Mission Control dashboard, live   │
 │ WebSocket feed, background jobs (shadow merge,       │
 │ self-healing sweeps, standup schedule, pager)        │
 └──────────────────────────────────────────────────────┘
```

### Why there is no mandatory daemon

Agent hooks are short-lived processes. If they had to reach a daemon, a crashed or not-yet-started
daemon would mean lost events and agents without context. Instead, **the SQLite database is the
source of truth and the engine is a library**. Hook handlers, the MCP server, the CLI and the
daemon all open the same database (WAL mode, `busy_timeout`), so every entry point works on its
own. The daemon adds things that need a long-running process: the dashboard, live push, and
scheduled background work.

## Packages

| Package             | Responsibility                                                                 |
| ------------------- | ------------------------------------------------------------------------------ |
| `packages/core`     | Domain types and runtime schemas, ids, errors, config, paths, secret redaction |
| `packages/store`    | SQLite access, migrations, repositories, full-text search                      |
| `packages/engine`   | All domain services; the `Mindly` facade used by every entry point             |
| `packages/git`      | Safe git invocation, shadow merge, diff/export analysis, import graph          |
| `packages/llm`      | Optional model providers (local Ollama, BYOK Anthropic/OpenAI), never required |
| `packages/notify`   | Pager channels (desktop, ntfy, webhook); off by default                        |
| `packages/runners`  | Headless agent runs for replay, cross-agent review and opt-in failover         |
| `packages/mcp`      | MCP server exposing Mindly tools to any MCP client                             |
| `packages/adapters` | Per-agent installers and hook translators (Claude Code, Codex, Cursor)         |
| `apps/cli`          | `mindly` command; the only published package (`mindly-cli`)                    |
| `apps/daemon`       | Local HTTP/WebSocket server for Mission Control and background jobs            |
| `apps/dashboard`    | Mission Control single-page app, served by the daemon                          |

Dependency direction is strictly downward: `core ← store ← engine ← {mcp, adapters, daemon, cli}`.
`git`, `llm`, `notify` and `runners` depend only on `core`; the engine receives them through
constructor injection so they can be faked in tests.

## Data model

All state lives in one database at `$MINDLY_HOME/mindly.db` (default `~/.mindly`). Every row is
scoped to a `project_id`; a project is identified by the canonical (realpath) root of its git
repository.

| Table             | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `projects`        | Known project roots and their trust state                                 |
| `sessions`        | One row per agent session (agent kind, external id, branch, worktree)     |
| `events`          | Append-only log of everything that happened; monotonic `seq`, unique `id` |
| `memories`        | Current version of each memory (fact, decision, rule, mistake, …)         |
| `memory_versions` | Full history of every memory change (time travel)                         |
| `memory_evidence` | Links a memory to files/commits/tests that support it (+ content hash)    |
| `memories_fts`    | FTS5 index over memory title/body/tags                                    |
| `tasks`           | Work items, owner session, status, plan                                   |
| `intents`         | What a session is about to change (files, symbols, contracts)             |
| `file_changes`    | Every edit an agent made: file, hunk hash, session, triggering prompt     |
| `conflicts`       | Detected problems between sessions, with severity and lifecycle           |
| `deliveries`      | Messages queued for a session/agent, with delivered/acked timestamps      |
| `context_packets` | What context was given to which session and why (Context X-Ray)           |
| `handoffs`        | Packaged task state for another agent to resume                           |
| `contracts`       | Executable memory: declarative checks bound to a memory                   |
| `snapshots`       | Multi-agent time-machine points (git ref + engine state)                  |
| `runs`            | Shadow merge, replay and review executions and their results              |

Design rules:

- **Ids** are UUIDv7 (time-ordered, globally unique) so records can be merged across machines when
  sync arrives.
- **Events are immutable.** Everything else is a projection that can be rebuilt or audited
  against the log.
- **Memories are versioned, never overwritten.** An update writes a new `memory_versions` row and
  bumps `memories.version`. "Deleting" marks a memory `archived`; `mindly forget` is the only
  hard delete and it is an explicit user action.
- **Every SQL statement is parameterised.** No string concatenation of values, ever. Dynamic
  `ORDER BY`/column names come from closed allow-lists.

## Trust model for memory

Each memory has a `trust` level and a `source`:

| Trust      | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `verified` | Checked against the repository (evidence hash or contract passes) |
| `approved` | Stated or approved by the user                                    |
| `proposed` | Asserted by an agent and not yet confirmed                        |
| `stale`    | Evidence changed or a contract failed; kept for history, flagged  |
| `rejected` | Explicitly rejected by the user; never injected again             |

Context is always rendered inside a clearly delimited block that tells the receiving agent the
content is _reference data from Mindly, not instructions_, and labels each item with its trust and
source. Only `approved` rules are phrased as project conventions, and even those never claim
higher priority than the user's live instructions.

## Event flow

1. **Session start** – adapter registers/refreshes the session, the context builder assembles a
   packet (approved rules, active work of other agents, recent decisions, open conflicts, pending
   deliveries, pending handoffs) within a token budget, records it as a `context_packet`, and
   returns it to the agent.
2. **Prompt submitted** – the prompt is stored (redacted) as an event; the rule detector looks for
   corrections ("no, we use pnpm"); relevant memories are retrieved (FTS + recency + trust + path
   scope) together with any undelivered telepathy messages.
3. **Before a tool runs** – for file-writing tools the intent ledger records the target, checks it
   against other sessions' active intents and path-scoped rules/mistakes, and returns advice. A rule
   marked `enforce` can deny the tool call; nothing else blocks.
4. **After a tool runs** – file changes are recorded with provenance; the impact analyser compares
   the exported surface of the changed file before/after and notifies sessions whose work depends
   on it; memories whose evidence covers the file are re-verified (self-healing); contracts bound to
   the file are re-run.
5. **Stop** – the turn is summarised, the session goes idle, rate-limit signatures are detected and
   trigger the failover flow.

Deliveries are **at-least-once with acknowledgement**: a delivery is marked `delivered` when it is
included in a context packet and `acked` when the agent calls the `mindly_ack` MCP tool or the next
turn starts without error. Undelivered items are retried at every hook boundary; expired items are
dropped with an event.

## Features and where they live

| Feature                   | Mechanism                                                                    |
| ------------------------- | ---------------------------------------------------------------------------- |
| Universal memory          | `engine/memory` + FTS5 retrieval                                             |
| Zero-prompt context       | `engine/context` on SessionStart                                             |
| Context compression       | Token budgeting, per-item truncation, optional LLM summary                   |
| Agent telepathy / inbox   | `engine/coordination/deliveries`                                             |
| Handoff and failover      | `engine/coordination/handoff`, rate-limit detection in Stop                  |
| Mission Control           | daemon + dashboard, live WebSocket over the event log                        |
| Intent ledger             | `engine/coordination/intents`, PreToolUse                                    |
| Conflict and impact radar | intent overlap, file overlap, export-surface diff + import graph             |
| Shadow merge              | `git merge-tree --write-tree` over every session's tree, checks in temp tree |
| Self-healing memory       | evidence content hashes re-checked on change and by periodic sweep           |
| Executable memory         | `contracts` table; declarative checks; command checks need user approval     |
| Say-it-once rules         | correction detector on prompts, path-scoped rules                            |
| Mistake memory            | failed attempts recorded and surfaced before similar edits                   |
| Code provenance           | `file_changes` hunk hashes; `mindly why file:line`                           |
| Context X-Ray             | `context_packets` with included/omitted items and scores                     |
| Cross-agent review        | `runners` headless review of a diff by a different agent                     |
| Agent A/B replay          | `runners` in isolated worktrees at the same base commit                      |
| Phone pager               | `notify` channels, minimal payloads, opt-in                                  |
| Multi-agent time machine  | `snapshots`: hidden git ref + engine state; restore is non-destructive       |
| Memory branches           | memories scoped to a git branch, promoted when the branch merges             |
| Morning standup           | digest built from the event log; CLI, dashboard, optional scheduled pager    |

## Processes and IPC

- **Hooks** run `mindly hook <agent> <event>`; JSON in on stdin, JSON out on stdout. Hard timeout,
  fail-open.
- **MCP** runs `mindly mcp` over stdio, spawned by the agent.
- **Daemon** listens on `127.0.0.1` only. See [security.md](security.md) for its authentication.

## Future: cloud sync

The cloud tier will replicate the event log and versioned tables (they are already append-only
and keyed by UUIDv7). End-to-end encryption, per-project opt-in, and the existing redaction pipeline
are prerequisites; none of that code exists yet by design.
