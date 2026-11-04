# @mindly/mcp

MCP server (stdio) that lets any MCP client (Claude Code, Codex, Cursor and others) read and write
Mindly explicitly. Clients spawn it as `mindly mcp --agent <kind>`; for clients without hooks (for
example Cursor) it is the only integration.

```ts
import { createMcpServer, startMcpServer } from '@mindly/mcp';

await startMcpServer({ agentKind: 'cursor', cwd: process.cwd(), env: process.env }); // stdio
const server = createMcpServer(mindly, { agentKind: 'codex', cwd }); // any transport (tests)
```

The calling session is resolved on every call: the most recently active live session of the
agent kind in the project for `cwd` (hook sessions first), otherwise a session with external id
`mcp-<pid>-<startTime>`. Logs go to `$MINDLY_HOME/logs/mindly.log`; stdout carries only the
protocol.

## Tools

| Tool                    | Description                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `mindly_context`        | Current context for this agent (or memory relevant to `query`); delivers messages.   |
| `mindly_search_memory`  | Full-text memory search with kind and trust filters.                                 |
| `mindly_remember`       | Store a fact, decision, note, mistake or rule, with optional file evidence/scope.    |
| `mindly_update_memory`  | Refine or archive one of your own proposed memories.                                 |
| `mindly_record_mistake` | Record what failed and what to do instead.                                           |
| `mindly_add_contract`   | Bind a memory to a declarative repository check (no command contracts).              |
| `mindly_declare_intent` | Announce files/symbols you are about to change; returns overlap warnings.            |
| `mindly_task_create`    | Create a task with an optional plan.                                                 |
| `mindly_task_update`    | Update a task's status, plan, blockers, title or description.                        |
| `mindly_task_claim`     | Take ownership of a task.                                                            |
| `mindly_tasks`          | List tasks (by status, or only yours).                                               |
| `mindly_send_message`   | Message another agent kind or session (at most 20 per minute per server process).    |
| `mindly_inbox`          | Unacknowledged messages for you, without marking them delivered.                     |
| `mindly_ack`            | Acknowledge inbox items.                                                             |
| `mindly_handoff`        | Hand your work (summary, next steps, blockers) to the next session of another agent. |
| `mindly_why`            | Code provenance for `file` + `line`: which session and prompt wrote it.              |
| `mindly_status`         | Live agents, open conflicts and counts of items needing the user.                    |

Inputs are validated with strict zod schemas; errors come back as MCP tool errors of the form
`<code>: <message>` (a `MindlyError` code, never a stack trace). Paths must stay inside the project
and off the secret deny-list.

## Trust model

Agent memories written through MCP are stored as `proposed` with the agent as source (only a fact
whose evidence excerpt matches the code becomes `verified`); only the user can approve memories,
and `enforce` rules and `command` contracts are never accepted here.
Stored content is always returned as delimited, sanitised reference data labelled with its trust
and source, exactly as the context renderer shows it, so it cannot pose as instructions.
