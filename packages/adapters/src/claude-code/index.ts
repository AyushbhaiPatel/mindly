import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  HookEventName,
  HookResult,
  InstallOptions,
  InstallStep,
  NormalizedHookEvent,
  RenderedHookOutput,
} from '@mindly/core';
import type { NativeEventSpec } from '../shared/claude-style.js';
import { parseClaudeStyle, renderClaudeStyle } from '../shared/claude-style.js';
import { hookCommand, MCP_SERVER_NAME, mcpLaunch } from '../shared/command.js';
import { ensureRecord } from '../shared/config-files.js';
import { detectAgent } from '../shared/detect.js';
import type { HookSpec } from '../shared/json-hooks.js';
import {
  addGroupedHooks,
  dropIfEmpty,
  hooksObject,
  removeGroupedHooks,
} from '../shared/json-hooks.js';
import type { PlanMode } from '../shared/plan.js';
import { compactSteps, planJsonFile, validateInstallOptions } from '../shared/plan.js';
import { isRecord } from '../shared/payload.js';
import {
  isMindlyStatusLine,
  readStatusLine,
  statusLineSetting,
  statusLineSettingsFiles,
} from './statusline.js';

const KIND = 'claude-code';

/** Native Claude Code hook events Mindly handles. */
export const CLAUDE_CODE_EVENTS: Readonly<Record<string, NativeEventSpec>> = {
  SessionStart: { event: 'session_start' },
  UserPromptSubmit: { event: 'prompt' },
  PreToolUse: { event: 'pre_tool' },
  PostToolUse: { event: 'post_tool' },
  PostToolUseFailure: { event: 'post_tool', failed: true },
  Stop: { event: 'stop' },
  SessionEnd: { event: 'session_end' },
};

const NAMES: Readonly<Record<HookEventName, string>> = {
  session_start: 'SessionStart',
  prompt: 'UserPromptSubmit',
  pre_tool: 'PreToolUse',
  post_tool: 'PostToolUse',
  stop: 'Stop',
  session_end: 'SessionEnd',
};

/** Tools whose calls Mindly inspects (file writes and shell). */
export const CLAUDE_CODE_TOOL_MATCHER = 'Edit|MultiEdit|Write|NotebookEdit|Bash';

/** `~/.claude.json` holds a lot of Claude Code state, so it gets a larger read cap. */
const MAX_CLAUDE_JSON_BYTES = 16 * 1024 * 1024;
const HOOK_TIMEOUT_SEC = 10;

function hookSpecs(command: readonly string[]): HookSpec[] {
  const spec = (event: string, matcher?: string): HookSpec => ({
    event,
    ...(matcher !== undefined ? { matcher } : {}),
    command: hookCommand(command, KIND, event),
    timeout: HOOK_TIMEOUT_SEC,
  });
  return [
    spec('SessionStart'),
    spec('UserPromptSubmit'),
    spec('PreToolUse', CLAUDE_CODE_TOOL_MATCHER),
    spec('PostToolUse', CLAUDE_CODE_TOOL_MATCHER),
    spec('PostToolUseFailure', CLAUDE_CODE_TOOL_MATCHER),
    spec('Stop'),
    spec('SessionEnd'),
  ];
}

/** Options for {@link createClaudeCodeAdapter}; mainly for tests. */
export interface ClaudeCodeAdapterOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Install Mindly's status line (default true). It is only added where no other status line
   * applies; false leaves any existing `statusLine` untouched. Uninstall always removes Mindly's.
   */
  statusLine?: boolean;
}

/** Config files touched by the Claude Code installer. */
export function claudeCodePaths(options: InstallOptions): { settings: string; mcp: string } {
  if (options.projectRoot !== null) {
    return {
      settings: join(options.projectRoot, '.claude', 'settings.json'),
      mcp: join(options.projectRoot, '.mcp.json'),
    };
  }
  return {
    settings: join(options.homeDir, '.claude', 'settings.json'),
    mcp: join(options.homeDir, '.claude.json'),
  };
}

/**
 * Whether install may add Mindly's status line: never when a settings file of the scope (the
 * target itself, the user's settings or the project's local settings) has a status line of the
 * user's own, because Mindly's would replace it, hide it or be hidden by it.
 */
async function mayAddStatusLine(options: InstallOptions): Promise<boolean> {
  const files = statusLineSettingsFiles(options.homeDir, options.projectRoot);
  const found = await Promise.all(files.map(readStatusLine));
  return !found.some((s) => s.owner === 'other');
}

async function plan(
  options: InstallOptions,
  mode: PlanMode,
  statusLine: boolean,
): Promise<InstallStep[]> {
  validateInstallOptions(options);
  const paths = claudeCodePaths(options);
  const install = mode === 'install';
  const withStatusLine = install && statusLine;
  const addStatusLine = withStatusLine && (await mayAddStatusLine(options));
  const settings = await planJsonFile(
    paths.settings,
    install
      ? `Register Mindly hooks${addStatusLine ? ' and status line' : ''} for Claude Code`
      : 'Remove Mindly hooks from Claude Code',
    mode,
    (config) => {
      const current = config['statusLine'];
      if (isMindlyStatusLine(current)) {
        if (withStatusLine) config['statusLine'] = statusLineSetting(options.command);
        else if (!install) Reflect.deleteProperty(config, 'statusLine');
      } else if ((current === undefined || current === null) && addStatusLine) {
        config['statusLine'] = statusLineSetting(options.command);
      }
      if (!install && !isRecord(config['hooks'])) return;
      const hooks = hooksObject(config, paths.settings);
      removeGroupedHooks(hooks, KIND);
      if (install) addGroupedHooks(hooks, hookSpecs(options.command), paths.settings);
      dropIfEmpty(config, 'hooks');
    },
  );
  const mcp = await planJsonFile(
    paths.mcp,
    install
      ? 'Register the Mindly MCP server for Claude Code'
      : 'Remove the Mindly MCP server from Claude Code',
    mode,
    (config) => {
      if (install) {
        const servers = ensureRecord(config, 'mcpServers', paths.mcp);
        const launch = mcpLaunch(options.command, KIND);
        servers[MCP_SERVER_NAME] = {
          type: 'stdio',
          command: launch.command,
          args: launch.args,
          env: {},
        };
      } else if (isRecord(config['mcpServers']) && MCP_SERVER_NAME in config['mcpServers']) {
        Reflect.deleteProperty(config['mcpServers'], MCP_SERVER_NAME);
      }
    },
    MAX_CLAUDE_JSON_BYTES,
  );
  return compactSteps([settings, mcp]);
}

/**
 * Creates the Claude Code adapter. Hooks and the status line go in `.claude/settings.json` (user
 * or project) and the MCP server in `~/.claude.json` (user scope) or `<project>/.mcp.json`
 * (project scope).
 */
export function createClaudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): AgentAdapter {
  return {
    kind: KIND,
    displayName: 'Claude Code',
    detect(): Promise<boolean> {
      const home = opts.homeDir ?? homedir();
      return detectAgent([join(home, '.claude')], ['claude'], opts.env);
    },
    parse(nativeEvent: string, payload: unknown): NormalizedHookEvent | null {
      return parseClaudeStyle(KIND, CLAUDE_CODE_EVENTS, nativeEvent, payload);
    },
    render(event: NormalizedHookEvent, result: HookResult): RenderedHookOutput {
      return renderClaudeStyle(event, result, {
        names: NAMES,
        supportsAsk: true,
        systemMessageEvents: new Set<HookEventName>([
          'session_start',
          'prompt',
          'pre_tool',
          'post_tool',
          'stop',
        ]),
      });
    },
    planInstall: (options) => plan(options, 'install', opts.statusLine ?? true),
    planUninstall: (options) => plan(options, 'uninstall', false),
  };
}

/** Default Claude Code adapter. */
export const claudeCodeAdapter: AgentAdapter = createClaudeCodeAdapter();
