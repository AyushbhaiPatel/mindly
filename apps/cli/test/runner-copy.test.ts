import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { applyInstallSteps, createClaudeCodeAdapter } from '@mindly/adapters';
import { describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/setup.js';
import {
  copyDir,
  ensureCopy,
  inRunnerCache,
  launcherPath,
  runnerTree,
  stableNode,
} from '../src/runner-copy.js';
import { cli, sandbox, tempDir } from './helpers.js';

function file(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A package that prints `ok <dep's answer>` when it can load its dependency. */
function cliPackage(dir: string): void {
  file(join(dir, 'package.json'), '{"name":"mindly-cli","type":"module"}');
  file(
    join(dir, 'dist', 'main.js'),
    "import dep from 'dep';\nconsole.log(['ok', dep, ...process.argv.slice(2)].join(' '));\n",
  );
}

function depPackage(dir: string): void {
  file(join(dir, 'package.json'), '{"name":"dep","type":"module","main":"index.js"}');
  file(join(dir, 'index.js'), "export default 'dep-1';\n");
}

/** A flat tree as `npx` leaves it: `_npx/<hash>/node_modules/{mindly-cli,dep,.bin}`. */
function npxTree(): string {
  const modules = join(realpathSync(tempDir('mindly-npx-')), '_npx', '826d5fe1', 'node_modules');
  cliPackage(join(modules, 'mindly-cli'));
  depPackage(join(modules, 'dep'));
  mkdirSync(join(modules, '.bin'));
  symlinkSync('../mindly-cli/dist/main.js', join(modules, '.bin', 'mindly'));
  return join(modules, 'mindly-cli', 'dist', 'main.js');
}

/** A tree as `pnpm dlx` leaves it: packages under `.pnpm`, linked to each other. */
function pnpmTree(): string {
  const modules = join(realpathSync(tempDir('mindly-dlx-')), 'dlx', 'ab12', 'node_modules');
  const store = join(modules, '.pnpm');
  const cliDir = join(store, 'mindly-cli@0.5.0', 'node_modules', 'mindly-cli');
  cliPackage(cliDir);
  depPackage(join(store, 'dep@1.0.0', 'node_modules', 'dep'));
  symlinkSync(
    '../../dep@1.0.0/node_modules/dep',
    join(store, 'mindly-cli@0.5.0', 'node_modules', 'dep'),
  );
  symlinkSync('.pnpm/mindly-cli@0.5.0/node_modules/mindly-cli', join(modules, 'mindly-cli'));
  return join(cliDir, 'dist', 'main.js');
}

function runs(entry: string, args: string[] = []): string {
  const r = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', input: '{}' });
  return `${r.stdout.trim()}${r.stderr.trim()}`;
}

/** Runs a recorded command string the way agents on macOS and Linux do: through `sh -c`. */
function sh(command: string, cwd: string): { code: number | null; out: string; err: string } {
  const r = spawnSync('/bin/sh', ['-c', command], { input: '{}', encoding: 'utf8', cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function launch(home: string, args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [launcherPath(home), ...args], {
    input: '{}',
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('package runner caches', () => {
  it('knows the caches of package runners', () => {
    expect(inRunnerCache('/home/a/.npm/_npx/826d5fe126bc685d/node_modules/.bin/mindly')).toBe(true);
    expect(
      inRunnerCache('C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1f\\node_modules\\x'),
    ).toBe(true);
    expect(inRunnerCache('/home/a/.cache/pnpm/dlx/abc123/node_modules/.bin/mindly')).toBe(true);
    expect(inRunnerCache('/home/a/.bun/install/cache/mindly-cli@0.5.0/dist/main.js')).toBe(true);
    expect(inRunnerCache('/usr/local/lib/node_modules/mindly-cli/dist/main.js')).toBe(false);
    expect(inRunnerCache('/home/a/project/node_modules/mindly-cli/dist/main.js')).toBe(false);
    expect(inRunnerCache('/home/a/src/dlxtools/apps/cli/dist/main.js')).toBe(false);
  });

  it("finds the runner's package tree, and none outside a runner's cache", () => {
    expect(runnerTree('/h/.npm/_npx/1f/node_modules/mindly-cli/dist/main.js')).toEqual({
      root: '/h/.npm/_npx/1f/node_modules',
      entry: join('mindly-cli', 'dist', 'main.js'),
    });
    expect(runnerTree('/h/.bun/install/cache/mindly-cli@0.5.0/dist/main.js')).toBe(null);
    expect(runnerTree('/usr/lib/node_modules/mindly-cli/dist/main.js')).toBe(null);
  });
});

describe('the command recorded by init', () => {
  it('from npx, or from the copy made from it, is Node running the launcher in the Mindly home', async () => {
    const home = tempDir('mindly-home-');
    const env = { PATH: '', MINDLY_HOME: home };
    const tree = runnerTree(npxTree())!;
    const expected = [stableNode(env), launcherPath(home)];
    expect(await installCommand(env, join(tree.root, tree.entry))).toEqual(expected);
    const copied = await ensureCopy(home, '0.5.0', tree);
    expect(await installCommand(env, copied)).toEqual(expected);
  });

  it('from an installed package is Node running that package', async () => {
    const command = await installCommand({ PATH: '' });
    expect(command[0]).toBe(stableNode({ PATH: '' }));
    expect(realpathSync(command[0] as string)).toBe(realpathSync(process.execPath));
    expect(inRunnerCache(command[1] as string)).toBe(false);
  });
});

describe('the copy kept in the Mindly home', () => {
  it('keeps working after the npx cache is cleared, through the launcher', async () => {
    const tree = runnerTree(npxTree())!;
    const home = tempDir('mindly-home-');
    const copied = await ensureCopy(home, '0.5.0', tree);
    expect(copied).toBe(
      join(home, 'lib', '0.5.0', 'node_modules', 'mindly-cli', 'dist', 'main.js'),
    );
    rmSync(dirname(tree.root), { recursive: true, force: true });
    expect(runs(copied)).toBe('ok dep-1');
    expect(launch(home, ['hook', 'claude-code', 'Stop']).out.trim()).toBe(
      'ok dep-1 hook claude-code Stop',
    );
    const bin = join(home, 'lib', '0.5.0', 'node_modules', '.bin', 'mindly');
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(isAbsolute(readlinkSync(bin))).toBe(false);
    expect(readdirSync(join(home, 'lib')).sort()).toEqual(['.mindly', '0.5.0', 'current']);
    // A second init reuses the copy.
    expect(await ensureCopy(home, '0.5.0', tree)).toBe(copied);
  });

  it('copies a pnpm dlx tree with its links pointing inside the copy', async () => {
    const tree = runnerTree(pnpmTree())!;
    expect(tree.entry).toBe(
      join('.pnpm', 'mindly-cli@0.5.0', 'node_modules', 'mindly-cli', 'dist', 'main.js'),
    );
    const home = tempDir('mindly-home-');
    const copied = await ensureCopy(home, '0.5.0', tree);
    rmSync(dirname(tree.root), { recursive: true, force: true });
    expect(runs(copied)).toBe('ok dep-1');
    expect(copied).toMatch(/[\\/]mindly-cli[\\/]dist[\\/]main\.js$/);
  });

  it('copies files behind a link that points outside the tree, and stops at link cycles', async () => {
    const tree = runnerTree(npxTree())!;
    const outside = join(tempDir('mindly-outside-'), 'dep');
    depPackage(outside);
    symlinkSync(outside, join(outside, 'self'));
    symlinkSync(dirname(outside), join(outside, 'parent'));
    rmSync(join(tree.root, 'dep'), { recursive: true });
    symlinkSync(outside, join(tree.root, 'dep'));
    const home = tempDir('mindly-home-');
    const copied = await ensureCopy(home, '0.5.0', tree);
    rmSync(dirname(outside), { recursive: true });
    expect(runs(copied)).toBe('ok dep-1');
  });

  it('gives the same version with another layout its own folder, and moves the launcher to it', async () => {
    const home = tempDir('mindly-home-');
    const npx = runnerTree(npxTree())!;
    const dlx = runnerTree(pnpmTree())!;
    await ensureCopy(home, '0.5.0', npx);
    expect(copyDir(home, '0.5.0', dlx)).toBe(join(home, 'lib', '0.5.0-2'));
    const copied = await ensureCopy(home, '0.5.0', dlx);
    expect(copied.startsWith(join(home, 'lib', '0.5.0-2'))).toBe(true);
    expect(runs(copied)).toBe('ok dep-1');
    expect(launch(home, ['x']).out.trim()).toBe('ok dep-1 x');
    expect(copyDir(home, '0.5.0', npx)).toBe(join(home, 'lib', '0.5.0'));
  });

  it('lets inits that race share a copy, also with different layouts', async () => {
    const home = tempDir('mindly-home-');
    const npx = runnerTree(npxTree())!;
    const got = await Promise.all([1, 2, 3, 4].map(() => ensureCopy(home, '0.5.0', npx)));
    expect(new Set(got).size).toBe(1);
    const other = tempDir('mindly-home-');
    const dlx = runnerTree(pnpmTree())!;
    const both = await Promise.all([
      ensureCopy(other, '0.5.0', npx),
      ensureCopy(other, '0.5.0', dlx),
      ensureCopy(other, '0.5.0', npx),
      ensureCopy(other, '0.5.0', dlx),
    ]);
    for (const entry of both) expect(runs(entry)).toBe('ok dep-1');
    expect(new Set(both).size).toBe(2);
    expect(readdirSync(join(other, 'lib')).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('leaves nothing half-copied behind when the copy fails', async () => {
    const tree = runnerTree(npxTree())!;
    const home = tempDir('mindly-home-');
    await expect(
      ensureCopy(home, '0.5.0', { root: tree.root, entry: join('missing', 'main.js') }),
    ).rejects.toThrow();
    expect(readdirSync(join(home, 'lib'))).toEqual([]);
  });
});

describe('the launcher', () => {
  it('ends hooks and the status line quietly when the copy is gone', async () => {
    const home = tempDir('mindly-home-');
    await ensureCopy(home, '0.5.0', runnerTree(npxTree())!);
    rmSync(join(home, 'lib', '0.5.0', 'node_modules', 'dep'), { recursive: true });
    for (const args of [['hook', 'claude-code', 'Stop'], ['statusline']]) {
      expect(launch(home, args)).toEqual({ code: 0, out: '', err: '' });
    }
    rmSync(join(home, 'lib'), { recursive: true });
    expect(launch(home, ['hook', 'codex', 'Stop'])).toEqual({ code: 0, out: '', err: '' });
    const doctor = launch(home, ['doctor']);
    expect(doctor.code).toBe(1);
    expect(doctor.err.trim().split('\n')).toHaveLength(1);
    expect(doctor.err).toMatch(/^Mindly could not start .*npx mindly-cli init/);
  });
});

describe('Node path', () => {
  function brew(): { root: string; keg: string; link: string } {
    const root = realpathSync(tempDir('mindly-brew-'));
    const keg = join(root, 'Cellar', 'node', '22.23.4', 'bin', 'node');
    file(keg, '#!/bin/sh\n');
    chmodSync(keg, 0o755);
    const link = join(root, 'bin', 'node');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(keg, link);
    return { root, keg, link };
  }

  it('prefers a stable path that resolves to the running Node over the versioned one', () => {
    const { keg, link } = brew();
    expect(stableNode({ PATH: '' }, keg, [link])).toBe(link);
    expect(stableNode({ PATH: dirname(link) }, keg, [])).toBe(link);
  });

  it('keeps the running path when no stable one leads to it', () => {
    const { keg, root } = brew();
    const other = join(root, 'other', 'node');
    file(other, '#!/bin/sh\n');
    chmodSync(other, 0o755);
    expect(stableNode({ PATH: dirname(other) }, keg, [])).toBe(keg);
    expect(stableNode({ PATH: dirname(keg) }, keg, [])).toBe(keg);
  });
});

describe('uninstall', () => {
  it('removes the copy, and hooks other projects still have end quietly', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    // `npx mindly-cli init --project` in this repo.
    const tree = runnerTree(npxTree())!;
    const env = { PATH: '', MINDLY_HOME: sb.mindlyHome };
    const command = await installCommand(env, join(tree.root, tree.entry));
    await ensureCopy(sb.mindlyHome, '0.5.0', tree);
    const claude = createClaudeCodeAdapter({ env: {} });
    applyInstallSteps(
      await claude.planInstall({ command, homeDir: sb.home, projectRoot: sb.repo }),
      { projectRoot: sb.repo },
    );
    const projectSettings = join(sb.repo, '.claude', 'settings.json');
    const stop = (
      JSON.parse(readFileSync(projectSettings, 'utf8')) as {
        hooks: { Stop: { hooks: { command: string }[] }[] };
      }
    ).hooks.Stop[0]!.hooks[0]!.command;
    expect(sh(stop, sb.repo).out.trim()).toBe('ok dep-1 hook claude-code Stop');

    // Then a user-wide install and a user-wide uninstall.
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    const dry = await cli(sb, ['uninstall', '--dry-run']);
    expect(dry.stdout).toContain(join(sb.mindlyHome, 'lib'));
    const removed = await cli(sb, ['uninstall', '--yes']);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain(launcherPath(sb.mindlyHome));
    expect(existsSync(join(sb.mindlyHome, 'lib'))).toBe(false);
    expect(existsSync(launcherPath(sb.mindlyHome))).toBe(true);
    expect(existsSync(join(sb.mindlyHome, 'mindly.db'))).toBe(true);
    expect(sh(stop, sb.repo)).toEqual({ code: 0, out: '', err: '' });
  });

  it('keeps a lib folder Mindly did not create, and a linked one', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    file(join(sb.mindlyHome, 'lib', 'python3', 'site.py'), '');
    expect((await cli(sb, ['uninstall', '--yes'])).stdout).not.toContain("Mindly's own copy");
    expect(existsSync(join(sb.mindlyHome, 'lib', 'python3', 'site.py'))).toBe(true);

    const sb2 = sandbox();
    mkdirSync(join(sb2.home, '.claude'));
    expect((await cli(sb2, ['init', '--yes'])).code).toBe(0);
    const outside = tempDir('mindly-outside-');
    file(join(outside, '.mindly'), '');
    file(join(outside, 'keep.txt'), 'x');
    symlinkSync(outside, join(sb2.mindlyHome, 'lib'));
    expect((await cli(sb2, ['uninstall', '--yes'])).code).toBe(0);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('keeps the copy when only one agent is disconnected', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    await ensureCopy(sb.mindlyHome, '0.5.0', runnerTree(npxTree())!);
    expect((await cli(sb, ['uninstall', '--agents', 'claude-code', '--yes'])).code).toBe(0);
    expect(existsSync(join(sb.mindlyHome, 'lib', '0.5.0'))).toBe(true);
  });
});
