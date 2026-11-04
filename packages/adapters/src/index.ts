import type { AgentAdapter } from '@mindly/core';
import { claudeCodeAdapter } from './claude-code/index.js';
import { codexAdapter } from './codex/index.js';
import { cursorAdapter } from './cursor/index.js';
import { geminiAdapter } from './gemini/index.js';
import { createMcpClientAdapters } from './mcp-clients/adapter.js';

export {
  CLAUDE_CODE_EVENTS,
  CLAUDE_CODE_TOOL_MATCHER,
  claudeCodeAdapter,
  claudeCodePaths,
  createClaudeCodeAdapter,
} from './claude-code/index.js';
export type { ClaudeCodeAdapterOptions } from './claude-code/index.js';
export {
  inspectClaudeCodeStatusLine,
  isMindlyStatusLine,
  parseClaudeCodeStatusLine,
  STATUS_LINE_REFRESH_SEC,
  statusLineSetting,
} from './claude-code/statusline.js';
export type { ClaudeCodeStatusLine, StatusLineInput } from './claude-code/statusline.js';
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
export {
  createGeminiAdapter,
  GEMINI_EVENTS,
  GEMINI_TOOL_MATCHER,
  geminiAdapter,
  geminiSettingsPath,
} from './gemini/index.js';
export type { GeminiAdapterOptions } from './gemini/index.js';
export {
  createMcpClientAdapter,
  createMcpClientAdapters,
  genericMcpSnippet,
  integrationOf,
  McpClientAdapter,
} from './mcp-clients/adapter.js';
export type { IntegrationLevel, McpClientAdapterOptions } from './mcp-clients/adapter.js';
export {
  findMcpClient,
  MCP_CLIENTS,
  mcpPlatform,
  parseJsonPointer,
} from './mcp-clients/catalog.js';
export type {
  McpClientSpec,
  McpConfigFormat,
  McpLaunch,
  McpPathContext,
  McpPlatform,
} from './mcp-clients/catalog.js';
export {
  detectFormatting,
  readJsoncValue,
  removeJsoncValue,
  setJsoncValue,
} from './mcp-clients/jsonc-edit.js';
export { applyInstallSteps, readOnlyTarget } from './apply.js';
export type { AppliedStep, ApplyOptions } from './apply.js';
export {
  hookCommand,
  isMindlyHookCommand,
  MCP_SERVER_NAME,
  mcpLaunch,
  shellJoin,
  shellQuote,
  validateArgv,
} from './shared/command.js';
export { classifyTool, extractEdits } from './shared/tools.js';
export { MAX_EXCERPT_CHARS, MAX_TEXT_CHARS } from './shared/payload.js';

/** Agents with deep hook integration (hooks + MCP). */
export const HOOK_AGENT_KINDS = ['claude-code', 'codex', 'cursor', 'gemini'] as const;

/**
 * Every built-in adapter, keyed by agent kind: the hook adapters first, then the MCP-only
 * clients from the catalog.
 */
export const adapters: Readonly<Record<string, AgentAdapter>> = Object.freeze({
  [claudeCodeAdapter.kind]: claudeCodeAdapter,
  [codexAdapter.kind]: codexAdapter,
  [cursorAdapter.kind]: cursorAdapter,
  [geminiAdapter.kind]: geminiAdapter,
  ...createMcpClientAdapters(),
});

/** Returns the built-in adapter for `kind`, or null when none exists. */
export function getAdapter(kind: string): AgentAdapter | null {
  return Object.prototype.hasOwnProperty.call(adapters, kind) ? (adapters[kind] ?? null) : null;
}
