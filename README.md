# Mindly

**One shared brain for every coding agent you run.**

Mindly keeps Claude Code, Codex, Cursor and any MCP-capable agent in sync: what the project knows,
what each agent is doing right now, and what just changed that the others need to know. It runs
entirely on your machine. No account, no server, no telemetry.

> Status: pre-release. APIs and storage format may change before 1.0.

## Why

Running several agents in parallel saves time until they step on each other: one renames an API
while another builds against the old shape, you repeat "we use pnpm" to every new session, and
when one agent hits its usage limit you re-explain the whole task to the next. Mindly removes
that overhead.

## What it does

**Shared memory**

- **Zero-prompt context** – new sessions start knowing your conventions, active work and recent
  decisions.
- **Say it once** – correct one agent ("no, use pnpm") and every agent follows the rule from then on.
- **Trust layer** – every memory is labelled `verified`, `approved`, `proposed` or `stale`, with its
  source, so one agent's guess never becomes everyone's fact.
- **Self-healing memory** – memories are tied to evidence in the code and flagged when it changes.
- **Executable memory** – turn a decision into a check ("login returns `user.role`") that is
  re-verified on every edit.
- **Mistake memory** – failed approaches are remembered and surfaced before an agent repeats them.
- **Memory branches** and **time travel** – memories follow git branches; every change is versioned.

**Live coordination**

- **Intent ledger** – agents declare what they are about to change; clashes are caught before any
  code is written.
- **Agent telepathy** – when one agent changes something another depends on, the other learns about
  it at its next step.
- **Impact radar** – export-surface diffs and the import graph tell you exactly who is affected.
- **Shadow merge** – every agent's work is merged and type-checked in the background, continuously.
- **Rate-limit failover** – when one agent hits its limit, another resumes at the same step.
- **Handoffs** – move an unfinished task between agents with plan, progress and blockers.

**Insight**

- **Mission Control** – a live local dashboard of every agent, task, intent and conflict.
- **Code provenance** – `mindly why src/auth.ts:42` shows which agent wrote a line and why.
- **Context X-Ray** – see exactly what context an agent received, and what it missed.
- **Cross-agent review** – one agent reviews another's diff automatically.
- **A/B replay** – rerun a task with a different agent from the same commit and compare.
- **Time machine** – snapshot code + memory + task state together; branch or rewind safely.
- **Morning standup** – a two-minute digest of what your agents did and what needs you.
- **Phone pager** – optional push notification when an agent is blocked or needs approval.

## Quick start

Requires Node.js 22.13 or newer and git.

```bash
npx mindly-cli init
```

`init` detects installed agents (or take `--agents claude-code,codex,cursor`), shows every file
and line it will change, asks for confirmation, and initialises local storage in `~/.mindly`. Use
`--project` to configure only the current repository and `--dry-run` to preview. Codex asks you to
approve new hooks once with `/hooks`. Then open your agents in the same project as usual.
`mindly doctor` checks the setup; `mindly uninstall` removes it again.

## Commands

Run inside a project; every read command takes `--json`.

```bash
mindly status                      # live agents, tasks, intents, conflicts, what needs you
mindly dashboard                   # open Mission Control (starts the daemon if needed)
mindly memory list|search <q>|show <id>
mindly memory add --kind rule --title "Use pnpm" [--scope 'src/**'] [--enforce] [--pin]
mindly memory approve|reject|archive|forget <id>
mindly rules [--approve <id>]      # approved and proposed rules
mindly why <file>:<line>           # which agent wrote a line, and why
mindly xray [--session <id>] [--query <q>]   # what context an agent got, or missed
mindly standup [--since 24h]       # what happened and what needs you
mindly handoff --summary "..." [--to codex]  # and: mindly handoffs
mindly snapshot create <label>|list|diff <id>|restore <id> [--branch <name>]
mindly conflicts [--all]           # and: mindly conflict <id> resolve|dismiss|ack
mindly trust [--show|--revoke]     # review and trust .mindly/config.json checks
mindly contract add <memoryId> --kind pattern_present --path src/x.ts --pattern 'role'
mindly review --session <id> --reviewer codex
mindly replay --prompt "..." --agents claude-code,codex
mindly export [--out file]         # JSON, mode 0600; mindly forget --project deletes
mindly daemon start|stop|status    # optional background daemon
mindly config get|set|path         # ~/.mindly/config.json, validated
```

Exit codes: 0 ok, 1 error, 2 usage. Output is plain text without colour when not on a terminal or
when `NO_COLOR` is set. Agents call `mindly hook <agent> <event>` and `mindly mcp --agent <agent>`
themselves; hooks fail open and never block an agent.

## Security and privacy

Everything stays in `~/.mindly` on your machine. Memory is always treated as data, never as
instructions. Secrets are redacted before storage. A freshly cloned repository cannot make Mindly
run commands until you explicitly trust it. Read the full [security model](docs/security.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Contributing](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE)
