import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { MINDLY_VERSION } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/setup.js';
import { copyDir, ensureCopy, inRunnerCache, runnerTree } from '../src/runner-copy.js';
import { cli, sandbox, tempDir } from './helpers.js';

function file(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A package that prints `ok <dep's answer>` when it can load its dependency. */
function cliPackage(dir: string): void {
  file(join(dir, 'package.json'), '{"name":"mindly-cli","type":"module"}');
  file(join(dir, 'dist', 'main.js'), "import dep from 'dep';\nconsole.log('ok', dep);\n");
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

function runs(entry: string): string {
  const r = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  return `${r.stdout.trim()}${r.stderr.trim()}`;
}

describe('the launcher recorded by init', () => {
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

  it('points agents at a copy in the Mindly home, never at npx or the cache', async () => {
    const entry = npxTree();
    const home = tempDir('mindly-home-');
    const command = await installCommand({ PATH: '', MINDLY_HOME: home }, entry);
    expect(command).toEqual([
      process.execPath,
      join(home, 'lib', MINDLY_VERSION, 'node_modules', 'mindly-cli', 'dist', 'main.js'),
    ]);
  });

  it('keeps an installed launcher as it is', async () => {
    const command = await installCommand({ PATH: '' });
    expect(command[0]).toBe(process.execPath);
    expect(inRunnerCache(command[1] as string)).toBe(false);
  });

  it('copies an npx tree that keeps working after the npx cache is cleared', async () => {
    const entry = npxTree();
    const tree = runnerTree(entry);
    expect(tree).not.toBe(null);
    const home = tempDir('mindly-home-');
    const copied = await ensureCopy(home, '0.5.0', tree!);
    expect(copied).toBe(
      join(home, 'lib', '0.5.0', 'node_modules', 'mindly-cli', 'dist', 'main.js'),
    );
    rmSync(dirname(tree!.root), { recursive: true, force: true });
    expect(runs(copied)).toBe('ok dep-1');
    const bin = join(home, 'lib', '0.5.0', 'node_modules', '.bin', 'mindly');
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(isAbsolute(readlinkSync(bin))).toBe(false);
    expect(readdirSync(join(home, 'lib'))).toEqual(['0.5.0']);
    // A second init reuses the copy.
    expect(await ensureCopy(home, '0.5.0', tree!)).toBe(copied);
  });

  it('copies a pnpm dlx tree with its links pointing inside the copy', async () => {
    const entry = pnpmTree();
    const tree = runnerTree(entry)!;
    expect(tree.entry).toBe(
      join('.pnpm', 'mindly-cli@0.5.0', 'node_modules', 'mindly-cli', 'dist', 'main.js'),
    );
    const home = tempDir('mindly-home-');
    const copied = await ensureCopy(home, '0.5.0', tree);
    rmSync(dirname(tree.root), { recursive: true, force: true });
    expect(runs(copied)).toBe('ok dep-1');
    expect(copied).toMatch(/[\\/]mindly-cli[\\/]dist[\\/]main\.js$/);
  });

  it('copies files behind a link that points outside the tree', async () => {
    const entry = npxTree();
    const tree = runnerTree(entry)!;
    const outside = join(tempDir('mindly-outside-'), 'dep');
    depPackage(outside);
    rmSync(join(tree.root, 'dep'), { recursive: true });
    symlinkSync(outside, join(tree.root, 'dep'));
    const home = tempDir('mindly-home-');
    const copied = await ensureCopy(home, '0.5.0', tree);
    rmSync(outside, { recursive: true });
    expect(runs(copied)).toBe('ok dep-1');
  });

  it('does not reuse a folder of the same version holding another layout', async () => {
    const home = tempDir('mindly-home-');
    const npx = runnerTree(npxTree())!;
    const dlx = runnerTree(pnpmTree())!;
    await ensureCopy(home, '0.5.0', npx);
    expect(copyDir(home, '0.5.0', dlx)).toBe(join(home, 'lib', '0.5.0-2'));
    const copied = await ensureCopy(home, '0.5.0', dlx);
    expect(runs(copied)).toBe('ok dep-1');
    expect(copyDir(home, '0.5.0', npx)).toBe(join(home, 'lib', '0.5.0'));
  });

  it('leaves nothing half-copied behind when the copy fails', async () => {
    const tree = runnerTree(npxTree())!;
    const home = tempDir('mindly-home-');
    await expect(
      ensureCopy(home, '0.5.0', { root: tree.root, entry: join('missing', 'main.js') }),
    ).rejects.toThrow();
    expect(readdirSync(join(home, 'lib'))).toEqual([]);
  });

  it('uninstall removes the copy along with the agent settings', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    file(join(sb.mindlyHome, 'lib', '0.5.0', 'node_modules', 'mindly-cli', 'package.json'), '{}');
    const dry = await cli(sb, ['uninstall', '--dry-run']);
    expect(dry.stdout).toContain(join(sb.mindlyHome, 'lib'));
    expect(existsSync(join(sb.mindlyHome, 'lib'))).toBe(true);
    const removed = await cli(sb, ['uninstall', '--yes']);
    expect(removed.code).toBe(0);
    expect(existsSync(join(sb.mindlyHome, 'lib'))).toBe(false);
    expect(existsSync(join(sb.mindlyHome, 'mindly.db'))).toBe(true);
  });

  it('a project-only or single-agent uninstall keeps the copy', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    expect((await cli(sb, ['init', '--yes'])).code).toBe(0);
    file(join(sb.mindlyHome, 'lib', '0.5.0', 'x'), '');
    expect((await cli(sb, ['uninstall', '--agents', 'claude-code', '--yes'])).code).toBe(0);
    expect(existsSync(join(sb.mindlyHome, 'lib'))).toBe(true);
  });
});
