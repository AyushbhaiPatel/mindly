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

| Internal concept                                           | Say                                                                           | Example                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| agent kind `claude-code`                                   | the product name                                                              | Claude Code, Codex, Cursor, Gemini CLI                                                   |
| session                                                    | the agent plus its short tag                                                  | Claude Code · 4409d433                                                                   |
| session status active / idle / rate_limited / ended        | working / idle / hit its usage limit / finished                               |                                                                                          |
| intent                                                     | "is editing" / "plans to edit"                                                | Codex is editing `src/dash.ts`                                                           |
| delivery                                                   | update for an agent                                                           | 1 update waiting for Codex                                                               |
| delivered / acked                                          | seen                                                                          |                                                                                          |
| conflict                                                   | conflict (with a plain description of the problem)                            | Claude Code changed `login()`; Codex's `src/dash.ts` uses it                             |
| severity info / warning / critical                         | FYI / check this / urgent                                                     |                                                                                          |
| conflict status open / acknowledged / resolved / dismissed | open / seen / resolved / dismissed                                            |                                                                                          |
| trust approved                                             | approved by you                                                               |                                                                                          |
| trust verified                                             | confirmed in the code                                                         |                                                                                          |
| trust proposed                                             | suggested by _agent_, waiting for you                                         |                                                                                          |
| trust stale                                                | may be outdated (code changed)                                                |                                                                                          |
| trust rejected                                             | rejected                                                                      |                                                                                          |
| memory kind rule / decision / fact / mistake / note        | rule / decision / fact / known pitfall / note                                 |                                                                                          |
| handoff pending / claimed                                  | waiting for _agent_ / picked up by _agent_                                    |                                                                                          |
| context packet                                             | context sent to an agent                                                      |                                                                                          |
| tokens                                                     | (do not show; at most "short / long")                                         |                                                                                          |
| run shadow_merge / review / replay                         | merge check / review / replay                                                 |                                                                                          |
| contract                                                   | check                                                                         | "Check: `login` returns `user.role`: passing"                                            |
| snapshot                                                   | snapshot                                                                      |                                                                                          |
| save                                                       | save ("Mindly saved you")                                                     | Mindly saved you 2 times today                                                           |
| save status caught / confirmed / expired / rejected        | pending (waiting for evidence) / counted / not confirmed in time / not a save |                                                                                          |
| save kind impact_warned                                    | told about a change before building on it                                     | Codex was told Claude Code changed code it uses before it wrote code using it            |
| save kind overlap_avoided                                  | stopped before overwriting another agent's work                               | Codex stopped before overwriting Claude Code's work                                      |
| save kind rule_enforced                                    | write blocked by your rule                                                    | A write by Codex was blocked by your rule                                                |
| save kind mistake_avoided                                  | known pitfall avoided                                                         | Codex didn't run a command that failed before                                            |
| save kind merge_conflict_early                             | merge conflict found before merging                                           | A merge conflict between Claude Code and Codex was found before either branch was merged |
| save kind check_broken_early                               | broken check fixed before merging                                             | A check Claude Code broke was caught and fixed before merging                            |
| save kind limit_handoff                                    | work continued after a usage limit                                            | Work continued in Codex after Claude Code hit its usage limit                            |

## Symbols and colour

- Status markers: `✓` ok/passing, `!` needs attention, `✗` failing/urgent, `•` neutral item, `→`
  next step. Fall back to `[ok]`, `[!]`, `[x]`, `-`, `->` when the terminal is not UTF-8
  (`LANG`/`LC_ALL` without `UTF-8`) or `MINDLY_ASCII=1`.
- Colour only adds emphasis (never the only signal): green ok, yellow attention, red urgent, dim for
  ids and times. Respect `NO_COLOR` and non-TTY output (no colour, same text).
- Width: wrap long lines at the terminal width (default 100); never truncate ids or paths silently.
- Lists of things of the same kind (agents, rules, memories, conflicts, saves, handoffs) are
  tables: a dimmed header row, one row per item, columns aligned, the id last. One column takes
  the remaining width and wraps; on a narrow terminal the least important columns are left out
  rather than squeezed, and a column that is empty for every row is not shown.

## Shape of a screen (CLI)

```text
Mindly · my-app · 2 agents working · 2 things need you

Agents
  Agent                     Status   Branch  Doing                      Active
  ● Claude Code · 4409d433  working  main    edited src/auth.ts 1m ago  1m ago
  ● Codex · f57f6d10        working  main    editing src/dash.ts        1m ago

Needs you
  Type        What
  ! Conflict  Claude Code · 4409d433 changed the exports of src/auth.ts; Codex's          [9f02a0c3]
              src/dash.ts uses them
  • Rule      "Don't use default exports" · suggested by you, in Claude Code              [7bc7e9b7]

→ mindly conflict 9f02a0c3 resolve   mark the conflict resolved
→ mindly rules --approve 7bc7e9b7    make the rule apply to every agent
```

## Mission Control

Saves are counted only once confirmed: totals, the status line (`mindly · 2 saves today · …`,
first and only when there are any), `mindly status`, the standup and the "saves this week" stat
never include pending, expired or rejected saves. Pending ones may appear in detail views, labelled
as not counted yet. The share card shows counts and agent names only unless the user asks for
details.

Same vocabulary, same order of importance: summary bar, "Needs you", agents, activity. Every
badge has text, every number has a label, every empty panel has a one-line explanation of what will
appear there and when. Tooltips explain terms the first time they appear (e.g. "Intent: what an
agent is about to edit").
