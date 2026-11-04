# Changelog

All notable changes to `mindly-cli` are documented here. The project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor version.

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
