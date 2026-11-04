# Changelog

All notable changes to `mindly-cli` are documented here. The project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor version.

## Unreleased

### Added

- Gemini CLI gets the full integration (hooks + MCP), like Claude Code, Codex and Cursor:
  `mindly init` registers `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`
  and `SessionEnd` hooks in `.gemini/settings.json` next to the MCP server, so Gemini's edits and
  shell commands are captured, context is injected at session start, on each prompt and after
  tool calls, and enforced rules can block a write. Comments and your own hooks in the settings
  file are kept, and `mindly uninstall` restores it.

## 0.1.3 — 2026-11-04

### Changed

- Mission Control has a new design in the style of ayushp.me: Newsreader and DM Sans type, a soft
  sky background, a calm "nightfall" dark mode, and one centered column.
- Data is structured instead of written as prose: a stats row, aligned tables for agents,
  conflicts, merge checks, memory and activity, with details on expand.
- One primary (gel) button per item; other actions are text links or in a `⋯` menu. Explanations
  moved into `?` tooltips. Tables stack into label/value rows on phones.
- Fonts are bundled (SIL OFL 1.1), so the dashboard still makes no external requests.

### Fixed

- Mission Control and `mindly status` now agree on what needs you: an open conflict that is more
  than FYI. The dashboard used to count only critical conflicts.

### Added

- An animated demo in the README, generated from a real two-agent run (`pnpm demo`).

## 0.1.2 — 2026-11-04

### Changed

- Every command is easier to read: a one-line summary first, plain words instead of internal
  terms ("suggested by Codex, waiting for you" instead of `proposed`), agent names like
  "Claude Code · 4409d433", relative times, no empty sections, and the exact next command to run.
  `mindly doctor` groups checks into Setup, Agents and Optional and tells you how to fix each one.
- Commands that take an id accept the 8-character short id shown in the output (or any unique
  prefix), instead of the full id.
- Mission Control: a summary bar, "Needs you" first with one action per item, conflicts written as
  problem statements, trust in words, explanations in every empty panel and help for each term.

`--json` output is unchanged.

## 0.1.1 — 2026-11-04

### Added

- `mindly init --agents <list>` connects 12 more agents through Mindly's MCP server: Windsurf,
  Kiro, Gemini CLI, VS Code (GitHub Copilot), Cline, Roo Code, Claude Desktop, OpenCode, Zed, Amp,
  Augment (Auggie CLI) and LM Studio. Comments and other settings in their config files are kept
  byte for byte, and `mindly uninstall` restores the original file.
- `mindly init --list-agents` shows every supported agent and its integration level.

### Changed

- The README now leads with the problem, real examples and installation.

## 0.1.0 — 2026-11-04

First public release: shared memory, live coordination and insight for Claude Code, Codex and
Cursor, with Mission Control, an MCP server and a local daemon. Also published as the now
deprecated `mindly-agents`.
