<div align="center">

# Mindly

**One shared brain for every coding agent you run.**

Claude Code, Codex and Cursor remember your project, see what each other is doing,<br>
and hear about changes that affect them before they write broken code.

[![npm](https://img.shields.io/npm/v/mindly-cli?color=2b7489&label=npm)](https://www.npmjs.com/package/mindly-cli)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-43853d)](#install)
![local-first](https://img.shields.io/badge/runs-100%25%20local-6f42c1)

```bash
npx mindly-cli init
```

</div>

---

## The problem

Running several agents at once is fast until they step on each other:

- You tell Claude Code "we use pnpm". Tomorrow Codex runs `npm install` anyway.
- Claude renames an API while Codex is building a page against the old one.
- Claude hits its usage limit halfway through a task, and you re-explain everything to Codex.
- Three weeks later nobody remembers _why_ a line exists, or which agent wrote it.

Each agent has its own memory and no idea the others exist. Mindly gives them a shared one.

## What it looks like

**Say it once.** You correct one agent:

```text
you → Claude Code:  From now on always use pnpm, never npm.
```

Every other agent, now and in future sessions, starts with this in its context:

```text
## Project rules (from the user)
- [rule · user-approved · user] From now on always use pnpm, never npm
```

**Catch breakage before it happens.** Claude changes `login()` while Codex is editing a file that
imports it. On its very next step, Codex is told:

```text
## Updates from other agents since your last turn
- [impact · from claude-code #7c3476be · just now] claude-code #7c3476be changed the exports of
  src/auth.ts — Changed signature: login. Your files that import it: src/dash.ts.
  Re-check usages of these exports before continuing.
```

**See everything at a glance.**

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

**Know who wrote what, and why.**

```text
$ mindly why src/auth.ts:1
src/auth.ts:1  export function login(u: string, pw: string) {
Written by claude-code #7c3476be with Edit at 2026-11-04 19:04
  prompt: Add a password parameter to login
```

## Install

Requires **Node.js 22.13+** and **git**. macOS and Linux.

```bash
npx mindly-cli init            # connect your agents (asks before changing anything)
```

or install it globally and use the `mindly` command:

```bash
npm i -g mindly-cli
mindly init
```

`init` detects your agents, shows every file and line it will change, and asks before writing.
Use `--project` to set up only the current repository and `--dry-run` to preview. Then open your
agents as usual; there is nothing else to run. `mindly doctor` checks the setup and
`mindly uninstall` removes it.

| Agent                    | Integration | Status                                           |
| ------------------------ | ----------- | ------------------------------------------------ |
| Claude Code              | hooks + MCP | tested end to end                                |
| Codex CLI                | hooks + MCP | supported (approve the hooks once with `/hooks`) |
| Cursor                   | hooks + MCP | supported                                        |
| Windsurf                 | MCP tools   | supported                                        |
| Kiro                     | MCP tools   | supported                                        |
| Gemini CLI               | MCP tools   | supported                                        |
| VS Code (GitHub Copilot) | MCP tools   | supported                                        |
| Cline                    | MCP tools   | supported                                        |
| Roo Code                 | MCP tools   | supported                                        |
| Claude Desktop           | MCP tools   | supported                                        |
| OpenCode                 | MCP tools   | supported                                        |
| Zed                      | MCP tools   | supported                                        |
| Amp                      | MCP tools   | supported                                        |
| Augment (Auggie CLI)     | MCP tools   | supported                                        |
| LM Studio                | MCP tools   | supported                                        |
| Any other MCP client     | MCP tools   | supported (manual config, below)                 |

`mindly init --list-agents` prints the agent names to pass to `--agents` (for example
`mindly init --agents windsurf,gemini`). Hook agents capture work and receive context
automatically. MCP-only clients get Mindly's tools but no automatic capture, so add a line such as
"Call `mindly_context` at the start of each task" to that agent's rules or instructions file.
`init` edits only the `mindly` entry in each config file and keeps comments, other servers and
formatting as they are.

### Other MCP clients

For a client not in the list, add a stdio server to its MCP config. Most use this shape (run
`which mindly` for the absolute path if the client does not inherit your `PATH`):

```json
{
  "mcpServers": {
    "mindly": { "command": "mindly", "args": ["mcp", "--agent", "my-agent"] }
  }
}
```

`--agent` is a short lowercase name you choose; it labels the client in Mindly's status views.

## Features

**Shared memory**

- **Zero-prompt context:** new sessions start knowing your rules, decisions, active work and
  open conflicts.
- **Say it once:** corrections like "no, use pnpm" become project rules for every agent.
- **Trust layer:** every memory is labelled `user-approved`, `verified in code`, `proposed` or
  `stale`, with its source, so one agent's guess never becomes everyone's fact.
- **Self-healing memory:** memories are tied to evidence in the code and flagged when it changes.
- **Executable memory:** turn a decision into a check ("login returns `user.role`") that runs on
  every edit.
- **Mistake memory:** failed commands are remembered and surfaced before another agent repeats
  them.
- **Memory branches and time travel:** memories follow git branches; every change is versioned.

**Live coordination**

- **Intent ledger:** agents' in-progress edits are tracked; overlapping work is flagged before it
  collides.
- **Agent telepathy:** updates reach other agents at their next step.
- **Impact radar:** changed exports plus the import graph tell an agent which of _its_ files
  are affected.
- **Shadow merge:** with agents in separate worktrees, their work is merged and checked in the
  background, continuously.
- **Rate-limit failover:** when one agent hits its usage limit, the next one is briefed with the
  goal, plan, files and next steps.
- **Handoffs:** move an unfinished task between agents.

**Insight**

- **Mission Control** (`mindly dashboard`): a live local dashboard of agents, tasks, conflicts,
  memory and runs.
- **Code provenance** (`mindly why file:line`): which agent wrote a line, when, and from which
  prompt.
- **Context X-Ray** (`mindly xray`): exactly what context an agent received, and what it missed.
- **Cross-agent review:** one agent reviews another's changes, read-only.
- **A/B replay:** rerun a task with different agents from the same commit and compare.
- **Time machine** (`mindly snapshot`): snapshot memory, tasks and code together; restore safely
  to a new branch.
- **Morning standup** (`mindly standup`): what your agents did and what needs you.
- **Phone pager:** optional notifications (desktop, ntfy, webhook) when an agent is blocked or
  rate-limited.

## How it works

```text
 Claude Code      Codex        Cursor / any MCP client
     │ hooks        │ hooks          │ MCP
     └──────────────┴────────────────┘
                    │
             mindly (local CLI)
                    │
     ┌──────────────┴──────────────┐
     │  engine: memory · rules ·   │      optional: mindly daemon
     │  intents · impact · handoff │ ───▶ dashboard, shadow merge,
     └──────────────┬──────────────┘      checks, standup
                    │
            ~/.mindly/mindly.db (SQLite, on your machine)
```

Agents call Mindly through their own hook systems on every session start, prompt and file edit.
Mindly answers with a short, ranked block of context, labelled as reference data, never as
instructions. Hooks are fast (about 100 ms) and **fail open**: if anything goes wrong, the agent
simply continues. More in [docs/architecture.md](docs/architecture.md).

## Commands

```bash
mindly status                       # agents, tasks, intents, conflicts, what needs you
mindly dashboard                    # open Mission Control in the browser
mindly rules [--approve <id>]       # project rules, approved and proposed
mindly memory list|search <q>|show <id>|add|approve|reject|archive|forget
mindly why <file>:<line>            # who wrote a line, and why
mindly xray [--session <id>]        # what context an agent got
mindly standup [--since 24h]        # daily digest
mindly conflicts                    # open conflicts; mindly conflict <id> resolve|dismiss|ack
mindly handoff --summary "…" [--to codex]
mindly snapshot create|list|diff|restore
mindly review --session <id> --reviewer codex
mindly replay --prompt "…" --agents claude-code,codex
mindly trust                        # review and allow this repo's .mindly/config.json checks
mindly export | forget              # your data, as JSON or gone
mindly doctor | config | daemon start|stop|status
```

Every read command takes `--json`. Run `mindly <command> --help` for options.

## Privacy and security

- **Local only.** Everything lives in `~/.mindly` (owner-only permissions). No account, no
  server, no telemetry. Optional model features use your own API key or a local model, and are
  off by default.
- **Secrets are redacted** before anything is stored, and secret files (`.env`, keys,
  credentials) are never read.
- **Memory is data, not instructions.** Agents can only _propose_; only you approve rules.
  Context is clearly labelled, so a malicious README or web page can't turn into a rule for every
  agent.
- **Untrusted repos can't run commands.** Checks in `.mindly/config.json` run only after you
  review and trust that exact version.
- The dashboard listens on `127.0.0.1` only and requires a one-time login code.

Full threat model: [docs/security.md](docs/security.md). Found a vulnerability? See
[SECURITY.md](SECURITY.md).

## FAQ

**Does it slow my agents down?** Hooks add about 100 ms per event and never block: on any error
or timeout the agent carries on without Mindly.

**Does it send my code anywhere?** No. Nothing leaves your machine unless you configure an LLM
provider or a notification channel yourself.

**Do I need the daemon?** No. Memory and coordination work without it; the daemon adds the
dashboard and background jobs (shadow merge, checks, standup).

**What if an agent learns something wrong?** It stays `proposed` and is labelled as unverified.
Reject it with `mindly memory reject <id>` and it is never shown again.

## Status

Mindly is **pre-1.0**: it works and is tested (480+ tests, a security review, live runs with
Claude Code), but storage and APIs may still change. Feedback and bug reports are very welcome.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Setup is `pnpm install && pnpm check`.

## License

[Apache-2.0](LICENSE)
