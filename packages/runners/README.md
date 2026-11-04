# @synapse/runners

Headless runs of coding agents for three explicitly requested features:

- **Cross-agent review** (`runReview`): a different agent reviews a diff in its strictest
  read-only mode and returns structured findings.
- **A/B replay** (`runReplay`): the same prompt is given to several agents, each in an isolated
  temporary worktree at the same base commit; results are captured, diffed, optionally checked and
  compared.
- **Opt-in failover launch** (`launchTask`): after a rate limit, the next agent is started in the
  existing worktree. The engine only calls this when `config.failover.autoLaunch` is `true`
  (default `false`) or the user explicitly asks for it.

Supported agents: Claude Code (`claude`) and Codex (`codex`). Depends on `@synapse/core`,
`@synapse/git` and Node built-ins.

## API overview

| Area     | Exports                                                                                   |
| -------- | ----------------------------------------------------------------------------------------- |
| Port     | `createRunners(options)` returns `RunnerPort` (`review`, `replay`, `launch`, `available`) |
| Profiles | `AGENT_PROFILES`, `agentProfile`, `detectAgent`, `parseClaudeOutput`, `parseCodexOutput`  |
| Process  | `runProcess`, `buildAgentEnv`, `runAgent`                                                 |
| Review   | `runReview`, `prepareDiff`, `buildReviewPrompt`, `parseFindings`                          |
| Replay   | `runReplay`, `replayRefName`, `assertValidRunId`, `parseNumstat`                          |
| Launch   | `launchTask`                                                                              |

`RunnerOptions` (shared by every entry point) lets callers set the environment used for binary
lookup and auth pass-through, the kill grace period, output caps, the turn limit and an
`AbortSignal`.

## Agent CLI flags

All per-agent knowledge lives in `AGENT_PROFILES` in `src/agents.ts`; update it there when a CLI
changes. The prompt is always written to **stdin**, never passed in argv.

| Agent       | Mode   | argv                                                                                                                                                                                              | Status                                                                                                                                                    |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | review | `claude -p --output-format json --no-session-persistence --max-turns N --permission-mode plan --tools Read,Grep,Glob --disallowedTools Edit,MultiEdit,Write,NotebookEdit,Bash,WebFetch,WebSearch` | All flags confirmed in the CLI reference. Prompt on stdin with no positional query is the documented piping behaviour of `-p`.                            |
| Claude Code | task   | `claude -p --output-format json --no-session-persistence --max-turns N --permission-mode acceptEdits --disallowedTools WebFetch,WebSearch`                                                        | Confirmed. In print mode, tools that would need a prompt (for example Bash) are denied.                                                                   |
| Codex       | review | `codex exec --sandbox read-only -c approval_policy="never" --ephemeral --json -C <cwd> --output-last-message <tmpfile> -`                                                                         | `exec`, `--sandbox`, `--json`, `--output-last-message`, `--ephemeral`, `-` (stdin) confirmed. `-C` and the `approval_policy` config override are assumed. |
| Codex       | task   | same with `--sandbox workspace-write`                                                                                                                                                             | as above                                                                                                                                                  |

Output parsing is tolerant: Claude's JSON result object (`result`, `is_error`, `total_cost_usd`,
`usage`, `session_id`, `num_turns`) and Codex's JSON Lines events (`thread.started`,
`item.completed` with an `agent_message`, `turn.completed` with `usage`, `turn.failed`, `error`)
are used when present; otherwise the raw text is treated as the final message. Codex's
`--output-last-message` file wins over the event stream for the final text. Codex reports token
usage but not cost, so `costUsd` is `null` for Codex.

`--skip-git-repo-check` is deliberately not passed: every run happens inside a git repository or
worktree, so Codex's own safety check stays on.

Sources (checked November 2026):

- Claude Code CLI reference: <https://code.claude.com/docs/en/cli-reference>
- Claude Code headless mode: <https://code.claude.com/docs/en/headless>
- Claude Code permission modes: <https://code.claude.com/docs/en/permission-modes>
- Codex non-interactive mode: <https://developers.openai.com/codex/noninteractive>
  (now redirects to <https://learn.chatgpt.com/docs/non-interactive-mode>)

## Security notes

- **No shell, ever.** Agents run through `spawn(absolutePath, argv, { shell: false })`. The binary
  is resolved by scanning absolute `PATH` entries for an executable file; relative entries such as
  `.` are ignored. The only caller-influenced argv values are the working directory and a temp
  file path the runner created, each passed as a single argument.
- **Prompt via stdin.** Prompts and diffs never appear in argv, so they do not leak through `ps`
  and are not subject to argv length limits.
- **Minimal environment.** Children get `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `TERM=dumb`,
  `NO_COLOR=1`, plus only that agent's own auth/config variables when set
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CONFIG_DIR` for Claude Code; `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`,
  `CODEX_HOME` for Codex). Other secrets, `NODE_OPTIONS` and `GIT_*` are dropped.
- **Hard limits.** Each run has a timeout; on expiry or abort the whole process group gets
  SIGTERM, then SIGKILL after a grace period (POSIX: `detached: true` + `process.kill(-pid)`).
  Stdout is capped at 2 MiB (head kept) and stderr at 64 KiB (tail kept).
- **Least privilege (T6).** Review runs use the agent's strictest read-only mode (Claude Code plan
  mode with only Read/Grep/Glob and Edit/Write/Bash/web tools denied; Codex `read-only` sandbox).
  Task runs (`workspace-write` / `acceptEdits`) only happen in a temporary detached worktree
  (replay) or in a worktree the user already works in (opt-in failover). Web tools are denied for
  Claude Code task runs.
- **Untrusted diffs.** Review diffs are redacted with core `redact()`, stripped of control
  characters, capped at ~120 KB and placed between random per-run delimiters the diff cannot
  forge, with an explicit instruction to treat the content as data. Reviewer output is validated
  with zod; text is redacted and sanitised; unparseable output becomes a single `low` finding.
- **Replay isolation.** Every agent gets its own `materializeTree` worktree, which is always
  disposed in a `finally` block, including on failure and timeout. Results are captured with
  `captureWorktreeCommit` (secret deny-listed paths are never stored) and kept reachable under
  `refs/synapse/replays/<runId>/<agent>`; run ids and agent kinds are validated before use.
- **Checks are trusted input only (T2).** `runReplay` runs `checks` through `runChecks` only when
  provided; callers must take them from a project config the user trusted (hash-pinned), never
  from repository content, memory or agent output.
- Prompts given to replay and launch are redacted before being sent.

## Caveats

- On Windows, `.cmd` shims cannot be spawned without a shell and are not supported; process-group
  kill is replaced by killing the direct child.
- A runaway agent can still use the network through its own tools where its sandbox allows it;
  Synapse relies on the agent's permission system for that.
