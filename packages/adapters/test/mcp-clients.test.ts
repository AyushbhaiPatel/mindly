import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { InstallOptions } from '@mindly/core';
import { isMindlyError } from '@mindly/core';
import {
  adapters,
  applyInstallSteps,
  createMcpClientAdapter,
  detectFormatting,
  findMcpClient,
  genericMcpSnippet,
  getAdapter,
  integrationOf,
  MCP_CLIENTS,
  McpClientAdapter,
  parseJsonPointer,
  removeJsoncValue,
  setJsoncValue,
} from '../src/index.js';
import type { McpClientSpec } from '../src/index.js';
import { must, tempDir } from './helpers.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'mcp-clients');
const COMMAND = ['/opt/my tools/mindly', '--profile', "it's"];

function fixtureText(kind: string, name: string): string {
  return readFileSync(join(FIXTURES, kind, name), 'utf8');
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function opts(home: string, projectRoot: string | null = null): InstallOptions {
  return { command: COMMAND, homeDir: home, projectRoot };
}

function adapterFor(spec: McpClientSpec, home: string): McpClientAdapter {
  return createMcpClientAdapter(spec, { homeDir: home, env: { PATH: '' }, platform: 'linux' });
}

function servers(spec: McpClientSpec, text: string): Record<string, unknown> {
  let node: unknown = parseJsonc(text);
  for (const seg of parseJsonPointer(spec.serversPointer)) {
    node = (node as Record<string, unknown>)[seg];
  }
  return node as Record<string, unknown>;
}

async function expectRefusal(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(isMindlyError(err, 'invalid_input')).toBe(true);
    expect((err as Error).message).toMatch(pattern);
    return;
  }
  throw new Error('expected a refusal');
}

const SpecSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  displayName: z.string().min(1),
  format: z.enum(['json', 'jsonc']),
  serversPointer: z.string().regex(/^\/[^/]+(\/[^/]+)*$/),
  docs: z.array(z.string().url().startsWith('https://')).min(1),
});

describe('catalog', () => {
  it('is well-formed, unique and registered', () => {
    const kinds = MCP_CLIENTS.map((c) => c.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const spec of MCP_CLIENTS) {
      expect(SpecSchema.safeParse(spec).success).toBe(true);
      const adapter = getAdapter(spec.kind);
      expect(adapter).toBeInstanceOf(McpClientAdapter);
      expect(integrationOf(must(adapter))).toBe('mcp');
      expect(findMcpClient(spec.kind)).toBe(spec);
    }
    expect(integrationOf(must(getAdapter('claude-code')))).toBe('hooks+mcp');
    expect(Object.keys(adapters)).toEqual(expect.arrayContaining(['cursor', 'windsurf', 'zed']));
    expect(findMcpClient('nope')).toBeNull();
  });

  it('parses JSON pointers with escapes', () => {
    expect(parseJsonPointer('')).toEqual([]);
    expect(parseJsonPointer('/amp.mcpServers')).toEqual(['amp.mcpServers']);
    expect(parseJsonPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(() => parseJsonPointer('mcpServers')).toThrow();
  });

  it('resolves user paths per platform', () => {
    const home = '/home/u';
    const user = (kind: string, platform: 'darwin' | 'linux' | 'win32') =>
      must(findMcpClient(kind)).userConfig({ homeDir: home, platform })[0];
    expect(user('vscode', 'darwin')).toBe('/home/u/Library/Application Support/Code/User/mcp.json');
    expect(user('vscode', 'linux')).toBe('/home/u/.config/Code/User/mcp.json');
    expect(user('vscode', 'win32')).toBe(
      join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'),
    );
    expect(user('claude-desktop', 'darwin')).toBe(
      '/home/u/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(user('claude-desktop', 'linux')).toBe(
      '/home/u/.config/Claude/claude_desktop_config.json',
    );
    expect(user('roo-code', 'linux')).toBe(
      '/home/u/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
    );
    expect(user('windsurf', 'darwin')).toBe('/home/u/.codeium/windsurf/mcp_config.json');
    expect(user('kiro', 'darwin')).toBe('/home/u/.kiro/settings/mcp.json');
    expect(user('zed', 'darwin')).toBe('/home/u/.config/zed/settings.json');
    expect(user('opencode', 'darwin')).toBe('/home/u/.config/opencode/opencode.json');
    expect(user('amp', 'linux')).toBe('/home/u/.config/amp/settings.json');
    expect(user('cline', 'darwin')).toBe('/home/u/.cline/data/settings/cline_mcp_settings.json');
    expect(user('augment', 'linux')).toBe('/home/u/.augment/settings.json');
    expect(user('lm-studio', 'darwin')).toBe('/home/u/.lmstudio/mcp.json');
  });

  it('resolves project paths and prefers an existing alternative file', async () => {
    const home = tempDir();
    const root = tempDir();
    const project = (kind: string) =>
      adapterFor(must(findMcpClient(kind)), home).configPath({ homeDir: home, projectRoot: root });
    expect(project('vscode')).toBe(join(root, '.vscode', 'mcp.json'));
    expect(project('kiro')).toBe(join(root, '.kiro', 'settings', 'mcp.json'));
    expect(project('roo-code')).toBe(join(root, '.roo', 'mcp.json'));
    expect(project('zed')).toBe(join(root, '.zed', 'settings.json'));
    expect(project('opencode')).toBe(join(root, 'opencode.json'));
    expect(project('claude-desktop')).toBeNull();
    write(join(root, 'opencode.jsonc'), '{}\n');
    expect(project('opencode')).toBe(join(root, 'opencode.jsonc'));

    const desktop = adapterFor(must(findMcpClient('claude-desktop')), home);
    expect(desktop.supportsProjectScope).toBe(false);
    await expectRefusal(desktop.planInstall(opts(home, root)), /no project-level MCP config/);
    expect(await desktop.planUninstall(opts(home, root))).toEqual([]);
  });
});

describe.each(MCP_CLIENTS.map((spec) => [spec.kind, spec] as const))('%s', (kind, spec) => {
  it('creates the config when the file is missing, and is idempotent', async () => {
    const home = tempDir();
    const adapter = adapterFor(spec, home);
    const file = must(adapter.configPath({ homeDir: home, projectRoot: null }));
    expect(existsSync(file)).toBe(false);
    const steps = await adapter.planInstall(opts(home));
    expect(steps).toHaveLength(1);
    expect(must(steps[0]).previous).toBeNull();
    applyInstallSteps(steps);
    const entry = servers(spec, readFileSync(file, 'utf8'))['mindly'];
    expect(entry).toEqual(adapter.serverEntry(COMMAND));
    expect(JSON.stringify(entry)).toContain(`"mcp","--agent","${kind}"`);
    expect(await adapter.planInstall(opts(home))).toEqual([]);
    expect(await adapter.isConfigured({ homeDir: home, projectRoot: null })).toBe(true);
  });

  it('handles an empty file', async () => {
    const home = tempDir();
    const adapter = adapterFor(spec, home);
    const file = must(adapter.configPath({ homeDir: home, projectRoot: null }));
    write(file, fixtureText(kind, 'empty.json'));
    applyInstallSteps(await adapter.planInstall(opts(home)));
    expect(Object.keys(servers(spec, readFileSync(file, 'utf8')))).toEqual(['mindly']);
    applyInstallSteps(await adapter.planUninstall(opts(home)));
    // The servers object created by install is removed again, leaving an empty document.
    expect(JSON.parse(readFileSync(file, 'utf8') || '{}')).toEqual({});
  });

  it('preserves other servers and keys byte-for-byte; uninstall removes only mindly', async () => {
    const home = tempDir();
    const adapter = adapterFor(spec, home);
    const file = must(adapter.configPath({ homeDir: home, projectRoot: null }));
    const original = fixtureText(kind, 'existing.json');
    write(file, original);
    applyInstallSteps(await adapter.planInstall(opts(home)));
    const installed = readFileSync(file, 'utf8');
    const map = servers(spec, installed);
    expect(Object.keys(map)).toEqual(['other', 'mindly']);
    expect(map['other']).toEqual(servers(spec, original)['other']);
    // Every original line survives (only lines were added, apart from a comma).
    const kept = installed.split('\n');
    for (const line of original.split('\n')) {
      expect(kept.some((l) => l === line || l === `${line},`)).toBe(true);
    }
    expect(await adapter.planInstall(opts(home))).toEqual([]);

    applyInstallSteps(await adapter.planUninstall(opts(home)));
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(await adapter.planUninstall(opts(home))).toEqual([]);
  });

  it('refuses an invalid file without touching it', async () => {
    const home = tempDir();
    const adapter = adapterFor(spec, home);
    const file = must(adapter.configPath({ homeDir: home, projectRoot: null }));
    const bad = fixtureText(kind, 'invalid.json');
    write(file, bad);
    await expectRefusal(adapter.planInstall(opts(home)), /is not valid JSON/);
    await expectRefusal(adapter.planUninstall(opts(home)), /is not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe(bad);
  });

  it('refuses to overwrite a servers value that is not an object', async () => {
    const home = tempDir();
    const adapter = adapterFor(spec, home);
    const file = must(adapter.configPath({ homeDir: home, projectRoot: null }));
    const key = must(parseJsonPointer(spec.serversPointer)[0]);
    write(file, JSON.stringify({ [key]: ['not', 'an', 'object'] }));
    await expectRefusal(adapter.planInstall(opts(home)), /not an object/);
  });

  it('uninstall with a missing file does nothing', async () => {
    const home = tempDir();
    expect(await adapterFor(spec, home).planUninstall(opts(home))).toEqual([]);
  });

  it('never handles hooks', () => {
    const adapter = adapterFor(spec, tempDir());
    expect(adapter.parse()).toBeNull();
    expect(
      adapter.render({} as never, {
        context: 'x',
        decision: null,
        reason: null,
        userMessage: null,
      }),
    ).toEqual({ stdout: '', exitCode: 0 });
  });

  if (spec.format === 'jsonc') {
    it('keeps comments and trailing commas in JSONC files', async () => {
      const home = tempDir();
      const adapter = adapterFor(spec, home);
      const file = must(adapter.configPath({ homeDir: home, projectRoot: null }));
      const original = fixtureText(kind, 'comments.jsonc');
      write(file, original);
      applyInstallSteps(await adapter.planInstall(opts(home)));
      const installed = readFileSync(file, 'utf8');
      expect(installed).toContain(`// User settings for ${kind}`);
      expect(installed).toContain('/* servers used every day */');
      expect(installed).toContain('// keep this one');
      expect(installed).toContain('// trailing comment');
      // Only lines were added: every original line is still there, verbatim.
      for (const line of original.split('\n')) expect(installed.split('\n')).toContain(line);
      expect(Object.keys(servers(spec, installed))).toEqual(['other', 'mindly']);
      expect(await adapter.planInstall(opts(home))).toEqual([]);
      applyInstallSteps(await adapter.planUninstall(opts(home)));
      expect(readFileSync(file, 'utf8')).toBe(original);
    });
  } else {
    it('refuses comments in strict JSON files', async () => {
      const home = tempDir();
      const adapter = adapterFor(spec, home);
      const file = must(adapter.configPath({ homeDir: home, projectRoot: null }));
      write(file, '// note\n{}\n');
      await expectRefusal(adapter.planInstall(opts(home)), /is not valid JSON/);
    });
  }

  if (spec.projectConfig !== null) {
    it('installs at project scope without touching the user config', async () => {
      const home = tempDir();
      const root = tempDir();
      const adapter = adapterFor(spec, home);
      const steps = await adapter.planInstall(opts(home, root));
      expect(must(steps[0]).file.startsWith(root)).toBe(true);
      applyInstallSteps(steps);
      expect(await adapter.isConfigured({ homeDir: home, projectRoot: root })).toBe(true);
      expect(await adapter.isConfigured({ homeDir: home, projectRoot: null })).toBe(false);
    });
  }
});

describe('MCP client detection', () => {
  it('detects config directories and binaries on PATH', async () => {
    const home = tempDir();
    const windsurf = adapterFor(must(findMcpClient('windsurf')), home);
    expect(await windsurf.detect()).toBe(false);
    mkdirSync(join(home, '.codeium', 'windsurf'), { recursive: true });
    expect(await windsurf.detect()).toBe(true);

    const bin = tempDir();
    write(join(bin, 'kiro'), '#!/bin/sh\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(join(bin, 'kiro'), 0o755);
    const kiro = createMcpClientAdapter(must(findMcpClient('kiro')), {
      homeDir: home,
      env: { PATH: bin },
      platform: 'linux',
    });
    expect(await kiro.detect()).toBe(true);
  });
});

describe('jsonc edits', () => {
  it('matches indentation and line endings', () => {
    expect(detectFormatting('{\n\t"a": 1\n}')).toMatchObject({ insertSpaces: false });
    expect(detectFormatting('{\r\n    "a": 1\r\n}')).toMatchObject({
      insertSpaces: true,
      tabSize: 4,
      eol: '\r\n',
    });
    const text = '{\r\n    "servers": {}\r\n}\r\n';
    const out = setJsoncValue('/x.json', text, 'json', ['servers', 'mindly'], { command: 'm' });
    expect(out).toContain('\r\n        "mindly": {');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps a byte-order mark', () => {
    const text = '\uFEFF{ "mcpServers": {} }';
    const out = setJsoncValue('/x.json', text, 'json', ['mcpServers', 'mindly'], { command: 'm' });
    expect(out.startsWith('\uFEFF')).toBe(true);
    expect(removeJsoncValue('/x.json', out, 'json', ['mcpServers', 'mindly'])).toBe(text);
  });

  it('replaces an outdated mindly entry in place', () => {
    const text = '{\n  "mcpServers": {\n    "mindly": { "command": "old" },\n    "b": {}\n  }\n}\n';
    const out = setJsoncValue('/x.json', text, 'json', ['mcpServers', 'mindly'], {
      command: 'new',
    });
    expect(Object.keys((parseJsonc(out) as { mcpServers: object }).mcpServers)).toEqual([
      'mindly',
      'b',
    ]);
    expect(out).toContain('"new"');
    expect(out).not.toContain('"old"');
  });

  it('adds a missing servers key and removes it cleanly from a one-line object', () => {
    const text = '{\n  "theme": "x" // dark\n}\n';
    const out = setJsoncValue('/x.json', text, 'jsonc', ['mcpServers', 'mindly'], { a: 1 });
    expect(out).toBe(
      '{\n  "theme": "x", // dark\n  "mcpServers": {\n    "mindly": {\n      "a": 1\n    }\n  }\n}\n',
    );
    const compact = '{"a":{"b":1}}';
    const added = setJsoncValue('/x.json', compact, 'json', ['a', 'mindly'], { c: 2 });
    expect(parseJsonc(added)).toEqual({ a: { b: 1, mindly: { c: 2 } } });
    expect(removeJsoncValue('/x.json', added, 'json', ['a', 'mindly'])).toBe(compact);
  });

  it('refuses a non-object top level', () => {
    expect(() => setJsoncValue('/x.json', '[]', 'json', ['a'], 1)).toThrow(/JSON object/);
  });

  it('prints a generic snippet', () => {
    const snippet = JSON.parse(genericMcpSnippet(['mindly'])) as {
      mcpServers: { mindly: { command: string; args: string[] } };
    };
    expect(snippet.mcpServers.mindly).toEqual({
      command: 'mindly',
      args: ['mcp', '--agent', 'other'],
    });
  });
});

describe('install then uninstall restores the original file', () => {
  it('removes a servers object that install created', async () => {
    const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { applyInstallSteps, getAdapter } = await import('../src/index.js');
    const home = mkdtempSync(join(tmpdir(), 'mindly-zed-'));
    const file = join(home, '.config', 'zed', 'settings.json');
    mkdirSync(join(home, '.config', 'zed'), { recursive: true });
    const original = '// Zed settings\n{\n  "vim_mode": true\n}\n';
    writeFileSync(file, original);
    const adapter = getAdapter('zed')!;
    const opts = { command: ['/usr/bin/node', '/x/main.js'], projectRoot: null, homeDir: home };
    applyInstallSteps(await adapter.planInstall(opts));
    expect(readFileSync(file, 'utf8')).toContain('context_servers');
    applyInstallSteps(await adapter.planUninstall(opts));
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});
