import { constants, existsSync, realpathSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  applyInstallSteps,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createCursorAdapter,
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

/** Agents `mindly init` knows how to connect. */
export const SUPPORTED_AGENTS = ['claude-code', 'codex', 'cursor'] as const;
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

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
  };
}

/** Parses `--agents a,b`. */
export function parseAgents(value: string | undefined): SupportedAgent[] | null {
  if (value === undefined) return null;
  const list = splitList(value);
  if (list.length === 0) throw new UsageError('--agents needs at least one agent');
  for (const a of list) {
    if (!(SUPPORTED_AGENTS as readonly string[]).includes(a)) {
      throw new UsageError(`unknown agent "${a}" (supported: ${SUPPORTED_AGENTS.join(', ')})`);
    }
  }
  return [...new Set(list)] as SupportedAgent[];
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
}

/** `mindly init`. */
export async function init(out: Out, o: SetupOptions): Promise<number> {
  const env = out.io.env;
  const all = adaptersFor(env);
  let agents = parseAgents(o.agents);
  if (agents === null) {
    agents = [];
    for (const a of SUPPORTED_AGENTS) if (await all[a].detect()) agents.push(a);
    if (agents.length === 0) {
      out.line('No supported agent (Claude Code, Codex, Cursor) was detected.');
      out.line('Choose explicitly with: mindly init --agents claude-code,codex,cursor');
    } else {
      out.line(`Detected: ${agents.map((a) => all[a].displayName).join(', ')}`);
    }
  }
  const command = await installCommand(env);
  const projectRoot = o.project ? await projectRootOf(out.io.cwd) : null;
  const homeDir = userHome(env);
  const plans: AgentPlan[] = [];
  for (const agent of agents) {
    const adapter = all[agent];
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
  if (agents.length > 0) {
    out.line('Restart running agent sessions so they pick up the hooks and the MCP server.');
  }
  return 0;
}

/** `mindly uninstall`: removes Mindly's hooks and MCP entries (data in `$MINDLY_HOME` is kept). */
export async function uninstall(out: Out, o: SetupOptions): Promise<number> {
  const env = out.io.env;
  const all = adaptersFor(env);
  const agents = parseAgents(o.agents) ?? [...SUPPORTED_AGENTS];
  const command = await installCommand(env);
  const projectRoot = o.project ? await projectRootOf(out.io.cwd) : null;
  const homeDir = userHome(env);
  const plans: AgentPlan[] = [];
  for (const agent of agents) {
    const adapter = all[agent];
    plans.push({
      agent,
      adapter,
      steps: await adapter.planUninstall({ command, projectRoot, homeDir }),
    });
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
