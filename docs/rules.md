# Rules

A rule is something every agent should follow in this project, such as "use pnpm, never npm".
Rules reach every connected agent at the start of each session.

There are three ways to get one:

- **Tell an agent.** A correction like "from now on always use pnpm" becomes a proposed rule.
- **Import the files you already have.** See below.
- **Add one yourself** with `mindly memory add` or in Mission Control.

Rules that an agent picked up stay **proposed** until you approve them with
`mindly rules --approve <id>`. `mindly rules` lists them all.

## Import from your instruction files

When you run `mindly init` inside a repository, Mindly reads the instruction files you already
wrote for your agents:

- `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`
- `.cursorrules`, `.cursor/rules/`, `.windsurfrules`
- `.github/copilot-instructions.md`, `.clinerules`, `.roo/rules/`, `.kiro/steering/`, and similar
  files

Each bullet or sentence becomes a rule, shown with its file and line. Mindly asks before importing
the new ones. With `--yes`, or when there is no terminal to ask on, they are added as proposals for
you to approve.

What it skips and keeps:

- Headings, code blocks and boilerplate are skipped. A code block ends only at a fence of the same
  kind that is at least as long as the one that opened it, so examples that contain their own
  fences are skipped whole.
- Bold and link markup is removed. Inline code is kept exactly as written, and so are names such
  as `__init__.py` or `MY__ENV__VAR`.
- Context such as a "Don'ts" heading stays attached to the items under it.
- A rule Mindly already has is not imported again. That includes rules you archived or rejected.
- Your decision on a rule stands. An agent that states a rule you rejected does not bring it back,
  and one that restates a rule you approved does not change its text or its approval. Only you
  can do either.
- Path patterns in Cursor, Copilot and Kiro rules become the rule's scope.
- If you later delete a line from the file, its rule is marked as possibly outdated.

`mindly init --no-import` skips this step. `mindly rules import` runs it again later
(`--dry-run` shows what it would add).

## Write rules back into the files

`mindly rules sync` writes your approved rules into a marked section of `AGENTS.md`, `CLAUDE.md`
and `GEMINI.md`. It uses the files the checkout already has, or creates `AGENTS.md`. Agents that
are not connected to Mindly then follow the rules too, and the rules are versioned with your code.

It is off until you turn it on. `init` offers it, and `mindly rules sync` shows the change and asks
first. `--dry-run` previews and `--yes` skips the question.

Once it is on:

- The section is rewritten whenever a rule is approved, edited or archived, so check the diff
  before you commit.
- Mindly only writes between `<!-- mindly:rules:start -->` and `<!-- mindly:rules:end -->`.
  Everything else in the file stays exactly as you wrote it.
- Only rules you approved yourself are written. A rule picked up from a prompt reaches connected
  agents right away, but goes into the files only after you approve it. Restoring a snapshot does
  not count as that approval.
- A rule imported from a file is not written back into that same file.
- Edits made inside the section are replaced, with a warning. Change rules with `mindly rules` or
  in Mission Control.
- Each linked git worktree is turned on separately and gets its own copy.

`mindly rules sync --off` removes the section from the current checkout. `mindly uninstall`
removes it everywhere.
