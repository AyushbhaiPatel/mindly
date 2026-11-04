import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type {
  AgentAdapter,
  HookResult,
  InstallOptions,
  InstallStep,
  NormalizedHookEvent,
  RenderedHookOutput,
} from '@mindly/core';
import { MindlyError } from '@mindly/core';
import { MCP_SERVER_NAME, mcpLaunch } from '../shared/command.js';
import { readConfigText, stepIfChanged } from '../shared/config-files.js';
import { detectAgent } from '../shared/detect.js';
import { SILENT } from '../shared/event.js';
import type { PlanMode } from '../shared/plan.js';
import { validateInstallOptions } from '../shared/plan.js';
import type { McpClientSpec, McpPathContext, McpPlatform } from './catalog.js';
import { MCP_CLIENTS, mcpPlatform, parseJsonPointer } from './catalog.js';
import { readJsoncValue, removeJsoncValue, setJsoncValue } from './jsonc-edit.js';

/** How deeply Mindly integrates with an agent. */
export type IntegrationLevel = 'hooks+mcp' | 'mcp';

/** Options for {@link McpClientAdapter}; mainly for tests. */
export interface McpClientAdapterOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Picks the first existing candidate, else the first one. */
function pickPath(candidates: readonly string[], kind: string): string {
  const first = candidates[0];
  if (first === undefined) throw new MindlyError('internal', `no config path for ${kind}`);
  return candidates.find((c) => existsSync(c)) ?? first;
}

/**
 * Generic adapter for clients Mindly reaches through MCP only. It never handles hooks: `parse`
 * returns null and `render` prints nothing. Install and uninstall add or remove only the
 * `mindly` entry in the client's MCP servers map, editing the file in place so other servers,
 * comments and formatting stay as they were.
 */
export class McpClientAdapter implements AgentAdapter {
  readonly kind: string;
  readonly displayName: string;
  readonly integration: IntegrationLevel = 'mcp';
  readonly spec: McpClientSpec;
  private readonly homeDir: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly platform: McpPlatform;

  constructor(spec: McpClientSpec, opts: McpClientAdapterOptions = {}) {
    this.spec = spec;
    this.kind = spec.kind;
    this.displayName = spec.displayName;
    this.homeDir = opts.homeDir;
    this.env = opts.env;
    this.platform = mcpPlatform(opts.platform);
  }

  /** Whether the client has a project-level MCP config (`mindly init --project`). */
  get supportsProjectScope(): boolean {
    return this.spec.projectConfig !== null;
  }

  private ctx(homeDir: string): McpPathContext {
    return { homeDir, platform: this.platform };
  }

  /**
   * The config file Mindly edits for these options, or null for project scope when the client
   * has no project-level config.
   */
  configPath(options: Pick<InstallOptions, 'homeDir' | 'projectRoot'>): string | null {
    if (options.projectRoot !== null) {
      const project = this.spec.projectConfig;
      return project === null ? null : pickPath(project(options.projectRoot), this.kind);
    }
    return pickPath(this.spec.userConfig(this.ctx(options.homeDir)), this.kind);
  }

  /** The JSON value Mindly writes under the servers map. */
  serverEntry(command: readonly string[]): Record<string, unknown> {
    return this.spec.entry(mcpLaunch(command, this.kind));
  }

  detect(): Promise<boolean> {
    const ctx = this.ctx(this.homeDir ?? homedir());
    return detectAgent(this.spec.detectDirs(ctx), this.spec.detectBinaries, this.env);
  }

  parse(): NormalizedHookEvent | null {
    return null;
  }

  render(_event: NormalizedHookEvent, _result: HookResult): RenderedHookOutput {
    return SILENT;
  }

  planInstall(options: InstallOptions): Promise<InstallStep[]> {
    return this.plan(options, 'install');
  }

  planUninstall(options: InstallOptions): Promise<InstallStep[]> {
    return this.plan(options, 'uninstall');
  }

  private async plan(options: InstallOptions, mode: PlanMode): Promise<InstallStep[]> {
    validateInstallOptions(options);
    const file = this.configPath(options);
    if (file === null) {
      if (mode === 'uninstall') return [];
      throw new MindlyError(
        'invalid_input',
        `${this.displayName} has no project-level MCP config; install it without --project`,
      );
    }
    const path = [...parseJsonPointer(this.spec.serversPointer), MCP_SERVER_NAME];
    const previous = await readConfigText(file);
    let content: string;
    if (mode === 'install') {
      content = setJsoncValue(
        file,
        previous,
        this.spec.format,
        path,
        this.serverEntry(options.command),
      );
    } else {
      if (previous === null) return [];
      content = removeJsoncValue(file, previous, this.spec.format, path, {
        pruneEmptyParent: true,
      });
    }
    const step = stepIfChanged(
      file,
      mode === 'install'
        ? `Register the Mindly MCP server for ${this.displayName}`
        : `Remove the Mindly MCP server from ${this.displayName}`,
      previous,
      content,
    );
    return step === null ? [] : [step];
  }

  /** True when the config for these options already holds a `mindly` server entry. */
  async isConfigured(options: Pick<InstallOptions, 'homeDir' | 'projectRoot'>): Promise<boolean> {
    const file = this.configPath(options);
    if (file === null) return false;
    const path = [...parseJsonPointer(this.spec.serversPointer), MCP_SERVER_NAME];
    return readJsoncValue(file, await readConfigText(file), this.spec.format, path) !== undefined;
  }
}

/** Creates the MCP-only adapter for a catalog entry. */
export function createMcpClientAdapter(
  spec: McpClientSpec,
  opts: McpClientAdapterOptions = {},
): McpClientAdapter {
  return new McpClientAdapter(spec, opts);
}

/** MCP-only adapters for every catalog entry, keyed by kind. */
export function createMcpClientAdapters(
  opts: McpClientAdapterOptions = {},
): Record<string, McpClientAdapter> {
  const out: Record<string, McpClientAdapter> = {};
  for (const spec of MCP_CLIENTS) out[spec.kind] = new McpClientAdapter(spec, opts);
  return out;
}

/** Integration level of any adapter: MCP-only adapters say so, everything else has hooks. */
export function integrationOf(adapter: AgentAdapter): IntegrationLevel {
  return adapter instanceof McpClientAdapter ? 'mcp' : 'hooks+mcp';
}

/**
 * The stdio server snippet for clients not in the catalog (a `mcpServers` map, the most common
 * shape), as pretty-printed JSON.
 */
export function genericMcpSnippet(command: readonly string[], agentKind = 'other'): string {
  const launch = mcpLaunch(command, agentKind);
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: { command: launch.command, args: launch.args } } },
    null,
    2,
  );
}
