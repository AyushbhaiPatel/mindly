import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
import { readConfigText, stepIfChanged } from '../shared/config-files.js';
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
import { parseToml, TOML_BLOCK_BEGIN, upsertMcpServerToml } from './toml.js';

export { findPatchText, MAX_PATCH_BYTES, parseApplyPatch, readApplyPatch } from './apply-patch.js';

const KIND = 'codex';

/** Native Codex hook events Mindly handles. */
export const CODEX_EVENTS: Readonly<Record<string, NativeEventSpec>> = {
  SessionStart: { event: 'session_start' },
  UserPromptSubmit: { event: 'prompt' },
  PreToolUse: { event: 'pre_tool' },
  PostToolUse: { event: 'post_tool' },
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

/** Codex reports shell / unified exec as `Bash` and file edits as `apply_patch`. */
export const CODEX_TOOL_MATCHER = '^(Bash|apply_patch)$';

const HOOK_TIMEOUT_SEC = 10;
/** Codex caps SessionEnd hooks at 3 seconds. */
const SESSION_END_TIMEOUT_SEC = 3;

function hookSpecs(command: readonly string[]): HookSpec[] {
  const spec = (event: string, timeout: number, matcher?: string): HookSpec => ({
    event,
    ...(matcher !== undefined ? { matcher } : {}),
    command: hookCommand(command, KIND, event),
    timeout,
  });
  return [
    spec('SessionStart', HOOK_TIMEOUT_SEC),
    spec('UserPromptSubmit', HOOK_TIMEOUT_SEC),
    spec('PreToolUse', HOOK_TIMEOUT_SEC, CODEX_TOOL_MATCHER),
    spec('PostToolUse', HOOK_TIMEOUT_SEC, CODEX_TOOL_MATCHER),
    spec('Stop', HOOK_TIMEOUT_SEC),
    spec('SessionEnd', SESSION_END_TIMEOUT_SEC),
  ];
}

/** Options for {@link createCodexAdapter}; mainly for tests. */
export interface CodexAdapterOptions {
  homeDir?: string;
  /** Environment used for `CODEX_HOME` and PATH lookups. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function codexHome(homeDir: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = env['CODEX_HOME'];
  return fromEnv !== undefined && isAbsolute(fromEnv) ? fromEnv : join(homeDir, '.codex');
}

/** Config files touched by the Codex installer. */
export function codexPaths(
  options: InstallOptions,
  env: NodeJS.ProcessEnv = {},
): { hooks: string; config: string } {
  const dir =
    options.projectRoot !== null
      ? join(options.projectRoot, '.codex')
      : codexHome(options.homeDir, env);
  return { hooks: join(dir, 'hooks.json'), config: join(dir, 'config.toml') };
}

async function planToml(
  file: string,
  options: InstallOptions,
  mode: PlanMode,
): Promise<InstallStep | null> {
  const previous = await readConfigText(file);
  if (mode === 'uninstall') {
    if (previous === null) return null;
    const doc = parseToml(file, previous);
    const servers = doc['mcp_servers'];
    const present = isRecord(servers) && MCP_SERVER_NAME in servers;
    if (!present && !previous.includes(TOML_BLOCK_BEGIN)) return null;
  }
  const launch = mode === 'install' ? mcpLaunch(options.command, KIND) : null;
  const content = upsertMcpServerToml(file, previous ?? '', MCP_SERVER_NAME, launch);
  return stepIfChanged(
    file,
    mode === 'install'
      ? 'Register the Mindly MCP server for Codex'
      : 'Remove the Mindly MCP server from Codex',
    previous,
    content,
  );
}

/**
 * Creates the Codex adapter. Hooks go in `hooks.json` and the MCP server in `config.toml`, both
 * under `$CODEX_HOME` (default `~/.codex`) or `<project>/.codex` for project installs.
 */
export function createCodexAdapter(opts: CodexAdapterOptions = {}): AgentAdapter {
  const env = opts.env ?? process.env;
  async function plan(options: InstallOptions, mode: PlanMode): Promise<InstallStep[]> {
    validateInstallOptions(options);
    const paths = codexPaths(options, env);
    const install = mode === 'install';
    const hooks = await planJsonFile(
      paths.hooks,
      install ? 'Register Mindly hooks for Codex' : 'Remove Mindly hooks from Codex',
      mode,
      (config) => {
        if (!install && !isRecord(config['hooks'])) return;
        const h = hooksObject(config, paths.hooks);
        removeGroupedHooks(h, KIND, options.command);
        if (install) addGroupedHooks(h, hookSpecs(options.command), paths.hooks);
        dropIfEmpty(config, 'hooks');
      },
    );
    const mcp = await planToml(paths.config, options, mode);
    return compactSteps([hooks, mcp]);
  }

  return {
    kind: KIND,
    displayName: 'Codex',
    detect(): Promise<boolean> {
      return detectAgent([codexHome(opts.homeDir ?? homedir(), env)], ['codex'], env);
    },
    parse(nativeEvent: string, payload: unknown): NormalizedHookEvent | null {
      return parseClaudeStyle(KIND, CODEX_EVENTS, nativeEvent, payload);
    },
    render(event: NormalizedHookEvent, result: HookResult): RenderedHookOutput {
      return renderClaudeStyle(event, result, {
        names: NAMES,
        supportsAsk: false,
        systemMessageEvents: new Set<HookEventName>(['session_start', 'prompt', 'stop']),
      });
    },
    planInstall: (options) => plan(options, 'install'),
    planUninstall: (options) => plan(options, 'uninstall'),
  };
}

/** Default Codex adapter. */
export const codexAdapter: AgentAdapter = createCodexAdapter();
