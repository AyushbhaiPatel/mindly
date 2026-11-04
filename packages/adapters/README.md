# @synapse/adapters

Per-agent hook translators and installers for Claude Code, Codex and Cursor. Each adapter
implements `AgentAdapter` from `@synapse/core` (`packages/core/src/hooks.ts`):

- `parse(nativeEvent, payload)` turns a native hook payload into a `NormalizedHookEvent`, or
  returns `null` (never throws) for unknown events or payloads missing the session id / cwd.
- `render(event, result)` produces the exact stdout each agent expects. An empty result prints
  nothing. Exit code is always 0; denials use the agent's JSON fields, never exit code 2.
- `planInstall` / `planUninstall` compute `InstallStep`s that merge Synapse's hooks and MCP
  server into the agent's config without touching user entries. `applyInstallSteps` writes them
  atomically, keeps a `<file>.<timestamp>.bak` backup, and refuses if a file changed after planning.

Hooks run `<command> hook <agent> <NativeEvent>`; the MCP server is `<command> mcp --agent <agent>`.
Each argv element is POSIX single-quoted when needed; argv containing CR, LF or NUL is rejected.
Uninstall removes hook entries whose command contains `hook <agent> <event>` and the MCP server
named `synapse`.

## Agents

| Agent       | Hook config                                                                    | MCP config                                        |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| Claude Code | `~/.claude/settings.json` or `<project>/.claude/settings.json`                 | `~/.claude.json` (user) or `<project>/.mcp.json`  |
| Codex       | `$CODEX_HOME/hooks.json` (default `~/.codex`) or `<project>/.codex/hooks.json` | `config.toml` next to it, `[mcp_servers.synapse]` |
| Cursor      | `~/.cursor/hooks.json` or `<project>/.cursor/hooks.json`                       | `mcp.json` next to it                             |

**Claude Code** events: `SessionStart`, `UserPromptSubmit`, `PreToolUse` / `PostToolUse` /
`PostToolUseFailure` (matcher `Edit|MultiEdit|Write|NotebookEdit|Bash`), `Stop`, `SessionEnd`.
Context goes out as `hookSpecificOutput.additionalContext` (capped at 10 000 characters, the
documented limit); `deny`/`ask` as `permissionDecision`; user notices as `systemMessage`. Stop never
gets `additionalContext` because that would keep Claude working.

**Codex** events: `SessionStart`, `UserPromptSubmit`, `PreToolUse` / `PostToolUse` (matcher
`^(Bash|apply_patch)$`), `Stop`, `SessionEnd` (3 s timeout, the documented maximum). `apply_patch`
envelopes are parsed into per-file edits (bounded to 2 MB input). Codex has no `ask` decision, so
`ask` is turned into context. Hooks are written to `hooks.json`; `config.toml` gets only a
marker-delimited `[mcp_servers.synapse]` block, leaving the rest of the file byte-for-byte intact.
Codex asks the user to review new non-managed hooks (`/hooks`) before they run, and loads
project-level `.codex/` config only for trusted projects.

**Cursor** events: `sessionStart` (context via `additional_context`), `beforeSubmitPrompt`,
`preToolUse` (`permission`, `user_message`, `agent_message`), `afterFileEdit`,
`afterShellExecution`, `postToolUseFailure` (`additional_context`), `stop`, `sessionEnd`.
`beforeShellExecution` and `postToolUse` are parsed but not installed (to avoid double counting).
`beforeSubmitPrompt` cannot add context, so prompt-time context reaches Cursor through MCP.

No adapter ever emits an `allow` decision: it would skip the agent's own permission prompt.

## Documentation used

- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Codex hooks: https://developers.openai.com/codex/hooks (redirects to https://learn.chatgpt.com/docs/hooks)
- Codex MCP: https://developers.openai.com/codex/mcp (redirects to https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- Cursor hooks: https://cursor.com/docs/agent/hooks
- Cursor MCP: https://cursor.com/docs/context/mcp

Read in November 2026. Where the docs were silent, the parsers accept both plausible spellings
(e.g. Codex `apply_patch` input as a string or argv array; Cursor `conversation_id` or
`session_id`) and ignore unknown fields.

## Assumptions not confirmed by the docs

- Codex `apply_patch` puts the patch text in `tool_input.command`; the docs name the field but not
  its exact shape, so arrays and `input` / `patch` keys are accepted too.
- Codex `tool_response` shape is undocumented; failure is inferred from `exit_code`, `success`,
  `is_error` or `error`.
- Cursor tool names in `preToolUse` and the payload of `postToolUseFailure` (we read
  `error_message` / `error`) are not fully specified.
- Codex hook commands are assumed to run through a shell (the docs' examples use shell syntax).
