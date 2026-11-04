import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeError, homePaths, mindlyHome, type HomePaths } from '@mindly/core';
import { gitVersion, versionAtLeast } from '@mindly/git';
import { MIGRATIONS, schemaVersion, Store } from '@mindly/store';
import { withProject } from '../context.js';
import { clean, type Out } from '../util.js';
import { runningDaemon } from './daemon.js';
import { adaptersFor, installCommand, SUPPORTED_AGENTS, userHome } from './setup.js';

/** Result of one doctor check. */
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

function permissionChecks(paths: HomePaths): Check[] {
  if (process.platform === 'win32') {
    return [{ name: 'permissions', status: 'info', detail: 'not checked on Windows' }];
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
  return [
    loose.length === 0
      ? { name: 'permissions', status: 'ok', detail: 'home is 0700, files are owner-only' }
      : {
          name: 'permissions',
          status: 'fail',
          detail: `readable by others: ${loose.slice(0, 5).join(', ')}${loose.length > 5 ? ', ...' : ''} (chmod 700 directories, 600 files)`,
        },
  ];
}

/** Runs every check. Never prints or returns secrets (only paths, versions and states). */
export async function runChecks(out: Out): Promise<Check[]> {
  const env = out.io.env;
  const checks: Check[] = [];
  const node = process.versions.node;
  checks.push({
    name: 'node',
    status: atLeast(node, MIN_NODE) ? 'ok' : 'fail',
    detail: `v${node}${atLeast(node, MIN_NODE) ? '' : ` (need >= ${MIN_NODE.join('.')})`}`,
  });
  try {
    await import('node:sqlite');
    checks.push({ name: 'node:sqlite', status: 'ok', detail: 'available' });
  } catch {
    checks.push({ name: 'node:sqlite', status: 'fail', detail: 'not available in this Node.js' });
  }
  try {
    const v = await gitVersion();
    const ok = versionAtLeast(v, MIN_GIT[0], MIN_GIT[1]);
    checks.push({
      name: 'git',
      status: ok ? 'ok' : 'warn',
      detail: `${v.major}.${v.minor}.${v.patch}${ok ? '' : ` (shadow merge needs >= ${MIN_GIT.join('.')})`}`,
    });
  } catch {
    checks.push({ name: 'git', status: 'fail', detail: 'git was not found on PATH' });
  }

  let paths: HomePaths | null = null;
  try {
    paths = homePaths(mindlyHome(env));
  } catch (err) {
    checks.push({ name: 'home', status: 'fail', detail: describeError(err) });
  }
  if (paths) {
    if (!existsSync(paths.home)) {
      checks.push({
        name: 'home',
        status: 'fail',
        detail: `${paths.home} does not exist (run mindly init)`,
      });
    } else {
      checks.push({ name: 'home', status: 'ok', detail: paths.home });
      checks.push(...permissionChecks(paths));
      try {
        const store = Store.open(paths.db, { busyTimeoutMs: 2000 });
        try {
          const v = schemaVersion(store.db);
          checks.push({
            name: 'database',
            status: v === MIGRATIONS.length ? 'ok' : 'fail',
            detail: `schema v${v}${v === MIGRATIONS.length ? '' : ` (expected v${MIGRATIONS.length})`}`,
          });
        } finally {
          store.close();
        }
      } catch (err) {
        checks.push({ name: 'database', status: 'fail', detail: describeError(err) });
      }
    }
  }

  const adapters = adaptersFor(env);
  const command = await installCommand(env);
  // Mindly may be installed user-wide or only for this project (`init --project`).
  let projectRoot: string | null = null;
  try {
    const { findRepoRoot } = await import('@mindly/git');
    projectRoot = await findRepoRoot(out.io.cwd);
  } catch {
    projectRoot = null;
  }
  for (const kind of SUPPORTED_AGENTS) {
    const adapter = adapters[kind];
    try {
      const detected = await adapter.detect();
      const plan = (root: string | null) =>
        adapter.planInstall({ command, projectRoot: root, homeDir: userHome(env) });
      const userSteps = await plan(null);
      const projectSteps = projectRoot ? await plan(projectRoot) : null;
      if (userSteps.length === 0) {
        checks.push({ name: kind, status: 'ok', detail: 'hooks and MCP server configured' });
      } else if (projectSteps !== null && projectSteps.length === 0) {
        checks.push({
          name: kind,
          status: 'ok',
          detail: 'hooks and MCP server configured for this project',
        });
      } else if (detected) {
        checks.push({
          name: kind,
          status: 'warn',
          detail:
            'installed, but Mindly hooks/MCP are missing or point elsewhere (run mindly init)',
        });
      } else {
        checks.push({ name: kind, status: 'info', detail: 'not installed' });
      }
    } catch (err) {
      checks.push({ name: kind, status: 'warn', detail: describeError(err) });
    }
  }

  const daemon = await runningDaemon(env);
  checks.push({
    name: 'daemon',
    status: 'info',
    detail: daemon
      ? `running on 127.0.0.1:${daemon.port} (pid ${daemon.pid})`
      : 'not running (optional)',
  });

  if (paths && existsSync(paths.home)) {
    try {
      checks.push(
        await withProject(out.io, ({ project }) => {
          const name = clean(project.project.name, 80);
          if (project.configError) {
            return {
              name: 'project',
              status: 'warn',
              detail: `${name}: invalid .mindly/config.json`,
            } as Check;
          }
          if (project.configHash === null) {
            return { name: 'project', status: 'ok', detail: `${name}: no project config` } as Check;
          }
          return project.trusted
            ? ({ name: 'project', status: 'ok', detail: `${name}: config trusted` } as Check)
            : ({
                name: 'project',
                status: 'warn',
                detail: `${name}: config not trusted, its checks will not run (mindly trust)`,
              } as Check);
        }),
      );
    } catch (err) {
      checks.push({ name: 'project', status: 'warn', detail: describeError(err) });
    }
  }
  return checks;
}

/** `mindly doctor`. Exit code 1 when any check fails. */
export async function doctor(out: Out, o: { json?: boolean }): Promise<number> {
  const checks = await runChecks(out);
  const failed = checks.some((c) => c.status === 'fail');
  if (o.json) {
    out.json({ ok: !failed, checks });
    return failed ? 1 : 0;
  }
  const s = out.style;
  const tag: Record<Check['status'], string> = {
    ok: s.green('ok  '),
    warn: s.yellow('warn'),
    fail: s.red('FAIL'),
    info: s.dim('info'),
  };
  for (const c of checks) out.line(`${tag[c.status]}  ${c.name.padEnd(12)} ${c.detail}`);
  out.line();
  out.line(failed ? s.red('Some checks failed.') : s.green('Mindly looks healthy.'));
  return failed ? 1 : 0;
}
