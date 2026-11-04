import { join } from 'node:path';

/*
 * Data-driven catalog of MCP clients Mindly can connect through MCP only (no hooks). Each entry
 * says where the client keeps its MCP config, how the file is written, where the servers map
 * lives and what a stdio server entry looks like. Sources are listed in the package README.
 */

/** On-disk format of a client's MCP config file. */
export type McpConfigFormat =
  /** Strict JSON: comments or trailing commas make the file invalid for the client. */
  | 'json'
  /** JSON with comments and trailing commas (VS Code style). Comments are preserved. */
  | 'jsonc';

/** Platforms the path resolvers distinguish; anything else is treated like Linux. */
export type McpPlatform = 'darwin' | 'linux' | 'win32';

/** Inputs to the path resolvers. */
export interface McpPathContext {
  /** Absolute home directory. */
  homeDir: string;
  platform: McpPlatform;
}

/** How Mindly's MCP server is launched (from `mcpLaunch`). */
export interface McpLaunch {
  command: string;
  args: string[];
}

/** One MCP client in the catalog. */
export interface McpClientSpec {
  /** Agent kind (slug) used in `--agents` and `mindly mcp --agent <kind>`. */
  kind: string;
  displayName: string;
  format: McpConfigFormat;
  /**
   * Candidate user-level config files, most preferred first. The first one that exists is edited;
   * when none exists the first is created.
   */
  userConfig: (ctx: McpPathContext) => string[];
  /** Candidate project-level config files relative to the project root, or null when the client
   * has no project-level MCP config. */
  projectConfig: ((projectRoot: string) => string[]) | null;
  /** RFC 6901 JSON pointer to the object that maps server names to entries. */
  serversPointer: string;
  /** Builds the stdio server entry for Mindly. */
  entry: (launch: McpLaunch) => Record<string, unknown>;
  /** Directories whose existence means the client is installed. */
  detectDirs: (ctx: McpPathContext) => string[];
  /** Executables whose presence on PATH means the client is installed. */
  detectBinaries: readonly string[];
  /** Official documentation used for this entry. */
  docs: readonly string[];
}

/** Narrows `process.platform` to the platforms the resolvers know. */
export function mcpPlatform(platform: NodeJS.Platform = process.platform): McpPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

/** Per-OS application config directory (`~/Library/Application Support`, `~/.config`, `%APPDATA%`). */
function appConfigDir(ctx: McpPathContext): string {
  switch (ctx.platform) {
    case 'darwin':
      return join(ctx.homeDir, 'Library', 'Application Support');
    case 'win32':
      return join(ctx.homeDir, 'AppData', 'Roaming');
    case 'linux':
      return join(ctx.homeDir, '.config');
  }
}

/** VS Code's user settings directory. */
function vscodeUserDir(ctx: McpPathContext): string {
  return join(appConfigDir(ctx), 'Code', 'User');
}

/** `~/.config` on every platform (used by CLI tools that follow XDG even on macOS). */
function xdgConfig(ctx: McpPathContext): string {
  return join(ctx.homeDir, '.config');
}

const standard = (launch: McpLaunch): Record<string, unknown> => ({
  command: launch.command,
  args: launch.args,
});

/** Every MCP-only client Mindly can install into. */
export const MCP_CLIENTS: readonly McpClientSpec[] = Object.freeze([
  {
    kind: 'windsurf',
    displayName: 'Windsurf',
    format: 'jsonc',
    userConfig: (ctx) => [join(ctx.homeDir, '.codeium', 'windsurf', 'mcp_config.json')],
    projectConfig: null,
    serversPointer: '/mcpServers',
    entry: standard,
    detectDirs: (ctx) => [join(ctx.homeDir, '.codeium', 'windsurf')],
    detectBinaries: ['windsurf'],
    docs: ['https://docs.windsurf.com/windsurf/cascade/mcp'],
  },
  {
    kind: 'kiro',
    displayName: 'Kiro',
    format: 'json',
    userConfig: (ctx) => [join(ctx.homeDir, '.kiro', 'settings', 'mcp.json')],
    projectConfig: (root) => [join(root, '.kiro', 'settings', 'mcp.json')],
    serversPointer: '/mcpServers',
    entry: standard,
    detectDirs: (ctx) => [join(ctx.homeDir, '.kiro')],
    detectBinaries: ['kiro'],
    docs: ['https://kiro.dev/docs/mcp/configuration/'],
  },
  {
    kind: 'gemini',
    displayName: 'Gemini CLI',
    format: 'jsonc',
    userConfig: (ctx) => [join(ctx.homeDir, '.gemini', 'settings.json')],
    projectConfig: (root) => [join(root, '.gemini', 'settings.json')],
    serversPointer: '/mcpServers',
    entry: standard,
    detectDirs: (ctx) => [join(ctx.homeDir, '.gemini')],
    detectBinaries: ['gemini'],
    docs: ['https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md'],
  },
  {
    kind: 'vscode',
    displayName: 'VS Code (GitHub Copilot)',
    format: 'jsonc',
    userConfig: (ctx) => [join(vscodeUserDir(ctx), 'mcp.json')],
    projectConfig: (root) => [join(root, '.vscode', 'mcp.json')],
    serversPointer: '/servers',
    entry: (launch) => ({ type: 'stdio', command: launch.command, args: launch.args }),
    detectDirs: (ctx) => [vscodeUserDir(ctx)],
    detectBinaries: ['code'],
    docs: [
      'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
      'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    ],
  },
  {
    kind: 'cline',
    displayName: 'Cline',
    format: 'json',
    userConfig: (ctx) => [
      join(ctx.homeDir, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    ],
    projectConfig: null,
    serversPointer: '/mcpServers',
    entry: standard,
    detectDirs: (ctx) => [
      join(ctx.homeDir, '.cline'),
      join(vscodeUserDir(ctx), 'globalStorage', 'saoudrizwan.claude-dev'),
    ],
    detectBinaries: ['cline'],
    docs: ['https://docs.cline.bot/mcp/configuring-mcp-servers'],
  },
  {
    kind: 'roo-code',
    displayName: 'Roo Code',
    format: 'json',
    userConfig: (ctx) => [
      join(
        vscodeUserDir(ctx),
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'mcp_settings.json',
      ),
    ],
    projectConfig: (root) => [join(root, '.roo', 'mcp.json')],
    serversPointer: '/mcpServers',
    entry: standard,
    detectDirs: (ctx) => [join(vscodeUserDir(ctx), 'globalStorage', 'rooveterinaryinc.roo-cline')],
    detectBinaries: [],
    docs: ['https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo'],
  },
  {
    kind: 'claude-desktop',
    displayName: 'Claude Desktop',
    format: 'json',
    userConfig: (ctx) => [join(appConfigDir(ctx), 'Claude', 'claude_desktop_config.json')],
    projectConfig: null,
    serversPointer: '/mcpServers',
    entry: standard,
    detectDirs: (ctx) => [join(appConfigDir(ctx), 'Claude')],
    detectBinaries: [],
    docs: ['https://modelcontextprotocol.io/docs/develop/connect-local-servers'],
  },
  {
    kind: 'opencode',
    displayName: 'OpenCode',
    format: 'jsonc',
    userConfig: (ctx) => [
      join(xdgConfig(ctx), 'opencode', 'opencode.json'),
      join(xdgConfig(ctx), 'opencode', 'opencode.jsonc'),
    ],
    projectConfig: (root) => [join(root, 'opencode.json'), join(root, 'opencode.jsonc')],
    serversPointer: '/mcp',
    entry: (launch) => ({
      type: 'local',
      command: [launch.command, ...launch.args],
      enabled: true,
    }),
    detectDirs: (ctx) => [join(xdgConfig(ctx), 'opencode')],
    detectBinaries: ['opencode'],
    docs: ['https://opencode.ai/docs/mcp-servers/', 'https://opencode.ai/docs/config/'],
  },
  {
    kind: 'zed',
    displayName: 'Zed',
    format: 'jsonc',
    userConfig: (ctx) => [
      ctx.platform === 'win32'
        ? join(appConfigDir(ctx), 'Zed', 'settings.json')
        : join(xdgConfig(ctx), 'zed', 'settings.json'),
    ],
    projectConfig: (root) => [join(root, '.zed', 'settings.json')],
    serversPointer: '/context_servers',
    entry: standard,
    detectDirs: (ctx) => [
      ctx.platform === 'win32' ? join(appConfigDir(ctx), 'Zed') : join(xdgConfig(ctx), 'zed'),
    ],
    detectBinaries: ['zed'],
    docs: ['https://zed.dev/docs/ai/mcp'],
  },
  {
    kind: 'amp',
    displayName: 'Amp',
    format: 'jsonc',
    userConfig: (ctx) => [
      join(xdgConfig(ctx), 'amp', 'settings.json'),
      join(xdgConfig(ctx), 'amp', 'settings.jsonc'),
    ],
    projectConfig: (root) => [
      join(root, '.amp', 'settings.json'),
      join(root, '.amp', 'settings.jsonc'),
    ],
    // A literal top-level key containing a dot, not a nested path.
    serversPointer: '/amp.mcpServers',
    entry: standard,
    detectDirs: (ctx) => [join(xdgConfig(ctx), 'amp')],
    detectBinaries: ['amp'],
    docs: ['https://ampcode.com/docs/customize/mcp', 'https://ampcode.com/docs/cli/settings'],
  },
  {
    kind: 'augment',
    displayName: 'Augment (Auggie CLI)',
    format: 'json',
    userConfig: (ctx) => [join(ctx.homeDir, '.augment', 'settings.json')],
    projectConfig: null,
    serversPointer: '/mcpServers',
    entry: standard,
    detectDirs: (ctx) => [join(ctx.homeDir, '.augment')],
    detectBinaries: ['auggie'],
    docs: ['https://docs.augmentcode.com/cli/integrations'],
  },
  {
    kind: 'lm-studio',
    displayName: 'LM Studio',
    format: 'json',
    userConfig: (ctx) => [join(ctx.homeDir, '.lmstudio', 'mcp.json')],
    projectConfig: null,
    serversPointer: '/mcpServers',
    entry: standard,
    detectDirs: (ctx) => [join(ctx.homeDir, '.lmstudio')],
    detectBinaries: ['lms'],
    docs: ['https://lmstudio.ai/docs/app/mcp'],
  },
] satisfies McpClientSpec[]);

/** Looks up a catalog entry by kind. */
export function findMcpClient(kind: string): McpClientSpec | null {
  return MCP_CLIENTS.find((c) => c.kind === kind) ?? null;
}

/** Splits an RFC 6901 JSON pointer into unescaped segments. `''` is the document root. */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
