import type { AgentAdapter } from '@synapse/core';
import { claudeCodeAdapter } from './claude-code/index.js';
import { codexAdapter } from './codex/index.js';
import { cursorAdapter } from './cursor/index.js';

export {
  CLAUDE_CODE_EVENTS,
  CLAUDE_CODE_TOOL_MATCHER,
  claudeCodeAdapter,
  claudeCodePaths,
  createClaudeCodeAdapter,
} from './claude-code/index.js';
export type { ClaudeCodeAdapterOptions } from './claude-code/index.js';
export {
  CODEX_EVENTS,
  CODEX_TOOL_MATCHER,
  codexAdapter,
  codexPaths,
  createCodexAdapter,
  findPatchText,
  MAX_PATCH_BYTES,
  parseApplyPatch,
} from './codex/index.js';
export type { CodexAdapterOptions } from './codex/index.js';
export {
  CURSOR_EVENTS,
  CURSOR_INSTALLED_EVENTS,
  createCursorAdapter,
  cursorAdapter,
  cursorPaths,
} from './cursor/index.js';
export type { CursorAdapterOptions } from './cursor/index.js';
export { applyInstallSteps } from './apply.js';
export type { AppliedStep } from './apply.js';
export {
  hookCommand,
  isSynapseHookCommand,
  MCP_SERVER_NAME,
  mcpLaunch,
  shellJoin,
  shellQuote,
  validateArgv,
} from './shared/command.js';
export { classifyTool, extractEdits } from './shared/tools.js';
export { MAX_EXCERPT_CHARS, MAX_TEXT_CHARS } from './shared/payload.js';

/** Every built-in adapter, keyed by agent kind. */
export const adapters: Readonly<Record<string, AgentAdapter>> = Object.freeze({
  [claudeCodeAdapter.kind]: claudeCodeAdapter,
  [codexAdapter.kind]: codexAdapter,
  [cursorAdapter.kind]: cursorAdapter,
});

/** Returns the built-in adapter for `kind`, or null when none exists. */
export function getAdapter(kind: string): AgentAdapter | null {
  return Object.prototype.hasOwnProperty.call(adapters, kind) ? (adapters[kind] ?? null) : null;
}
