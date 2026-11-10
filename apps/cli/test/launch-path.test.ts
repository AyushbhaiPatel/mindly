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
  it('knows the caches of package runners', () => {
    expect(inRunnerCache('/home/a/.npm/_npx/826d5fe126bc685d/node_modules/.bin/mindly')).toBe(true);
    expect(
      inRunnerCache('C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1f\\node_modules\\x'),
    ).toBe(true);
    expect(inRunnerCache('/home/a/.cache/pnpm/dlx/abc123/node_modules/.bin/mindly')).toBe(true);
    expect(inRunnerCache('/home/a/.bun/install/cache/mindly-cli@0.5.0/dist/main.js')).toBe(true);
    expect(inRunnerCache('/tmp/bunx-501-mindly-cli@latest/node_modules/x')).toBe(true);
    expect(inRunnerCache('/usr/local/lib/node_modules/mindly-cli/dist/main.js')).toBe(false);
    expect(inRunnerCache('/home/a/project/node_modules/mindly-cli/dist/main.js')).toBe(false);
    expect(inRunnerCache('/home/a/src/dlxtools/apps/cli/dist/main.js')).toBe(false);
  });

  it('refuses to connect agents from one, with the command that installs Mindly for good', () => {
    const refusal = runnerCacheRefusal('/home/a/.npm/_npx/1f/node_modules/mindly-cli/dist/main.js');
    expect(refusal).toMatch(/temporary package cache/);
    expect(refusal).toContain('npm i -g mindly-cli && mindly init');
    expect(refusal).not.toContain('\n');
    expect(runnerCacheRefusal('/usr/local/lib/node_modules/mindly-cli/dist/main.js')).toBe(null);
  });
});

describe('the command recorded by init', () => {
  it('from an installed package is Node running that package', async () => {
    const command = await installCommand({ PATH: '' });
    expect(command[0]).toBe(stableNode({ PATH: '' }));
    expect(realpathSync(command[0] as string)).toBe(realpathSync(process.execPath));
    expect(inRunnerCache(command[1] as string)).toBe(false);
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
