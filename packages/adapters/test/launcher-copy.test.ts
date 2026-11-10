import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstallSteps, createClaudeCodeAdapter } from '../src/index.js';
import { tempDir } from './helpers.js';

const claude = createClaudeCodeAdapter({ env: {} });

/** What `npx mindly-cli@<version> init` records: Node running the copy in the Mindly home. */
const copied = (version: string): string[] => [
  '/usr/local/bin/node',
  `/home/a/.mindly/lib/${version}/node_modules/mindly-cli/dist/main.js`,
];

function settingsIn(home: string): string {
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, '{}');
  return settings;
}

describe('the launcher copy kept by npx init', () => {
  it('a later init from a global install replaces its hooks', async () => {
    const home = tempDir();
    const settings = settingsIn(home);
    for (const command of [copied('0.5.0'), ['/usr/local/bin/mindly']]) {
      applyInstallSteps(await claude.planInstall({ command, homeDir: home, projectRoot: null }));
    }
    const hooks = JSON.parse(readFileSync(settings, 'utf8')).hooks as Record<string, unknown[]>;
    expect(JSON.stringify(hooks)).not.toContain('/lib/0.5.0/');
    expect(hooks['Stop']).toHaveLength(1);
  });

  it('init from a newer version takes over the hooks and the status line', async () => {
    const home = tempDir();
    const settings = settingsIn(home);
    for (const v of ['0.5.0', '0.6.0']) {
      applyInstallSteps(
        await claude.planInstall({ command: copied(v), homeDir: home, projectRoot: null }),
      );
    }
    const written = JSON.parse(readFileSync(settings, 'utf8')) as {
      statusLine: { command: string };
      hooks: Record<string, unknown[]>;
    };
    expect(written.statusLine.command).toBe(`${copied('0.6.0').join(' ')} statusline`);
    expect(JSON.stringify(written.hooks)).not.toContain('/lib/0.5.0/');
    expect(written.hooks['Stop']).toHaveLength(1);
  });

  it('uninstall from a global install removes its hooks and status line', async () => {
    const home = tempDir();
    const settings = settingsIn(home);
    applyInstallSteps(
      await claude.planInstall({ command: copied('0.5.0'), homeDir: home, projectRoot: null }),
    );
    applyInstallSteps(
      await claude.planUninstall({
        command: ['/usr/local/bin/mindly'],
        homeDir: home,
        projectRoot: null,
      }),
    );
    expect(readFileSync(settings, 'utf8')).not.toContain('mindly-cli');
  });
});
