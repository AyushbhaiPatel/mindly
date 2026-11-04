import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, InstallOptions } from '@mindly/core';
import { isMindlyError } from '@mindly/core';
import {
  applyInstallSteps,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createCursorAdapter,
  createGeminiAdapter,
  createMcpClientAdapter,
  MCP_CLIENTS,
  readOnlyTarget,
} from '../src/index.js';
import { tempDir as rawTempDir } from './helpers.js';

const tempDir = () => realpathSync(rawTempDir());

const COMMAND = ['/opt/mindly/bin/mindly'];
const claude = createClaudeCodeAdapter({ env: {} });

function opts(home: string, projectRoot: string | null = null): InstallOptions {
  return { command: COMMAND, homeDir: home, projectRoot };
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

function isLink(path: string): boolean {
  return lstatSync(path).isSymbolicLink();
}

function adaptersFor(home: string): AgentAdapter[] {
  return [
    claude,
    createCodexAdapter({ env: {} }),
    createCursorAdapter({ env: {} }),
    createGeminiAdapter({ env: {} }),
    ...MCP_CLIENTS.map((spec) =>
      createMcpClientAdapter(spec, { homeDir: home, env: { PATH: '' }, platform: 'linux' }),
    ),
  ];
}

describe.skipIf(process.platform === 'win32')('symlinked config files', () => {
  it('writes through a chain of links and keeps every link (install and uninstall)', async () => {
    const home = tempDir();
    const dotfiles = tempDir();
    const real = join(dotfiles, 'claude', 'settings.json');
    const middle = join(dotfiles, 'current-settings.json');
    const settings = join(home, '.claude', 'settings.json');
    write(real, JSON.stringify({ model: 'opus' }));
    link(join('claude', 'settings.json'), middle);
    link(middle, settings);
    chmodSync(real, 0o640);

    const applied = applyInstallSteps(await claude.planInstall(opts(home)));
    const step = applied.find((a) => a.file === settings);
    expect(step?.target).toBe(real);
    expect(step?.createdTarget).toBe(false);
    expect(readlinkSync(settings)).toBe(middle);
    expect(readlinkSync(middle)).toBe(join('claude', 'settings.json'));
    expect(isLink(settings) && isLink(middle) && !isLink(real)).toBe(true);
    const installed = readFileSync(real, 'utf8');
    expect(installed).toContain('hook claude-code SessionStart');
    expect(installed).toContain('"model": "opus"');
    expect(statSync(real).mode & 0o777).toBe(0o640);
    // The backup sits next to the path the agent reads; no temp files are left behind.
    expect(step?.backup).toMatch(/settings\.json\..*\.bak$/);
    expect(dirname(step?.backup ?? '')).toBe(join(home, '.claude'));
    expect(readdirSync(join(dotfiles, 'claude'))).toEqual(['settings.json']);

    applyInstallSteps(await claude.planUninstall(opts(home)));
    expect(isLink(settings) && isLink(middle)).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('creates the missing file a dangling link points to', async () => {
    const home = tempDir();
    const dotfiles = tempDir();
    const real = join(dotfiles, 'gemini', 'settings.json');
    const settings = join(home, '.gemini', 'settings.json');
    link(real, settings);

    const gemini = createGeminiAdapter({ env: {} });
    const applied = applyInstallSteps(await gemini.planInstall(opts(home)));
    expect(applied).toEqual([{ file: settings, backup: null, target: real, createdTarget: true }]);
    expect(isLink(settings)).toBe(true);
    expect(readFileSync(real, 'utf8')).toContain('hook gemini BeforeTool');
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });

  it('refuses a symlink loop', () => {
    const dir = tempDir();
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(() =>
      applyInstallSteps([{ file: a, description: 'x', content: '{}', previous: null }]),
    ).toThrowError(/symlink/);
    expect(isLink(a) && isLink(b)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses a read-only link target before writing anything, leaving no backup',
    async () => {
      const home = tempDir();
      const store = tempDir();
      const real = join(store, 'settings.json');
      const settings = join(home, '.claude', 'settings.json');
      write(real, '{}\n');
      link(real, settings);
      chmodSync(real, 0o444);
      chmodSync(store, 0o555);
      try {
        expect(readOnlyTarget(settings)).toBe(real);
        let error: unknown;
        try {
          applyInstallSteps(await claude.planInstall(opts(home)));
        } catch (err) {
          error = err;
        }
        expect(isMindlyError(error, 'forbidden')).toBe(true);
        expect((error as Error).message).toContain('read-only');
        expect(readFileSync(real, 'utf8')).toBe('{}\n');
        expect(readdirSync(join(home, '.claude'))).toEqual(['settings.json']);
        expect(existsSync(join(home, '.claude.json'))).toBe(false);
      } finally {
        chmodSync(store, 0o755);
      }
      expect(readOnlyTarget(join(home, '.claude.json'))).toBeNull();
    },
  );

  it('reports a symlink loop while planning', async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    const other = join(home, '.claude', 'other.json');
    link(other, settings);
    symlinkSync(settings, other);
    await expect(claude.planInstall(opts(home))).rejects.toThrowError(/is a symlink loop/);
  });

  it('keeps a project directory that links outside the project untouched', async () => {
    const home = tempDir();
    const project = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(project, '.claude'));
    const steps = await claude.planInstall(opts(home, project));
    let error: unknown;
    try {
      applyInstallSteps(steps, { projectRoot: project });
    } catch (err) {
      error = err;
    }
    expect(isMindlyError(error, 'path_outside_project')).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(project, '.mcp.json'))).toBe(false);
  });

  it('keeps project files that link outside the project untouched', async () => {
    const home = tempDir();
    const project = tempDir();
    const outside = join(tempDir(), 'mcp.json');
    write(outside, '{}');
    link(outside, join(project, '.mcp.json'));
    const steps = await claude.planInstall(opts(home, project));
    let error: unknown;
    try {
      applyInstallSteps(steps, { projectRoot: project });
    } catch (err) {
      error = err;
    }
    expect(isMindlyError(error, 'path_outside_project')).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('{}');
    expect(isLink(join(project, '.mcp.json'))).toBe(true);
  });

  it('writes project files that link inside the project', async () => {
    const home = tempDir();
    const project = tempDir();
    write(join(project, 'config', 'mcp.json'), '{}');
    link(join('config', 'mcp.json'), join(project, '.mcp.json'));
    applyInstallSteps(await claude.planInstall(opts(home, project)), { projectRoot: project });
    expect(isLink(join(project, '.mcp.json'))).toBe(true);
    expect(readFileSync(join(project, 'config', 'mcp.json'), 'utf8')).toContain('mindly');
  });

  it('keeps links for every adapter across install, uninstall and reinstall', async () => {
    const home = tempDir();
    const dotfiles = tempDir();
    const all = adaptersFor(home);
    for (const adapter of all) applyInstallSteps(await adapter.planInstall(opts(home)));

    // Move every written config into a dotfiles folder and link it back, the way stow does.
    const links = new Map<string, string>();
    for (const [i, adapter] of all.entries()) {
      for (const step of await adapter.planUninstall(opts(home))) {
        if (links.has(step.file)) continue;
        const real = join(dotfiles, String(i), String(links.size));
        mkdirSync(dirname(real), { recursive: true });
        renameSync(step.file, real);
        symlinkSync(real, step.file);
        links.set(step.file, real);
      }
    }
    expect(links.size).toBeGreaterThan(all.length);

    for (const adapter of all) applyInstallSteps(await adapter.planUninstall(opts(home)));
    for (const [file, real] of links) {
      expect(readlinkSync(file)).toBe(real);
      expect(readFileSync(real, 'utf8')).not.toContain('mcp --agent');
    }
    for (const adapter of all) applyInstallSteps(await adapter.planInstall(opts(home)));
    for (const [file, real] of links) {
      expect(readlinkSync(file)).toBe(real);
      expect(existsSync(real)).toBe(true);
    }
    for (const adapter of all) expect(await adapter.planInstall(opts(home))).toEqual([]);
  });
});
