import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCommand } from '../src/commands/setup.js';
import { inRunnerCache, runnerCacheRefusal, stableNode } from '../src/launch-path.js';
import { tempDir } from './helpers.js';

function file(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('package runner caches', () => {
  it('knows the caches of package runners by their layout', () => {
    for (const path of [
      '/home/a/.npm/_npx/826d5fe126bc685d/node_modules/.bin/mindly',
      'C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1f0e9a2b3c4d5e6f\\node_modules\\mindly-cli\\dist\\main.js',
      '/home/a/.cache/pnpm/dlx/hfz5kqp2gqeoeyvztqv4ws2fji/19a1b2c3d4e-1f2a/node_modules/.pnpm/mindly-cli@0.5.0/node_modules/mindly-cli/dist/main.js',
      '/tmp/dlx-12345/node_modules/mindly-cli/dist/main.js',
      '/tmp/xfs-1a2b3c4d/dlx-4242/node_modules/mindly-cli/dist/main.js',
      '/tmp/bunx-501-mindly-cli@latest/node_modules/mindly-cli/dist/main.js',
      '/home/a/.bun/install/cache/mindly-cli@0.5.0/dist/main.js',
    ]) {
      expect(inRunnerCache(path), path).toBe(true);
    }
  });

  it('does not mistake installs in folders named like a runner for its cache', () => {
    for (const path of [
      '/usr/local/lib/node_modules/mindly-cli/dist/main.js',
      '/home/a/project/node_modules/mindly-cli/dist/main.js',
      '/home/a/src/dlxtools/apps/cli/dist/main.js',
      '/home/dlx/.npm-global/lib/node_modules/mindly-cli/dist/main.js',
      '/home/a/code/dlx-tools/node_modules/mindly-cli/dist/main.js',
      '/home/a/src/bunx-demo/node_modules/mindly-cli/dist/main.js',
      'C:\\Users\\dlx\\AppData\\Roaming\\npm\\node_modules\\mindly-cli\\dist\\main.js',
      '/home/a/_npx/notes/node_modules/mindly-cli/dist/main.js',
    ]) {
      expect(inRunnerCache(path), path).toBe(false);
    }
  });

  it('decides on the real path, not a link to it', () => {
    const base = realpathSync(tempDir('mindly-real-'));
    const cached = join(base, '_npx', '826d5fe126bc685d', 'node_modules', 'mindly-cli', 'main.js');
    file(cached, '');
    const linkedIn = join(base, 'bin', 'mindly');
    mkdirSync(dirname(linkedIn), { recursive: true });
    symlinkSync(cached, linkedIn);
    expect(inRunnerCache(linkedIn)).toBe(true);
    const installed = join(base, 'lib', 'node_modules', 'mindly-cli', 'main.js');
    file(installed, '');
    const linkedOut = join(base, '_npx', 'aaaaaaaaaaaaaaaa', 'node_modules', 'mindly');
    mkdirSync(dirname(linkedOut), { recursive: true });
    symlinkSync(installed, linkedOut);
    expect(inRunnerCache(linkedOut)).toBe(false);
  });

  it('refuses to connect agents from one, with the command that installs Mindly for good', () => {
    const refusal = runnerCacheRefusal(
      '/home/a/.npm/_npx/826d5fe126bc685d/node_modules/mindly-cli/dist/main.js',
    );
    expect(refusal).toMatch(/temporary package cache/);
    expect(refusal).toContain('npm i -g mindly-cli && mindly init');
    expect(refusal).not.toContain('\n');
    expect(runnerCacheRefusal('/usr/local/lib/node_modules/mindly-cli/dist/main.js')).toBe(null);
  });
});

describe('the command recorded by init', () => {
  it('from an installed package is Node running that package', async () => {
    const command = await installCommand({ PATH: '' });
    expect(command[0]).toBe(stableNode());
    expect(realpathSync(command[0] as string)).toBe(realpathSync(process.execPath));
    expect(inRunnerCache(command[1] as string)).toBe(false);
  });

  it('is the same whatever PATH holds, so agents connected from another shell stay connected', async () => {
    // A `node` on PATH that leads to the running binary, as a version manager or a test harness
    // puts there.
    const dir = tempDir('mindly-path-node-');
    symlinkSync(process.execPath, join(dir, 'node'));
    expect(await installCommand({ PATH: dir })).toEqual(await installCommand({ PATH: '' }));
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
    expect(stableNode(keg, [link])).toBe(link);
  });

  it('keeps the running path when no stable one leads to it', () => {
    const { keg, root } = brew();
    const other = join(root, 'other', 'node');
    file(other, '#!/bin/sh\n');
    chmodSync(other, 0o755);
    expect(stableNode(keg, [other])).toBe(keg);
    expect(stableNode(keg, [])).toBe(keg);
  });
});
