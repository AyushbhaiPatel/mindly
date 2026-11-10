import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeError,
  homePaths,
  mindlyHome,
  readUserConfig,
  shortId,
  type HomePaths,
} from '@mindly/core';
import { checkSafePattern, sentinelOf, type Mindly, type ProjectContext } from '@mindly/engine';
import { gitVersion, lockfileIn, mirrorRemotes, versionAtLeast } from '@mindly/git';
import { MIGRATIONS, schemaVersion, Store } from '@mindly/store';
import { withProject } from '../context.js';
import { clean, type Out } from '../util.js';
import { runningDaemon } from './daemon.js';
import { inspectClaudeCodeStatusLine, McpClientAdapter } from '@mindly/adapters';
import { adapterOf, adaptersFor, installCommand, SUPPORTED_AGENTS, userHome } from './setup.js';
import { count, type Step } from '../present/index.js';
import { renderDoctor, type DoctorItem } from '../views/doctor.js';
import { notReadyWords } from '../views/sentinel.js';

/** Result of one doctor check (the `--json` shape; keep it stable). */
export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
}

/** Minimum Node.js version (`node:sqlite` without a flag). */
export const MIN_NODE = [22, 13] as const;
/** Minimum git version for shadow merge (`git merge-tree --write-tree`). */
export const MIN_GIT = [2, 38] as const;

function atLeast(version: string, [major, minor]: readonly [number, number]): boolean {
  const [a = 0, b = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  return a > major || (a === major && b >= minor);
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Builds a doctor item: the JSON check plus its human wording. */
function item(
  check: Check,
  group: DoctorItem['group'],
  text: string,
  fix: Step | string | null = null,
): DoctorItem {
  if (typeof fix === 'string') fix = { why: fix };
  return { check, group, text, fix };
}

/** Whether Claude Code's status line (for this project, or user-wide) shows Mindly. */
async function claudeStatusLineCheck(
  homeDir: string,
  projectRoot: string | null,
  command: readonly string[],
): Promise<DoctorItem> {
  const found = await inspectClaudeCodeStatusLine(homeDir, projectRoot, command);
  if (found.owner === 'mindly') {
    return item(
      {
        name: 'claude-code-statusline',
        status: 'ok',
        detail: `mindly statusline in ${found.file}`,
      },
      'Agents',
      "Claude Code's status line shows Mindly's rules, updates and conflicts",
    );
  }
  if (found.owner === 'other') {
    return item(
      {
        name: 'claude-code-statusline',
        status: 'info',
        detail: `your own status line in ${found.file}`,
      },
      'Optional',
      `Claude Code uses your own status line (${found.file}); add \`mindly statusline\` to it to see Mindly's counts there`,
    );
  }
  return item(
    { name: 'claude-code-statusline', status: 'info', detail: 'no status line' },
    'Optional',
    "Claude Code has no status line; mindly init --agents claude-code adds Mindly's",
  );
}

function permissionChecks(paths: HomePaths): DoctorItem[] {
  if (process.platform === 'win32') {
    return [
      item(
        { name: 'permissions', status: 'info', detail: 'not checked on Windows' },
        'Setup',
        'File permissions are not checked on Windows',
      ),
    ];
  }
  const loose: string[] = [];
  const dirs = [paths.home, paths.logs, paths.run];
  for (const d of dirs) if (existsSync(d) && modeOf(d) !== 0o700) loose.push(`${d} (dir)`);
  const files = [
    paths.db,
    `${paths.db}-wal`,
    `${paths.db}-shm`,
    paths.config,
    paths.token,
    paths.daemonState,
  ];
  if (existsSync(paths.logs)) {
    for (const f of readdirSync(paths.logs).slice(0, 200)) files.push(join(paths.logs, f));
  }
  for (const f of files) {
    if (existsSync(f) && statSync(f).isFile() && (modeOf(f) & 0o077) !== 0) loose.push(f);
  }
  if (loose.length === 0) {
    return [
      item(
        { name: 'permissions', status: 'ok', detail: 'home is 0700, files are owner-only' },
        'Setup',
        "Only you can read Mindly's files",
      ),
    ];
  }
  const shown = `${loose.slice(0, 5).join(', ')}${loose.length > 5 ? ', ...' : ''}`;
  return [
    item(
      {
        name: 'permissions',
        status: 'fail',
        detail: `readable by others: ${shown} (chmod 700 directories, 600 files)`,
      },
      'Setup',
      `Other users on this machine can read: ${shown}`,
      `Make them private: chmod 700 ${paths.home} and chmod 600 the files listed`,
    ),
  ];
}

/**
 * Doctor line for an MCP-only client, or null when it is neither installed nor configured (so
 * the dozen catalog clients do not each add a "not installed" line).
 */
async function mcpClientCheck(
  adapter: McpClientAdapter,
  command: string[],
  homeDir: string,
  projectRoot: string | null,
): Promise<DoctorItem | null> {
  const name = adapter.kind;
  const label = adapter.displayName;
  try {
    const scopes: (string | null)[] =
      projectRoot !== null && adapter.supportsProjectScope ? [null, projectRoot] : [null];
    let present = false;
    for (const root of scopes) {
      const steps = await adapter.planInstall({ command, projectRoot: root, homeDir });
      if (steps.length === 0) {
        const where = root === null ? '' : ' for this project';
        return item(
          { name, status: 'ok', detail: `MCP server configured${where} (MCP tools only)` },
          'Agents',
          `${label}: connected${where} (Mindly tools only, no automatic capture)`,
        );
      }
      if (await adapter.isConfigured({ homeDir, projectRoot: root })) present = true;
    }
    if (present) {
      return item(
        {
          name,
          status: 'warn',
          detail: 'Mindly MCP entry points elsewhere (run mindly init --agents ' + name + ')',
        },
        'Agents',
        `${label}: its Mindly entry points to another Mindly install`,
        { cmd: `mindly init --agents ${name}`, why: 'point it at this Mindly' },
      );
    }
    if (await adapter.detect()) {
      return item(
        {
          name,
          status: 'info',
          detail: `installed, MCP not configured (optional: mindly init --agents ${name})`,
        },
        'Optional',
        `${label} is installed but not connected (connect it with: mindly init --agents ${name})`,
      );
    }
    return null;
  } catch (err) {
    return item(
      { name, status: 'warn', detail: describeError(err) },
      'Agents',
      `${label}: could not read its settings (${describeError(err)})`,
      `Check ${label}'s MCP settings file, then run: mindly init --agents ${name}`,
    );
  }
}

/** Whether this project's `.mindly/config.json` is valid and trusted. */
function projectItem(project: ProjectContext): DoctorItem {
  const name = clean(project.project.name, 80);
  if (project.configError) {
    return item(
      { name: 'project', status: 'warn', detail: `${name}: invalid .mindly/config.json` },
      'Setup',
      `This project (${name}) has an invalid .mindly/config.json`,
      'Fix .mindly/config.json (see mindly trust --show), then run: mindly trust',
    );
  }
  if (project.configHash === null) {
    return item(
      { name: 'project', status: 'ok', detail: `${name}: no project config` },
      'Setup',
      `This project (${name}) has no .mindly/config.json, which is fine`,
    );
  }
  return project.trusted
    ? item(
        { name: 'project', status: 'ok', detail: `${name}: config trusted` },
        'Setup',
        `This project's (${name}) .mindly/config.json is trusted`,
      )
    : item(
        {
          name: 'project',
          status: 'warn',
          detail: `${name}: config not trusted, its checks will not run (mindly trust)`,
        },
        'Setup',
        `This project's (${name}) .mindly/config.json is not trusted, so its checks do not run`,
        { cmd: 'mindly trust', why: 'review its commands and trust it' },
      );
}

function bytesWords(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Whether checkpoints (what `mindly bisect` searches) are on, how many exist and what they take. */
async function checkpointItems(
  mindly: Mindly,
  project: ProjectContext,
  cwd: string,
): Promise<DoctorItem[]> {
  const cfg = mindly.config.checkpoints;
  if (!cfg.enabled) {
    return [
      item(
        { name: 'checkpoints', status: 'info', detail: 'off (checkpoints.enabled is false)' },
        'Optional',
        'Checkpoints are off, so mindly bisect has nothing to search',
        {
          cmd: 'mindly config set checkpoints.enabled true',
          why: 'save the code after every agent edit',
        },
      ),
    ];
  }
  const worktree = await mindly.checkpoints.worktreeOf(cwd);
  if (!worktree) {
    return [
      item(
        { name: 'checkpoints', status: 'info', detail: 'not a git repository' },
        'Optional',
        'This folder is not a git repository, so Mindly keeps no checkpoints here (mindly bisect needs them)',
      ),
    ];
  }
  const stats = await mindly.checkpoints.stats(project.project.id);
  const disk = stats.diskBytes === null ? '' : `, about ${bytesWords(stats.diskBytes)} on disk`;
  const items = [
    item(
      {
        name: 'checkpoints',
        status: 'ok',
        detail: `on: ${stats.count} stored${disk}, kept ${cfg.keepDays} days`,
      },
      'Optional',
      `Checkpoints are on: ${count(stats.count, 'step')} saved for mindly bisect${disk}, kept ${cfg.keepDays} days (at most ${cfg.maxPerWorktree} per checkout)`,
    ),
  ];
  let mirrors: string[] = [];
  try {
    mirrors = await mirrorRemotes(worktree);
  } catch {
    // Not knowing is not a problem to report.
  }
  for (const remote of mirrors) {
    const name = clean(remote, 80);
    items.push(
      item(
        {
          name: 'checkpoints-mirror',
          status: 'warn',
          detail: `remote ${name} is a mirror: git push --mirror also pushes hidden checkpoint refs`,
        },
        'Setup',
        `Remote ${name} has remote.${name}.mirror set, so git push --mirror would also push Mindly's hidden checkpoint refs (copies of this code after each agent edit) to it`,
        `Push branches explicitly instead, or unset it with: git config --unset remote.${name}.mirror`,
      ),
    );
  }
  return items;
}

/** Whether the sentinel is on, what it runs, and what keeps it from running. */
function sentinelItems(mindly: Mindly, project: ProjectContext, daemon: boolean): DoctorItem[] {
  const svc = sentinelOf(mindly);
  const ready = svc.readiness(project);
  if (!mindly.config.sentinel.enabled) {
    return [
      item(
        { name: 'sentinel', status: 'info', detail: 'off (sentinel.enabled is false)' },
        'Optional',
        'The sentinel is off; when on, it runs your trusted checks after agent edits and finds the edit that broke one',
        { cmd: 'mindly config set sentinel.enabled true', why: 'turn it on' },
      ),
    ];
  }
  if (!ready.ready) {
    const w = notReadyWords(ready.reason ?? 'no_checks');
    return [
      item(
        { name: 'sentinel', status: 'warn', detail: `on, but ${w.why}` },
        'Setup',
        `The sentinel is on, but ${w.why}`,
        w.step,
      ),
    ];
  }
  const names = ready.checks.map((c) => clean(c.name, 64)).join(', ');
  const items = [
    item(
      {
        name: 'sentinel',
        status: daemon ? 'ok' : 'info',
        detail: `on: runs ${names}${daemon ? '' : ' (daemon not running)'}`,
      },
      'Optional',
      daemon
        ? `The sentinel runs ${names} after agent edits`
        : `The sentinel would run ${names} after agent edits, but it runs in the background service, which is not running`,
      daemon ? null : { cmd: 'mindly daemon start', why: 'start the background service' },
    ),
  ];
  const lockfile = ready.setup === null ? lockfileIn(project.root) : null;
  if (lockfile !== null) {
    items.push(
      item(
        { name: 'sentinel-setup', status: 'info', detail: `${lockfile} found, no sentinel.setup` },
        'Optional',
        `The sentinel checks a scratch copy of the code without installing dependencies (${clean(lockfile, 60)} found)`,
        'Add an install command as sentinel.setup in .mindly/config.json, e.g. "setup": ["pnpm", "install", "--frozen-lockfile"], then run mindly trust',
      ),
    );
  }
  return items;
}

/** Pattern contracts whose pattern no longer passes the safety check, so they cannot run. */
function rejectedPatternItems(mindly: Mindly, project: ProjectContext): DoctorItem[] {
  const rejected = mindly.store.contracts
    .list(project.project.id)
    .filter(
      (c) =>
        (c.kind === 'pattern_present' || c.kind === 'pattern_absent') &&
        checkSafePattern(c.spec.pattern ?? '') !== null,
    );
  if (rejected.length === 0) return [];
  const list = rejected
    .map((c) => `memory ${shortId(c.memoryId)}: ${clean(c.spec.pattern ?? '', 80)}`)
    .join('; ');
  const n = rejected.length;
  const summary = `${n} contract${n === 1 ? '' : 's'} cannot run: pattern rejected as too expensive to evaluate safely (${list})`;
  return [
    item({ name: 'contract-patterns', status: 'warn', detail: summary }, 'Setup', summary, {
      cmd: 'mindly contract add <memoryId> --kind <kind> --path <file> --pattern <simpler pattern>',
      why: 'add the check again with fewer optional parts or alternatives',
    }),
  ];
}

/**
 * Entries of the user config that Mindly ignores because they cannot be used (an empty
 * redaction pattern, a glob that does not parse). Nothing when the file is fine; the file being
 * unreadable is reported by the commands that need it.
 */
function configChecks(paths: HomePaths): DoctorItem[] {
  let warnings: string[];
  try {
    warnings = readUserConfig(paths.config).warnings;
  } catch (err) {
    return [
      item(
        { name: 'config', status: 'fail', detail: describeError(err) },
        'Setup',
        `Your settings in ${paths.config} cannot be used: ${describeError(err)}`,
        'Fix the file, or see the settings with: mindly config get',
      ),
    ];
  }
  return warnings.map((w) =>
    item(
      { name: 'config', status: 'warn', detail: w },
      'Setup',
      `A setting is ignored: ${w}`,
      'Change it with mindly config set, or remove it with mindly config unset',
    ),
  );
}

/** Runs every check. Never prints or returns secrets (only paths, versions and states). */
export async function runDoctor(out: Out): Promise<DoctorItem[]> {
  const env = out.io.env;
  const items: DoctorItem[] = [];
  const node = process.versions.node;
  const nodeOk = atLeast(node, MIN_NODE);
  items.push(
    item(
      {
        name: 'node',
        status: nodeOk ? 'ok' : 'fail',
        detail: `v${node}${nodeOk ? '' : ` (need >= ${MIN_NODE.join('.')})`}`,
      },
      'Setup',
      nodeOk ? `Node.js ${node}` : `Node.js ${node} is too old`,
      nodeOk ? null : `Install Node.js ${MIN_NODE.join('.')} or newer`,
    ),
  );
  try {
    await import('node:sqlite');
    items.push(
      item(
        { name: 'node:sqlite', status: 'ok', detail: 'available' },
        'Setup',
        'Built-in SQLite is available',
      ),
    );
  } catch {
    items.push(
      item(
        { name: 'node:sqlite', status: 'fail', detail: 'not available in this Node.js' },
        'Setup',
        'This Node.js has no built-in SQLite (node:sqlite)',
        `Install Node.js ${MIN_NODE.join('.')} or newer`,
      ),
    );
  }
  try {
    const v = await gitVersion();
    const ok = versionAtLeast(v, MIN_GIT[0], MIN_GIT[1]);
    const version = `${v.major}.${v.minor}.${v.patch}`;
    items.push(
      item(
        {
          name: 'git',
          status: ok ? 'ok' : 'warn',
          detail: `${version}${ok ? '' : ` (shadow merge needs >= ${MIN_GIT.join('.')})`}`,
        },
        'Setup',
        ok
          ? `git ${version}`
          : `git ${version} is too old for merge checks between agents (needs ${MIN_GIT.join('.')})`,
        ok ? null : `Update git to ${MIN_GIT.join('.')} or newer`,
      ),
    );
  } catch {
    items.push(
      item(
        { name: 'git', status: 'fail', detail: 'git was not found on PATH' },
        'Setup',
        'git was not found',
        'Install git and make sure it is on your PATH',
      ),
    );
  }

  let paths: HomePaths | null = null;
  try {
    paths = homePaths(mindlyHome(env));
  } catch (err) {
    items.push(
      item(
        { name: 'home', status: 'fail', detail: describeError(err) },
        'Setup',
        `Mindly's data folder is not usable: ${describeError(err)}`,
        'Point MINDLY_HOME at an absolute path you own, or unset it',
      ),
    );
  }
  if (paths) {
    if (!existsSync(paths.home)) {
      items.push(
        item(
          {
            name: 'home',
            status: 'fail',
            detail: `${paths.home} does not exist (run mindly init)`,
          },
          'Setup',
          `Mindly's data folder ${paths.home} does not exist yet`,
          { cmd: 'mindly init', why: 'create it and connect your agents' },
        ),
      );
    } else {
      items.push(
        item(
          { name: 'home', status: 'ok', detail: paths.home },
          'Setup',
          `Data folder ${paths.home}`,
        ),
      );
      items.push(...permissionChecks(paths));
      items.push(...configChecks(paths));
      try {
        const store = Store.open(paths.db, { busyTimeoutMs: 2000 });
        try {
          const v = schemaVersion(store.db);
          const ok = v === MIGRATIONS.length;
          items.push(
            item(
              {
                name: 'database',
                status: ok ? 'ok' : 'fail',
                detail: `schema v${v}${ok ? '' : ` (expected v${MIGRATIONS.length})`}`,
              },
              'Setup',
              ok
                ? 'Database is up to date'
                : `Database format v${v} does not match this Mindly (v${MIGRATIONS.length})`,
              ok ? null : 'Update Mindly to the newest version (npm install -g mindly-cli)',
            ),
          );
        } finally {
          store.close();
        }
      } catch (err) {
        items.push(
          item(
            { name: 'database', status: 'fail', detail: describeError(err) },
            'Setup',
            `The database cannot be opened: ${describeError(err)}`,
            `Close other Mindly processes (mindly daemon stop) and check ${paths.db}`,
          ),
        );
      }
    }
  }

  // The status line is optional, so it does not decide whether an agent counts as connected.
  const adapters = adaptersFor(env, { statusLine: false });
  const command = await installCommand(env);
  // Mindly may be installed user-wide or only for this project (`init --project`).
  let projectRoot: string | null;
  try {
    const { findRepoRoot } = await import('@mindly/git');
    projectRoot = await findRepoRoot(out.io.cwd);
  } catch {
    projectRoot = null;
  }
  for (const kind of SUPPORTED_AGENTS) {
    const adapter = adapterOf(adapters, kind);
    const label = adapter.displayName;
    if (adapter instanceof McpClientAdapter) {
      const check = await mcpClientCheck(adapter, command, userHome(env), projectRoot);
      if (check !== null) items.push(check);
      continue;
    }
    try {
      const detected = await adapter.detect();
      const plan = (root: string | null) =>
        adapter.planInstall({ command, projectRoot: root, homeDir: userHome(env) });
      const userSteps = await plan(null);
      const projectSteps = projectRoot ? await plan(projectRoot) : null;
      if (userSteps.length === 0) {
        items.push(
          item(
            { name: kind, status: 'ok', detail: 'hooks and MCP server configured' },
            'Agents',
            `${label}: connected (automatic capture and Mindly tools)`,
          ),
        );
      } else if (projectSteps !== null && projectSteps.length === 0) {
        items.push(
          item(
            {
              name: kind,
              status: 'ok',
              detail: 'hooks and MCP server configured for this project',
            },
            'Agents',
            `${label}: connected for this project (automatic capture and Mindly tools)`,
          ),
        );
      } else if (detected) {
        items.push(
          item(
            {
              name: kind,
              status: 'warn',
              detail:
                'installed, but Mindly hooks/MCP are missing or point elsewhere (run mindly init)',
            },
            'Agents',
            `${label} is installed but not connected to Mindly`,
            { cmd: `mindly init --agents ${kind}`, why: 'connect it' },
          ),
        );
      } else {
        items.push(
          item(
            { name: kind, status: 'info', detail: 'not installed' },
            'Optional',
            `${label} is not installed`,
          ),
        );
      }
      const connected = userSteps.length === 0 || projectSteps?.length === 0;
      if (kind === 'claude-code' && connected) {
        items.push(await claudeStatusLineCheck(userHome(env), projectRoot, command));
      }
    } catch (err) {
      items.push(
        item(
          { name: kind, status: 'warn', detail: describeError(err) },
          'Agents',
          `${label}: could not read its settings (${describeError(err)})`,
          `Check ${label}'s settings files, then run: mindly init --agents ${kind}`,
        ),
      );
    }
  }

  const daemon = await runningDaemon(env);
  items.push(
    item(
      {
        name: 'daemon',
        status: 'info',
        detail: daemon
          ? `running on 127.0.0.1:${daemon.port} (pid ${daemon.pid})`
          : 'not running (optional)',
      },
      'Optional',
      daemon
        ? `Background service is running (open Mission Control with: mindly dashboard)`
        : 'Background service is not running; it powers Mission Control and background checks (start it with: mindly daemon start)',
    ),
  );

  if (paths && existsSync(paths.home)) {
    try {
      items.push(
        ...(await withProject(out.io, async ({ mindly, project }): Promise<DoctorItem[]> => [
          projectItem(project),
          ...project.configWarnings.map((w) =>
            item(
              { name: 'project-config', status: 'warn', detail: w },
              'Setup',
              `This project's .mindly/config.json has an entry Mindly leaves out: ${w}`,
              'Fix that entry in .mindly/config.json',
            ),
          ),
          ...rejectedPatternItems(mindly, project),
          ...(await checkpointItems(mindly, project, out.io.cwd)),
          ...sentinelItems(mindly, project, daemon !== null),
        ])),
      );
    } catch (err) {
      items.push(
        item(
          { name: 'project', status: 'warn', detail: describeError(err) },
          'Setup',
          `This folder could not be opened as a project: ${describeError(err)}`,
        ),
      );
    }
  }
  return items;
}

/** Runs every check and returns the `--json` shape. */
export async function runChecks(out: Out): Promise<Check[]> {
  return (await runDoctor(out)).map((i) => i.check);
}

/** `mindly doctor`. Exit code 1 when any check fails. */
export async function doctor(out: Out, o: { json?: boolean }): Promise<number> {
  const items = await runDoctor(out);
  const failed = items.some((i) => i.check.status === 'fail');
  if (o.json) {
    out.json({ ok: !failed, checks: items.map((i) => i.check) });
    return failed ? 1 : 0;
  }
  renderDoctor(out.screen(), items);
  return failed ? 1 : 0;
}
