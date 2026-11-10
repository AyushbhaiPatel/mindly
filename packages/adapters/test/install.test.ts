import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, InstallOptions } from '@mindly/core';
import { isMindlyError } from '@mindly/core';
import {
  applyInstallSteps,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createCursorAdapter,
  getAdapter,
  adapters,
} from '../src/index.js';
import { must, tempDir } from './helpers.js';

const COMMAND = ['/opt/my tools/mindly', '--profile', "it's"];
const claude = createClaudeCodeAdapter({ env: {} });
const codex = createCodexAdapter({ env: {} });
const cursor = createCursorAdapter({ env: {} });

function opts(home: string, projectRoot: string | null = null): InstallOptions {
  return { command: COMMAND, homeDir: home, projectRoot };
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

async function install(adapter: AgentAdapter, o: InstallOptions) {
  const steps = await adapter.planInstall(o);
  applyInstallSteps(steps);
  return steps;
}

const USER_HOOK = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '/usr/local/bin/audit.sh' }],
};

describe('registry', () => {
  it('exposes every adapter', () => {
    expect(Object.keys(adapters).slice(0, 3)).toEqual(['claude-code', 'codex', 'cursor']);
    expect(getAdapter('codex')?.displayName).toBe('Codex');
    expect(getAdapter('toString')).toBeNull();
    expect(getAdapter('nope')).toBeNull();
  });
});

describe('claude-code install', () => {
  it('merges with existing hooks and MCP servers, and is idempotent', async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    const claudeJson = join(home, '.claude.json');
    write(settings, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [USER_HOOK] } }));
    write(claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));

    const steps = await install(claude, opts(home));
    expect(steps.map((s) => s.file).sort()).toEqual([claudeJson, settings].sort());
    expect(steps.find((s) => s.file === settings)?.previous).toContain('audit.sh');

    const s = readJson(settings);
    expect(s['model']).toBe('opus');
    const hooks = s['hooks'] as Record<string, unknown[]>;
    expect(hooks['PreToolUse']).toHaveLength(2);
    expect(hooks['PreToolUse']?.[0]).toEqual(USER_HOOK);
    expect(hooks['PreToolUse']?.[1]).toEqual({
      matcher: 'Edit|MultiEdit|Write|NotebookEdit|Bash',
      hooks: [
        {
          type: 'command',
          command: `'/opt/my tools/mindly' --profile 'it'\\''s' hook claude-code PreToolUse`,
          timeout: 10,
        },
      ],
    });
    expect(Object.keys(hooks).sort()).toEqual(
      [
        'PostToolUse',
        'PostToolUseFailure',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );

    const c = readJson(claudeJson);
    expect(c['numStartups']).toBe(3);
    expect(c['mcpServers']).toEqual({
      other: { command: 'x' },
      mindly: {
        type: 'stdio',
        command: '/opt/my tools/mindly',
        args: ['--profile', "it's", 'mcp', '--agent', 'claude-code'],
        env: {},
      },
    });

    // A backup of the previous content sits next to each file.
    expect(
      readdirSync(join(home, '.claude')).some((n) => /^settings\.json\..*\.bak$/.test(n)),
    ).toBe(true);

    const before = readFileSync(settings, 'utf8');
    expect(await claude.planInstall(opts(home))).toEqual([]);
    expect(readFileSync(settings, 'utf8')).toBe(before);
  });

  it('uninstall removes only Mindly entries', async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    write(settings, JSON.stringify({ hooks: { PreToolUse: [USER_HOOK] } }));
    write(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    await install(claude, opts(home));
    applyInstallSteps(await claude.planUninstall(opts(home)));
    expect(readJson(settings)).toEqual({ hooks: { PreToolUse: [USER_HOOK] } });
    expect(readJson(join(home, '.claude.json'))).toEqual({
      mcpServers: { other: { command: 'x' } },
    });
    expect(await claude.planUninstall(opts(home))).toEqual([]);
  });

  it("keeps another tool's hook whose command ends like Mindly's", async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    const other = {
      hooks: [{ type: 'command', command: '/usr/local/bin/othertool hook claude-code Stop' }],
    };
    write(settings, JSON.stringify({ hooks: { Stop: [other], PreToolUse: [USER_HOOK] } }));

    await install(claude, opts(home));
    let hooks = readJson(settings)['hooks'] as Record<string, unknown[]>;
    expect(hooks['Stop']?.[0]).toEqual(other);
    expect(hooks['Stop']).toHaveLength(2);
    // Installing again replaces Mindly's own entries and nothing else.
    await install(claude, opts(home));
    hooks = readJson(settings)['hooks'] as Record<string, unknown[]>;
    expect(hooks['Stop']).toHaveLength(2);

    applyInstallSteps(await claude.planUninstall(opts(home)));
    expect(readJson(settings)['hooks']).toEqual({ Stop: [other], PreToolUse: [USER_HOOK] });

    // The same for Cursor's flat hook lists.
    const cursorHooks = join(home, '.cursor', 'hooks.json');
    const flat = { command: 'othertool hook cursor stop' };
    write(cursorHooks, JSON.stringify({ version: 1, hooks: { stop: [flat] } }));
    await install(cursor, opts(home));
    await install(cursor, opts(home));
    applyInstallSteps(await cursor.planUninstall(opts(home)));
    expect(readJson(cursorHooks)).toEqual({ version: 1, hooks: { stop: [flat] } });
  });

  it('replaces hooks written with a launcher Mindly no longer uses', async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    await install(claude, { ...opts(home), command: ['/usr/bin/node', '/x/main.js'] });
    // Same launcher: replaced in place. A named Mindly launcher: also replaced.
    await install(claude, { ...opts(home), command: ['/usr/bin/node', '/x/main.js'] });
    let hooks = readJson(settings)['hooks'] as Record<string, unknown[]>;
    expect(hooks['Stop']).toHaveLength(1);
    await install(claude, { ...opts(home), command: ['/old/bin/mindly'] });
    await install(claude, opts(home));
    hooks = readJson(settings)['hooks'] as Record<string, unknown[]>;
    expect(JSON.stringify(hooks['Stop'])).not.toContain('/old/bin/mindly');
  });

  it('replaces and removes hooks pinned to an older npx version', async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    const old = { ...opts(home), command: ['npx', '--yes', 'mindly-cli@0.4.0'] };
    const now = { ...opts(home), command: ['npx', '--yes', 'mindly-cli@0.5.0'] };
    write(settings, JSON.stringify({ hooks: { PreToolUse: [USER_HOOK] } }));
    await install(claude, old);
    expect(readFileSync(settings, 'utf8')).toContain('mindly-cli@0.4.0 hook claude-code');
    // The upgrade replaces every hook the older version wrote, and adds no second set.
    await install(claude, now);
    const text = readFileSync(settings, 'utf8');
    expect(text).not.toContain('mindly-cli@0.4.0');
    const hooks = readJson(settings)['hooks'] as Record<string, unknown[]>;
    expect(hooks['Stop']).toHaveLength(1);
    expect(hooks['PreToolUse']).toHaveLength(2);
    // An uninstall run from yet another version still finds them, and keeps the user's.
    applyInstallSteps(
      await claude.planUninstall({ ...opts(home), command: ['npx', '--yes', 'mindly-cli@latest'] }),
    );
    expect(readJson(settings)['hooks']).toEqual({ PreToolUse: [USER_HOOK] });
    // The same for Codex.
    const codexHooks = join(home, '.codex', 'hooks.json');
    await install(codex, old);
    await install(codex, now);
    expect(readFileSync(codexHooks, 'utf8')).not.toContain('mindly-cli@0.4.0');
    applyInstallSteps(await codex.planUninstall(now));
    expect(readFileSync(codexHooks, 'utf8')).not.toContain('mindly-cli');
  });

  it('keeps user hooks that share a matcher group with Mindly', async () => {
    const home = tempDir();
    const settings = join(home, '.claude', 'settings.json');
    await install(claude, opts(home));
    const s = readJson(settings);
    const stop = must((s['hooks'] as Record<string, { hooks: unknown[] }[]>)['Stop']);
    must(stop[0]).hooks.push({ type: 'command', command: 'say done' });
    writeFileSync(settings, JSON.stringify(s));
    applyInstallSteps(await claude.planUninstall(opts(home)));
    expect(readJson(settings)).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    });
  });

  it('writes project-scoped files', async () => {
    const home = tempDir();
    const project = tempDir();
    const steps = await claude.planInstall(opts(home, project));
    expect(steps.map((s) => s.file).sort()).toEqual(
      [join(project, '.claude', 'settings.json'), join(project, '.mcp.json')].sort(),
    );
    expect(steps.every((s) => s.previous === null)).toBe(true);
    applyInstallSteps(steps);
    if (process.platform !== 'win32') {
      expect(statSync(join(project, '.claude')).mode & 0o777).toBe(0o700);
      expect(statSync(join(project, '.mcp.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to overwrite invalid JSON', async () => {
    const home = tempDir();
    write(join(home, '.claude', 'settings.json'), '{ "hooks": ');
    await expect(claude.planInstall(opts(home))).rejects.toSatisfy((e) =>
      isMindlyError(e, 'invalid_input'),
    );
    write(join(home, '.claude', 'settings.json'), '[1,2]');
    await expect(claude.planInstall(opts(home))).rejects.toSatisfy((e) =>
      isMindlyError(e, 'invalid_input'),
    );
    write(join(home, '.claude', 'settings.json'), '{"hooks": {"Stop": "bad"}}');
    await expect(claude.planInstall(opts(home))).rejects.toSatisfy((e) =>
      isMindlyError(e, 'invalid_input'),
    );
  });

  it('rejects argv containing newlines or NUL', async () => {
    const home = tempDir();
    for (const bad of [['/bin/mindly\nrm -rf ~'], ['/bin/syn\0apse'], [], ['']]) {
      await expect(
        claude.planInstall({ command: bad, homeDir: home, projectRoot: null }),
      ).rejects.toSatisfy((e) => isMindlyError(e, 'invalid_input'));
    }
  });
});

describe('codex install', () => {
  const userToml = [
    '# my codex config',
    'model = "gpt-5-codex"',
    '',
    '[mcp_servers.docs]',
    'command = "docs-mcp" # keep me',
    '',
    '[profiles.fast]',
    'model = "gpt-5-mini"',
    '',
  ].join('\n');

  it('merges hooks.json and appends a managed TOML block, preserving comments', async () => {
    const home = tempDir();
    const dir = join(home, '.codex');
    write(join(dir, 'config.toml'), userToml);
    write(join(dir, 'hooks.json'), JSON.stringify({ hooks: { Stop: [USER_HOOK] } }));
    await install(codex, opts(home));

    const toml = readFileSync(join(dir, 'config.toml'), 'utf8');
    expect(toml.startsWith(userToml.trimEnd())).toBe(true);
    expect(toml).toContain('command = "docs-mcp" # keep me');
    const doc = parseToml(toml) as Record<string, Record<string, unknown>>;
    expect(doc['mcp_servers']?.['mindly']).toEqual({
      command: '/opt/my tools/mindly',
      args: ['--profile', "it's", 'mcp', '--agent', 'codex'],
    });
    expect(doc['profiles']).toEqual({ fast: { model: 'gpt-5-mini' } });

    const hooks = readJson(join(dir, 'hooks.json'))['hooks'] as Record<string, unknown[]>;
    expect(hooks['Stop']?.[0]).toEqual(USER_HOOK);
    expect(hooks['PreToolUse']?.[0]).toMatchObject({ matcher: '^(Bash|apply_patch)$' });
    expect(JSON.stringify(hooks['SessionEnd'])).toContain('"timeout":3');

    expect(await codex.planInstall(opts(home))).toEqual([]);

    applyInstallSteps(await codex.planUninstall(opts(home)));
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(userToml);
    expect(readJson(join(dir, 'hooks.json'))).toEqual({ hooks: { Stop: [USER_HOOK] } });
    expect(await codex.planUninstall(opts(home))).toEqual([]);
  });

  it('replaces an unmarked mindly server table', async () => {
    const home = tempDir();
    const file = join(home, '.codex', 'config.toml');
    write(
      file,
      '[mcp_servers.mindly]\ncommand = "old"\n\n[mcp_servers.mindly.env]\nA = "1"\n\n[x]\ny = 1\n',
    );
    await install(codex, opts(home));
    const doc = parseToml(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    expect((doc['mcp_servers']?.['mindly'] as Record<string, unknown>)['command']).toBe(
      '/opt/my tools/mindly',
    );
    expect(doc['x']).toEqual({ y: 1 });
  });

  it('honours CODEX_HOME for user installs', async () => {
    const home = tempDir();
    const codexHome = tempDir();
    const steps = await createCodexAdapter({ env: { CODEX_HOME: codexHome } }).planInstall(
      opts(home),
    );
    expect(steps.map((s) => s.file).sort()).toEqual(
      [join(codexHome, 'config.toml'), join(codexHome, 'hooks.json')].sort(),
    );
  });

  it('refuses invalid TOML and inline-table server definitions', async () => {
    const home = tempDir();
    const file = join(home, '.codex', 'config.toml');
    write(file, 'model = "unterminated\n');
    await expect(codex.planInstall(opts(home))).rejects.toSatisfy((e) =>
      isMindlyError(e, 'invalid_input'),
    );
    write(file, 'mcp_servers = { mindly = { command = "x" } }\n');
    await expect(codex.planInstall(opts(home))).rejects.toSatisfy((e) =>
      isMindlyError(e, 'invalid_input'),
    );
    // Valid TOML that Mindly's table cannot be appended to is not called invalid.
    write(file, 'mcp_servers = { other = { command = "o" } }\n');
    const refused = await codex.planInstall(opts(home)).catch((e: unknown) => e);
    expect(isMindlyError(refused, 'invalid_input')).toBe(true);
    expect((refused as Error).message).toContain('inline table');
    expect((refused as Error).message).not.toContain('not valid TOML');
    expect(readFileSync(file, 'utf8')).toBe('mcp_servers = { other = { command = "o" } }\n');
  });

  it("keeps the comments above the table after the user's own mindly table", async () => {
    const home = tempDir();
    const file = join(home, '.codex', 'config.toml');
    write(
      file,
      [
        '[mcp_servers.mindly]',
        'command = "old"',
        '# about mindly',
        'args = []',
        '',
        '# about other',
        '# second line',
        '[mcp_servers.other]',
        'command = "o"',
        '',
      ].join('\n'),
    );
    await install(codex, opts(home));
    const toml = readFileSync(file, 'utf8');
    expect(toml).toContain('# about other\n# second line\n[mcp_servers.other]');
    expect(toml).not.toContain('# about mindly');
    expect(toml).not.toContain('"old"');
  });
});

describe('cursor install', () => {
  it('merges hooks.json and mcp.json, idempotent, uninstall restores', async () => {
    const home = tempDir();
    const dir = join(home, '.cursor');
    const userHooks = { version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }] } };
    const userMcp = { mcpServers: { github: { command: 'gh-mcp', args: [] } } };
    write(join(dir, 'hooks.json'), JSON.stringify(userHooks));
    write(join(dir, 'mcp.json'), JSON.stringify(userMcp));
    await install(cursor, opts(home));

    const hooks = readJson(join(dir, 'hooks.json'));
    expect(hooks['version']).toBe(1);
    const h = hooks['hooks'] as Record<string, { command: string }[]>;
    expect(h['afterFileEdit']).toEqual([
      { command: './format.sh' },
      { command: `'/opt/my tools/mindly' --profile 'it'\\''s' hook cursor afterFileEdit` },
    ]);
    expect(h['postToolUse']).toBeUndefined();
    expect(
      (readJson(join(dir, 'mcp.json'))['mcpServers'] as Record<string, unknown>)['mindly'],
    ).toEqual({
      type: 'stdio',
      command: '/opt/my tools/mindly',
      args: ['--profile', "it's", 'mcp', '--agent', 'cursor'],
    });

    expect(await cursor.planInstall(opts(home))).toEqual([]);
    applyInstallSteps(await cursor.planUninstall(opts(home)));
    expect(readJson(join(dir, 'hooks.json'))).toEqual(userHooks);
    expect(readJson(join(dir, 'mcp.json'))).toEqual(userMcp);
  });

  it('leaves Mindly hooks of other agent kinds alone', async () => {
    const home = tempDir();
    const file = join(home, '.cursor', 'hooks.json');
    const foreign = { version: 1, hooks: { stop: [{ command: 'mindly hook generic stop' }] } };
    write(file, JSON.stringify(foreign));
    await install(cursor, opts(home));
    applyInstallSteps(await cursor.planUninstall(opts(home)));
    expect(readJson(file)).toEqual(foreign);
  });

  it('uninstall without config files is a no-op', async () => {
    expect(await cursor.planUninstall(opts(tempDir()))).toEqual([]);
  });
});

describe('applyInstallSteps', () => {
  it('refuses when the file changed since planning', async () => {
    const home = tempDir();
    const steps = await cursor.planInstall(opts(home));
    write(join(home, '.cursor', 'mcp.json'), '{}');
    expect(() => applyInstallSteps(steps)).toThrowError(/changed since/);
  });

  it('rejects relative paths', () => {
    expect(() =>
      applyInstallSteps([{ file: 'rel.json', description: 'x', content: '{}', previous: null }]),
    ).toThrowError();
  });
});
