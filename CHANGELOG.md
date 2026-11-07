# Changelog

All notable changes to `mindly-cli` are documented here. The project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor version.

## 0.4.0 — 2026-11-07

### Added

- `mindly bisect -- <command>` finds the agent edit that broke a command. Mindly now keeps a
  checkpoint of the code after every agent edit: a git commit of the whole working tree stored
  under a hidden ref (`refs/mindly/steps/<worktree>/<step>`) in your repository, taken through a
  private index so your index, HEAD, branches, stash and files are never touched. Each checkpoint
  is a parentless commit, so pruning one really frees it. Secret files on the deny-list are never
  stored. After an edit tool only the touched paths are refreshed; a full
  rescan happens at session start, on each prompt and after a shell command that may have written
  files, and changes no agent edit explains become an `outside` step. Checkpoints never block or
  slow a hook: a busy lock or a git error skips the checkpoint and marks the next one as a gap.
  `mindly bisect` checks the steps out one by one in a scratch worktree in a temp folder (never in
  your checkout), runs the command without a shell with a minimal environment and a time limit,
  reads exit codes like `git bisect run` (0 good, 125 skip, else bad), binary-searches, re-runs
  the two steps around the answer and calls the result unreliable when they disagree. The result
  names the step, the agent and session, the prompt, the rules in effect for those files then,
  the last good step and the failing output; `--setup "<command>"` installs dependencies first
  and again only when a step changes a lockfile or manifest; `--since`, `--good` and `--bad`
  pick the range; `--json` has a stable shape. A reliable result made by an agent is recorded as a
  mistake memory from you, scoped to the step's paths, and every bisect is stored as a run of the
  new kind `bisect`.
- `mindly bisect list`, `mindly bisect show <step> [--patch]` and `mindly bisect revert <step>`,
  which applies the reverse of that one step to your checkout with `git apply -R --3way` after
  showing the patch and asking (it refuses when the lines changed since, never commits and never
  touches other files).
- `checkpoints.enabled` (default true), `checkpoints.keepDays` (14) and
  `checkpoints.maxPerWorktree` (5,000) in the user config. The daemon prunes old checkpoints
  hourly; without the daemon a hook prunes at most once a day. `mindly forget --project` and
  `mindly uninstall` delete the hidden refs and rows, and `mindly doctor` reports whether
  checkpoints are on, how many exist, their approximate disk use, and warns when a remote has
  `remote.<name>.mirror` set (a `git push --mirror` would push the hidden refs).
- Database schema v4: a `checkpoints` table, and the `runs` table rebuilt so it accepts the
  `bisect` run kind. Applied automatically; upgrades from v1, v2 and v3 keep every row.
- `mindly track [--since 30d] [--area <folder>] [--agent <kind>] [--min-edits 20] [--explain]
[--json]`: a track record of each agent in this repository, per folder (the first
  `track.areaDepth` folders of a path, default 2; root files are `(root)`). For each agent it
  shows edits and sessions, and how often its edits broke something: a check (reliable
  `mindly bisect` results whose first bad step is one of its edits, once per step, at the time of
  that edit), a recorded decision (each time a contract started failing right after its edit in
  the project's own checkout) or a merge (shadow-merge and split merge conflicts naming only its
  session). It also counts writes blocked by an enforced rule (confirmed saves, as a count), the
  share of the lines it added or changed that are still in the code after 7 days on the branch it
  worked on, and how many of its sessions hit a usage limit. There is no score: every rate shows
  its counts and a 95% Wilson interval, rates appear only with at least `track.minEdits` (20)
  edits and `track.minSessions` (3) sessions in a folder, and agents are called clearly different
  only on their breakages, when the intervals do not overlap and the higher count comes from at
  least 2 sessions. Outcomes involving several sessions, outside steps and gap steps count for
  nobody, and each opening of a conflict is attributed from the sessions recorded at that moment.
- `mindly split` adds the track record (counts only, inside the planner's data block) to the
  planning prompt, and the plan review shows a suggested agent next to a part when another agent
  clearly breaks less in the folder the part mainly owns. The plan's own choice is never changed.
- `GET /api/projects/:projectId/track?since&area&agent&minEdits` on the daemon (read-only, same
  shape as `mindly track --json`), and a daemon job that checks the lines of up to 500 edits per
  run (at most 20 seconds) once they are 7 days old. `mindly track` checks up to 200 more itself
  (at most 3 seconds) and says how many are still waiting.
- Agent edits now record which lines of the file they added or changed (a change inside a line
  counts as that line), and `conflict.opened` events record the
  sessions and paths of that opening. `mindly bisect` stores the blamed step (kind, session,
  paths, time) with its run, so the track record still counts it after the checkpoint is pruned.
- Database schema v5: `file_change_lines` (hashes of the lines each agent edit added or changed),
  `line_survival` (per edit: tracked lines and how many are still present; no file content) and
  an index on `file_changes (created_at, id)`. Applied automatically; upgrades from v1 to v4 keep
  every row.

### Changed

- Once a Mindly with schema v4 or v5 has upgraded your database, an older Mindly (0.3.0 or
  earlier) cannot open it any more. Upgrade every Mindly install on the machine together.

## 0.3.0 — 2026-11-05

### Added

- Saves: Mindly records each time it demonstrably helped, with the events that prove it. Seven
  kinds: an agent told about a changed export before it used it, an agent that stopped before
  overwriting another agent's work, a write blocked by an enforced rule, a known pitfall avoided
  (a command that failed before not run, or changed until it succeeded), a merge conflict found
  before either branch was merged, a broken check fixed before merging, and work picked up by
  another agent after a usage limit. A save starts pending and counts only once the helped
  agent's later hook events show the problem was avoided; otherwise it expires. Writes through
  the shell count as writes. Dismissed conflicts drop their saves, and the same problem is counted
  once across sessions and retries.
- `mindly saves [--since 7d] [--all] [--json]` lists saves in plain sentences;
  `mindly saves reject <id>` removes one from every total ("not a save").
- `mindly saves card [--week | --since 30d] [--details] [--out card.svg]`: a shareable SVG card
  of the last 7 days, this week or the period you ask for (the card names it).
  It shows counts and agent names only, never project names, paths or code unless `--details`.
  Mission Control has the same card behind the Share button of its new Saves panel (SVG or PNG).
- Saves show up where you already look: first on the status line (`mindly · 2 saves today · …`),
  a line in `mindly status`, a section in `mindly standup`, and a "saves this week" stat and
  Saves panel in Mission Control.
- Daemon API: `GET /api/projects/:id/saves`, `POST /api/saves/:id/reject` and
  `GET /api/projects/:id/saves/card.svg`. Agents cannot create or change saves: there is no MCP
  tool for them.
- Database schema v2 (a new `saves` table), applied automatically.
- `mindly split "<goal>"` divides one goal between agents working at the same time. A connected
  agent plans the split read-only (`claude -p --permission-mode plan` or
  `codex exec --sandbox read-only`), or `--plan plan.json` takes a hand-written plan; the plan is
  validated (2-6 parts, connected agents, no dependency cycles, non-overlapping `owns` globs) and
  reviewed before anything is created. Mindly then creates one git worktree per part next to the
  repository (`../<repo>.mindly/<split>-<part>` on branch `mindly/<split>/<part>`), a parent task
  with one child task per part, and a brief that the next session of the part's agent started in
  that folder receives at session start: its part, the files it owns, what it depends on and the
  shared contract (stored as approved decisions). Writes to files owned by another part raise a
  coordination warning, or are blocked with `--strict`; when a part changes an export or a contract
  decision, the parts that depend on it get an impact update. `mindly split status` shows every
  part's agent, state, changed files and conflicts with the latest merge check; `mindly split
check` merges every part in memory and runs the trusted checks (the daemon does the same on its
  shadow-merge schedule while an agent works in a part); `mindly split merge` merges the
  parts in dependency order into `mindly/<split>/integration` (never pushes, never touches your
  branch) and stops cleanly on a conflict; `mindly split abort [--keep-branches]` removes the
  worktrees and branches the split created. Mission Control gets a Split view, the daemon
  `GET /api/projects/:id/splits` and `GET /api/splits/:id`, and agents a read-only
  `mindly_split_status` MCP tool; a blocked part or a failed split merge check shows under
  "Needs you". Database schema v3 adds the `splits` and `split_parts` tables and a `worktree`
  column on handoffs (the upgrade note for schema v2 below applies to v3 as well).

### Changed

- Once a Mindly with schema v2 has upgraded your database, an older Mindly (0.2.0 or earlier)
  cannot open it any more. Upgrade every Mindly install on the machine together. Until the first
  hook or command upgrades a v1 database, the status line shows plain `mindly`.

## 0.2.0 — 2026-11-05

### Added

- Gemini CLI gets the full integration (hooks + MCP), like Claude Code, Codex and Cursor:
  `mindly init` registers `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`
  and `SessionEnd` hooks in `.gemini/settings.json` next to the MCP server, so Gemini's edits and
  shell commands are captured, context is injected at session start, on each prompt and after
  tool calls, and enforced rules can block a write. Comments and your own hooks in the settings
  file are kept, and `mindly uninstall` restores it.
- Claude Code status line: `mindly statusline` shows `mindly · 3 rules · 1 update · 0 conflicts`
  for the session's project. `mindly init` adds it unless you already have a status line (then it
  explains how to chain one into the other; `--no-statusline` skips it), `mindly doctor` reports
  it and `mindly uninstall` removes it. Read-only, no daemon needed, falls back to `mindly`.
- `mindly init` imports the rules you already wrote for your agents: it reads `CLAUDE.md`,
  `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/`, `.windsurfrules`, Copilot, Cline,
  Roo Code, Kiro, Zed and Augment rule files at the repository root, shows each rule with its file
  and line, and asks before storing the new ones as approved rules (with `--yes` or without a
  terminal they are added as suggestions to approve). `--no-import` skips the step;
  `mindly rules import [--dry-run] [--yes]` runs it again later and only adds rules Mindly does not
  have yet.
- `mindly rules sync` keeps your approved rules in a marked section of `AGENTS.md`, `CLAUDE.md`
  and `GEMINI.md`, so agents that are not connected to Mindly follow them too. Opt-in: `init`
  offers it and `rules sync` asks before the first write (`--dry-run` previews). Only the text
  between the `mindly:rules` markers changes; `rules sync --off` and `mindly uninstall` remove it.

### Fixed

- `mindly init`, `mindly uninstall` and other config edits no longer replace a symlinked agent
  settings file with a regular file, so configs managed by stow, chezmoi and other dotfile
  managers keep working. Mindly writes the file at the end of the link (creating it if the link
  points to a missing file), and the output names both paths. If an agent's settings file is
  read-only (for example generated by Nix home-manager), that agent is skipped with the changes
  to make yourself, and the other agents are still connected.
- Contract patterns that stack many optional parts or ambiguous alternatives (for example `(a|a)`
  repeated 20 times) are rejected when the contract is created, with a message saying why, instead
  of stalling evaluation on long lines. An existing contract with such a pattern reports why it
  cannot run, and `mindly doctor` lists it; add it again with a simpler pattern.
- `mindly rules sync` with every approved rule already written in a file no longer adds a section
  that only says so. An existing section keeps that note until `rules sync --off`.
- A timing test of the `mindly hook` binary asserts the median and fastest of several cold starts
  instead of the slowest, so machine load no longer fails it.

### Security

- Rule import from instruction files is linear in the file size. A crafted `AGENTS.md` (for
  example a long line of `' **a'`) could make `mindly init` spend seconds to minutes in regex
  backtracking; `init` also reads the files once instead of up to three times.
- The rules section is found with CommonMark fence rules (closing fence of the same character and
  at least the opener's length; indented code ignored). An unclosed or nested code fence used to
  hide the markers, and every sync appended another section. A file that mentions the markers but
  has no well-formed section, or that ends inside an unclosed code block, is now left alone and
  reported as needing attention.
- Rules imported from a repository's instruction files are labelled as coming from that file
  (`from AGENTS.md`), not from the user, while they wait for approval; agents cannot edit them.
  Rules you confirm during `init` are recorded as approved by you.
- Rules sync writes only rules you approved explicitly (`memory add`, `rules --approve`, Mission
  Control, or confirming an import). Rules auto-approved because a prompt said "always …" still
  reach connected agents but are not committed to `AGENTS.md`/`CLAUDE.md` until you approve them;
  `mindly rules sync` lists how many are waiting.
- An imported rule file with one invalid glob keeps its valid globs instead of becoming
  project-wide; a file with no valid glob is skipped.
- Rule directories (`.cursor/rules`, …) that are links leading out of the project are no longer
  scanned.
- Dependencies: the `glob`/`minimatch` advisories reported by `pnpm audit` are resolved.

## 0.1.3 — 2026-11-04

### Changed

- Mission Control has a new design in the style of ayushp.me: Newsreader and DM Sans type, a soft
  sky background, a calm "nightfall" dark mode, and one centered column.
- Data is structured instead of written as prose: a stats row, aligned tables for agents,
  conflicts, merge checks, memory and activity, with details on expand.
- One primary (gel) button per item; other actions are text links or in a `⋯` menu. Explanations
  moved into `?` tooltips. Tables stack into label/value rows on phones.
- Fonts are bundled (SIL OFL 1.1), so the dashboard still makes no external requests.

### Fixed

- Mission Control and `mindly status` now agree on what needs you: an open conflict that is more
  than FYI. The dashboard used to count only critical conflicts.

### Added

- An animated demo in the README, generated from a real two-agent run (`pnpm demo`).

## 0.1.2 — 2026-11-04

### Changed

- Every command is easier to read: a one-line summary first, plain words instead of internal
  terms ("suggested by Codex, waiting for you" instead of `proposed`), agent names like
  "Claude Code · 4409d433", relative times, no empty sections, and the exact next command to run.
  `mindly doctor` groups checks into Setup, Agents and Optional and tells you how to fix each one.
- Commands that take an id accept the 8-character short id shown in the output (or any unique
  prefix), instead of the full id.
- Mission Control: a summary bar, "Needs you" first with one action per item, conflicts written as
  problem statements, trust in words, explanations in every empty panel and help for each term.

`--json` output is unchanged.

## 0.1.1 — 2026-11-04

### Added

- `mindly init --agents <list>` connects 12 more agents through Mindly's MCP server: Windsurf,
  Kiro, Gemini CLI, VS Code (GitHub Copilot), Cline, Roo Code, Claude Desktop, OpenCode, Zed, Amp,
  Augment (Auggie CLI) and LM Studio. Comments and other settings in their config files are kept
  byte for byte, and `mindly uninstall` restores the original file.
- `mindly init --list-agents` shows every supported agent and its integration level.

### Changed

- The README now leads with the problem, real examples and installation.

## 0.1.0 — 2026-11-04

First public release: shared memory, live coordination and insight for Claude Code, Codex and
Cursor, with Mission Control, an MCP server and a local daemon. Also published as the now
deprecated `mindly-agents`.
