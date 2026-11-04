import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstallOptions } from '@mindly/core';
import {
  applyInstallSteps,
  chainedStatusLineScript,
  createClaudeCodeAdapter,
  effectiveStatusLine,
  isMindlyStatusLineCommand,
  planStatusLineInstall,
  statusLineCommand,
  statusLineLauncherExists,
} from '../src/index.js';
import { tempDir } from './helpers.js';

const COMMAND = ['/opt/my tools/mindly', '--profile', "it's"];
const claude = createClaudeCodeAdapter({ env: {} });

function opts(home: string, command = COMMAND, projectRoot: string | null = null): InstallOptions {
  return { command, homeDir: home, projectRoot };
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function settingsOf(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function installStatusLine(o: InstallOptions) {
  const plan = await planStatusLineInstall(o);
  applyInstallSteps(plan.steps);
  return plan;
}

describe('isMindlyStatusLineCommand', () => {
  it('recognises only bare Mindly invocations', () => {
    expect(isMindlyStatusLineCommand('mindly statusline')).toBe(true);
    expect(isMindlyStatusLineCommand('/usr/local/bin/mindly statusline')).toBe(true);
    expect(
      isMindlyStatusLineCommand('/usr/bin/node /x/node_modules/mindly-cli/dist/main.js statusline'),
    ).toBe(true);
    expect(
      isMindlyStatusLineCommand("'/n o/node' '/src/mindly/apps/cli/dist/main.js' statusline"),
    ).toBe(true);
    expect(isMindlyStatusLineCommand(statusLineCommand(COMMAND), COMMAND)).toBe(true);

    expect(isMindlyStatusLineCommand(statusLineCommand(COMMAND))).toBe(false);
    expect(isMindlyStatusLineCommand('~/.claude/statusline.sh')).toBe(false);
    expect(isMindlyStatusLineCommand('npx ccstatusline')).toBe(false);
    expect(isMindlyStatusLineCommand('other statusline')).toBe(false);
    expect(isMindlyStatusLineCommand('node /x/app/dist/main.js statusline')).toBe(false);
    expect(isMindlyStatusLineCommand('~/s.sh; mindly statusline')).toBe(false);
    expect(isMindlyStatusLineCommand('mine.sh && mindly statusline')).toBe(false);
    expect(isMindlyStatusLineCommand('echo "$(mindly statusline)"')).toBe(false);
    expect(isMindlyStatusLineCommand('mindly statusline --extra')).toBe(false);
    expect(isMindlyStatusLineCommand(42)).toBe(false);
  });
});

describe('claude-code status line install', () => {
  it('adds the status line, keeps every other key and is idempotent', async () => {
    const home = tempDir();
    const file = join(home, '.claude', 'settings.json');
    write(file, JSON.stringify({ model: 'opus', env: { A: '1' }, hooks: { Stop: [] } }));
    const first = await installStatusLine(opts(home));
    expect(first.state).toEqual({ kind: 'none' });
    expect(first.steps).toHaveLength(1);
    expect(first.file).toBe(file);
    expect(settingsOf(home)).toEqual({
      model: 'opus',
      env: { A: '1' },
      hooks: { Stop: [] },
      statusLine: { type: 'command', command: statusLineCommand(COMMAND) },
    });
    const written = readFileSync(file, 'utf8');

    const again = await planStatusLineInstall(opts(home));
    expect(again.state).toEqual({
      kind: 'mindly',
      command: statusLineCommand(COMMAND),
      current: true,
    });
    expect(again.steps).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(written);
  });

  it('creates settings.json when missing, in the project with projectRoot', async () => {
    const home = tempDir();
    const project = tempDir();
    await installStatusLine(opts(home, COMMAND, project));
    const settings = JSON.parse(
      readFileSync(join(project, '.claude', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(settings['statusLine']).toEqual({
      type: 'command',
      command: statusLineCommand(COMMAND),
    });
  });

  it('never replaces a status line the user configured', async () => {
    const home = tempDir();
    const file = join(home, '.claude', 'settings.json');
    const original = JSON.stringify({
      statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 2 },
    });
    write(file, original);
    const plan = await installStatusLine(opts(home));
    expect(plan.state).toEqual({ kind: 'foreign', command: '~/.claude/statusline.sh' });
    expect(plan.steps).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(original);

    const steps = await claude.planUninstall(opts(home));
    expect(steps).toEqual([]);
  });

  it('points an older Mindly status line at the current command and keeps padding', async () => {
    const home = tempDir();
    write(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'mindly statusline', padding: 1 } }),
    );
    const plan = await installStatusLine(opts(home));
    expect(plan.state).toEqual({ kind: 'mindly', command: 'mindly statusline', current: false });
    expect(settingsOf(home)['statusLine']).toEqual({
      type: 'command',
      command: statusLineCommand(COMMAND),
      padding: 1,
    });
  });

  it('uninstall removes only the status line Mindly installed', async () => {
    const home = tempDir();
    write(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    applyInstallSteps(await claude.planInstall(opts(home)));
    await installStatusLine(opts(home));
    applyInstallSteps(await claude.planUninstall(opts(home)));
    expect(settingsOf(home)).toEqual({ model: 'opus' });

    write(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'mindly statusline' } }),
    );
    applyInstallSteps(await claude.planUninstall(opts(home)));
    expect(settingsOf(home)).toEqual({});
  });

  it('refuses settings.json that is not valid JSON', async () => {
    const home = tempDir();
    write(join(home, '.claude', 'settings.json'), '{ nope');
    await expect(planStatusLineInstall(opts(home))).rejects.toThrow(/not valid JSON/);
  });
});

describe('claude-code status line state', () => {
  it('reports the effective status line, project settings first', async () => {
    const home = tempDir();
    const project = tempDir();
    expect(await effectiveStatusLine({ homeDir: home, projectRoot: project })).toEqual({
      file: null,
      state: { kind: 'none' },
    });
    await installStatusLine(opts(home));
    expect(
      (await effectiveStatusLine({ homeDir: home, projectRoot: project, command: COMMAND })).state,
    ).toMatchObject({ kind: 'mindly', current: true });
    const local = join(project, '.claude', 'settings.local.json');
    write(local, JSON.stringify({ statusLine: { type: 'command', command: 'starship-claude' } }));
    expect(await effectiveStatusLine({ homeDir: home, projectRoot: project })).toEqual({
      file: local,
      state: { kind: 'foreign', command: 'starship-claude' },
    });
  });

  it('checks that the launcher still exists', async () => {
    const dir = tempDir();
    const bin = join(dir, 'mindly');
    write(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    const script = join(dir, 'mindly-cli', 'dist', 'main.js');
    write(script, '');
    expect(await statusLineLauncherExists(bin + ' statusline', {})).toBe(true);
    expect(await statusLineLauncherExists('mindly statusline', { PATH: dir })).toBe(true);
    expect(await statusLineLauncherExists('mindly statusline', { PATH: tempDir() })).toBe(false);
    expect(await statusLineLauncherExists(join(dir, 'gone') + ' statusline', {})).toBe(false);
    expect(await statusLineLauncherExists(bin + ' ' + script + ' statusline', {})).toBe(true);
    expect(await statusLineLauncherExists(bin + ' ' + join(dir, 'x.js') + ' statusline', {})).toBe(
      false,
    );
  });

  it('writes a wrapper that chains an existing status line with Mindly', () => {
    const script = chainedStatusLineScript("jq -r '.model.display_name'", ['mindly']);
    expect(script).toBe(
      [
        '#!/bin/sh',
        '# Claude Code status line: your own line, then Mindly.',
        'input=$(cat)',
        "printf '%s' \"$input\" | sh -c 'jq -r '\\''.model.display_name'\\'''",
        'printf \'%s\' "$input" | mindly statusline',
        '',
      ].join('\n'),
    );
  });
});
