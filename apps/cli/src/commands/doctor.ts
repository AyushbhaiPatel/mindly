import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeError,
  homePaths,
  mindlyHome,
  readUserConfig,
  shortId,
  type HomePaths,
  unusableNotifyChannels,
} from '@mindly/core';
import { checkSafePattern, sentinelOf, type Mindly, type ProjectContext } from '@mindly/engine';
import { findRepoRoot, gitVersion, lockfileIn, mirrorRemotes, versionAtLeast } from '@mindly/git';
import {
  confirmSchemaVersion,
  MIGRATIONS,
  peekSchemaVersion,
  schemaVersion,
  Store,
} from '@mindly/store';
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

/**
 * The permission bits of `path`, or null when nothing is there (or, with `only: 'file'`, when it
 * is not a regular file). One `stat` answers both questions: SQLite removes its `-wal` and `-shm`
 * files when the last process closes the database, so a file seen a moment ago may be gone.
 */
export function modeIfThere(path: string, only?: 'file'): number | null {
  try {
    const st = statSync(path);
    if (only === 'file' && !st.isFile()) return null;
    return st.mode & 0o777;
  } catch {
    return null;
  }
}

/** The entries of a folder, or none when it is not there (any more). */
function entriesOf(dir: string, max: number): string[] {
  try {
    return readdirSync(dir).slice(0, max);
  } catch {
    return [];
  }
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

/**
 * Notification channels the config file holds with a URL that cannot be used. Reading the file
 * leaves them out, so nothing else says that they never send anything.
 */
function notifyChannelChecks(paths: HomePaths): DoctorItem[] {
  return unusableNotifyChannels(paths.config).map((c) =>
    item(
      {
        name: 'notify-channel',
        status: 'warn',
        detail: `notify.channels[${c.index}] (${c.type}): ${c.problem}`,
      },
      'Setup',
      `The ${c.type} channel notify.channels[${c.index}] is not used: its ${c.problem}`,
      { cmd: 'mindly config get notify.channels', why: 'see it, then set the channels again' },
    ),
  );
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

/**
 * Why the checks that need the store were not run: its format is older, it cannot be opened, or
 * the project in it could not be.
 */
type StoreSkip = 'older' | 'unusable' | 'project';

interface DatabaseCheck {
  item: DoctorItem;
  skipped: StoreSkip | null;
}

/**
 * The checks that need the store, reported as not run. Their names stay in the output, so a
 * reader of `--json` that looks a check up by name finds it and sees why it has no result. The
 * project's own entry is left out when the caller reports it itself.
 */
function skippedStoreItems(why: StoreSkip): DoctorItem[] {
  const reason = {
    older: 'the database is in an older format',
    unusable: 'the database cannot be opened',
    project: 'the project could not be opened',
  }[why];
  const said = {
    older: 'not checked until the database is upgraded',
    unusable: 'not checked, the database cannot be opened',
    project: 'not checked, the project could not be opened',
  }[why];
  const detail = `not checked: ${reason}`;
  return [
    ...(why === 'project'
      ? []
      : [item({ name: 'project', status: 'info', detail }, 'Setup', `This project: ${said}`)]),
    item({ name: 'checkpoints', status: 'info', detail }, 'Optional', `Checkpoints: ${said}`),
    item({ name: 'sentinel', status: 'info', detail }, 'Optional', `The sentinel: ${said}`),
  ];
}

/** What stopped the database from being read, as far as the advice to give depends on it. */
export type DatabaseErrorKind = 'busy' | 'permission' | 'damaged' | 'other';

const SQLITE_PERM = 3;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_CORRUPT = 11;
const SQLITE_AUTH = 23;
const SQLITE_NOTADB = 26;

/**
 * Tells a busy database from one Mindly may not read and from a damaged file. They need opposite
 * advice: moving a database away is right for a damaged file and loses everything when the file
 * was only busy.
 */
export function classifyDatabaseError(err: unknown): DatabaseErrorKind {
  const e = (err ?? {}) as { code?: unknown; errcode?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  // node:sqlite reports SQLite's (possibly extended) result code; the primary code is its low byte.
  const primary = typeof e.errcode === 'number' ? e.errcode & 0xff : -1;
  const message = typeof e.message === 'string' ? e.message : '';
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return 'busy';
  if (/database (table )?is (locked|busy)/i.test(message)) return 'busy';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission';
  if (primary === SQLITE_PERM || primary === SQLITE_READONLY || primary === SQLITE_AUTH) {
    return 'permission';
  }
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) return 'damaged';
  if (/malformed|not a database/i.test(message)) return 'damaged';
  return 'other';
}

function damagedItem(what: string, dbPath: string): DoctorItem {
  return item(
    { name: 'database', status: 'fail', detail: what },
    'Setup',
    `The database file cannot be read as a Mindly database: ${what}`,
    `Check ${dbPath}; if it is damaged, move it away and Mindly starts a new one`,
  );
}

/** The `database` check for an error met while reading the database, with advice that fits it. */
export function databaseErrorItem(err: unknown, dbPath: string): DoctorItem {
  const what = describeError(err);
  switch (classifyDatabaseError(err)) {
    case 'busy':
      return item(
        { name: 'database', status: 'fail', detail: what },
        'Setup',
        'The database is busy: another Mindly process is holding it',
        'Close other Mindly processes (mindly daemon stop) and run mindly doctor again',
      );
    case 'permission':
      return item(
        { name: 'database', status: 'fail', detail: what },
        'Setup',
        `Mindly is not allowed to read or write ${dbPath}: ${what}`,
        `Make ${dbPath} and its folder readable and writable by you (and not on a read-only disk)`,
      );
    case 'damaged':
      return damagedItem(what, dbPath);
    case 'other':
      return item(
        { name: 'database', status: 'fail', detail: what },
        'Setup',
        `The database cannot be opened: ${what}`,
        `Close other Mindly processes (mindly daemon stop) and check ${dbPath}`,
      );
  }
}

/** A version further ahead of this Mindly's than this is damage, not a newer release. */
const MAX_VERSIONS_AHEAD = 1000;

/**
 * The database's format, read before anything opens the store: opening it applies every pending
 * migration and refuses a newer format, so a check made afterwards could only ever see "up to
 * date" or a failed open. `skipped` says why the store must not be opened by this diagnostic, or
 * is null when it can be.
 */
function databaseCheck(dbPath: string): DatabaseCheck {
  const latest = MIGRATIONS.length;
  const failed = (err: unknown): DatabaseCheck => ({
    item: databaseErrorItem(err, dbPath),
    skipped: 'unusable',
  });
  let found: number | null;
  try {
    found = peekSchemaVersion(dbPath, { busyTimeoutMs: 2000 });
    // The first look reads the file's header and nothing else. Whatever it says other than "up
    // to date" (or "empty") is acted on without the store ever opening the file, so SQLite has
    // to read the database first: a file cut short or overwritten still has a header.
    const empty =
      found === 0 && modeIfThere(dbPath, 'file') !== null && statSync(dbPath).size === 0;
    if (found !== null && found !== latest && !empty) {
      found = confirmSchemaVersion(dbPath, { busyTimeoutMs: 2000 });
    }
  } catch (err) {
    return failed(err);
  }
  // No Mindly wrote a version this far ahead: the number is not a version.
  if (found !== null && found > latest + MAX_VERSIONS_AHEAD) {
    return {
      item: damagedItem(`schema version ${found} is not one Mindly writes`, dbPath),
      skipped: 'unusable',
    };
  }
  if (found !== null && found > latest) {
    return {
      item: item(
        { name: 'database', status: 'fail', detail: `schema v${found} (expected v${latest})` },
        'Setup',
        `The database was written by a newer Mindly (format v${found}, this version reads v${latest})`,
        'Update Mindly to the newest version (npm install -g mindly-cli)',
      ),
      skipped: 'unusable',
    };
  }
  // Version 0 is a file without a schema (a process stopped between creating it and setting it
  // up): there is nothing to upgrade, the store sets it up like a database that is not there.
  if (found !== null && found >= 1 && found < latest) {
    return {
      item: item(
        { name: 'database', status: 'info', detail: `schema v${found} (expected v${latest})` },
        'Setup',
        `The database is in an older format v${found}; it is upgraded to v${latest} the next time Mindly runs`,
      ),
      skipped: 'older',
    };
  }
  // Up to date, or not set up yet (the store creates it).
  try {
    const store = Store.open(dbPath, { busyTimeoutMs: 2000 });
    try {
      const v = schemaVersion(store.db);
      return {
        item: item(
          { name: 'database', status: 'ok', detail: `schema v${v}` },
          'Setup',
          'Database is up to date',
        ),
        skipped: null,
      };
    } finally {
      store.close();
    }
  } catch (err) {
    return failed(err);
  }
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
  for (const d of dirs) {
    const mode = modeIfThere(d);
    if (mode !== null && mode !== 0o700) loose.push(`${d} (dir)`);
  }
  const files = [
    paths.db,
    `${paths.db}-wal`,
    `${paths.db}-shm`,
    paths.config,
    paths.token,
    paths.daemonState,
  ];
  for (const f of entriesOf(paths.logs, 200)) files.push(join(paths.logs, f));
  for (const f of files) {
    const mode = modeIfThere(f, 'file');
    if (mode !== null && (mode & 0o077) !== 0) loose.push(f);
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
  // Set while the database is in a format this Mindly cannot work with as it is: the checks that
  // open the store are not run then, since opening it would upgrade or refuse it.
  let storeSkipped: StoreSkip | null = null;
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
      items.push(...notifyChannelChecks(paths));
      items.push(...permissionChecks(paths));
      items.push(...configChecks(paths));
      const database = databaseCheck(paths.db);
      items.push(database.item);
      storeSkipped = database.skipped;
    }
  }

  // The status line is optional, so it does not decide whether an agent counts as connected.
  const adapters = adaptersFor(env, { statusLine: false });
  const command = await installCommand(env);
  // Mindly may be installed user-wide or only for this project (`init --project`).
  let projectRoot: string | null;
  try {
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

  if (paths && existsSync(paths.home) && storeSkipped !== null) {
    items.push(...skippedStoreItems(storeSkipped));
  } else if (paths && existsSync(paths.home)) {
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
        ...skippedStoreItems('project'),
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
