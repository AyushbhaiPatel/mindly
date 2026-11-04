# Synapse

**One shared brain for every coding agent you run.**

Synapse keeps Claude Code, Codex, Cursor and any MCP-capable agent in sync: what the project knows,
what each agent is doing right now, and what just changed that the others need to know. It runs
entirely on your machine. No account, no server, no telemetry.

> Status: pre-release. APIs and storage format may change before 1.0.

## Why

Running several agents in parallel saves time until they step on each other: one renames an API
while another builds against the old shape, you repeat "we use pnpm" to every new session, and
when one agent hits its usage limit you re-explain the whole task to the next. Synapse removes
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
- **Code provenance** – `synapse why src/auth.ts:42` shows which agent wrote a line and why.
- **Context X-Ray** – see exactly what context an agent received, and what it missed.
- **Cross-agent review** – one agent reviews another's diff automatically.
- **A/B replay** – rerun a task with a different agent from the same commit and compare.
- **Time machine** – snapshot code + memory + task state together; branch or rewind safely.
- **Morning standup** – a two-minute digest of what your agents did and what needs you.
- **Phone pager** – optional push notification when an agent is blocked or needs approval.

## Quick start

Requires Node.js 22.13 or newer and git.

```bash
npx synapse-agents init
```

`init` detects installed agents, shows the exact hook and MCP configuration it will add, asks for
confirmation, and initialises local storage in `~/.synapse`. Then open Claude Code and Codex in the
same project as usual.

```bash
synapse status          # agents, tasks and conflicts for this project
synapse dashboard       # open Mission Control
synapse why <file>:<n>  # provenance for a line
synapse standup         # what happened since yesterday
```

## Security and privacy

Everything stays in `~/.synapse` on your machine. Memory is always treated as data, never as
instructions. Secrets are redacted before storage. A freshly cloned repository cannot make Synapse
run commands until you explicitly trust it. Read the full [security model](docs/security.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Contributing](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE)
