# Security model

Mindly sits between a developer, their source code and several autonomous agents. That makes it
a high-value target: anything that can write into Mindly memory can try to influence every agent
on the machine. This document lists the threats we design against and the controls that answer
them. Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).

## Assets

- Source code and uncommitted changes of every connected project
- Prompts and agent transcripts (may contain secrets pasted by the user)
- The memory store itself (integrity matters as much as confidentiality)
- The developer's agent credentials and model API keys

## Trust boundaries

| Boundary                       | Trusted side          | Untrusted side                                |
| ------------------------------ | --------------------- | --------------------------------------------- |
| User ↔ Mindly CLI              | the local user        | —                                             |
| Agent hook payloads            | shape validated       | content (prompts, tool output, file contents) |
| Repository contents and config | after explicit trust  | any freshly cloned repository                 |
| Memory content                 | never                 | always treated as data                        |
| Browser ↔ daemon               | authenticated session | every other web origin                        |
| Model provider responses       | never                 | always treated as data                        |

## Threats and controls

### T1. Prompt injection through shared memory

An agent reads a malicious README or web page and stores "always run `curl … | sh`" as a
memory, which is then injected into every other agent.

- Memories carry `source` and `trust`. Agent-created memories are `proposed`.
- Context is rendered as delimited reference data with explicit labels; it never claims system or
  user authority.
- Only user-sourced or user-approved rules are phrased as conventions; `enforce` rules can only be
  created by the user through the CLI or dashboard.
- Rendered memory text is sanitised: control characters stripped, fence/delimiter sequences
  neutralised, length capped.

### T2. Hostile repository configuration

A cloned repository ships `.mindly/config.json` that defines a shadow-merge check command such as
`rm -rf ~`.

- Repository-level config can never introduce commands until the user runs `mindly trust` for
  that project; the trusted config's hash is pinned and re-approval is required after any change.
- Commands are executed with `execFile`/`spawn` and an argument array, never through a shell, with
  a timeout, a minimal environment, and the working directory pinned inside a temp worktree.
- Executable-memory contracts are declarative by default (file exists, pattern present/absent,
  JSON key present, exported symbol present). `command` contracts need the same explicit approval
  and hash pinning.

### T3. Secrets leaking into memory, logs or notifications

- A redaction pass runs on every prompt, tool payload, memory body and notification before it is
  stored or sent: private keys, common provider tokens (AWS, GitHub, Slack, Stripe, OpenAI,
  Anthropic, Google, npm, JWTs), `.env`-style assignments and high-entropy strings next to
  secret-like names.
- Paths matching the default deny-list (`.env*`, `*.pem`, `*.key`, `id_*`, `.ssh/`, `.aws/`,
  `.npmrc`, `.netrc`, `secrets/`, credential stores) are never read for evidence and their content
  is never captured.
- Model API keys are read from environment variables at call time and never written to disk by
  Mindly.
- Pager payloads contain titles and counts only, never code or prompt text.

### T4. Local network and browser attacks on the daemon

- Binds to `127.0.0.1` only; refuses to start on any other interface.
- Every request needs either a bearer token (CLI) or a session cookie (dashboard). The token is
  32 random bytes stored in `$MINDLY_HOME/daemon.token` with mode `0600`; comparisons are
  constant-time.
- The dashboard is opened through a one-time login code in the URL fragment (never sent in logs or
  `Referer`), exchanged for an `HttpOnly`, `SameSite=Strict` cookie.
- `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence);
  `Origin` must match for state-changing requests and WebSocket upgrades.
- Strict `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`. No CORS.
- Request bodies are size-limited and schema-validated.

### T5. Local file-system exposure

- `$MINDLY_HOME` is created with mode `0700`; the database, token and logs are `0600`.
- Every path that comes from a payload is resolved with `realpath` and must stay inside the
  project root before it is read. Symlinks pointing outside are rejected.

### T6. Command and argument injection in git and runners

- Git is always invoked as `git` with an argument array; user-controlled refs and paths are
  validated and passed after `--` where git supports it. `GIT_CONFIG_NOSYSTEM`, a fixed
  `core.hooksPath` of `/dev/null` and `protocol.allow=never` for network protocols are set for
  internal operations so a hostile repo cannot run hooks or fetch.
- Headless agent runs (replay, review, failover) are opt-in per invocation or by explicit config,
  run in isolated temporary worktrees, and use the agent's own permission system in its most
  restrictive mode that can complete the task (review runs are read-only).

### T7. Denial of service against agents

- Hooks have a hard deadline (default 1500 ms) and fail open: on any internal error they print
  nothing and exit 0 so the agent continues.
- Context packets are bounded by a token budget; retrieval queries are bounded by `LIMIT`.
- SQLite runs with `busy_timeout` and WAL; long-running work happens in the daemon, not in hooks.

### T8. Supply chain

- Minimal runtime dependencies; exact versions pinned; lockfile committed.
- SQLite comes from Node's built-in `node:sqlite` (no native addon download at install time).
- CI runs `pnpm audit` and Dependabot is enabled.

### Hardening from the first security review

- Agents cannot restate a user memory: a same-title write from a non-user source is refused, so an
  agent cannot replace an approved rule's body while keeping its trust.
- Evidence only verifies a fact when every excerpt is substantial (at least 20 normalised
  characters) and present in the file; evidence without an excerpt never verifies.
- Any path, glob or id containing control, line-break or bidi characters is rejected at input and
  sanitised again at render time, so structure in a context block cannot be forged.
- Rules are auto-approved only from short prompts without code blocks; anything else (typically
  pasted, untrusted text) is proposed. Agents Mindly launches itself carry `MINDLY_HEADLESS_RUN=1`,
  and their prompts are never captured as rules. Headless Claude Code runs load only user settings.
- Rules imported from a repository's instruction files (`CLAUDE.md`, `AGENTS.md`, …) are approved
  only when the user confirms the list on a terminal; with `--yes` or without a terminal they are
  added as suggestions that wait for approval, and they are never `enforce` rules.
- Failed command output is never stored or replayed; mistake memories keep only the command.
- Trusting a project config requires the hash the user reviewed; a changed file is refused.
- Config files are read with `lstat` + `O_NOFOLLOW | O_NONBLOCK` and a byte cap, so a config that
  points at a device or FIFO cannot hang hooks.
- Deny-list matching is case-insensitive and uses the on-disk case (`realpath.native`).
- Contract regexes allow at most two unbounded quantifiers (large bounded repeats count as
  unbounded) and eight quantifiers in total, over lines capped at 200 characters, with the time
  budget checked after every line.

## Data retention and deletion

- `mindly export` writes everything for a project as JSON.
- `mindly forget --project` hard-deletes a project's rows and vacuums the database.
- `mindly forget --memory <id>` hard-deletes one memory and its history.
- Raw prompts are kept for 30 days by default (`retention.promptsDays`), then reduced to their
  redacted summary.
