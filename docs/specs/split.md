# Spec: `mindly split`, parallel agents without collisions

Status: proposed · Target: 0.4.0 (MVP in 0.3.x) · Owner: unassigned

## Problem

Running several agents at once is the fastest way to build, and the most fragile: they edit the
same files, build on each other's half-finished interfaces, and someone has to merge it all. Tools
like Conductor run agents in parallel but don't coordinate _what_ each may touch; Mindly
coordinates but doesn't help set the work up. Nobody does both, agent-neutrally.

## Goal

One command turns a goal into non-overlapping parts, gives each part to an agent in its own
worktree with clear ownership and a shared contract, keeps them in sync while they work, and
produces one integration branch when they're done:

```bash
mindly split "add billing: API endpoints, Stripe webhook handler, dashboard billing page"
```

## User flow

```text
$ mindly split "add billing: API, webhook handler, dashboard page"

Plan · add billing                                    (planned by Claude Code, read-only)

  PART        AGENT         OWNS                         DEPENDS ON
  1 API       Claude Code   src/api/billing/**           —
  2 Webhooks  Codex         src/webhooks/stripe/**       1 (uses BillingEvent)
  3 Page      Gemini CLI    src/app/billing/**           1 (calls GET /billing)

  Shared contract
  • BillingEvent { id, type, amount, currency }  — owned by part 1
  • GET /api/billing → { plan, status, renewsAt } — owned by part 1

→ Edit the plan in $EDITOR, or press Enter to create 3 worktrees and briefs.

✓ Created 3 worktrees next to the repo (../my-app.mindly/billing-api, …)
→ Start each agent in its folder; Mindly briefs it on its part when the session starts.
→ mindly split status     see progress, conflicts and the merge check
```

## Planning

- `mindly split "<goal>" [--parts n] [--agents claude-code,codex,gemini] [--plan plan.json]`.
- The plan is produced by one connected agent in **read-only review mode** through
  `@mindly/runners` (`claude -p --permission-mode plan` / `codex exec --sandbox read-only`), with a
  prompt that includes the repo tree (bounded), approved rules and relevant decisions, and asks for
  strict JSON. If no agent is available or the user prefers, `--plan plan.json` takes a hand-written
  plan; an LLM provider from config may also be used.
- Plan schema (zod-validated):
  `{ goal, parts: [{ key, title, agent, owns: glob[], reads?: glob[], dependsOn: key[], brief }],
   contract: [{ name, owner: key, definition }] }`.
- Validation before anything is created: `owns` globs are project-relative, pass
  `cleanScopePaths`, and are **pairwise disjoint** (checked against the current file list plus the
  glob patterns); every agent is connected (`detect()` + Mindly hooks installed); the dependency
  graph is acyclic; 2–6 parts.
- The user reviews and may edit the plan (`$EDITOR` on the JSON, or a numbered prompt) before
  anything is created. Approving the plan stores the contract items as **user-approved decisions**
  (`kind: decision`, scoped to the split) — that is the "shared contract" every part sees.

## Execution (MVP: `--brief`, default)

1. Create one git worktree per part on branch `mindly/<split>/<key>` from the current HEAD, in a
   sibling folder `../<repo>.mindly/<split>-<key>` (never inside the repo). Use `@mindly/git`;
   refuse if branches/folders exist.
2. Create a parent task (the goal) and one child task per part (`tasks.parent_id`), owned by no
   one yet. Store part metadata (worktree, branch, agent, owns, dependsOn) in a new
   `split_parts` table (migration).
3. For each part, write a handoff/brief targeted at the agent kind **and** the worktree path, so
   the next session of that agent started in that folder claims it at `session_start` (extend the
   context builder's handoff claim to match on worktree when present).
4. Ownership: the part's session gets an intent on its `owns` globs. On `pre_tool`, a write to a
   file owned by _another_ part returns a coordination warning naming the owner; with
   `mindly split --strict` it is denied (a user `enforce` rule scoped to that part's worktree).
5. Contract changes: if the owning part changes a contract item (export surface / decision edit),
   dependants get an impact delivery immediately (existing impact radar), and the decision's
   history records it.
6. The daemon's shadow-merge job treats all parts of a split as one merge set and runs trusted
   checks on the combined tree; results show in `split status` and Mission Control.

## Execution (later: `--launch`)

Opt-in only, per invocation, with a clear cost warning: start each part's agent headlessly in its
worktree via `@mindly/runners` `launchTask` in task mode, one at a time or ≤ 3 in parallel, with a
time limit; progress streams into Mission Control. Never pushes; never touches the main worktree.

## Finishing

- `mindly split status`: per part — agent, state (waiting · working · done · blocked), files
  changed, last activity, conflicts, merge-check result; plus "next step".
- `mindly split merge`: when all parts are done and the merge check passes, merge the part
  branches in dependency order into `mindly/<split>/integration` (no fast-forward, no push), run the
  trusted checks once more, and print the branch to open a PR from. Stops on the first conflict
  with a clear message.
- `mindly split abort [--keep-branches]`: remove worktrees (and branches unless kept), close
  intents/tasks, keep the memory history.

## Surfaces

- CLI as above, following `docs/output-style.md` (summary first, tables, next steps).
- Mission Control: a "Split" view (parts table with progress, the contract, merge check) and a
  "Needs you" item when a part is blocked or the merge check fails.
- MCP: `mindly_split_status` (read-only) so agents can see their part and the contract; agents
  cannot create or change splits.
- Daemon API: `GET /api/projects/:id/splits`, `GET /api/splits/:id`.

## Safety

- Planning runs agents read-only; execution in `--brief` mode starts nothing.
- Worktrees live outside the repository; paths are validated; existing branches/folders are never
  overwritten; `abort` only removes what the split created (tracked in `split_parts`).
- Ownership globs are validated and disjoint; strict mode uses the existing user-`enforce` path.
- Integration never pushes and never modifies the user's current branch.

## Acceptance criteria (MVP)

1. A hand-written `--plan` with 3 parts creates 3 worktrees, 3 child tasks and briefs; overlapping
   `owns` globs, unknown agents and cycles are rejected before anything is created.
2. A session started in a part's worktree is briefed on its part and the contract (test via hook
   events), and a write to another part's files is warned (or denied with `--strict`).
3. A contract change by the owner reaches dependants as an impact update.
4. `split status` and `split merge` work end to end on a temp repo; merge stops cleanly on a
   conflict; `abort` leaves no worktrees or branches it created.
5. Agent planning (`claude -p` read-only) is tested with the fake-agent executables pattern from
   `packages/runners/test`; invalid JSON plans are rejected with a readable error.
