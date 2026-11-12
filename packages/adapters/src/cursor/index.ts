import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  AgentAdapter,
  HookEventName,
  HookResult,
  InstallOptions,
  InstallStep,
  NormalizedHookEvent,
  RenderedHookOutput,
} from '@mindly/core';
import { hookCommand, MCP_SERVER_NAME, mcpLaunch } from '../shared/command.js';
import { ensureRecord } from '../shared/config-files.js';
import { detectAgent } from '../shared/detect.js';
import {
  baseEvent,
  contextText,
  jsonOutput,
  lookupEvent,
  reasonText,
  SILENT,
  userMessageText,
} from '../shared/event.js';
import type { HookSpec } from '../shared/json-hooks.js';
import { addFlatHooks, dropIfEmpty, hooksObject, removeFlatHooks } from '../shared/json-hooks.js';
import type { PlanMode } from '../shared/plan.js';
import { compactSteps, planJsonFile, validateInstallOptions } from '../shared/plan.js';
import {
  asRecord,
  isRecord,
  MAX_PATH_CHARS,
  readNonEmptyString,
  readString,
} from '../shared/payload.js';
import { buildTool } from '../shared/tools.js';

const KIND = 'cursor';

/** How a native Cursor event maps to Mindly. */
interface CursorEventSpec {
  event: HookEventName;
  /** How the tool section is built for tool events. */
  tool?: 'generic' | 'shell' | 'file_edit';
  failed?: boolean;
  /** Whether Cursor reads `additional_context` from this event's output. */
  acceptsContext?: boolean;
}

/** Native Cursor hook events Mindly understands. */
export const CURSOR_EVENTS: Readonly<Record<string, CursorEventSpec>> = {
  sessionStart: { event: 'session_start', acceptsContext: true },
  beforeSubmitPrompt: { event: 'prompt' },
  preToolUse: { event: 'pre_tool', tool: 'generic' },
  beforeShellExecution: { event: 'pre_tool', tool: 'shell' },
  postToolUse: { event: 'post_tool', tool: 'generic', acceptsContext: true },
  postToolUseFailure: { event: 'post_tool', tool: 'generic', failed: true, acceptsContext: true },
  afterFileEdit: { event: 'post_tool', tool: 'file_edit' },
  afterShellExecution: { event: 'post_tool', tool: 'shell' },
  stop: { event: 'stop' },
  sessionEnd: { event: 'session_end' },
};

/** Events the installer registers. `postToolUse` is left out: `afterFileEdit` and
 * `afterShellExecution` already report the changes, and both would double-count edits. */
export const CURSOR_INSTALLED_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'afterFileEdit',
  'afterShellExecution',
  'postToolUseFailure',
  'stop',
  'sessionEnd',
] as const;

const RequiredSchema = z.object({
  id: z.string().trim().min(1).max(512),
  cwd: z.string().min(1).max(MAX_PATH_CHARS),
});

/** The real path of an existing file or directory; the path itself when it cannot be read. */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** True when `path` is `root` or lies under it, compared as real paths. */
function isUnder(root: string, path: string): boolean {
  const base = real(root).replace(/[\\/]+$/, '');
  const at = real(path);
  return at === base || at.startsWith(`${base}/`) || at.startsWith(`${base}\\`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory an event is read from. Cursor reports every root of a multi-root workspace; the
 * event belongs to the one that holds the file being written, or else the one that holds the
 * reported working directory (the first root when neither says). The root only helps to find
 * the project: the reported working directory is kept whenever it exists, because a shell
 * command's relative paths start where it runs. Only a write to a file in a root while the
 * working directory lies elsewhere is read from that root, so the file's project decides.
 */
function eventCwd(payload: Record<string, unknown>): string | null {
  const cwd = readNonEmptyString(payload, ['cwd'], MAX_PATH_CHARS + 1);
  const root = eventRoot(payload, cwd);
  if (cwd === null) return root;
  if (root === null || isUnder(root, cwd)) return cwd;
  if (!isDirectory(cwd)) return root;
  return writtenFile(payload) !== null && isUnder(root, writtenFile(payload) as string)
    ? root
    : cwd;
}

/** The file an event writes, when it names one. */
function writtenFile(payload: Record<string, unknown>): string | null {
  const input = asRecord(payload['tool_input']);
  return (
    readNonEmptyString(payload, ['file_path'], MAX_PATH_CHARS + 1) ??
    readNonEmptyString(input, ['file_path', 'path', 'target_file'], MAX_PATH_CHARS + 1)
  );
}

function eventRoot(payload: Record<string, unknown>, cwd: string | null): string | null {
  const listed = payload['workspace_roots'] ?? payload['workspaceRoots'];
  const roots = Array.isArray(listed)
    ? listed.filter((r): r is string => typeof r === 'string' && r.trim() !== '')
    : [];
  if (roots.length === 0) return cwd;
  if (roots.length > 1) {
    const file = writtenFile(payload);
    // The deepest root wins when one root is nested in another.
    const deepestFirst = [...roots].sort((a, b) => b.length - a.length);
    for (const at of [file, cwd]) {
      if (at === null) continue;
      const holder = deepestFirst.find((r) => isUnder(r, at));
      if (holder !== undefined) return holder;
    }
  }
  return roots[0] ?? cwd;
}

function parseCursor(nativeEvent: string, payload: unknown): NormalizedHookEvent | null {
  try {
    const found = lookupEvent(CURSOR_EVENTS, nativeEvent);
    if (found === null || !isRecord(payload)) return null;
    const [name, spec] = found;
    const required = RequiredSchema.safeParse({
      id: readNonEmptyString(payload, ['conversation_id', 'session_id', 'conversationId'], 513),
      cwd: eventCwd(payload),
    });
    if (!required.success) return null;
    const ev = baseEvent(KIND, spec.event, name, required.data.id, required.data.cwd);
    ev.transcriptPath = readNonEmptyString(payload, ['transcript_path'], MAX_PATH_CHARS);
    switch (spec.event) {
      case 'session_start':
        ev.startSource = readNonEmptyString(payload, ['source', 'composer_mode'], 64);
        break;
      case 'prompt':
        ev.prompt = readString(payload, ['prompt']);
        break;
      case 'pre_tool':
      case 'post_tool': {
        const isPost = spec.event === 'post_tool';
        if (spec.tool === 'shell') {
          ev.tool = buildTool({
            name: 'Shell',
            input: { command: payload['command'] },
            ...(isPost ? { response: { output: payload['output'] } } : {}),
            shell: true,
            writes: false,
          });
        } else if (spec.tool === 'file_edit') {
          ev.tool = buildTool({
            name: 'afterFileEdit',
            input: { file_path: payload['file_path'], edits: payload['edits'] },
            writes: true,
          });
        } else {
          const toolName = readNonEmptyString(payload, ['tool_name'], 200);
          if (toolName === null) return null;
          const input = asRecord(payload['tool_input']);
          ev.tool = buildTool({
            name: toolName,
            input,
            ...(isPost
              ? {
                  response:
                    payload['tool_output'] ?? payload['error'] ?? payload['error_message'] ?? null,
                }
              : {}),
            ...(spec.failed === true ? { failed: true } : {}),
          });
        }
        break;
      }
      case 'stop':
      case 'session_end':
        break;
    }
    return ev;
  } catch {
    return null;
  }
}

function renderCursor(event: NormalizedHookEvent, result: HookResult): RenderedHookOutput {
  try {
    const spec =
      event.nativeEvent !== undefined
        ? lookupEvent(CURSOR_EVENTS, event.nativeEvent)?.[1]
        : undefined;
    const context = contextText(result);
    const notice = userMessageText(result);
    switch (event.event) {
      case 'session_start':
        return jsonOutput(context !== null ? { additional_context: context } : {});
      case 'pre_tool': {
        const out: Record<string, unknown> = {};
        const messages: string[] = [];
        if (result.decision === 'deny' || result.decision === 'ask') {
          out['permission'] = result.decision;
          const reason = reasonText(result);
          out['user_message'] = notice ?? reason;
          messages.push(reason);
        } else if (notice !== null) {
          out['user_message'] = notice;
        }
        if (context !== null) messages.push(context);
        if (messages.length > 0) out['agent_message'] = messages.join('\n\n');
        return jsonOutput(out);
      }
      case 'post_tool':
        if (context !== null && (spec === undefined || spec.acceptsContext === true)) {
          return jsonOutput({ additional_context: context });
        }
        return SILENT;
      default:
        // beforeSubmitPrompt cannot add context; stop's followup_message would start a new
        // turn; sessionEnd has no output. Context reaches Cursor through MCP instead.
        return SILENT;
    }
  } catch {
    return SILENT;
  }
}

/** Options for {@link createCursorAdapter}; mainly for tests. */
export interface CursorAdapterOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Config files touched by the Cursor installer. */
export function cursorPaths(options: InstallOptions): { hooks: string; mcp: string } {
  const dir =
    options.projectRoot !== null
      ? join(options.projectRoot, '.cursor')
      : join(options.homeDir, '.cursor');
  return { hooks: join(dir, 'hooks.json'), mcp: join(dir, 'mcp.json') };
}

async function plan(options: InstallOptions, mode: PlanMode): Promise<InstallStep[]> {
  validateInstallOptions(options);
  const paths = cursorPaths(options);
  const install = mode === 'install';
  const specs: HookSpec[] = CURSOR_INSTALLED_EVENTS.map((event) => ({
    event,
    command: hookCommand(options.command, KIND, event),
  }));
  const hooks = await planJsonFile(
    paths.hooks,
    install ? 'Register Mindly hooks for Cursor' : 'Remove Mindly hooks from Cursor',
    mode,
    (config) => {
      if (!install && !isRecord(config['hooks'])) return;
      if (install && config['version'] === undefined) config['version'] = 1;
      const h = hooksObject(config, paths.hooks);
      removeFlatHooks(h, KIND);
      if (install) addFlatHooks(h, specs, paths.hooks);
      dropIfEmpty(config, 'hooks');
    },
  );
  const mcp = await planJsonFile(
    paths.mcp,
    install
      ? 'Register the Mindly MCP server for Cursor'
      : 'Remove the Mindly MCP server from Cursor',
    mode,
    (config) => {
      if (install) {
        const servers = ensureRecord(config, 'mcpServers', paths.mcp);
        const launch = mcpLaunch(options.command, KIND);
        servers[MCP_SERVER_NAME] = { type: 'stdio', command: launch.command, args: launch.args };
      } else if (isRecord(config['mcpServers']) && MCP_SERVER_NAME in config['mcpServers']) {
        Reflect.deleteProperty(config['mcpServers'], MCP_SERVER_NAME);
      }
    },
  );
  return compactSteps([hooks, mcp]);
}

/**
 * Creates the Cursor adapter. Hooks go in `.cursor/hooks.json` and the MCP server in
 * `.cursor/mcp.json`, under the home directory or the project root.
 */
export function createCursorAdapter(opts: CursorAdapterOptions = {}): AgentAdapter {
  return {
    kind: KIND,
    displayName: 'Cursor',
    detect(): Promise<boolean> {
      return detectAgent([join(opts.homeDir ?? homedir(), '.cursor')], ['cursor'], opts.env);
    },
    parse: parseCursor,
    render: renderCursor,
    planInstall: (options) => plan(options, 'install'),
    planUninstall: (options) => plan(options, 'uninstall'),
  };
}

/** Default Cursor adapter. */
export const cursorAdapter: AgentAdapter = createCursorAdapter();
