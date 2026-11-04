# Output style

How Mindly talks to people in the CLI and in Mission Control. The goal: someone who has never read
the docs understands what they see, knows what matters, and knows what to do next.

## Principles

1. **Answer first.** Every screen starts with a one-line summary of the state ("2 agents working ·
   1 thing needs you"), then details. If nothing is happening, say so ("All quiet.").
2. **Plain words, not internals.** Use the vocabulary below. Never show event types, table names,
   token counts or enum values (`session_start`, `proposed`, `intent_overlap`) without translation.
3. **Every list item says what it is and why it matters.** "Codex is editing `src/dash.ts`", not
   "Intent: Editing src/dash.ts (src/dash.ts)".
4. **Always end with what to do next** when there is something to do: one or two exact commands
   (CLI) or buttons (dashboard).
5. **Hide what is empty.** No `Tasks (0)` sections. Empty states are one friendly line.
6. **Short ids only.** Show the 8-character short id (`shortId()` in core), never a full UUID. Every
   command that takes an id accepts the short id (and a full id). Ambiguous short ids are reported
   with the candidates.
7. **Relative times.** "2m ago", "yesterday 14:05"; absolute local time only where precision matters
   (provenance), never UTC.
8. **Machine output stays exact.** `--json` output is unchanged by any of this: full ids, raw enums,
   timestamps in ms.

## Vocabulary

| Internal concept                                           | Say                                                | Example                                                      |
| ---------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| agent kind `claude-code`                                   | the product name                                   | Claude Code, Codex, Cursor, Gemini CLI                       |
| session                                                    | the agent plus its short tag                       | Claude Code · 4409d433                                       |
| session status active / idle / rate_limited / ended        | working / idle / hit its usage limit / finished    |                                                              |
| intent                                                     | "is editing" / "plans to edit"                     | Codex is editing `src/dash.ts`                               |
| delivery                                                   | update for an agent                                | 1 update waiting for Codex                                   |
| delivered / acked                                          | seen                                               |                                                              |
| conflict                                                   | conflict (with a plain description of the problem) | Claude Code changed `login()`; Codex's `src/dash.ts` uses it |
| severity info / warning / critical                         | FYI / check this / urgent                          |                                                              |
| conflict status open / acknowledged / resolved / dismissed | open / seen / resolved / dismissed                 |                                                              |
| trust approved                                             | approved by you                                    |                                                              |
| trust verified                                             | confirmed in the code                              |                                                              |
| trust proposed                                             | suggested by _agent_, waiting for you              |                                                              |
| trust stale                                                | may be outdated (code changed)                     |                                                              |
| trust rejected                                             | rejected                                           |                                                              |
| memory kind rule / decision / fact / mistake / note        | rule / decision / fact / known pitfall / note      |                                                              |
| handoff pending / claimed                                  | waiting for _agent_ / picked up by _agent_         |                                                              |
| context packet                                             | context sent to an agent                           |                                                              |
| tokens                                                     | (do not show; at most "short / long")              |                                                              |
| run shadow_merge / review / replay                         | merge check / review / replay                      |                                                              |
| contract                                                   | check                                              | "Check: `login` returns `user.role`: passing"                |
| snapshot                                                   | snapshot                                           |                                                              |

## Symbols and colour

- Status markers: `✓` ok/passing, `!` needs attention, `✗` failing/urgent, `•` neutral item, `→`
  next step. Fall back to `[ok]`, `[!]`, `[x]`, `-`, `->` when the terminal is not UTF-8
  (`LANG`/`LC_ALL` without `UTF-8`) or `MINDLY_ASCII=1`.
- Colour only adds emphasis (never the only signal): green ok, yellow attention, red urgent, dim for
  ids and times. Respect `NO_COLOR` and non-TTY output (no colour, same text).
- Width: wrap long lines at the terminal width (default 100); never truncate ids or paths silently.

## Shape of a screen (CLI)

```text
Mindly · my-app · 2 agents working · 2 things need you

Agents
  ● Claude Code · 4409d433   working · main · edited src/auth.ts 1m ago
  ● Codex · f57f6d10         working · main · editing src/dash.ts

Needs you
  ! Conflict: Claude Code changed the exports of src/auth.ts; Codex's src/dash.ts uses them  [9f02a0c3]
  • Suggested rule from Claude Code: "Don't use default exports"                          [7bc7e9b7]

→ mindly conflict 9f02a0c3 resolve     mark the conflict resolved
→ mindly rules --approve 7bc7e9b7      make the rule apply to every agent
```

## Mission Control

Same vocabulary, same order of importance: summary bar, "Needs you", agents, activity. Every
badge has text, every number has a label, every empty panel has a one-line explanation of what will
appear there and when. Tooltips explain terms the first time they appear (e.g. "Intent: what an
agent is about to edit").
