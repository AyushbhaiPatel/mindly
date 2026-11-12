import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
      join(tmpdir(), 'dlx-12345', 'node_modules', 'mindly-cli', 'dist', 'main.js'),
      '/tmp/dlx-12345/node_modules/mindly-cli/dist/main.js',
      '/tmp/xfs-1a2b3c4d/dlx-4242/node_modules/mindly-cli/dist/main.js',
      '/tmp/bunx-501-mindly-cli@latest/node_modules/mindly-cli/dist/main.js',
      '/home/a/.bun/install/cache/mindly-cli@0.5.0/dist/main.js',
      // yarn 4 dlx with its default PnP linker runs the package from its zip in yarn's cache.
      '/home/a/.yarn/berry/cache/mindly-cli-npm-0.5.0-3f2a1b9c8d-10c0.zip/node_modules/mindly-cli/dist/main.js',
      '/home/a/project/.yarn/cache/mindly-cli-npm-0.5.0-3f2a1b9c8d-10c0.zip/node_modules/mindly-cli/dist/main.js',
      '/somewhere/archive.ZIP/node_modules/mindly-cli/dist/main.js',
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
      '/home/a/code/dlx-2024/node_modules/mindly-cli/dist/main.js',
      '/home/a/src/bunx-demo/node_modules/mindly-cli/dist/main.js',
      'C:\\Users\\dlx\\AppData\\Roaming\\npm\\node_modules\\mindly-cli\\dist\\main.js',
      '/home/a/_npx/notes/node_modules/mindly-cli/dist/main.js',
      '/home/a/zips/node_modules/mindly-cli/dist/main.js',
    ]) {
      expect(inRunnerCache(path), path).toBe(false);
    }
  });

  it('checks the path as given and once links are resolved', () => {
    const base = realpathSync(tempDir('mindly-real-'));
    // A link from an ordinary folder into a cache.
    const cached = join(base, '_npx', '826d5fe126bc685d', 'node_modules', 'mindly-cli', 'main.js');
    file(cached, '');
    const linkedIn = join(base, 'bin', 'mindly');
    mkdirSync(dirname(linkedIn), { recursive: true });
    symlinkSync(cached, linkedIn);
    expect(inRunnerCache(linkedIn)).toBe(true);
    // pnpm with a global virtual store: the dlx folder links into the store's `links`, so only
    // the path as given shows the cache.
    const store = join(base, 'store', 'v10', 'links', 'mindly-cli', '0.5.0', 'abc', 'node_modules');
    file(join(store, 'mindly-cli', 'dist', 'main.js'), '');
    const dlx = join(base, 'dlx', 'hfz5kqp2gqeoeyvztqv4ws2fji', '19a1b2c3d4e-1f2a', 'node_modules');
    mkdirSync(dlx, { recursive: true });
    symlinkSync(join(store, 'mindly-cli'), join(dlx, 'mindly-cli'));
    const viaDlx = join(dlx, 'mindly-cli', 'dist', 'main.js');
    expect(inRunnerCache(viaDlx)).toBe(true);
    expect(inRunnerCache(realpathSync(viaDlx))).toBe(false);
  });

  it('refuses to connect agents from one, with the command that installs Mindly for good', () => {
    const entry = '/home/a/.npm/_npx/826d5fe126bc685d/node_modules/mindly-cli/dist/main.js';
    const refusal = runnerCacheRefusal([entry]);
    expect(refusal).toMatch(/temporary package cache/);
    expect(refusal).toContain('npm i -g mindly-cli && mindly init');
    expect(refusal).not.toContain('\n');
    // The script Node was started with counts too (pnpm's global virtual store).
    expect(runnerCacheRefusal(['/usr/local/lib/node_modules/mindly-cli/dist/main.js', entry])).toBe(
      refusal,
    );
    expect(runnerCacheRefusal(['/usr/local/lib/node_modules/mindly-cli/dist/main.js'])).toBe(null);
  });

  it('refuses an entry that is not a file Node can start, when it must exist', () => {
    const base = realpathSync(tempDir('mindly-entry-'));
    const entry = join(base, 'lib', 'node_modules', 'mindly-cli', 'dist', 'main.js');
    file(entry, '');
    expect(runnerCacheRefusal([entry], true)).toBe(null);
    const zip = join(base, 'pkg.bin');
    file(zip, 'not a folder');
    for (const missing of [join(base, 'nowhere', 'main.js'), join(zip, 'dist', 'main.js')]) {
      const refusal = runnerCacheRefusal([missing], true);
      expect(refusal, missing).toContain('not a file Node can start');
      expect(refusal).toContain('npm i -g mindly-cli && mindly init');
      // A monorepo checkout that is not built yet is not refused.
      expect(runnerCacheRefusal([missing], false)).toBe(null);
    }
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
