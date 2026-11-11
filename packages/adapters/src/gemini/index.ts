import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  HookResult,
  InstallOptions,
  InstallStep,
  NormalizedHookEvent,
  RenderedHookOutput,
} from '@mindly/core';
import { MindlyError } from '@mindly/core';
import type { NativeEventSpec } from '../shared/claude-style.js';
import { parseClaudeStyle } from '../shared/claude-style.js';
import { hookCommand, isMindlyHookCommand, MCP_SERVER_NAME, mcpLaunch } from '../shared/command.js';
import { cloneJson, readConfigText, stepIfChanged } from '../shared/config-files.js';
import { detectAgent } from '../shared/detect.js';
import {
  contextText,
  jsonOutput,
  MAX_NOTICE_CHARS,
  reasonText,
  SILENT,
  userMessageText,
} from '../shared/event.js';
import type { HookSpec } from '../shared/json-hooks.js';
import { addGroupedHooks, removeGroupedHooks } from '../shared/json-hooks.js';
import type { PlanMode } from '../shared/plan.js';
import { validateInstallOptions } from '../shared/plan.js';
import { capText, isRecord, readString } from '../shared/payload.js';
import { buildTool } from '../shared/tools.js';
import {
  editJsoncArrayItem,
  readJsoncValue,
  removeJsoncValue,
  setJsoncValue,
} from '../mcp-clients/jsonc-edit.js';

const KIND = 'gemini';
const FORMAT = 'jsonc';

/** Native Gemini CLI hook events Mindly handles. */
export const GEMINI_EVENTS: Readonly<Record<string, NativeEventSpec>> = {
  SessionStart: { event: 'session_start' },
  BeforeAgent: { event: 'prompt' },
  BeforeTool: { event: 'pre_tool' },
  AfterTool: { event: 'post_tool' },
  AfterAgent: { event: 'stop' },
  SessionEnd: { event: 'session_end' },
};

/** Gemini CLI's built-in file-writing tools. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'replace']);
/** Gemini CLI's built-in shell tool. */
const SHELL_TOOL = 'run_shell_command';

/** Tools whose calls Mindly inspects (file writes and shell). Gemini tool matchers are regexes. */
export const GEMINI_TOOL_MATCHER = '^(write_file|replace|run_shell_command)$';

/** Gemini CLI hook timeouts are in milliseconds. */
const HOOK_TIMEOUT_MS = 10_000;

function hookSpecs(command: readonly string[]): HookSpec[] {
  const spec = (event: string, matcher?: string): HookSpec => ({
    event,
    ...(matcher !== undefined ? { matcher } : {}),
    command: hookCommand(command, KIND, event),
    timeout: HOOK_TIMEOUT_MS,
    name: `mindly-${event}`,
  });
  return [
    spec('SessionStart'),
    spec('BeforeAgent'),
    spec('BeforeTool', GEMINI_TOOL_MATCHER),
    spec('AfterTool', GEMINI_TOOL_MATCHER),
    spec('AfterAgent'),
    spec('SessionEnd'),
  ];
}

/**
 * Flattens Gemini's tool result (`{ llmContent, returnDisplay, error: { message, type } }`) into
 * the fields the shared tool builder reads. The shell tool reports a non-zero exit as an
 * `Exit Code: N` line in `llmContent` instead of an error.
 */
function toolResponse(toolName: string, response: unknown): Record<string, unknown> {
  if (!isRecord(response)) return {};
  const out: Record<string, unknown> = {};
  const error = response['error'];
  if (isRecord(error)) out['error'] = readString(error, ['message', 'type']) || 'error';
  const content = readString(response, ['llmContent', 'returnDisplay']);
  if (content !== null) out['output'] = content;
  if (toolName === SHELL_TOOL && content !== null) {
    const exit = /^Exit Code: (-?\d+)\s*$/m.exec(content);
    if (exit !== null) out['exit_code'] = Number(exit[1]);
  }
  return out;
}

/**
 * In headless mode (`gemini -p`) Gemini prepends SessionStart context to the first prompt as
 * `<hook_context>...</hook_context>` (with `<` and `>` escaped inside), so BeforeAgent would hand
 * Mindly its own context back as if the user had typed it.
 */
const HOOK_CONTEXT_RE = /^\s*<hook_context>[\s\S]*?<\/hook_context>\s*/;

/** Parses a Gemini CLI hook payload (Claude-style base fields). Never throws. */
function parseGemini(nativeEvent: string, payload: unknown): NormalizedHookEvent | null {
  try {
    const ev = parseClaudeStyle(KIND, GEMINI_EVENTS, nativeEvent, payload);
    if (ev === null || !isRecord(payload)) return ev;
    if (ev.tool !== null) {
      const name = ev.tool.name;
      ev.tool = buildTool({
        name,
        input: payload['tool_input'] ?? {},
        ...(ev.event === 'post_tool'
          ? { response: toolResponse(name, payload['tool_response']) }
          : {}),
        ...(WRITE_TOOLS.has(name) ? { writes: true } : {}),
        ...(name === SHELL_TOOL ? { shell: true } : {}),
      });
    }
    if (ev.prompt !== null) ev.prompt = ev.prompt.replace(HOOK_CONTEXT_RE, '');
    if (ev.event === 'stop') ev.lastMessage = readString(payload, ['prompt_response']);
    return ev;
  } catch {
    return null;
  }
}

/**
 * Renders a result as Gemini CLI hook JSON. Gemini reads `hookSpecificOutput.additionalContext`
 * on SessionStart, BeforeAgent and AfterTool only. BeforeTool has no context channel, so a deny
 * folds the context into the reason the model sees; without a deny or an ask the context is
 * dropped, and only the warning that a line could not be read fully goes to the person, as the
 * `systemMessage`. Decisions are top-level `decision` /
 * `reason`; `allow` is never emitted so Gemini's own confirmations still apply, and AfterAgent
 * never gets a decision (a deny there would force a retry turn).
 */
function renderGemini(event: NormalizedHookEvent, result: HookResult): RenderedHookOutput {
  try {
    if (event.event === 'session_end') return SILENT;
    const out: Record<string, unknown> = {};
    const context = contextText(result);
    let notice = userMessageText(result);
    if (event.event === 'pre_tool') {
      if (result.decision === 'deny') {
        const reason = reasonText(result);
        out['decision'] = 'deny';
        out['reason'] = context === null ? reason : `${reason}\n\n${context}`;
      } else if (result.decision === 'ask') {
        out['decision'] = 'ask';
        out['reason'] = reasonText(result);
        // Gemini shows the systemMessage in its confirmation prompt.
        notice ??= reasonText(result);
      }
      // The model cannot be told before the tool runs that its line was not read: the person is.
      const unread = result.unreadWarning ?? null;
      if (result.decision !== 'deny' && result.decision !== 'ask' && unread !== null) {
        const warning = capText(unread, MAX_NOTICE_CHARS);
        if (warning.trim() !== '') notice = notice === null ? warning : `${notice}\n\n${warning}`;
      }
    } else if (context !== null && event.event !== 'stop') {
      out['hookSpecificOutput'] = {
        hookEventName: event.nativeEvent ?? '',
        additionalContext: context,
      };
    }
    if (notice !== null) out['systemMessage'] = notice;
    return jsonOutput(out);
  } catch {
    return SILENT;
  }
}

/** Options for {@link createGeminiAdapter}; mainly for tests. */
export interface GeminiAdapterOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** The settings file the Gemini CLI installer edits; it holds both hooks and MCP servers. */
export function geminiSettingsPath(
  options: Pick<InstallOptions, 'homeDir' | 'projectRoot'>,
): string {
  return join(options.projectRoot ?? options.homeDir, '.gemini', 'settings.json');
}

async function plan(options: InstallOptions, mode: PlanMode): Promise<InstallStep[]> {
  validateInstallOptions(options);
  const file = geminiSettingsPath(options);
  const install = mode === 'install';
  const previous = await readConfigText(file);
  if (previous === null && !install) return [];

  const current = readJsoncValue(file, previous, FORMAT, ['hooks']);
  if (current !== undefined && current !== null && !isRecord(current)) {
    throw new MindlyError('invalid_input', `"hooks" in ${file} must be an object`);
  }
  const before = isRecord(current) ? current : {};
  // Validates every event list and computes what the element edits below must produce.
  const after = cloneJson(before);
  removeGroupedHooks(after, KIND);
  const specs = install ? hookSpecs(options.command) : [];
  addGroupedHooks(after, specs, file);

  // Hook groups are edited one array element at a time, so the user's own groups and the
  // comments around them keep their bytes. Nothing is touched when the hooks are already right.
  let text: string | null = previous;
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  for (const [event, groups] of unchanged ? [] : Object.entries(before)) {
    if (!Array.isArray(groups)) continue;
    for (let i = groups.length - 1; i >= 0; i--) {
      const group: unknown = groups[i];
      if (!isRecord(group) || !Array.isArray(group['hooks'])) continue;
      const inner = group['hooks'] as unknown[];
      const kept = inner.filter((h) => !(isRecord(h) && isMindlyHookCommand(h['command'], KIND)));
      if (kept.length === inner.length) continue;
      const value = kept.length > 0 ? { ...group, hooks: kept } : undefined;
      text = editJsoncArrayItem(file, text ?? '', FORMAT, ['hooks', event], i, value);
    }
  }
  for (const spec of unchanged ? [] : specs) {
    const group = (after[spec.event] as unknown[]).at(-1);
    const path = ['hooks', spec.event];
    text = Array.isArray(readJsoncValue(file, text, FORMAT, path))
      ? editJsoncArrayItem(file, text ?? '', FORMAT, path, null, group)
      : setJsoncValue(file, text, FORMAT, path, [group]);
  }
  for (const event of Object.keys(before)) {
    if (after[event] !== undefined || text === null) continue;
    text = removeJsoncValue(file, text, FORMAT, ['hooks', event], { pruneEmptyParent: true });
  }

  const server = ['mcpServers', MCP_SERVER_NAME];
  if (install) {
    const launch = mcpLaunch(options.command, KIND);
    text = setJsoncValue(file, text, FORMAT, server, {
      command: launch.command,
      args: launch.args,
    });
  } else if (text !== null) {
    text = removeJsoncValue(file, text, FORMAT, server, { pruneEmptyParent: true });
  }

  const step = stepIfChanged(
    file,
    install
      ? 'Register Mindly hooks and MCP server for Gemini CLI'
      : 'Remove Mindly hooks and MCP server from Gemini CLI',
    previous,
    text ?? '',
  );
  return step === null ? [] : [step];
}

/**
 * Creates the Gemini CLI adapter. Hooks and the MCP server both live in `.gemini/settings.json`
 * (user or project). The file is JSONC, so it is edited in place: comments and unrelated settings
 * stay as they were.
 */
export function createGeminiAdapter(opts: GeminiAdapterOptions = {}): AgentAdapter {
  return {
    kind: KIND,
    displayName: 'Gemini CLI',
    detect(): Promise<boolean> {
      return detectAgent([join(opts.homeDir ?? homedir(), '.gemini')], ['gemini'], opts.env);
    },
    parse: parseGemini,
    render: renderGemini,
    planInstall: (options) => plan(options, 'install'),
    planUninstall: (options) => plan(options, 'uninstall'),
  };
}

/** Default Gemini CLI adapter. */
export const geminiAdapter: AgentAdapter = createGeminiAdapter();
