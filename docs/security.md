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
- An `enforce` rule is applied to every path a tool call reports, and to the files a shell
  command's text shows it writes. Files on the deny-list can be protected this way too: their
  names are matched against the rule, but they are still never read and nothing about them is
  stored. Reading a command is best effort, not a sandbox: a program can write a file its command
  line never names, a path held in a variable or passed through a pipe is not followed, and a
  command too long to read to its end (200,000 characters, 500 write targets) is answered with a
  warning that the rest was not checked. A patch with more files than are reported in one call
  is refused.
- git commands are read the same way. One counts as only looking, or only moving refs and the
  index, when its subcommand is known to do so and every option and setting it is given keeps it
  so. Anything else is taken as a possible change of the whole working tree, which gets a warning
  when a covered file is there: an alias, a subcommand or option not known here, a `-c` setting
  not known to be harmless, a line that may change what git runs with, a push into a repository
  on this machine, and a config write that changes what later commands do. The folders git fills
  (a clone, a new repository or working tree, a submodule) are checked as written as a whole, and
  the code it runs (`rebase --exec`, `bisect run`, `difftool --extcmd`, `submodule foreach`, a
  `!` alias) is read like any other command. What git runs on its own, from settings already in
  place, is not seen: hooks in `.git/hooks` or under a `core.hooksPath` set earlier (husky,
  lint-staged and the like running on commit), filters, diff drivers and `core.fsmonitor` in the
  repository's config, variables exported before the session, a remote whose URL is a path on
  this machine, and the files a clone from elsewhere brings.
- Only a shell command Mindly can read fully is checked exactly, and only such a command is ever
  blocked. A line is read fully when every part of it is plain and every program on it is one
  whose writes Mindly models completely, given only options it reads as the program does. The
  programs read fully are `git` (with its own tables of subcommands and options), `rm`, `mv`,
  `cp`, `mkdir`, `rmdir`, `touch`, `ln`, `chmod`, `chown`, `cat`, `ls`, `head`, `tail`, `wc`,
  `grep` without `-r`, `echo`, `printf` without `-v`, and the builtins `cd`, `true`, `false`,
  `:`, `pwd`, `exit`, and `test` and `[` without `-v` or `-R`. Each of the file tools is read
  with the options it is known to take; any other option, or a long option abbreviated, makes the
  line one not read fully (`cp -b`, `cp --parents`, `rm --rec`, `touch -r`, `rmdir -p`). The
  rest of a line read fully is: words of plain characters (`*` and `?` included, unless they may
  match what an earlier command of the line makes), single-quoted text, double-quoted text
  without `$`, a backtick or a backslash; `&&`, `||`, `;` and line ends; redirections to a plain
  path (`>`, `>>`, `2>`, `&>`), `2>&1`, `</dev/null`; a pipe into `head`, `tail`, `grep`, `wc` or
  `cat`; assignments by the shell's rules (a name and `=` outside quotes, whatever the quoting of
  the value) to lower-case variables or to harmless upper-case ones (locale, time zone, terminal,
  author, pager or editor); `env` with no option of its own in front of a program; and `if`,
  `then`, `elif`, `else` and `fi`. On such a line the paths a command names, the files git writes
  its output to and the folders it fills are blocked when a rule covers them, and what may change
  the whole tree is a warning, as described above.
- Anything else is not read fully: any other program (`sort`, `uniq`, `awk`, `sed`, `rg`,
  `find`, `tar`, interpreters such as `python`, `node`, `ruby` and `perl`, `npx`, `tsc` and other
  compilers, package managers, formatters, test runners, anything not known here), a program by
  its path, `env` with options, `sudo` and other launchers, an assignment to `HOME`, `PWD`,
  `OLDPWD`, `CDPATH` or any other upper-case variable, a variable or a substitution (`$VAR`,
  `$(…)`, a backtick), a backslash, a subshell or group, a function, a loop, a here-document or
  here-string, a process substitution, code fed to a shell (`bash -c`, `| sh`), any other
  builtin (`export`, `set`, `source`, `read`, `[[`, …), a `[…]` class or `{a,b}`, `!`, a
  background `&`, and more than 4,000 commands. Such a line is never blocked, and never let
  through without a word. It may write the whole tree: whenever a file an enforced rule covers is
  present in the project, or a folder a rule names is there, it gets one warning that names the
  rule and what it covers; the write guards (a split's ownership of files) are asked the same
  way and only warn. The paths it names are read as far as the time allows, as possible writes
  only, so a folder it makes and fills is warned about too. Nothing of it is asked of git. Lines
  that now warn this way include any line with `$VAR` or `$(…)`, a loop or a function, a test
  run through a package manager, `npx`, a pipe into `sort` or `xargs`, `sed`, `find`, strict
  shell options, `export`, `source`, `[[ … ]]`, and a shell given code.
- A shell tool call is always read as a shell line, even when its text holds a patch; only a
  call that is nothing but a patch (its text, or `apply_patch` given one in a here-document) is
  read as the edits of that patch.
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
- Checkpoints (`mindly bisect`) store the working tree after each agent edit as git commits
  inside the repository itself, under `refs/mindly/steps/<worktree id>/<step>`. They hold code,
  not prompts; the prompt is linked by event id and goes through the usual redaction and
  retention. Paths on the deny-list (and the project's `ignore` globs) keep their HEAD content
  in every checkpoint tree, so a modified or untracked `.env` is never stored. The private index
  files Mindly uses to take them live under `$MINDLY_HOME/checkpoints/`, never in the
  repository. Hidden refs are not sent by a normal `git push`, `git push --all` or
  `git push --tags`; `git push --mirror` does send them, so `mindly doctor` warns when a remote
  has `remote.<name>.mirror` set. Checkpoints are deleted after `checkpoints.keepDays` (14) or
  beyond `checkpoints.maxPerWorktree` (5,000), by `mindly forget --project` and by
  `mindly uninstall`; `checkpoints.enabled = false` turns them off.
- The track record (`mindly track`) checks, once per agent edit and only after it is 7 days old,
  how many of the lines the edit added or changed are still in the file. At edit time it stores only
  hashes of those lines. To check, it reads the current file in the agent's checkout (or the
  project root when that checkout is gone), or, when another branch is checked out there, the
  file at the tip of the branch the agent worked on (`git cat-file`, never a checkout); it hashes
  the lines and stores two counts per edit (`line_survival`), never file content. Paths on the
  deny-list are never read, files over 512 KB are skipped, and a path that now resolves outside
  the tree (a symlink) is not followed. The track record is computed from local data, is not
  available to agents over MCP, and is never included in a saves card.

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

- `mindly bisect` runs only the command the user typed after `--` (and the `--setup` command
  they gave), as an argument list without a shell, in a scratch worktree in a temp directory with
  a minimal environment and a time limit; nothing from the repository, memory or agent output
  chooses what runs. Agents cannot start a bisect: there is no MCP tool or daemon endpoint for it.
- The sentinel (off by default, `sentinel.enabled`) runs only the project's `checks` and its
  `sentinel.setup` command, from the `.mindly/config.json` the user trusted at that exact hash
  (`mindly trust` lists the setup command too; any change to the file stops it until trusted
  again). It runs them the same way as the merge checks: argument list, no shell, minimal
  environment, time limit, own process group, killed when the daemon stops. They run in a warm
  scratch worktree under `$MINDLY_HOME/sentinel/` (mode `0700`), outside the repository, never in
  the user's checkout; the path is refused if it is inside or around the repository (the sentinel
  reports `MINDLY_HOME` inside the repository as not ready). One pass at a time holds a checkout,
  by a lock released only when its process ends, and the daemon queues passes behind the
  project's merge checks. Bisects the sentinel starts are capped per project per day
  (`sentinel.maxBisectsPerDay`), and a step where nothing could run is retried with a growing
  back-off (15 minutes up to 6 hours), not on every tick. Agents cannot start a pass: there is no
  MCP tool, and the daemon endpoint only reads. A mistake the sentinel records from its own bisect
  has the system as its source, so it is only `proposed` (a user-run `mindly bisect` records an
  approved one): nobody looked at the result before agents are warned with it.
- Check output reaches agents only as a redacted, sanitized, length-capped tail inside the
  delivery of a break, rendered as reference data like every other delivery: a test that prints
  instructions cannot turn them into a rule, a memory or a command.

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
  added as suggestions that wait for approval, and they are never `enforce` rules. Their source is
  the repository file (`{ type: 'agent', agentKind: 'repo-file', sessionId: null }`, an agent kind
  no real agent may use), so agents see them labelled "from AGENTS.md", never as the user's. No
  agent can edit, restate or archive them; a confirmed import is recorded as the user's approval.
- Instruction file import is linear in the file size: items and sentences longer than twice the
  rule length cap are skipped before any markdown is stripped, emphasis and comments are removed
  without backtracking regexes, and each `mindly init` reads the files once. A file scoped to globs
  keeps only its valid globs, and is skipped when none is valid, so its rules never widen to the
  whole project. Rule directories are only entered when their real path stays inside the project.
- Rules sync is opt-in per project and asks before its first write. It writes only rules the user
  approved explicitly, only between Mindly's markers in `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`
  inside the project, and rule text cannot close the section. A rule counts as explicitly approved
  when one of its versions was written as approved by the user outside any agent session
  (`changed_by_type = 'user'` with no session): `mindly memory add`, `mindly rules --approve`,
  `mindly memory approve`, Mission Control, or confirming an import. Rules auto-approved because a
  prompt said "always …" are sent to connected agents but are not committed to the repository
  until the user approves them; approving an already approved rule still records a version.
- The section's markers are only recognised outside code, following CommonMark: a fence closes only
  on a run of the same character at least as long as the opener, an unclosed fence runs to the end
  of the file, and indented code is ignored. A file that contains a marker but no well-formed
  section is reported as needing attention and never written, so a section is never appended twice.
  Rule import and evidence checks ignore the section, so Mindly never treats its own output as the
  user's instructions or as proof of a rule.
- Agents cannot create, confirm or edit saves: there is no MCP tool for saves and the MCP server
  does not follow the event log for them. Saves are settled only from events Mindly records
  itself, and the only user action is rejecting one. Save titles are plain sentences without code,
  and commands are stored redacted.
- A save counts only on positive evidence from the helped agent's own later hook events. While a
  session has a save waiting for evidence, its tool calls are recorded without their content: the
  tool name, written paths, the redacted command key, a fingerprint of the normalized command line
  (never the line itself) and which watched files a shell command may have written. A shell
  command that names a watched file (path or basename) and is not made only of read-only programs
  counts as writing it, so a write through the shell (`sed -i`, `cp`, `mv`, `>`, `tee`) drops the
  save instead of confirming it.
- Fingerprints are decided once. The first save for an underlying problem settles it for good: if
  it expires or is rejected, later attempts at the same problem (the same rule and paths, the same
  other agent's intent, the same known pitfall and command) never create a new save. This can only
  under-count, never inflate.
- The saves share card contains counts by kind and agent names only. The project name, save
  sentences and file paths are added only on explicit request (`--details`, the Mission Control
  checkbox); it never contains code. The card is rendered locally and never uploaded.
- Failed command output is never stored or replayed; mistake memories keep only the command.
- Trusting a project config requires the hash the user reviewed; a changed file is refused.
- Config files are read with `lstat` + `O_NOFOLLOW | O_NONBLOCK` and a byte cap, so a config that
  points at a device or FIFO cannot hang hooks.
- Deny-list matching is case-insensitive and uses the on-disk case (`realpath.native`).
- Contract regexes allow at most two unbounded quantifiers (large bounded repeats count as
  unbounded) and eight quantifiers in total, and patterns whose optional parts and alternatives
  combine into too many ways to match are rejected, so the work per line stays polynomial. Lines
  are capped at 200 characters, with the time budget checked after every line. A stored contract
  whose pattern fails these checks is not run: it reports an error explaining why, and
  `mindly doctor` lists it.

## Data retention and deletion

- `mindly export` writes everything for a project as JSON.
- `mindly forget --project` hard-deletes a project's rows, deletes its checkpoint refs and the
  sentinel's scratch worktrees from the repositories and vacuums the database. Scratch worktrees
  unused for 3 days, and those of checkouts that no longer exist, are removed by the daemon (and
  made again when needed). A scratch worktree pins the commit it last checked out, so git keeps
  that commit's objects until the tree is removed, even past `checkpoints.keepDays`.
- `mindly forget --memory <id>` hard-deletes one memory and its history.
- Raw prompts are kept for 30 days by default (`retention.promptsDays`), then reduced to their
  redacted summary.
