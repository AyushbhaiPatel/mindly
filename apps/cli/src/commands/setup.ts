import { constants, existsSync, realpathSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  applyInstallSteps,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createCursorAdapter,
  createMcpClientAdapters,
  HOOK_AGENT_KINDS,
  integrationOf,
  MCP_CLIENTS,
  McpClientAdapter,
} from '@mindly/adapters';
import {
  defaultUserConfig,
  ensureHome,
  mindlyHome,
  resolveLayout,
  writeJsonFile,
  type AgentAdapter,
  type InstallStep,
} from '@mindly/core';
import { findRepoRoot } from '@mindly/git';
import { openMindly } from '@mindly/runtime';
import { diffSummary } from '../diff.js';
import { confirm, type CliIo } from '../io.js';
import { splitList, UsageError, type Out } from '../util.js';

/** Agents `mindly init` knows how to connect: hook agents first, then MCP-only clients. */
export const SUPPORTED_AGENTS: readonly string[] = Object.freeze([
  ...HOOK_AGENT_KINDS,
  ...MCP_CLIENTS.map((c) => c.kind),
]);
/** An agent kind from {@link SUPPORTED_AGENTS}. */
export type SupportedAgent = string;

/** Suggestion printed for MCP-only clients (Mindly never edits their rule files). */
export const MCP_ONLY_RULE = 'Call `mindly_context` at the start of each task';

/** The user's home directory as seen by `io` (tests point `HOME` at a temp dir). */
export function userHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = process.platform === 'win32' ? env['USERPROFILE'] : env['HOME'];
  return fromEnv && isAbsolute(fromEnv) ? fromEnv : homedir();
}

/** Adapters bound to the user's home and environment. */
export function adaptersFor(env: NodeJS.ProcessEnv): Record<SupportedAgent, AgentAdapter> {
  const homeDir = userHome(env);
  return {
    'claude-code': createClaudeCodeAdapter({ homeDir, env }),
    codex: createCodexAdapter({ homeDir, env }),
    cursor: createCursorAdapter({ homeDir, env }),
    ...createMcpClientAdapters({ homeDir, env }),
  };
}

/** The adapter for a supported agent kind. */
export function adapterOf(all: Record<SupportedAgent, AgentAdapter>, kind: string): AgentAdapter {
  const adapter = Object.prototype.hasOwnProperty.call(all, kind) ? all[kind] : undefined;
  if (adapter === undefined) throw new UsageError(`unknown agent "${kind}"`);
  return adapter;
}

/** `mindly init --list-agents`: every supported agent with its integration level. */
export function listAgents(out: Out): number {
  const all = adaptersFor(out.io.env);
  const s = out.style;
  const width = Math.max(...SUPPORTED_AGENTS.map((k) => k.length)) + 2;
  out.line(s.bold(`${'Agent'.padEnd(width)}Integration  Name`));
  for (const kind of SUPPORTED_AGENTS) {
    const adapter = adapterOf(all, kind);
    const level = integrationOf(adapter) === 'mcp' ? 'MCP tools  ' : 'hooks + MCP';
    const scope =
      adapter instanceof McpClientAdapter && !adapter.supportsProjectScope
        ? ' (user scope only)'
        : '';
    out.line(`${kind.padEnd(width)}${level}  ${adapter.displayName}${scope}`);
  }
  out.line();
  out.line('hooks + MCP: automatic capture and context injection, plus Mindly tools.');
  out.line('MCP tools: Mindly tools only; the agent must call them itself.');
  return 0;
}

/** Parses `--agents a,b`. */
export function parseAgents(value: string | undefined): SupportedAgent[] | null {
  if (value === undefined) return null;
  const list = splitList(value);
  if (list.length === 0) throw new UsageError('--agents needs at least one agent');
  for (const a of list) {
    if (!(SUPPORTED_AGENTS as readonly string[]).includes(a)) {
      throw new UsageError(
        `unknown agent "${a}" (supported: ${SUPPORTED_AGENTS.join(', ')}; see mindly init --list-agents)`,
      );
    }
  }
  return [...new Set(list)];
}

async function onPath(binary: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter((d) => d !== '');
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe'] : [''];
  for (const dir of dirs.slice(0, 256)) {
    for (const ext of exts) {
      const candidate = join(dir, binary + ext);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        if (process.platform !== 'win32') await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Absolute path of the CLI's entry point: `dist/main.js` of the installed `mindly-cli` package,
 * or `apps/cli/dist/main.js` in a monorepo checkout.
 */
export function cliEntry(): string {
  return resolveLayout(import.meta.url).cliMain;
}

/**
 * The argv agents run to reach Mindly: the global `mindly` when this process was started through
 * it, otherwise `node <absolute path to dist/main.js>` so hooks work without a global install.
 */
export async function installCommand(env: NodeJS.ProcessEnv): Promise<string[]> {
  const running = process.argv[1];
  const global = await onPath('mindly', env);
  if (global && running && sameFile(global, running)) return [global];
  return [process.execPath, cliEntry()];
}

async function projectRootOf(cwd: string): Promise<string> {
  try {
    return await findRepoRoot(cwd);
  } catch {
    return realpathSync(cwd);
  }
}

interface AgentPlan {
  agent: SupportedAgent;
  adapter: AgentAdapter;
  steps: InstallStep[];
}

function printPlan(out: Out, plans: readonly AgentPlan[], none: string): number {
  const s = out.style;
  let total = 0;
  for (const p of plans) {
    out.line(s.bold(p.adapter.displayName));
    if (p.steps.length === 0) out.line(`  ${s.dim(none)}`);
    for (const step of p.steps) {
      total++;
      const d = diffSummary(step.previous, step.content);
      out.line(`  ${step.description}`);
      out.line(
        `  ${s.cyan(step.file)} ${s.dim(`(${step.previous === null ? 'new file' : 'modified'}, +${d.added} -${d.removed} lines)`)}`,
      );
      for (const l of d.lines) {
        out.line(`    ${l.startsWith('+') ? s.green(l) : l.startsWith('-') ? s.red(l) : s.dim(l)}`);
      }
    }
  }
  return total;
}

/** Creates `$MINDLY_HOME`, the database and a default `config.json` when it is absent. */
export function initHome(io: CliIo): string {
  const paths = ensureHome(mindlyHome(io.env));
  if (!existsSync(paths.config)) writeJsonFile(paths.config, defaultUserConfig());
  openMindly({ env: io.env, disableNotify: true, disableLlm: true }).close();
  return paths.home;
}

interface SetupOptions {
  agents?: string;
  project?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  listAgents?: boolean;
}

/** `mindly init`. */
export async function init(out: Out, o: SetupOptions): Promise<number> {
  if (o.listAgents) return listAgents(out);
  const env = out.io.env;
  const all = adaptersFor(env);
  const projectRoot = o.project ? await projectRootOf(out.io.cwd) : null;
  let agents = parseAgents(o.agents);
  if (agents === null) {
    agents = [];
    for (const a of SUPPORTED_AGENTS) if (await adapterOf(all, a).detect()) agents.push(a);
    if (agents.length === 0) {
      out.line('No supported agent was detected.');
      out.line('Choose explicitly with: mindly init --agents claude-code,codex,cursor');
      out.line('See every supported agent with: mindly init --list-agents');
    } else {
      out.line(`Detected: ${agents.map((a) => adapterOf(all, a).displayName).join(', ')}`);
    }
    if (projectRoot !== null) {
      const userOnly = agents.filter((a) => !supportsProject(adapterOf(all, a)));
      if (userOnly.length > 0) {
        out.line(
          `Skipping ${userOnly.map((a) => adapterOf(all, a).displayName).join(', ')}: no project-level MCP config (run mindly init without --project).`,
        );
        agents = agents.filter((a) => !userOnly.includes(a));
      }
    }
  }
  const command = await installCommand(env);
  const homeDir = userHome(env);
  const plans: AgentPlan[] = [];
  for (const agent of agents) {
    const adapter = adapterOf(all, agent);
    plans.push({
      agent,
      adapter,
      steps: await adapter.planInstall({ command, projectRoot, homeDir }),
    });
  }
  out.line(
    `Hooks and MCP will run: ${command.join(' ')}${projectRoot ? ` (project scope: ${projectRoot})` : ' (user scope)'}`,
  );
  out.line();
  const total = printPlan(out, plans, 'already configured');
  if (o.dryRun) {
    out.line();
    out.line('Dry run: nothing was written.');
    return 0;
  }
  if (total > 0) {
    out.line();
    if (
      !(await confirm(out.io, `Apply ${total} change${total === 1 ? '' : 's'}?`, o.yes === true))
    ) {
      out.line('Nothing changed.');
      return 1;
    }
    for (const p of plans) {
      for (const applied of applyInstallSteps(p.steps)) {
        out.line(`Wrote ${applied.file}${applied.backup ? ` (backup: ${applied.backup})` : ''}`);
      }
    }
  }
  const home = initHome(out.io);
  out.line(`Mindly storage is ready in ${home}.`);
  if (agents.includes('codex')) {
    out.line();
    out.line(
      'Codex: start Codex and run /hooks to review and approve the Mindly hooks; Codex does not run new hooks until you approve them.',
    );
  }
  const mcpOnly = plans.filter((p) => integrationOf(p.adapter) === 'mcp');
  if (mcpOnly.length > 0) out.line();
  for (const p of mcpOnly) {
    out.line(
      `${p.adapter.displayName}: gets Mindly's MCP tools but no automatic capture; add "${MCP_ONLY_RULE}" to its rules/instructions file.`,
    );
  }
  if (agents.length > 0) {
    out.line('Restart running agent sessions so they pick up the hooks and the MCP server.');
  }
  return 0;
}

function supportsProject(adapter: AgentAdapter): boolean {
  return !(adapter instanceof McpClientAdapter) || adapter.supportsProjectScope;
}

/** `mindly uninstall`: removes Mindly's hooks and MCP entries (data in `$MINDLY_HOME` is kept). */
export async function uninstall(out: Out, o: SetupOptions): Promise<number> {
  const env = out.io.env;
  const all = adaptersFor(env);
  const explicit = parseAgents(o.agents);
  const agents = explicit ?? [...SUPPORTED_AGENTS];
  const command = await installCommand(env);
  const projectRoot = o.project ? await projectRootOf(out.io.cwd) : null;
  const homeDir = userHome(env);
  const plans: AgentPlan[] = [];
  for (const agent of agents) {
    const adapter = adapterOf(all, agent);
    const steps = await adapter.planUninstall({ command, projectRoot, homeDir });
    // Without --agents, MCP-only clients with nothing to remove are not worth a line each.
    if (explicit === null && steps.length === 0 && integrationOf(adapter) === 'mcp') continue;
    plans.push({ agent, adapter, steps });
  }
  const total = printPlan(out, plans, 'nothing to remove');
  if (o.dryRun) {
    out.line();
    out.line('Dry run: nothing was written.');
    return 0;
  }
  if (total === 0) {
    out.line('Mindly is not connected to any of these agents.');
    return 0;
  }
  out.line();
  if (!(await confirm(out.io, `Apply ${total} change${total === 1 ? '' : 's'}?`, o.yes === true))) {
    out.line('Nothing changed.');
    return 1;
  }
  for (const p of plans) {
    for (const applied of applyInstallSteps(p.steps)) {
      out.line(`Wrote ${applied.file}${applied.backup ? ` (backup: ${applied.backup})` : ''}`);
    }
  }
  out.line(
    `Disconnected. Your Mindly data in ${mindlyHome(env)} is kept; delete a project's data with mindly forget --project.`,
  );
  return 0;
}
