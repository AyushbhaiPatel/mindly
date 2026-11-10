import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MINDLY_VERSION } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { inRunnerCache, installCommand } from '../src/commands/setup.js';
import {
  SUPPORTED_NODE,
  failsOpen,
  loadSqliteWithFts5,
  nodeProblem,
  nodeVersionSupported,
} from '../src/node-check.js';
import { tempDir } from './helpers.js';

const loads = (): Promise<unknown> => Promise.resolve({});
const missing = (): Promise<unknown> => Promise.reject(new Error('No such built-in module'));

describe('supported Node versions', () => {
  it('follows the range in engines: 22.16+ on 22, no 23, any later major', () => {
    expect(SUPPORTED_NODE).toBe('^22.16.0 || >=24.0.0');
    for (const v of ['v22.16.0', 'v22.23.4', 'v24.0.0', 'v25.0.0', 'v26.1.0']) {
      expect(nodeVersionSupported(v), v).toBe(true);
    }
    for (const v of [
      'v20.18.0',
      'v22.0.0',
      'v22.13.0',
      'v22.15.1',
      'v23.4.0',
      'v23.11.1',
      'v18.20.4',
      'junk',
    ]) {
      expect(nodeVersionSupported(v), v).toBe(false);
    }
  });

  it('matches engines in the CLI and workspace package.json', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    for (const file of [join(root, 'package.json'), join(root, 'apps', 'cli', 'package.json')]) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { engines?: { node?: string } };
      expect(pkg.engines?.node, file).toBe(SUPPORTED_NODE);
    }
  });

  it('names the version it found, before anything loads SQLite', async () => {
    let tried = false;
    const problem = await nodeProblem(['doctor'], {
      version: 'v22.13.0',
      loadSqlite: () => {
        tried = true;
        return loads();
      },
    });
    expect(problem).toBe(
      'Mindly needs Node.js 22.16 or newer on the 22 line, or 24 or newer; this is v22.13.0.',
    );
    expect(tried).toBe(false);
  });

  it('refuses a supported version that does not provide node:sqlite', async () => {
    const problem = await nodeProblem(['init'], { version: 'v22.20.0', loadSqlite: missing });
    expect(problem).toMatch(
      /built-in SQLite and full-text search \(FTS5\); this Node \(v22\.20\.0\)/,
    );
  });

  it('refuses a SQLite without FTS5', async () => {
    const noFts5 = (): Promise<unknown> => Promise.reject(new Error('no such module: fts5'));
    const problem = await nodeProblem(['search', 'x'], { version: 'v24.1.0', loadSqlite: noFts5 });
    expect(problem).toMatch(/^Mindly needs Node\.js 22\.16 .*FTS5.*v24\.1\.0/);
  });

  it('finds FTS5 in the SQLite of the Node running the tests', async () => {
    await expect(loadSqliteWithFts5()).resolves.toBeUndefined();
  });

  it('lets version and help through on any Node, and passes a supported one', async () => {
    for (const argv of [
      [],
      ['--version'],
      ['-v'],
      ['--help'],
      ['-h'],
      ['help'],
      ['help', 'init'],
    ]) {
      expect(
        await nodeProblem(argv, { version: 'v18.0.0', loadSqlite: missing }),
        argv.join(' '),
      ).toBe(null);
    }
    expect(await nodeProblem(['doctor'], { version: 'v24.1.0', loadSqlite: loads })).toBe(null);
  });

  it('keeps agent-run commands quiet', () => {
    expect(failsOpen(['hook', 'claude-code', 'Stop'])).toBe(true);
    expect(failsOpen(['statusline'])).toBe(true);
    expect(failsOpen(['doctor'])).toBe(false);
    expect(failsOpen(['mcp', '--agent', 'cursor'])).toBe(false);
  });
});

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

  it('asks npx for this exact version when Mindly runs from the npx cache', async () => {
    const root = tempDir('mindly-npx-');
    const modules = join(root, '_npx', '826d5fe126bc685d', 'node_modules');
    const bin = join(modules, '.bin');
    const dist = join(modules, 'mindly-cli', 'dist');
    mkdirSync(bin, { recursive: true });
    mkdirSync(dist, { recursive: true });
    const target = join(dist, 'main.js');
    writeFileSync(target, '', { mode: 0o755 });
    symlinkSync(target, join(bin, 'mindly'));
    const argv1 = process.argv[1];
    process.argv[1] = join(bin, 'mindly');
    try {
      expect(await installCommand({ PATH: bin })).toEqual([
        'npx',
        '--yes',
        `mindly-cli@${MINDLY_VERSION}`,
      ]);
    } finally {
      if (argv1 !== undefined) process.argv[1] = argv1;
    }
  });

  it('keeps an installed launcher as it is', async () => {
    const command = await installCommand({ PATH: '' });
    expect(command[0]).toBe(process.execPath);
    expect(inRunnerCache(command[1] as string)).toBe(false);
  });
});

const BUILT_MAIN = join(import.meta.dirname, '..', 'dist', 'main.js');

describe.skipIf(!existsSync(BUILT_MAIN))('built binary', () => {
  it('stops quietly when its reader goes away', async () => {
    const child = spawn(process.execPath, [BUILT_MAIN, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/EPIPE|Error/);
  });

  it('prints one line and fails on a Node without node:sqlite; hooks stay quiet', () => {
    const cmd = spawnSync(process.execPath, ['--no-experimental-sqlite', BUILT_MAIN, 'doctor'], {
      encoding: 'utf8',
    });
    expect(cmd.status).toBe(1);
    expect(cmd.stderr.trim()).toMatch(/^Mindly needs Node\.js 22\.16 or newer .*built-in SQLite/);
    expect(cmd.stderr.trim().split('\n')).toHaveLength(1);
    const hook = spawnSync(
      process.execPath,
      ['--no-experimental-sqlite', BUILT_MAIN, 'hook', 'claude-code', 'Stop'],
      { encoding: 'utf8', input: '{}' },
    );
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe('');
    expect(hook.stderr).toBe('');
    const version = spawnSync(
      process.execPath,
      ['--no-experimental-sqlite', BUILT_MAIN, '--version'],
      {
        encoding: 'utf8',
      },
    );
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(MINDLY_VERSION);
  });
});
