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
  stored. A write is checked at the name it is given (its folder resolved, the name itself not
  followed) and, when that name is a symbolic link, where the link leads: a rule that covers
  either blocks it, so a covered name that is a link cannot be removed or replaced, and a link
  to a covered file cannot be written through. A path a tool call reports with a `..` after a
  folder's name is checked both as its text folds, which is how editing tools take it, and as
  the system takes it, off the folder a link before it leads to. A tool call that writes
  through a link to a file that is not there is checked where that file would be made, the
  links followed by hand at most eight times, each from the folder it is really in, and refused
  when that does not settle it, or when such a link's own target has a `..` after a folder's
  name. A tool call onto a regular file that has another name as well
  (a hard link) is blocked when an enforced rule names that very file by a plain path (the
  first 32 rules are looked at); otherwise it is warned about, with the enforced rules named,
  as the name does not tell whether a rule covers the file under its other name. The link
  count is looked at for every path the call reports, one outside the project too, since its
  other name may be inside.
  Reading a command is not a sandbox: a program can write a file its command line never
  names. A line whose paths depend on what runs (a variable, a pipe into anything but a filter,
  a `cd` other than a leading one) is not read fully and is warned about, as described below,
  and a command too long to read to its end (200,000 characters, 500 write targets), or one
  whose paths could not all be placed in the time there is, is answered
  with a warning that the rest was not checked. A patch with more files than are reported in one
  call is refused.
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
  `grep` without `-r`, `echo`, `printf` without `-v`, and the builtins `true`, `false`, `:`,
  `pwd`, `exit`, and `test` and `[` without `-v` or `-R`. Each of the file tools is read
  with the options it is known to take; any other option, or a long option abbreviated, makes the
  line one not read fully (`cp -b`, `cp --parents`, `cp -T`, `mv -T`, `rm --rec`, `touch -r`,
  `rmdir -p`), as does `ln` with a single operand. An `mv` or `git mv` that takes
  away the folder the commands run in (the session's own, or the one a leading `cd` entered)
  or a folder above it, by name or by a wildcard that may match it, makes the line not read
  fully: the commands after it run where the text does not tell. So does any later word that
  names a path going through something the line made earlier. What a command created, replaced
  or moved into place (a link, the destination of a copy or a move, a redirection target, a file
  `touch` made, a path git wrote by name) may be a link to anywhere, whatever program made it: a
  path with it as a folder above, or the thing itself written with a `/` after it, leads where
  the text does not tell (`ln -s certs lnk && rm -f lnk/server.pem`). A write onto the very path
  made by a command that may make a link of either kind (`ln`, `cp` with `-a`, `-R`, `-P`, `-l`
  or `-s`, `mv`, git) may reach another file through it (`ln certs/server.pem f && echo x > f`),
  and the line is not read fully either. The one exception is a folder `mkdir` made on the line,
  with its parents under `-p` (each parent that is not there is a folder the command makes,
  and is checked like the one it names, up to 256 of them in one call; a line that makes more
  is told the rest was not checked): paths under it are read as written, unless something else made
  that path first (`ln -s certs d; mkdir d`), or a command that may make a link is given it as
  its destination without a `/` after it. What is only removed (`rm`, `rmdir`, the source of a
  move), or only changed in mode or owner, is not made; nor are the folder a command runs in
  and the top of the tree, only what they hold. A git command that may change the tree as a
  whole (a switch, a merge, a pull, a reset, a stash, a patch applied) makes whatever that tree
  holds: after it, a path given to another program there is not read fully
  (`git pull && rm -f certs/server.pem`, `git checkout other && echo x > link`). A pathspec git matches by
  rules of its own (`:(icase)…`, `:(glob)…`, `:/…`, or any under `--icase-pathspecs`,
  `--glob-pathspecs` or `--literal-pathspecs`) may name anything in the tree, and a command
  that writes by one makes whatever the tree holds in the same way. The paths git is given in its
  own working tree are not held against what the line made: git does not follow a link there,
  it refuses the path or puts a folder in the link's place. The destination of `git mv` is
  followed, and is held like any other; and a folder git is sent to or pointed at (`-C`,
  `--work-tree`, `--git-dir`) that is, or is reached through, something the line made, or that
  is written with a wildcard outside quotes (`git -C cert? rm -f server.pem`), is not
  read fully. A symbolic link that was there before the line ran may lead to what the line
  makes, which comparing the text does not show (`lnk` leads to `d/a`, and the line runs
  `ln -s ../../certs d/a/sub; rm -f lnk/sub/server.pem`; or `sl` leads to `secrets`, which is
  not there until `mkdir secrets && mv b.txt sl/k`). So once a line has made anything, a folder
  `mkdir` made included, a later path it writes, removes or lands something on that has a
  symbolic link among the parts of it that are there, or is one that leads nowhere, makes the
  line not read fully; the paths git is given in its own tree are left out, as above. The
  same holds the other way round: what a command makes at a path with such a link among its
  parts is somewhere the text does not tell, so nothing a later command of the line writes is
  read (`current` leads to `stage`, and the line runs
  `ln -s ../certs current/x && rm -f stage/x/server.pem`). A folder `mkdir` makes there does
  not count, and a line that ends with that command, or only reads after it, is read fully.
  A path the text does not settle makes the line not read fully as well: a `..`
  after a folder's name in any path written or copied from (`rm -f deep/../server.pem`: the
  system takes `..` off the folder a link before it leads to; a leading `../..` is placed from
  the folder the session is in), and a word that starts with a `~` the shell expands to
  anything but the user's own home (`~-`, `~+`, `~name`). A `~` is one the shell expands only
  as the first character of a word with nothing quoted, not even an empty string, before the
  first `/`, and not after the `=` of an option; any other is a name (`~''/x`, `./~/x`,
  `--output=~/x`), and is held against what the line made like any other name. When `HOME` is
  set and empty, `~/x` is `/x`, as the shell takes it. A path under `/proc`, `/dev` or `/sys`
  leads where the system says (`/proc/self/cwd` is the folder the command runs in): one that
  is written, other than `/dev/null`, `/dev/zero`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`
  and `/dev/fd/N`, makes the line not read fully. A file that has another name as well (a hard link:
  a link count above one when the command is checked) is written under every name it has, and
  a write onto a symbolic link that leads to a file that is not there makes that file. A line
  that writes such a name in place, that is its content, mode, owner or times (a redirection
  onto it, `cp` onto it, `touch`, `chmod`, `chown`, an output file of git), is not read fully.
  A recursive `chmod` or `chown` looks through the folder it is given. A copy into a folder
  looks only at what it lands on: the name of each source there, and under it the names a
  source folder holds (for `src/.`, the names `src` holds), where a symbolic link is written
  through and counts too; the rest of the destination is not looked at. A folder git fills
  with files of its own naming (`format-patch`, with `-o` or where it runs) is looked at for
  files of such names right in it, and a symbolic link of such a name counts. A
  folder with more in it than can be looked at in the time there is counts as holding one.
  Taking a name away or giving it to something else (`rm`, `mv` onto it, `ln -f`,
  `cp --remove-destination`) leaves the file alone, and git puts a new file where it writes
  one of its tree: those are read as before. With `ln -n`, a destination
  that is a link to a folder is the name itself, not the folder, unless it is written with a
  `/` or `/.` after it or there is more than one source. What follows `--` is an operand,
  whatever it looks like (`ln -sf -- -n dir` links a file named `-n`, `chmod -- -w file` takes
  `-w` for the mode, `rm -- -old.pem` removes a file of that name), and a colon in a name
  given to `mv` or `cp` is part of the name. A copy,
  move or link into a folder lands inside it under each source's name, and that name is what is
  made and what is checked (the name itself, and where it leads when it is a link): a destination written with a `/` after it, a folder `mkdir` made earlier on the line, or
  a folder on disk (not a link to one) that the line has not written, removed or renamed. Any
  other destination is made itself; one written earlier on the line in any way may or may not be
  a folder, and the line is not read fully. What a source brings is looked up on disk when the
  command is checked, which is before the line runs. So a source the line has written by then
  makes the line not read fully: one with a wildcard that may match what an earlier command
  made (`echo x > n.key && cp *.key certs/`); one whose content is brought (a recursive copy, a
  move, a source with `/` or `/.` after it) that is, lies under, or holds something the line
  wrote (`echo x > out/n.key && cp -r out certs/`, `ln -s pems pp; cp -r pp/. out/`); and, once
  the line has made anything, one with a symbolic link among the parts of it that are there.
  A source named in full and copied without its content lands under its own name whatever it
  is, and so does a file the line made by a command that makes no link, or a folder `mkdir`
  made and nothing was put in: `echo x > n.key && cp n.key certs/` is read fully, and blocked.
  A destination a copy may have filled as a folder (a recursive copy, several sources, a source
  found by a wildcard) holds names not known, and is never such a plain file
  (`cp tpl/* stage && cp -r stage/. conf/`). A source whose names cannot be listed makes the
  line not read fully as well: one whose content is brought and that has a wildcard in a
  folder on its way (`cp -r pkg/*/keys out/`), a folder of more than 50,000 entries or one that
  cannot be read, and one still being listed when the time runs out. Under `cp -L` or `-H`, a
  symbolic link found inside a source is followed by the copy and not by the listing, and the
  line is not read fully (`cp -rL docs out/` with `docs/latest` a link to a folder). A
  wildcard source that starts with a dot matches names that start with one (`cp .env* out/`).
  More than 2,000 files brought to a folder that is not there are held against the rules by
  their names under it, and are not placed one by one.
  A folder `mkdir` made is not counted as written for what lies under it, which was there
  before (`mkdir -p out && mv out/a b`). `ln -s` makes a link under the name of each source
  as written, whether or not the source is there, so a source with a wildcard that matches
  nothing lands under that very name as well (`ln -s shared/*.pem certs/` makes
  `certs/*.pem`). The rest of a line read fully is: words of plain characters
  (`*` and `?` included, unless they may match what an earlier command of the line makes; a
  part of a path with more than three runs of `*` is taken to match anything; a copy or move of
  more than 64 sources is not read fully; a wildcard that matches nothing stays in the
  name as written, so in a name a command makes itself (the target of `touch` or `mkdir`, of a
  redirection, an output file of git) it is read both ways, as what it matches and as the name
  itself: `touch certs/zz*` makes a file of that very name and is blocked when a rule covers
  it, and so is `echo x > certs/*.pem` when the wildcard matches a covered file. A wildcard in
  the destination of `cp`, `mv` or `ln`, in any part of it, or in a folder git fills (a clone,
  the folder `format-patch` writes its files to), is not
  read fully: where it matches a folder, what is copied, moved or linked is put inside it
  (`cp b.txt cert?/`). A wildcard in what is removed, or changed in mode or owner, only takes
  what is there and is read as written (`rm -f */*.pem`, `rm -rf */dist`), except that one
  which may match a symbolic link is not read
  fully where the link would be followed: a link to a folder, for a folder on the way to what
  is written (a plain part after the wildcard that is such a link counts too) and for a last
  part that is removed with a `/` after it; any
  link, for a last part the command writes in place. A link to a file among the folders
  `*/dist` expands in changes nothing, and `rm -f *.tmp` on a link only removes the link),
  a comment (from a `#` that starts a word to the end of its line, which is dropped; what is on
  the next line is read),
  single-quoted text, double-quoted text
  without `$`, a backtick or a backslash; `&&`, `||`, `;` and line ends; redirections to a plain
  path (`>`, `>>`, `2>`, `&>`), `2>&1`, `</dev/null`; a pipe into `head`, `tail`, `grep`, `wc` or
  `cat`; assignments by the shell's rules (a name and `=` outside quotes, whatever the quoting of
  the value) to lower-case variables or to harmless upper-case ones (locale, time zone, terminal,
  author, pager or editor); `env` with no option of its own in front of a program; and `if`,
  `then`, `elif`, `else` and `fi`. On such a line the paths a command names, the files git writes
  its output to and the folders it fills are blocked when a rule covers them, and what may change
  the whole tree is a warning, as described above. Where a `cd` lands is not followed. A line
  with a `cd`, `pushd` or `popd` is read fully only when all of this holds, and what follows
  the `cd` then runs in that folder or not at all:
  - the first thing on the line is the bare word `cd`: no command before it, no redirection
    (`>x || cd …`), no assignment, no `env`, `command`, `builtin`, `sudo` or other launcher, and
    no quotes around it;
  - it has exactly one operand, no option, and no redirection of its own;
  - the operand is plain text that names the folder as written: it does not start with `~` or
    `-`, has no wildcard, and, when `CDPATH` is set and not empty in Mindly's own environment,
    starts with `/` or `./`, so the shell does not look for it elsewhere;
  - the operand has no `..` anywhere (`cd ..`, `cd ../x`, `cd a/../b`): the shell takes `..`
    off its own spelling of the folder it is in, which may go through a symbolic link that
    Mindly, given the folder itself, cannot see, while every other path is placed from the
    folder itself, links followed;
  - the folder is there when the command is checked, is a directory, is not reached through a
    symbolic link in any part of the path, and can be entered (search permission);
  - everything after the `cd` is one chain of `&&` to the end of the line: no `;`, `||`, `&`
    or line end between commands, so nothing runs when the `cd` fails. A pipe into a filter is
    part of the chain: its commands run together or not at all;
  - there is no other `cd`, `pushd` or `popd` on the line. `cd` as a word given to another
    program (`echo cd`, `git log cd`) is not one.
- Anything else is not read fully: any other program (`sort`, `uniq`, `awk`, `sed`, `rg`,
  `find`, `tar`, interpreters such as `python`, `node`, `ruby` and `perl`, `npx`, `tsc` and other
  compilers, package managers, formatters, test runners, anything not known here), a program by
  its path, `env` with options, `sudo` and other launchers, an assignment to `HOME`, `PWD`,
  `OLDPWD`, `CDPATH` or any other upper-case variable, a variable or a substitution (`$VAR`,
  `$(…)`, a backtick), a backslash, a subshell or group, a function, a loop, a here-document or
  here-string, a process substitution, code fed to a shell (`bash -c`, `| sh`), any other
  builtin (`export`, `set`, `source`, `read`, `[[`, …), any `cd` but the leading one described
  above, a `[…]` class or `{a,b}`, `!`, a background `&`, a private-use character or a
  noncharacter anywhere on the line (U+E000 to U+F8FF, U+FDD0 to U+FDEF, U+FFFE, U+FFFF and the
  private-use planes), and more than 4,000 commands. Such a line is never blocked, and never let
  through without a word. It may write any file, one that is not there yet too, so the warning
  does not wait for a covered file or a rule's folder to be there: in a project with an enforced
  rule, every line not read fully gets one warning that says it could not be read fully and
  names the enforced rules (five of them, and how many more), those first that cover something
  the line names or may reach, with what of that is covered. The write guards (a split's
  ownership of files) are asked about the whole tree and only warn. The first 32 paths it names
  are placed one by one, as possible writes only, to say which covered paths it names. Where
  the agent takes context before a tool runs, the warning goes to the model. Gemini takes none
  there, so on Gemini the person is shown, in place of the context, what the call is warned
  about under enforced rules, as plain text with the rules named without markup characters:
  this warning; the warning that a line read fully names or may reach a covered file (a git
  command that may change the tree, a `chmod`), or that the search for one could not finish;
  the notice that a command was not read to its end or that time ran out; the notice that
  paths outside the working tree were not checked; and the warning that a tool call writes a
  file with another name. Reference context for the model (memory, other sessions' work) is
  still dropped there. Nothing of it is asked of git. Lines
  that now warn this way include any line with `$VAR` or `$(…)`, a loop or a function, a test
  run through a package manager, `npx`, a pipe into `sort` or `xargs`, `sed`, `find`, strict
  shell options, `export`, `source`, `[[ … ]]`, and a shell given code.

  What this guarantees for a shell line is that a write a rule covers is never let through
  without a word. It does not guarantee a block. A line Mindly cannot place exactly is warned
  about and runs, and that includes a line that would have been blocked had the uncertain part
  not been on it: `rm -f certs/server.pem` is blocked, `git pull && rm -f certs/server.pem`
  is warned about. The uncertain parts are a symbolic link in a wildcard's way, a wildcard in
  the destination of a copy, move or link, a path through something the line made earlier (a link, a copy,
  what git changed), a symbolic link that was there in a path named after the line has made
  something, a source of a copy that the line wrote before the copy, a file that has two
  names, a path the text does not settle or the system makes
  up, and whatever makes the line one not read fully in
  the first place. Such a line is also warned about when it turns out to write nothing
  covered: `npm test`, `git checkout main && rm -rf dist`, `chmod -R` over a folder of hard
  links, `cp config.json packages/*/`, `cp -r packages/*/dist out/`, `cp -rL docs out/` where
  `docs` holds a link, `touch a.txt && cp *.txt backup/`,
  `cp -r src out && cp -r out out2`, and a line that makes a folder and then names a path
  under `node_modules/pkg` where a package manager made that a link. A copy to a wildcard that
  does match a covered file (`cp b.txt certs/*.pem`) is warned about too, not blocked. Both
  are the known cost of warning rather than guessing.

- A shell tool call is read as a shell line, and when its text holds a patch, the files the patch
  names are possible writes besides. Only a call bash would run nothing of, `apply_patch` given a
  patch in a here-document whose delimiter is quoted, as the whole command, is read as the edits
  of that patch alone; a bare patch text, or a here-document bash expands, is shell code. A
  separate patch tool is read as the edits it holds.
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
