import { constants, existsSync, realpathSync, rmSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  applyInstallSteps,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createCursorAdapter,
  createGeminiAdapter,
  createMcpClientAdapters,
  HOOK_AGENT_KINDS,
  inspectClaudeCodeStatusLine,
  readOnlyTarget,
  integrationOf,
  MCP_CLIENTS,
  McpClientAdapter,
  type AppliedStep,
} from '@mindly/adapters';
import {
  defaultUserConfig,
  ensureHome,
  MINDLY_VERSION,
  mindlyHome,
  resolveLayout,
  writeJsonFile,
  type AgentAdapter,
  type InstallStep,
} from '@mindly/core';
import { sentinelOf, type Mindly } from '@mindly/engine';
import { findRepoRoot } from '@mindly/git';
import { openMindly } from '@mindly/runtime';
import { diffSummary } from '../diff.js';
import { confirm, type CliIo } from '../io.js';
import {
  copiedEntry,
  ensureCopy,
  inRunnerCache,
  runnerTree,
  type RunnerTree,
} from '../runner-copy.js';
import { clean, splitList, UsageError, type Out } from '../util.js';
import { renderInitSummary } from '../views/setup.js';
import { offerRuleImport } from './import.js';
import {
  offerRulesSync,
  planRulesSyncRemoval,
  printRulesFileChanges,
  removeRulesSync,
} from './rules-file.js';

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

/**
 * Adapters bound to the user's home and environment. `statusLine: false` keeps the Claude Code
 * adapter from adding its status line (an existing one is left as it is).
 */
export function adaptersFor(
  env: NodeJS.ProcessEnv,
  options: { statusLine?: boolean } = {},
): Record<SupportedAgent, AgentAdapter> {
  const homeDir = userHome(env);
  return {
    'claude-code': createClaudeCodeAdapter({
      homeDir,
      env,
      ...(options.statusLine !== undefined ? { statusLine: options.statusLine } : {}),
    }),
    codex: createCodexAdapter({ homeDir, env }),
    cursor: createCursorAdapter({ homeDir, env }),
    gemini: createGeminiAdapter({ homeDir, env }),
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
  const sc = out.screen();
  sc.summary(`Mindly works with ${SUPPORTED_AGENTS.length} agents.`);
  const row = (kind: string): readonly [string, string] => {
    const adapter = adapterOf(all, kind);
    const userOnly = adapter instanceof McpClientAdapter && !adapter.supportsProjectScope;
    return [
      adapter.displayName,
      `${kind}${userOnly ? '   (user-wide only, not per project)' : ''}`,
    ];
  };
  const full = SUPPORTED_AGENTS.filter((k) => integrationOf(adapterOf(all, k)) !== 'mcp');
  const tools = SUPPORTED_AGENTS.filter((k) => integrationOf(adapterOf(all, k)) === 'mcp');
  sc.section('Full integration (hooks + MCP)');
  sc.note('Mindly sees what the agent does and gives it context automatically, plus its tools.', 2);
  sc.pairs(full.map(row));
  sc.section('Tools only (MCP)');
  sc.note("The agent can call Mindly's tools, but nothing is captured or sent automatically.", 2);
  sc.pairs(tools.map(row));
  sc.next([
    { cmd: 'mindly init', why: 'connect every agent found on this machine' },
    { cmd: 'mindly init --agents claude-code,codex', why: 'connect only the agents you name' },
  ]);
  return 0;
}

/** Parses `--agents a,b`. */
export function parseAgents(value: string | undefined): SupportedAgent[] | null {
  if (value === undefined) return null;
  const list = splitList(value);
  if (list.length === 0) {
    throw new UsageError('--agents needs at least one agent, e.g. --agents claude-code,codex');
  }
  for (const a of list) {
    if (!(SUPPORTED_AGENTS as readonly string[]).includes(a)) {
      throw new UsageError(
        `"${a}" is not an agent Mindly knows; use one of: ${SUPPORTED_AGENTS.join(', ')} (details: mindly init --list-agents)`,
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

/** The runner's package tree this process runs from, when it runs from a runner's cache. */
function currentRunnerTree(
  env: NodeJS.ProcessEnv,
  entry: string = cliEntry(),
): { home: string; tree: RunnerTree } | null {
  const tree = runnerTree(entry);
  if (tree === null) return null;
  try {
    return { home: mindlyHome(env), tree };
  } catch {
    return null; // invalid MINDLY_HOME: init reports it when it creates the home
  }
}

/**
 * The argv agents run to reach Mindly: the global `mindly` when this process was started through
 * it, otherwise `node <absolute path to dist/main.js>` so hooks work without a global install.
 * From a package runner's cache (`npx mindly-cli init`) that path is the copy `init` keeps under
 * `$MINDLY_HOME/lib` (see runner-copy.ts), which may not exist yet.
 */
export async function installCommand(
  env: NodeJS.ProcessEnv,
  entry: string = cliEntry(),
): Promise<string[]> {
  // Checked first: npx puts its cache's `.bin` on PATH, so the `mindly` found there is the cache.
  const runner = currentRunnerTree(env, entry);
  if (runner !== null) {
    return [process.execPath, copiedEntry(runner.home, MINDLY_VERSION, runner.tree)];
  }
  const running = process.argv[1];
  const global = await onPath('mindly', env);
  if (global && running && sameFile(global, running)) return [global];
  return [process.execPath, entry];
}

/** `$MINDLY_HOME/lib`, where init keeps copies of Mindly, when it exists. */
function runnerCopies(env: NodeJS.ProcessEnv): string | null {
  try {
    const lib = join(mindlyHome(env), 'lib');
    return existsSync(lib) ? lib : null;
  } catch {
    return null;
  }
}

/**
 * Copies this process's package tree out of the runner's cache when {@link installCommand}
 * points there. Null when done or not needed, else why it failed.
 */
async function keepRunnerCopy(env: NodeJS.ProcessEnv): Promise<string | null> {
  const runner = currentRunnerTree(env);
  if (runner === null) return null;
  try {
    await ensureCopy(runner.home, MINDLY_VERSION, runner.tree);
    return null;
  } catch (err) {
    return clean(err instanceof Error ? err.message : String(err), 200);
  }
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

/**
 * Leaves out agents with a config file Mindly cannot write (usually generated by another tool,
 * such as Nix home-manager) and prints the changes to make there by hand instead.
 */
function skipReadOnly(out: Out, plans: AgentPlan[], verb: 'connect' | 'disconnect'): AgentPlan[] {
  const s = out.style;
  return plans.filter((p) => {
    const blocked = p.steps
      .map((step) => ({ file: step.file, target: readOnlyTarget(step.file) }))
      .find((b) => b.target !== null);
    if (blocked === undefined) return true;
    const where =
      blocked.target === blocked.file
        ? `${blocked.file} is read-only`
        : `${blocked.file} links to ${blocked.target}, which is read-only`;
    out.line(s.bold(p.adapter.displayName));
    out.line(`  ${s.yellow('Skipped')}: ${where}, so it is probably managed by another tool.`);
    out.line(`  To ${verb} it, make these changes where that tool keeps the file:`);
    for (const step of p.steps) {
      out.line(`  ${s.cyan(step.file)}`);
      for (const l of diffSummary(step.previous, step.content, Infinity, Infinity).lines) {
        out.line(`    ${l.startsWith('+') ? s.green(l) : l.startsWith('-') ? s.red(l) : s.dim(l)}`);
      }
    }
    return false;
  });
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
  /** `--no-statusline` sets this to false. */
  statusline?: boolean;
  /** `--no-import`: skip importing rules from CLAUDE.md, AGENTS.md and similar files. */
  import?: boolean;
}

/** `mindly init`. */
export async function init(out: Out, o: SetupOptions): Promise<number> {
  if (o.listAgents) return listAgents(out);
  const env = out.io.env;
  const statusLine = o.statusline !== false;
  const all = adaptersFor(env, { statusLine });
  const projectRoot = o.project ? await projectRootOf(out.io.cwd) : null;
  let agents = parseAgents(o.agents);
  if (agents === null) {
    agents = [];
    for (const a of SUPPORTED_AGENTS) if (await adapterOf(all, a).detect()) agents.push(a);
    if (agents.length === 0) {
      out.line('No supported agent was found on this machine.');
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
  const planned: AgentPlan[] = [];
  for (const agent of agents) {
    const adapter = adapterOf(all, agent);
    planned.push({
      agent,
      adapter,
      steps: await adapter.planInstall({ command, projectRoot, homeDir }),
    });
  }
  out.line(
    out.style.dim(
      `Agents will reach Mindly by running: ${command.join(' ')}${projectRoot ? ` (for the project ${projectRoot} only)` : ' (for all your projects)'}`,
    ),
  );
  if (inRunnerCache(cliEntry())) {
    out.line(
      out.style.dim(
        inRunnerCache(command[command.length - 1] as string)
          ? "Mindly is running from a package runner's cache, which may be cleared at any time. Install it with npm i -g mindly-cli and run mindly init again so agents keep reaching it."
          : `Mindly is running from a package runner's cache, so it keeps its own copy in ${join(mindlyHome(env), 'lib')} for the agents. To update it later, run the newer version's init, or install it with npm i -g mindly-cli.`,
      ),
    );
  }
  out.line();
  const plans = skipReadOnly(out, planned, 'connect');
  const total = printPlan(out, plans, 'already configured');
  const claudeStatusLine =
    statusLine && agents.includes('claude-code')
      ? await inspectClaudeCodeStatusLine(homeDir, projectRoot, command)
      : null;
  if (claudeStatusLine?.owner === 'other') {
    out.line();
    out.line(
      `Claude Code already has a status line (${claudeStatusLine.file}), so Mindly leaves it alone. To see Mindly's counts there too, have your script also pipe its input to \`mindly statusline\` (see "Claude Code status line" in Mindly's README).`,
    );
  }
  if (o.dryRun) {
    if (o.import !== false) await offerRuleImport(out, { dryRun: true }, 'init');
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
  }
  // Also when nothing changes: the configs may already point at a copy that was deleted since.
  const copyFailed = await keepRunnerCopy(env);
  if (copyFailed !== null) {
    out.warn(
      `Mindly could not copy itself out of the package runner's cache (${copyFailed}), so the agents were not connected. Install it with npm i -g mindly-cli and run mindly init again.`,
    );
    return 1;
  }
  if (total > 0) {
    for (const p of plans) {
      for (const applied of applyInstallSteps(p.steps, { projectRoot })) {
        out.line(describeApplied(applied));
      }
    }
  }
  const home = initHome(out.io);
  if (o.import !== false) {
    try {
      await offerRuleImport(out, { yes: o.yes === true }, 'init');
    } catch (err) {
      // The agents are connected already: a failed import must not fail init.
      const why = clean(err instanceof Error ? err.message : String(err), 200);
      out.line(`Rules were not imported (${why}). Try again with: mindly rules import`);
    }
  }
  try {
    await offerRulesSync(out, { yes: o.yes === true });
  } catch (err) {
    const why = clean(err instanceof Error ? err.message : String(err), 200);
    out.line(`The rules section was not written (${why}). Try again with: mindly rules sync`);
  }
  renderInitSummary(out.screen(), {
    home,
    connected: plans.filter((p) => p.steps.length > 0).map((p) => p.adapter.displayName),
    already: plans.filter((p) => p.steps.length === 0).map((p) => p.adapter.displayName),
    toolsOnly: plans
      .filter((p) => integrationOf(p.adapter) === 'mcp')
      .map((p) => p.adapter.displayName),
    codex: agents.includes('codex'),
    rule: MCP_ONLY_RULE,
  });
  return 0;
}

/** One line per written file; a symlinked config names the file the link points to. */
function describeApplied(a: AppliedStep): string {
  const backup = a.backup ? ` (backup: ${a.backup})` : '';
  if (a.target === null) return `Wrote ${a.file}${backup}`;
  if (a.createdTarget) {
    return `Created ${a.target}: ${a.file} links to it, but it did not exist yet`;
  }
  return `Wrote ${a.target} (linked from ${a.file})${backup}`;
}

function supportsProject(adapter: AgentAdapter): boolean {
  return !(adapter instanceof McpClientAdapter) || adapter.supportsProjectScope;
}

/** What `checkpointRows` counted or removed. */
interface CheckpointRemoval {
  rows: number;
  /** The sentinel's scratch trees that could not be removed (busy, or removal failed). */
  left: string[];
}

/**
 * Counts or deletes the checkpoints (hidden `refs/mindly/steps/*` refs and their rows) of the
 * project at `projectRoot`, or of every project without one, and on removal the sentinel's
 * scratch trees. Best effort: 0 when Mindly cannot be opened.
 */
async function checkpointRows(
  io: CliIo,
  projectRoot: string | null,
  action: 'count' | 'remove',
): Promise<CheckpointRemoval> {
  const none: CheckpointRemoval = { rows: 0, left: [] };
  if (!existsSync(mindlyHome(io.env))) return none;
  let mindly: Mindly;
  try {
    mindly = openMindly({ env: io.env, disableNotify: true, disableLlm: true });
  } catch {
    return none;
  }
  try {
    const projects =
      projectRoot === null
        ? mindly.store.projects.list().slice(0, 500)
        : [mindly.store.projects.findByRoot(realpathSync(projectRoot))].filter((p) => p !== null);
    let rows = 0;
    const left: string[] = [];
    for (const p of projects) {
      rows +=
        action === 'count'
          ? mindly.store.checkpoints.count(p.id)
          : (await mindly.checkpoints.forget(p.id)).rowsDeleted;
      // The sentinel's scratch trees are worktrees of the same repositories.
      if (action === 'remove') {
        const svc = sentinelOf(mindly);
        const r = await svc.forget(p.id);
        for (const w of [...r.busy, ...r.failed]) left.push(svc.warmPath(p.id, w));
      }
    }
    return { rows, left };
  } catch {
    return none;
  } finally {
    mindly.close();
  }
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
  const planned: AgentPlan[] = [];
  for (const agent of agents) {
    const adapter = adapterOf(all, agent);
    const steps = await adapter.planUninstall({ command, projectRoot, homeDir });
    // Without --agents, MCP-only clients with nothing to remove are not worth a line each.
    if (explicit === null && steps.length === 0 && integrationOf(adapter) === 'mcp') continue;
    planned.push({ agent, adapter, steps });
  }
  const plans = skipReadOnly(out, planned, 'disconnect');
  let total = printPlan(out, plans, 'nothing to remove');
  // Without --agents, Mindly is removed entirely: its rules section goes too.
  const rulesFile = explicit === null ? planRulesSyncRemoval(out.io) : null;
  if (rulesFile !== null) {
    out.line(out.style.bold('Rules in agent instruction files'));
    out.line("  Remove Mindly's rules section and stop keeping it updated");
    for (const { root, changes } of rulesFile) {
      out.line(`  ${out.style.dim(root)}`);
      total += Math.max(1, printRulesFileChanges(out, changes));
    }
  }
  // Checkpoints (copies of the code after agent edits) go only when every agent's hooks go.
  const checkpoints =
    explicit === null ? (await checkpointRows(out.io, projectRoot, 'count')).rows : 0;
  if (checkpoints > 0) {
    out.line(out.style.bold('Checkpoints'));
    out.line(
      `  Delete ${checkpoints} saved copies of the code after agent edits (hidden refs in your repositories)`,
    );
    total += 1;
  }
  // The copy `npx mindly-cli init` keeps for the agents goes when Mindly is removed user-wide.
  const copies = explicit === null && projectRoot === null ? runnerCopies(env) : null;
  if (copies !== null) {
    out.line(out.style.bold("Mindly's own copy"));
    out.line(`  Delete ${copies}, the copy of Mindly that init made for your agents`);
    total += 1;
  }
  if (o.dryRun) {
    out.line();
    out.line('Dry run: nothing was written.');
    return 0;
  }
  if (total === 0 && plans.length < planned.length) return 0;
  if (total === 0) {
    out.line('Mindly is not connected to any of these agents: there is nothing to remove.');
    return 0;
  }
  out.line();
  if (!(await confirm(out.io, `Apply ${total} change${total === 1 ? '' : 's'}?`, o.yes === true))) {
    out.line('Nothing changed.');
    return 1;
  }
  for (const p of plans) {
    for (const applied of applyInstallSteps(p.steps, { projectRoot })) {
      out.line(describeApplied(applied));
    }
  }
  if (rulesFile !== null) {
    for (const { root, changes } of removeRulesSync(out.io)) {
      for (const c of changes) {
        if (c.skipped === null && c.next !== c.previous) {
          out.line(`${c.next === null ? 'Deleted' : 'Wrote'} ${join(root, c.target)}`);
        }
      }
    }
  }
  const removal =
    checkpoints > 0
      ? await checkpointRows(out.io, projectRoot, 'remove')
      : { rows: 0, left: [] as string[] };
  const removed = removal.rows;
  let copiesRemoved = false;
  if (copies !== null) {
    try {
      rmSync(copies, { recursive: true, force: true });
      copiesRemoved = true;
    } catch (err) {
      const why = clean(err instanceof Error ? err.message : String(err), 200);
      out.warn(`${copies} could not be removed (${why}). Delete that folder by hand.`);
    }
  }
  const sc = out.screen();
  const names = plans.filter((p) => p.steps.length > 0).map((p) => p.adapter.displayName);
  sc.blank();
  if (names.length > 0) {
    sc.text(
      `${sc.mark('ok')} Disconnected ${names.join(', ')}. Restart running agent sessions so they stop using Mindly.`,
    );
  }
  if (rulesFile !== null) {
    sc.text(`${sc.mark('ok')} Removed Mindly's rules section from your agent instruction files.`);
  }
  if (copiesRemoved) {
    sc.text(`${sc.mark('ok')} Removed Mindly's own copy from ${copies}.`);
  }
  if (removed > 0) {
    sc.text(
      `${sc.mark('ok')} Removed ${removed} checkpoints (copies of the code saved after agent edits) from your repositories.`,
    );
  }
  for (const path of removal.left) {
    out.warn(
      `The sentinel's scratch copy at ${clean(path, 300)} could not be removed (a check may be running there). Delete that folder, then run \`git worktree prune\` in the repository.`,
    );
  }
  sc.note(`Your Mindly data in ${mindlyHome(env)} is kept.`, 2);
  sc.next([{ cmd: 'mindly forget --project', why: "delete this project's Mindly data too" }]);
  return 0;
}
