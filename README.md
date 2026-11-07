<div align="center">

<img src="docs/assets/logo.png" alt="Mindly logo: a lavender pixel-art elephant" width="96" height="96">

# Mindly

**Shared project memory for your coding agents, so they stop repeating mistakes and stop breaking each other's work.**

Claude Code, Codex, Cursor and Gemini CLI learn your project rules once, see what the other agents are
working on, and get a warning before they build on code another agent just changed.
Everything stays on your computer.

[![npm](https://img.shields.io/npm/v/mindly-cli?color=2b7489&label=npm)](https://www.npmjs.com/package/mindly-cli)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-43853d)](#install)

```bash
npx mindly-cli init
```

</div>

<p align="center"><img src="docs/assets/demo.svg" alt="Demo: Claude Code changes login() in src/auth.ts; before Codex edits src/dashboard.ts, which calls it, Mindly tells Codex about the change; mindly status and Mission Control show both agents and the open conflict." width="860"></p>

---

## Why

If you use more than one coding agent, you have probably seen this:

- You tell Claude Code "we use pnpm". The next day Codex runs `npm install` anyway.
- Claude renames a function while Codex is writing code that calls the old name.
- Claude hits its usage limit halfway through a task, and you explain everything again to Codex.
- Weeks later, nobody remembers why a line exists or which agent wrote it.

Each agent has its own memory and doesn't know the others exist. Mindly gives them one shared
memory and tells each of them what the others are doing.

## What it does

### You say it once, every agent knows

Correct one agent:

```text
you → Claude Code:  From now on always use pnpm, never npm.
```

From then on, every agent starts its sessions with this:

```text
## Project rules (from the user)
- [rule · user-approved · user] From now on always use pnpm, never npm
```

An agent can only _suggest_ a rule. Only you can approve one, so one agent's wrong guess doesn't
become an instruction for all of them.

### Agents hear about changes that affect them

Claude changes `login()` while Codex is editing a file that uses it. Before Codex's next step,
Mindly tells it:

```text
## Updates from other agents since your last turn
- [impact · from claude-code #7c3476be · just now] claude-code #7c3476be changed the exports of
  src/auth.ts — Changed signature: login. Your files that import it: src/dash.ts.
  Re-check usages of these exports before continuing.
```

### You see what every agent is doing

```text
$ mindly status
Agents (2)
  codex #dd7a9a10        active  main  0s ago
  claude-code #7c3476be  active  main  0s ago

Intents (1)
  Editing src/dash.ts (src/dash.ts)

Open conflicts (1)
  01a1a6c4…  warning  open  claude-code #7c3476be changed the exports of src/auth.ts
```

`mindly dashboard` opens the same view in your browser, live (Mission Control).

### You can ask who wrote a line, and why

```text
$ mindly why src/auth.ts:1
src/auth.ts:1  export function login(u: string, pw: string) {
Written by claude-code #7c3476be with Edit at 2026-11-04 19:04
  prompt: Add a password parameter to login
```

### New in 0.3: saves

`mindly saves` lists the times Mindly actually prevented a problem: a write blocked by your
rule, an agent warned about a changed function before it used it, a merge conflict found before
either branch was merged, and so on. A save counts only when the agent's later actions show the
problem was avoided. If there's no proof, it doesn't count. Each save shows the events behind it,
and `mindly saves reject <id>` removes one you disagree with.

`mindly saves card` makes an image of your saves to share. It shows counts and agent names only:
no project names, file paths or code.

### New in 0.3: split one goal between agents

```bash
mindly split "add billing: API, webhook handler, settings page"
```

An agent plans the work in read-only mode (or you pass your own plan with `--plan plan.json`).
You review the plan before anything is created. Then Mindly:

1. creates one git worktree and branch per part, next to your repository (your own checkout is
   not touched),
2. tells each agent which part is its job, which files it owns and what the parts agree on,
3. warns an agent that writes to another part's files (`--strict` blocks it instead),
4. checks in the background that all the parts still merge cleanly and pass your checks.

`mindly split status` shows how each part is going. `mindly split merge` merges the parts into one
new branch. It never pushes. `mindly split abort` removes only what the split created.

### New: find the edit that broke it

```bash
mindly bisect -- pnpm test
```

Agents make dozens of edits between commits, often several agents in the same checkout, so when a
test breaks `git bisect` cannot tell you which edit did it. Mindly can: it keeps a checkpoint of
the code after every agent edit (a hidden git commit in your repository, so unchanged files cost
nothing, and your branch, index and files are never touched). `mindly bisect` checks out those
checkpoints one by one in a scratch folder, runs your command there (exit 0 is good, 125 is skip,
anything else is bad, like `git bisect run`), and binary-searches to the first step that fails.
It re-runs the two steps around the answer so a flaky test cannot get an agent blamed, and it
tells you who made the edit, from which prompt, and which rules were in effect:

```text
Broke at step 87 of 140 · 6 runs · 41s
  codex #dd7a9a10 · Edit src/auth.ts · 14:32
  prompt: make login faster, skip the db lookup
  rules in effect for src/auth.ts then: login must return user.role (it was told)
  last good: step 86 (claude-code #7c34 · Edit src/ui/nav.tsx)
-> mindly bisect show 87 --patch     see exactly what changed
-> mindly bisect revert 87           undo only that edit in your checkout
```

`mindly bisect list` shows the steps of the last 24 hours, `mindly bisect show <step>` one step
with its diff, and `mindly bisect revert <step>` undoes that one edit in your checkout after
showing you the patch (never a commit, never a reset). A reliable result is remembered as a
mistake in the project's memory so the agents are warned before they repeat it. Checkpoints are
kept 14 days (`checkpoints.keepDays`) and can be turned off with `checkpoints.enabled`.

### Which agent is better at what, in your repo

```bash
mindly track
```

If you use several agents on the same code, you probably pick one by gut feeling. Mindly already
knows what each agent edited and what went wrong afterwards, so it can show you, folder by folder,
how often each agent's edits broke something in this repository:

```text
Track record · last 30 days · 2 agents · 1,284 edits

src/api
  codex        212 edits   broke 1 (0.5%) · kept 91% of 1,940 lines
  claude-code  188 edits   broke 7 (3.7%) · kept 84% of 2,210 lines
  -> codex breaks less here (clear difference)

src/ui
  claude-code  301 edits   broke 2 (0.7%) · kept 88% of 3,105 lines
  cursor        44 edits   broke 1 (2.3%) · kept 79% of 512 lines
  -> no clear difference yet

Usage limits: claude-code 3 of 41 sessions · codex 0 of 22
```

"Broke" adds up the edits that `mindly bisect` found broke a check, the recorded decisions an
edit broke, and failed merge checks. "Kept" is how many of the lines an agent wrote at least a week
ago are still in the code (later rewrites count as not kept). The numbers are meant to be honest:

- **Counts are always shown.** Every rate comes with what it counts ("broke 2 of 41 edits"), and
  there is no overall score or "best agent".
- **No rate without enough data.** An agent needs at least 20 edits and 3 sessions in a folder
  before any rate is shown there; until then it says "not enough data yet".
- **No clear difference means none.** Agents are compared only when their 95% confidence
  intervals do not overlap; otherwise Mindly says "no clear difference yet".
- **Only what is pinned to one agent counts.** A problem involving several sessions, or a change
  made outside any agent, counts for nobody.

`mindly track --area src/api --explain` shows one folder with the exact definition of each
number; `--since 90d`, `--agent codex` and `--json` work too. When you `mindly split` a goal and
one agent clearly breaks less in a folder a part owns, the plan review says so next to that part
(it never changes the plan for you). The track record stays on your machine and is never part of
a saves card.

## Install

You need **Node.js 22.13 or newer** and **git**, on macOS or Linux.

```bash
npx mindly-cli init
```

or install the `mindly` command globally:

```bash
npm i -g mindly-cli
mindly init
```

`init` finds the agents you have installed, shows every file and line it will change, and asks
before writing anything. Then use your agents as usual. There is nothing else to start.

- `--project` sets up only the current repository. `--dry-run` shows the changes without making
  them.
- Inside a repository, `init` offers to import the rules you already wrote in `CLAUDE.md`,
  `AGENTS.md`, `.cursorrules` and similar files. Mindly can also keep your approved rules written
  back into those files. See [docs/rules.md](docs/rules.md).
- `mindly doctor` checks the setup. `mindly uninstall` removes everything Mindly added.
- Config files that are symlinks (stow, chezmoi and other dotfile managers) stay symlinks. If a
  config file is read-only (for example from Nix home-manager), Mindly skips that agent and prints
  the lines to add yourself.

### Supported agents

| Agent                                                                                                                                          | How it connects | What you get                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| Claude Code, Codex CLI, Cursor, Gemini CLI                                                                                                     | hooks + MCP     | Everything works automatically: memory, warnings, tracking, rule enforcement |
| Windsurf, Kiro, VS Code (GitHub Copilot), Cline, Roo Code, Claude Desktop, OpenCode, Zed, Amp, Augment (Auggie CLI), LM Studio, any MCP client | MCP tools only  | The agent can read and add memory, but only when it calls Mindly's tools     |

Claude Code is the most tested. Codex asks you to approve its hooks once with `/hooks`.

For the MCP-only agents, add a line such as "Call `mindly_context` at the start of each task" to
that agent's rules file, or it won't check Mindly. `mindly init --list-agents` prints the names to
pass to `--agents` (for example `mindly init --agents windsurf,gemini`). `init` changes only the
`mindly` entry in each config file and keeps your comments, other servers and formatting.

<details>
<summary>Adding an MCP client that isn't listed</summary>

Add a stdio server to the client's MCP config. Most clients use this shape (use the full path from
`which mindly` if the client doesn't see your `PATH`):

```json
{
  "mcpServers": {
    "mindly": { "command": "mindly", "args": ["mcp", "--agent", "my-agent"] }
  }
}
```

`--agent` is any short lowercase name. It is how the client shows up in Mindly.

</details>

<details>
<summary>Claude Code status line</summary>

`init` also adds a line to the bottom of Claude Code:

```
mindly · 2 saves today · 3 rules · 1 update · 0 conflicts
```

That shows today's saves (when there are any), the rules in effect, updates from other agents waiting for this session,
and conflicts that need you. It only reads, refreshes every 10 seconds, and shows just `mindly` if
something goes wrong.

If you already have a status line, `init` leaves it alone. To show both, pass the same input to
`mindly statusline` from your own script:

```bash
#!/bin/bash
input=$(cat)
mine=$(printf '%s' "$input" | ~/.claude/my-statusline.sh)
printf '%s · %s\n' "$mine" "$(printf '%s' "$input" | mindly statusline)"
```

`mindly init --no-statusline` skips it.

</details>

## Everything else it can do

**Memory**

- **Session start:** every new session gets your rules, recent decisions, work in progress and
  open conflicts.
- **Labels on everything:** each memory says who it came from and whether it is approved by you,
  confirmed by the code, only proposed, or possibly outdated.
- **Outdated notes are flagged:** a memory is linked to the code it describes and gets flagged
  when that code changes.
- **Decisions that check themselves:** turn a decision ("login returns `user.role`") into a check
  that runs after every edit (`mindly contract`).
- **Failed commands are remembered:** before an agent runs a command that failed before, it is
  told what went wrong.
- **History:** memories follow your git branches, and every change to them is kept.

**Working together**

- **Who's editing what:** agents' in-progress edits are tracked, and two agents heading for the
  same file get a warning.
- **Background merge check:** when agents work in separate worktrees, Mindly regularly checks in
  the background that their work still merges and passes your checks.
- **Usage-limit handoff:** when an agent hits its usage limit, the next agent gets the goal, the
  plan, the files touched and the next steps.
- **Handoffs:** pass an unfinished task to another agent (`mindly handoff`).

**Looking back**

- **What an agent was told:** `mindly xray` shows the exact context a session received, and why a
  memory did not reach it.
- **Second opinion:** one agent reviews another agent's changes, read-only (`mindly review`).
- **Compare agents:** run the same prompt with several agents from the same commit
  (`mindly replay`).
- **Snapshots:** save memory, tasks and code together, and restore them to a new branch
  (`mindly snapshot`).
- **Daily summary:** what your agents did and what needs you (`mindly standup`).
- **Notifications:** optional desktop, ntfy or webhook alerts when an agent is stuck or hits its
  limit. Off by default.

## How it works

```text
 Claude Code      Codex        Cursor / any MCP client
     │ hooks        │ hooks          │ MCP
     └──────────────┴────────────────┘
                    │
             mindly (on your machine)
                    │
     ┌──────────────┴──────────────┐
     │  memory · rules · who's     │      optional background service:
     │  editing what · warnings    │ ───▶ dashboard, merge checks,
     └──────────────┬──────────────┘      daily summary
                    │
            ~/.mindly/mindly.db (a SQLite file on your machine)
```

Agents call Mindly through their own hooks at session start, on each prompt, and around each
tool call. Mindly answers with a short block of context that is marked as reference information,
not as instructions. More detail in [docs/architecture.md](docs/architecture.md).

## Commands

```bash
mindly status                       # agents, tasks, edits in progress, conflicts, what needs you
mindly dashboard                    # open Mission Control in the browser
mindly saves [--since 7d]           # times Mindly prevented a problem, with proof
mindly saves card --out saves.svg   # an image of your saves to share
mindly split "<goal>"               # divide a goal between agents in separate worktrees
mindly split status|check|merge|abort
mindly bisect -- <command>          # the agent edit that broke a command, who made it and why
mindly bisect list|show <step>|revert <step>
mindly track [--area src/api]       # which agent breaks less where in this repo, as counts
mindly rules [--approve <id>]       # project rules, approved and proposed
mindly rules import [--dry-run]     # import rules from CLAUDE.md, AGENTS.md, .cursorrules, …
mindly rules sync [--dry-run|--off] # keep approved rules in AGENTS.md, CLAUDE.md, GEMINI.md
mindly memory list|search <q>|show <id>|add|approve|reject|archive|forget
mindly why <file>:<line>            # who wrote a line, and why
mindly xray [--session <id>]        # what context an agent got
mindly standup [--since 24h]        # daily summary
mindly conflicts                    # open conflicts; mindly conflict <id> resolve|dismiss|ack
mindly handoff --summary "…" [--to codex]
mindly snapshot create|list|diff|restore
mindly review --session <id> --reviewer codex
mindly replay --prompt "…" --agents claude-code,codex
mindly trust                        # review and allow this repo's .mindly/config.json checks
mindly export | forget              # get your data as JSON, or delete it
mindly doctor | config | daemon start|stop|status
```

Most commands take `--json`. Run `mindly <command> --help` for all options.

## Privacy and security

- **Nothing leaves your machine.** Everything is stored in `~/.mindly`, readable only by you. No
  account, no server, no telemetry. Features that use a language model are off by default and use
  your own API key or a local model.
- **Secrets are removed** before anything is saved, and secret files (`.env`, keys, credentials)
  are never read. Checkpoints for `mindly bisect` are git commits inside your own repository,
  under hidden refs a normal `git push` never sends, and they leave secret files out.
- **Agents can't make rules on their own.** They can only suggest; you approve. Everything Mindly
  gives an agent is labelled as reference information, so text in a malicious README or web page
  can't become an instruction for all your agents.
- **A repository can't run commands on your machine through Mindly.** Checks defined in
  `.mindly/config.json` run only after you review and trust that exact version (`mindly trust`).
- **The dashboard** listens only on `127.0.0.1` and needs a one-time login code.

Full details: [docs/security.md](docs/security.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## FAQ

**Does it slow my agents down?** A little. Each hook call takes about 0.2 seconds on a laptop, most
of it starting Node. If Mindly fails or doesn't answer within 10 seconds, the agent carries on
without it.

**Does it send my code anywhere?** No. Nothing leaves your machine unless you set up a language
model provider or a notification channel yourself.

**Do I need to keep something running?** No. Memory, rules and warnings work without the
background service. It's only needed for the dashboard and the background jobs (merge checks,
daily summary). `mindly dashboard` starts it for you.

**What if an agent learns something wrong?** It stays marked as proposed and unverified. Reject it
with `mindly memory reject <id>` and it won't be shown again.

**Can I remove it?** Yes. `mindly uninstall` removes the hooks and config entries it added, and
`mindly forget --project` deletes everything Mindly stored for the project.

## Status

Mindly is **before 1.0**. It works and has 950 automated tests, but the storage format and
commands may still change between versions. Bug reports and feedback are very welcome.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Setup is `pnpm install && pnpm check`.

## License

[Apache-2.0](LICENSE)
