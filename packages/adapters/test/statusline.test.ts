import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstallOptions } from '@mindly/core';
import {
  applyInstallSteps,
  createClaudeCodeAdapter,
  inspectClaudeCodeStatusLine,
  isMindlyStatusLine,
  parseClaudeCodeStatusLine,
} from '../src/index.js';
import { tempDir } from './helpers.js';

const COMMAND = ['/opt/my tools/mindly', '--profile', "it's"];
const claude = createClaudeCodeAdapter({ env: {} });
const OWN = { type: 'command', command: '~/.claude/statusline.sh', padding: 2 };

function opts(home: string, projectRoot: string | null = null): InstallOptions {
  return { command: COMMAND, homeDir: home, projectRoot };
}

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function statusLineOf(file: string): unknown {
  return (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)['statusLine'];
}

describe('isMindlyStatusLine', () => {
  it.each([
    ['mindly statusline', true],
    ["'/opt/my tools/mindly' --profile 'it'\\''s' statusline", true],
    ['/usr/bin/node /x/node_modules/mindly-cli/dist/main.js statusline', true],
    ['/usr/bin/node /src/repo/apps/cli/dist/main.js statusline', true],
    ['mindly statusline | tee x', false],
    ['~/.claude/statusline.sh', false],
    ['npx ccstatusline@latest', false],
    ['my-tool statusline', false],
    ['statusline', false],
  ])('%s -> %s', (command, expected) => {
    expect(isMindlyStatusLine({ type: 'command', command })).toBe(expected);
  });

  it('rejects non-objects', () => {
    expect(isMindlyStatusLine('mindly statusline')).toBe(false);
    expect(isMindlyStatusLine(null)).toBe(false);
  });
});

describe('parseClaudeCodeStatusLine', () => {
  it('prefers workspace.current_dir, then cwd, then workspace.project_dir', () => {
    expect(
      parseClaudeCodeStatusLine({
        session_id: 'abc',
        cwd: '/b',
        workspace: { current_dir: '/a', project_dir: '/c' },
      }),
    ).toEqual({ sessionId: 'abc', dir: '/a' });
    expect(parseClaudeCodeStatusLine({ cwd: '/b', workspace: { project_dir: '/c' } })).toEqual({
      sessionId: null,
      dir: '/b',
    });
    expect(parseClaudeCodeStatusLine({ workspace: { project_dir: '/c' } }).dir).toBe('/c');
  });

  it('never throws on junk', () => {
    for (const junk of [null, 42, 'x', [], { session_id: 5, cwd: {}, workspace: 'no' }]) {
      expect(parseClaudeCodeStatusLine(junk)).toEqual({ sessionId: null, dir: null });
    }
  });
});

describe('claude-code status line install', () => {
  it('adds the status line, refreshes it in place and removes it on uninstall', async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    const steps = await claude.planInstall(opts(home));
    expect(steps.find((s) => s.file === settings)?.description).toBe(
      'Register Mindly hooks and status line for Claude Code',
    );
    applyInstallSteps(steps);
    expect(statusLineOf(settings)).toEqual({
      type: 'command',
      command: `'/opt/my tools/mindly' --profile 'it'\\''s' statusline`,
      refreshInterval: 10,
    });
    expect(await inspectClaudeCodeStatusLine(home, null)).toMatchObject({
      owner: 'mindly',
      file: settings,
    });

    // A new launcher path (e.g. a Node upgrade) rewrites Mindly's own entry.
    applyInstallSteps(await claude.planInstall({ ...opts(home), command: ['/new/mindly'] }));
    expect(statusLineOf(settings)).toMatchObject({ command: '/new/mindly statusline' });

    applyInstallSteps(await claude.planUninstall(opts(home)));
    expect(statusLineOf(settings)).toBeUndefined();
  });

  it("never touches the user's own status line", async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    write(settings, { statusLine: OWN });
    const steps = await claude.planInstall(opts(home));
    expect(steps.find((s) => s.file === settings)?.description).toBe(
      'Register Mindly hooks for Claude Code',
    );
    applyInstallSteps(steps);
    expect(statusLineOf(settings)).toEqual(OWN);
    expect(await inspectClaudeCodeStatusLine(home, null)).toEqual({
      owner: 'other',
      file: settings,
      command: OWN.command,
    });
    applyInstallSteps(await claude.planUninstall(opts(home)));
    expect(statusLineOf(settings)).toEqual(OWN);
  });

  it("does not add a project status line that would hide the user's own", async () => {
    const home = tempDir();
    const project = tempDir();
    write(join(home, '.claude', 'settings.json'), { statusLine: OWN });
    applyInstallSteps(await claude.planInstall(opts(home, project)));
    expect(statusLineOf(join(project, '.claude', 'settings.json'))).toBeUndefined();
    expect(await inspectClaudeCodeStatusLine(home, project)).toMatchObject({ owner: 'other' });
  });

  it("does not add one where the project's local settings already define one", async () => {
    const home = tempDir();
    const project = tempDir();
    write(join(project, '.claude', 'settings.local.json'), { statusLine: OWN });
    applyInstallSteps(await claude.planInstall(opts(home, project)));
    expect(statusLineOf(join(project, '.claude', 'settings.json'))).toBeUndefined();
  });

  it('statusLine: false neither adds nor removes it, so connection checks ignore it', async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    const without = createClaudeCodeAdapter({ env: {}, statusLine: false });
    applyInstallSteps(await without.planInstall(opts(home)));
    expect(statusLineOf(settings)).toBeUndefined();
    applyInstallSteps(await claude.planInstall(opts(home)));
    expect(await without.planInstall(opts(home))).toEqual([]);
    expect(statusLineOf(settings)).toMatchObject({ type: 'command' });
  });
});
