# @mindly/adapters

Per-agent hook translators and installers for Claude Code, Codex, Cursor and Gemini CLI, plus
MCP-only installers for a catalog of other MCP clients (see [MCP-only clients](#mcp-only-clients)).
Each adapter implements `AgentAdapter` from `@mindly/core` (`packages/core/src/hooks.ts`):

- `parse(nativeEvent, payload)` turns a native hook payload into a `NormalizedHookEvent`, or
  returns `null` (never throws) for unknown events or payloads missing the session id / cwd.
- `render(event, result)` produces the exact stdout each agent expects. An empty result prints
  nothing. Exit code is always 0; denials use the agent's JSON fields, never exit code 2.
- `planInstall` / `planUninstall` compute `InstallStep`s that merge Mindly's hooks and MCP
  server into the agent's config without touching user entries. `applyInstallSteps` writes them
  atomically, keeps a `<file>.<timestamp>.bak` backup, and refuses if a file changed after planning.

Hooks run `<command> hook <agent> <NativeEvent>`; the MCP server is `<command> mcp --agent <agent>`.
Each argv element is POSIX single-quoted when needed; argv containing CR, LF or NUL is rejected.
Uninstall removes hook entries whose command contains `hook <agent> <event>` and the MCP server
named `mindly`.

## Agents

| Agent       | Hook config                                                                    | MCP config                                       |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Claude Code | `~/.claude/settings.json` or `<project>/.claude/settings.json`                 | `~/.claude.json` (user) or `<project>/.mcp.json` |
| Codex       | `$CODEX_HOME/hooks.json` (default `~/.codex`) or `<project>/.codex/hooks.json` | `config.toml` next to it, `[mcp_servers.mindly]` |
| Cursor      | `~/.cursor/hooks.json` or `<project>/.cursor/hooks.json`                       | `mcp.json` next to it                            |
| Gemini CLI  | `~/.gemini/settings.json` or `<project>/.gemini/settings.json`, key `hooks`    | the same file, key `mcpServers`                  |

**Claude Code** events: `SessionStart`, `UserPromptSubmit`, `PreToolUse` / `PostToolUse` /
`PostToolUseFailure` (matcher `Edit|MultiEdit|Write|NotebookEdit|Bash`), `Stop`, `SessionEnd`.
Context goes out as `hookSpecificOutput.additionalContext` (capped at 10 000 characters, the
documented limit); `deny`/`ask` as `permissionDecision`; user notices as `systemMessage`. Stop never
gets `additionalContext` because that would keep Claude working.

**Codex** events: `SessionStart`, `UserPromptSubmit`, `PreToolUse` / `PostToolUse` (matcher
`^(Bash|apply_patch)$`), `Stop`, `SessionEnd` (3 s timeout, the documented maximum). `apply_patch`
envelopes are parsed into per-file edits (bounded to 2 MB input). Codex has no `ask` decision, so
`ask` is turned into context. Hooks are written to `hooks.json`; `config.toml` gets only a
marker-delimited `[mcp_servers.mindly]` block, leaving the rest of the file byte-for-byte intact.
Codex asks the user to review new non-managed hooks (`/hooks`) before they run, and loads
project-level `.codex/` config only for trusted projects.

**Cursor** events: `sessionStart` (context via `additional_context`), `beforeSubmitPrompt`,
`preToolUse` (`permission`, `user_message`, `agent_message`), `afterFileEdit`,
`afterShellExecution`, `postToolUseFailure` (`additional_context`), `stop`, `sessionEnd`.
`beforeShellExecution` and `postToolUse` are parsed but not installed (to avoid double counting).
`beforeSubmitPrompt` cannot add context, so prompt-time context reaches Cursor through MCP.

**Gemini CLI** events: `SessionStart` (`source` startup/resume/clear), `BeforeAgent` (the
prompt), `BeforeTool` / `AfterTool` (regex matcher `^(write_file|replace|run_shell_command)$`),
`AfterAgent` (`prompt_response` as the last message) and `SessionEnd`. The payload uses the same
base fields as Claude Code (`session_id`, `cwd`, `transcript_path`), so parsing reuses the
Claude-style parser; `write_file` and `replace` are file edits, `run_shell_command` is shell.
`tool_response` is `{ llmContent, returnDisplay, error? }`: a tool fails when `error` is set, and a
shell command fails when `llmContent` reports a non-zero `Exit Code: N`. Context goes out as
`hookSpecificOutput.additionalContext`, which Gemini reads on SessionStart, BeforeAgent and AfterTool
only (it escapes `<`/`>` and wraps it in `<hook_context>`). BeforeTool has no context channel, so a
`deny` folds the context into the top-level `reason` the model sees; `ask` is passed through and
its reason shown as `systemMessage` in Gemini's confirmation prompt. AfterAgent never gets a
decision (a `deny` there forces a retry turn). In headless mode (`gemini -p`) Gemini prepends the
SessionStart context to the first prompt, so the adapter strips that `<hook_context>` block before
the prompt is stored. Timeouts are in milliseconds (10 000) and each hook is named
`mindly-<Event>` for `/hooks panel`. Hooks and the MCP server share `settings.json`, which is JSONC:
the installer edits single array elements and properties in place, so comments and the user's own
hook groups keep their bytes, and uninstall restores the original file. Gemini fingerprints
project-level hooks and warns before running new or changed ones in untrusted folders.

No adapter ever emits an `allow` decision: it would skip the agent's own permission prompt.

## MCP-only clients

`src/mcp-clients/catalog.ts` describes every other client as data: user and project config paths
(home-relative, per platform), file format, a JSON pointer to the servers map, the entry shape and
detection paths. One generic `McpClientAdapter` turns each entry into an `AgentAdapter`: `parse`
returns null, `render` prints nothing, and install/uninstall add or remove only the `mindly`
server entry, launching `<command> mcp --agent <kind>`.

Edits are made in place (`src/mcp-clients/jsonc-edit.ts`, using `jsonc-parser` 3.3.1 for parsing
and scanning): the new property is inserted as new lines after the last existing one, with the
file's own indentation and line endings, so comments, trailing commas, ordering and other servers
stay byte-for-byte; uninstall removes exactly those lines and restores the original text.
Invalid files, comments in strict-JSON files and non-object containers are refused with an
`invalid_input` error and never overwritten.

| Kind             | User config (macOS / Linux)                                                                                       | Project config            | Servers key       | Format |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------- | ------ |
| `windsurf`       | `~/.codeium/windsurf/mcp_config.json`                                                                             | none                      | `mcpServers`      | JSONC  |
| `kiro`           | `~/.kiro/settings/mcp.json`                                                                                       | `.kiro/settings/mcp.json` | `mcpServers`      | JSON   |
| `vscode`         | `~/Library/Application Support/Code/User/mcp.json` / `~/.config/Code/User/mcp.json`                               | `.vscode/mcp.json`        | `servers`         | JSONC  |
| `cline`          | `~/.cline/data/settings/cline_mcp_settings.json`                                                                  | none                      | `mcpServers`      | JSON   |
| `roo-code`       | `<VS Code User>/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json`                              | `.roo/mcp.json`           | `mcpServers`      | JSON   |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` / `~/.config/Claude/claude_desktop_config.json` | none                      | `mcpServers`      | JSON   |
| `opencode`       | `~/.config/opencode/opencode.json` (or an existing `opencode.jsonc`)                                              | `opencode.json(c)`        | `mcp`             | JSONC  |
| `zed`            | `~/.config/zed/settings.json`                                                                                     | `.zed/settings.json`      | `context_servers` | JSONC  |
| `amp`            | `~/.config/amp/settings.json` (or an existing `settings.jsonc`)                                                   | `.amp/settings.json(c)`   | `amp.mcpServers`  | JSONC  |
| `augment`        | `~/.augment/settings.json` (Auggie CLI)                                                                           | none                      | `mcpServers`      | JSON   |
| `lm-studio`      | `~/.lmstudio/mcp.json`                                                                                            | none                      | `mcpServers`      | JSON   |

Entries are `{ "command", "args" }`, except VS Code (`{ "type": "stdio", "command", "args" }`)
and OpenCode (`{ "type": "local", "command": [argv...], "enabled": true }`). Amp's key is a literal
top-level `"amp.mcpServers"`, not a nested path. Windows paths use `%APPDATA%` where the
client does, but are untested.

Not in the catalog (users can paste the generic snippet from the main README):

- **Continue** and **Goose**: YAML configs (`~/.continue/config.yaml` `mcpServers:` list,
  `~/.config/goose/config.yaml` `extensions:` map). Editing YAML without losing comments would need
  a YAML round-trip library; not worth a new dependency yet.
- **Trae**: the official MCP docs page could not be read and secondary sources disagree on the
  user config path.
- **Augment IDE extensions**: configured through the settings panel; no file path is documented
  (the Auggie CLI is covered as `augment`).

Docs for each client are listed below and in each catalog entry's `docs` field.

## Documentation used

- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Codex hooks: https://developers.openai.com/codex/hooks (redirects to https://learn.chatgpt.com/docs/hooks)
- Codex MCP: https://developers.openai.com/codex/mcp (redirects to https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- Cursor hooks: https://cursor.com/docs/agent/hooks
- Cursor MCP: https://cursor.com/docs/context/mcp
- Windsurf: https://docs.windsurf.com/windsurf/cascade/mcp (now redirects to https://docs.devin.ai/desktop/cascade/mcp)
- Kiro: https://kiro.dev/docs/mcp/configuration/
- Gemini CLI hooks: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md,
  https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md (payloads and
  output handling checked against `@google/gemini-cli` 0.66.0; fixtures captured from a real run)
- Gemini CLI MCP: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- VS Code: https://code.visualstudio.com/docs/agents/reference/mcp-configuration,
  https://code.visualstudio.com/docs/copilot/customization/mcp-servers,
  https://code.visualstudio.com/docs/configure/settings (User directory per OS)
- Cline: https://docs.cline.bot/mcp/configuring-mcp-servers (path from the extension source,
  `apps/vscode/src/core/storage/disk.ts`)
- Roo Code: https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo
- Claude Desktop: https://modelcontextprotocol.io/docs/develop/connect-local-servers
- OpenCode: https://opencode.ai/docs/mcp-servers/, https://opencode.ai/docs/config/
- Zed: https://zed.dev/docs/ai/mcp
- Amp: https://ampcode.com/docs/customize/mcp, https://ampcode.com/docs/cli/settings
- Augment (Auggie CLI): https://docs.augmentcode.com/cli/integrations
- LM Studio: https://lmstudio.ai/docs/app/mcp
- Continue (skipped): https://docs.continue.dev/customize/deep-dives/mcp
- Goose (skipped): https://goose-docs.ai/docs/guides/config-files

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
- Windsurf: its docs now redirect to Devin Desktop, which documents `~/.config/devin/mcp_config.json`.
  Mindly writes the long-standing Windsurf path `~/.codeium/windsurf/mcp_config.json`, which the
  current page no longer mentions.
- VS Code: the docs name the user `mcp.json` ("MCP: Open User Configuration") but not its OS path;
  the path is the documented User settings directory plus `mcp.json`. VS Code's guided flow now
  labels these files as kept for compatibility.
- Gemini CLI, Windsurf and VS Code are treated as JSONC (comments kept) because their examples or
  settings loaders accept comments; the docs do not say so explicitly.
- LM Studio follows "Cursor's mcp.json notation" per its docs; the stdio entry shape is assumed
  from that.
- Roo Code's repository has been archived; the config location is unchanged.
