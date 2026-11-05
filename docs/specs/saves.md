# Spec: Mindly saves

Status: proposed · Target: 0.3.0 · Owner: unassigned

## Problem

Mindly prevents problems silently. When Codex is warned that `login()` changed before it writes
broken code, nothing visible happens; the bug simply never exists. Users cannot see the value, so
they do not trust it, keep it, or tell anyone about it.

## Goal

Record every time Mindly demonstrably helped, with evidence, and show it where people already look:
the status line, `mindly status`, the standup, Mission Control, and a weekly shareable card.

**Honesty rule (non-negotiable):** a save is only counted when there is concrete evidence that
Mindly's intervention happened _before_ the problem and the problem did not occur. No estimated
"hours saved", no counting of routine context. Every save links to the events that prove it. It is
better to under-count than to inflate.

## What counts as a save

| Kind                   | Trigger (caught)                                                                                                          | Confirmed when                                                                         | Plain sentence                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `impact_warned`        | An `impact` delivery about file F reaches session B (`delivery.delivered`) **before** B writes any file that imports F    | B later edits a dependent file it was told about, or the conflict resolves, within 2 h | "Codex was told `login()` changed before it wrote code using it"                |
| `overlap_avoided`      | `intent_overlap` warning returned to session B at `pre_tool` for file F                                                   | B does not write F in the next 10 min, or writes it only after A's intent closed       | "Codex stopped before overwriting Claude Code's work on `src/auth.ts`"          |
| `rule_enforced`        | `pre_tool` returned `deny` because of a user `enforce` rule                                                               | immediately (the write was blocked)                                                    | "A write to `src/generated/` was blocked by your rule"                          |
| `mistake_avoided`      | A known-pitfall warning was returned at `pre_tool` for command C                                                          | C is not run in the next 10 min, or runs and succeeds                                  | "Codex didn't repeat `npm test`, which failed before"                           |
| `merge_conflict_early` | Shadow merge opened a `merge_conflict` conflict while both sides were still unmerged                                      | immediately                                                                            | "A merge conflict between two agents was found before either branch was merged" |
| `check_broken_early`   | A contract went pass→fail, or a shadow-merge check failed, and was fixed (pass again) in the same session or before merge | on the fix                                                                             | "A broken check was caught and fixed before merging"                            |
| `limit_handoff`        | A `rate_limit` handoff was claimed by another agent                                                                       | on claim                                                                               | "Work continued in Codex after Claude Code hit its usage limit"                 |

Not saves: rules captured, context served, memories stored, conflicts that were dismissed as not
real (`dismissed` → the save is dropped), anything the user marks "not a save".

States: `caught` (intervention happened) → `confirmed` (evidence the problem was avoided) or
`expired` (no confirmation in time; not shown in totals). Only `confirmed` saves count in totals.
`caught` ones may be shown as "pending" in detail views.

## Data model

New migration (schema v2):

```sql
CREATE TABLE saves (
  id            TEXT PRIMARY KEY,                -- UUIDv7
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('impact_warned','overlap_avoided','rule_enforced',
                  'mistake_avoided','merge_conflict_early','check_broken_early','limit_handoff')),
  status        TEXT NOT NULL CHECK (status IN ('caught','confirmed','expired','rejected')),
  title         TEXT NOT NULL,                   -- plain sentence, sanitised, no code
  session_ids   TEXT NOT NULL DEFAULT '[]',
  paths         TEXT NOT NULL DEFAULT '[]',
  evidence      TEXT NOT NULL DEFAULT '[]',      -- event ids
  fingerprint   TEXT NOT NULL,                   -- dedupe: same problem counted once
  created_at    INTEGER NOT NULL,
  confirmed_at  INTEGER,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX saves_project ON saves (project_id, status, created_at);
```

New event types: `save.caught`, `save.confirmed`, `save.rejected`.

## Engine

- `packages/engine/src/features/saves.ts`: a `SavesService` + `savesModule`.
  - Producers hook into existing places: the hook handler (`pre_tool` overlap warning, enforce
    deny, mistake warning), `features/impact.ts` (delivery of impact), the daemon shadow-merge job,
    `features/contracts.ts` (fail→pass), continuity failover (handoff claimed).
  - Confirmation runs on the bus (`files.changed`, `turn.stopped`) and in the daemon housekeeping
    job (expiry after the window). Hooks stay within their time budget: confirmation logic is a
    few indexed queries, no file reads.
  - `record(kind, …)` is idempotent by fingerprint; `reject(id)` for user feedback.
- `summary(projectId, since)` → `{ total, byKind, byAgent, recent[] }` (confirmed only).

## Surfaces

- **Status line:** `mindly · 2 saves today · 3 rules · 0 conflicts` (saves first, only when > 0).
- **`mindly saves [--since 7d] [--json]`:** list with plain sentences, agent names, times, short
  ids; `mindly saves reject <id>` ("not a save").
- **`mindly status`:** one line under the summary when there are saves today.
- **Standup:** "Mindly saved you 4 times: …" section.
- **Mission Control:** a "Saves" stat in the stats row and a panel (table: when · what · agents),
  following `docs/output-style.md`.
- **Weekly card:** `mindly saves card [--week] [--out card.png|svg]` and a "Share" button in
  Mission Control. Card shows counts by kind and agent names only. **No project names, file paths
  or code unless `--details`**, so it is safe to post. Visual style per
  Mission Control (`apps/dashboard/src/styles.css`: light sky, Newsreader + DM Sans), rendered locally
  (reuse the SVG approach from `scripts/make-demo.mjs`; PNG via the daemon's existing
  Playwright-free path or SVG only).
- **Daemon API:** `GET /api/projects/:id/saves?since&status`, `POST /api/saves/:id/reject`.
- **MCP:** not exposed to agents (agents must not be able to create or edit saves).

## Acceptance criteria

1. Each of the 7 kinds has an end-to-end test driven through real hook events: caught → confirmed,
   caught → expired, and a negative case where the problem happened anyway (no save).
2. A dismissed conflict removes its save; `saves reject` removes it from all totals.
3. The same underlying problem is counted once (fingerprint) even across sessions and retries.
4. Status line stays under its current time budget (read-only, indexed query).
5. `--json` shapes documented in `docs/api.md`; `docs/output-style.md` vocabulary extended.
6. The card contains no paths or code without `--details` (test asserts it).

## Out of scope

Cost or time estimates; leaderboards across users; any network sharing (the user posts the card).
