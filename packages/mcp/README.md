# @mindly/mcp

MCP server (stdio) that lets any MCP client (Claude Code, Codex, Cursor and others) read and write
Mindly explicitly. Clients spawn it as `mindly mcp --agent <kind>`; for clients without hooks (for
example Cursor) it is the only integration.

```ts
import { createMcpServer, startMcpServer } from '@mindly/mcp';

await startMcpServer({ agentKind: 'cursor', cwd: process.cwd(), env: process.env }); // stdio
const server = createMcpServer(mindly, { agentKind: 'codex', cwd }); // any transport (tests)
```

A server works out once which session it speaks for and keeps it: a live session of the agent
kind that hooks created in the working tree of `cwd` and that no other running server speaks for,
otherwise a session of its own with external id `mcp-<pid>-<startTime>`. It chooses again only
when that session has ended, and a server on its own session moves to the client's hook session
once one exists. Two clients of the same agent kind therefore get a session each, and a second
window never takes over the first one's. When the client disconnects (stdin closes, the process
is signalled, the client stops reading) the server's own session is ended and its intents are
closed. `createMcp` returns the server together with that `release` call for other transports.

Logs go to `$MINDLY_HOME/logs/mindly.log`; stdout carries only the protocol.

## Tools

| Tool                    | Description                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `mindly_context`        | Current context for this agent (or memory relevant to `query`); delivers messages and picks up a waiting handoff, so it is not read-only. |
| `mindly_search_memory`  | Full-text memory search with kind and trust filters.                                                                                      |
| `mindly_remember`       | Store a fact, decision, note, mistake or rule, with optional file evidence/scope.                                                         |
| `mindly_update_memory`  | Refine or archive one of your own proposed memories.                                                                                      |
| `mindly_record_mistake` | Record what failed and what to do instead.                                                                                                |
| `mindly_add_contract`   | Bind a memory to a declarative repository check (no command contracts).                                                                   |
| `mindly_declare_intent` | Announce files/symbols you are about to change; returns overlap warnings.                                                                 |
| `mindly_task_create`    | Create a task with an optional plan.                                                                                                      |
| `mindly_task_update`    | Update a task's status, plan, blockers, title or description.                                                                             |
| `mindly_task_claim`     | Take ownership of a task.                                                                                                                 |
| `mindly_tasks`          | List tasks (by status, or only yours).                                                                                                    |
| `mindly_send_message`   | Message another agent kind or session (at most 20 per minute per server process).                                                         |
| `mindly_inbox`          | Unacknowledged messages for you, without marking them delivered.                                                                          |
| `mindly_ack`            | Acknowledge inbox items.                                                                                                                  |
| `mindly_handoff`        | Hand your work (summary, next steps, blockers) to the next session of another agent.                                                      |
| `mindly_why`            | Code provenance for `file` + `line`: which session and prompt wrote it.                                                                   |
| `mindly_status`         | Live agents, open conflicts and counts of items needing the user.                                                                         |

Inputs are validated with strict zod schemas; errors come back as MCP tool errors of the form
`<code>: <message>` (a `MindlyError` code, never a stack trace).

Paths are the agent's own: a relative path is read from `cwd`, and files are those of the working
tree the server runs in (a linked worktree when the client was started in one), as for hooks. They
must stay inside that tree, off the secret deny-list and out of the `.git` folder. Contracts are
the exception in one respect: they are always checked against the main checkout, and the tool says
so when the server runs in a linked worktree.

Intent summaries and symbols, messages and task descriptions are redacted before they are stored,
with the user's `redaction.extraPatterns` as well as the built-in rules.

## Trust model

Agent memories written through MCP are stored as `proposed` with the agent as source (only a fact
whose evidence excerpt matches the code becomes `verified`); only the user can approve memories,
and `enforce` rules and `command` contracts are never accepted here.
Stored content is always returned as delimited, sanitised reference data labelled with its trust
and source, exactly as the context renderer shows it, so it cannot pose as instructions.
