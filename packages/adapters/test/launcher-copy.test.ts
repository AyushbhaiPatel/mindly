import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstallSteps, createClaudeCodeAdapter, isMindlyStatusLine } from '../src/index.js';
import { tempDir } from './helpers.js';

const claude = createClaudeCodeAdapter({ env: {} });

/** What `npx mindly-cli init` records: Node running the launcher in the Mindly home. */
const launched = (node = '/usr/local/bin/node'): string[] => [
  node,
  '/home/a/.mindly/bin/mindly.cjs',
];

function settingsIn(home: string): string {
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, '{}');
  return settings;
}

interface Written {
  statusLine?: { command: string };
  hooks: Record<string, { hooks: { command: string }[] }[]>;
}

describe('the launcher kept by npx init', () => {
  it("has a status line any later install recognises as Mindly's", () => {
    const line = (command: string) => ({ type: 'command', command });
    expect(
      isMindlyStatusLine(line('/usr/local/bin/node /home/a/.mindly/bin/mindly.cjs statusline'), [
        '/usr/local/bin/mindly',
      ]),
    ).toBe(true);
    expect(isMindlyStatusLine(line('node /home/a/tools/bin/other.cjs statusline'))).toBe(false);
    expect(isMindlyStatusLine(line('node /home/a/.mindly/bin/mindly.cjs statusline | x'))).toBe(
      false,
    );
  });

  it('a later init from a global install replaces its hooks and status line', async () => {
    const home = tempDir();
    const settings = settingsIn(home);
    for (const command of [launched(), ['/usr/local/bin/mindly']]) {
      applyInstallSteps(await claude.planInstall({ command, homeDir: home, projectRoot: null }));
    }
    const written = JSON.parse(readFileSync(settings, 'utf8')) as Written;
    expect(JSON.stringify(written)).not.toContain('mindly.cjs');
    expect(written.statusLine?.command).toBe('/usr/local/bin/mindly statusline');
    expect(written.hooks['Stop']).toHaveLength(1);
  });

  it('init with another Node updates the status line along with the hooks', async () => {
    const home = tempDir();
    const settings = settingsIn(home);
    for (const node of [
      '/home/a/.nvm/versions/node/v22.11.0/bin/node',
      '/home/a/.nvm/versions/node/v22.12.0/bin/node',
    ]) {
      applyInstallSteps(
        await claude.planInstall({ command: launched(node), homeDir: home, projectRoot: null }),
      );
    }
    const written = JSON.parse(readFileSync(settings, 'utf8')) as Written;
    expect(written.statusLine?.command).toContain('v22.12.0');
    expect(JSON.stringify(written)).not.toContain('v22.11.0');
    expect(written.hooks['Stop']).toHaveLength(1);
  });

  it('uninstall from a global install removes its hooks and status line', async () => {
    const home = tempDir();
    const settings = settingsIn(home);
    applyInstallSteps(
      await claude.planInstall({ command: launched(), homeDir: home, projectRoot: null }),
    );
    applyInstallSteps(
      await claude.planUninstall({
        command: ['/usr/local/bin/mindly'],
        homeDir: home,
        projectRoot: null,
      }),
    );
    expect(readFileSync(settings, 'utf8')).not.toContain('mindly');
  });
});
