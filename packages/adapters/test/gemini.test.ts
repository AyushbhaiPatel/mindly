import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import type { InstallOptions } from '@mindly/core';
import { isMindlyError } from '@mindly/core';
import {
  applyInstallSteps,
  createGeminiAdapter,
  GEMINI_TOOL_MATCHER,
  geminiAdapter as a,
  getAdapter,
  HOOK_AGENT_KINDS,
  integrationOf,
} from '../src/index.js';
import { fixture, must, out, result, tempDir } from './helpers.js';

const f = (name: string) => fixture('gemini', name);
const COMMAND = ['/opt/my tools/mindly', '--profile', "it's"];
const gemini = createGeminiAdapter({ env: {} });

function opts(home: string, projectRoot: string | null = null): InstallOptions {
  return { command: COMMAND, homeDir: home, projectRoot };
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function readJsonc(file: string): Record<string, unknown> {
  return parseJsonc(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

async function install(o: InstallOptions) {
  const steps = await gemini.planInstall(o);
  applyInstallSteps(steps);
  return steps;
}

async function uninstall(o: InstallOptions) {
  const steps = await gemini.planUninstall(o);
  applyInstallSteps(steps);
  return steps;
}

describe('gemini registry', () => {
  it('is a hook agent', () => {
    expect(HOOK_AGENT_KINDS).toContain('gemini');
    const adapter = must(getAdapter('gemini'));
    expect(adapter.displayName).toBe('Gemini CLI');
    expect(integrationOf(adapter)).toBe('hooks+mcp');
  });
});

describe('gemini parse', () => {
  it('parses lifecycle events', () => {
    expect(a.parse('SessionStart', f('SessionStart'))).toMatchObject({
      agentKind: 'gemini',
      event: 'session_start',
      nativeEvent: 'SessionStart',
      externalSessionId: '6a4260f2-59ce-4412-be01-5df46b5bee9d',
      cwd: '/Users/dev/shop',
      startSource: 'startup',
    });
    expect(a.parse('SessionStart', f('SessionStart'))?.transcriptPath).toContain('/chats/');
    expect(a.parse('BeforeAgent', f('BeforeAgent'))).toMatchObject({
      event: 'prompt',
      prompt: 'Create hello.ts then change the greeting and show it',
    });
    expect(a.parse('AfterAgent', f('AfterAgent'))).toMatchObject({
      event: 'stop',
      lastMessage: 'Done: hello.ts now greets gemini.',
    });
    expect(a.parse('SessionEnd', f('SessionEnd'))?.event).toBe('session_end');
  });

  it('drops the SessionStart context Gemini prepends to headless prompts', () => {
    const fx = f('BeforeAgent');
    const prompt =
      '<hook_context>&lt;mindly-context&gt;\n- [rule] Use pnpm\n&lt;/mindly-context&gt;</hook_context>\n\nCreate hello.ts';
    expect(a.parse('BeforeAgent', { ...fx, prompt })?.prompt).toBe('Create hello.ts');
    expect(
      a.parse('BeforeAgent', { ...fx, prompt: 'see <hook_context>x</hook_context>' })?.prompt,
    ).toBe('see <hook_context>x</hook_context>');
  });

  it('extracts write_file and replace edits', () => {
    expect(a.parse('BeforeTool', f('BeforeTool.write_file'))?.tool).toEqual({
      name: 'write_file',
      writes: true,
      shell: false,
      edits: [
        {
          path: '/Users/dev/shop/hello.ts',
          addedText: "export const hello = 'world';\n",
          removedText: '',
          wholeFile: true,
        },
      ],
      command: null,
      failed: false,
      outputExcerpt: null,
    });
    expect(a.parse('BeforeTool', f('BeforeTool.replace'))?.tool).toMatchObject({
      name: 'replace',
      writes: true,
      edits: [
        {
          path: '/Users/dev/shop/hello.ts',
          addedText: "'gemini'",
          removedText: "'world'",
          wholeFile: false,
        },
      ],
    });
    expect(a.parse('AfterTool', f('AfterTool.replace'))?.tool).toMatchObject({
      writes: true,
      failed: false,
      outputExcerpt: expect.stringContaining('Successfully modified file'),
    });
  });

  it('parses shell commands and reads the exit code from the output', () => {
    expect(a.parse('BeforeTool', f('BeforeTool.run_shell_command'))?.tool).toMatchObject({
      name: 'run_shell_command',
      shell: true,
      writes: false,
      command: 'cat hello.ts && exit 3',
    });
    const after = a.parse('AfterTool', f('AfterTool.run_shell_command'))?.tool;
    expect(after).toMatchObject({ shell: true, failed: true });
    expect(after?.outputExcerpt).toContain('Exit Code: 3');

    const ok = f('AfterTool.run_shell_command');
    const response = ok['tool_response'] as Record<string, unknown>;
    const passed = a.parse('AfterTool', {
      ...ok,
      tool_response: { ...response, llmContent: 'Output: fine' },
    });
    expect(passed?.tool?.failed).toBe(false);
  });

  it('marks tool errors as failed', () => {
    expect(a.parse('AfterTool', f('AfterTool.replace.error'))?.tool).toMatchObject({
      name: 'replace',
      failed: true,
      outputExcerpt: expect.stringContaining('Could not find an exact match'),
    });
  });

  it('returns null for unknown events and invalid payloads', () => {
    const fx = f('BeforeAgent');
    expect(a.parse('BeforeModel', fx)).toBeNull();
    expect(a.parse('BeforeAgent', { ...fx, session_id: '' })).toBeNull();
    expect(a.parse('BeforeAgent', { ...fx, cwd: undefined })).toBeNull();
    expect(a.parse('BeforeTool', { ...f('BeforeTool.replace'), tool_name: undefined })).toBeNull();
    expect(a.parse('BeforeAgent', 'nope')).toBeNull();
  });
});

describe('gemini render', () => {
  it('injects context on SessionStart, BeforeAgent and AfterTool', () => {
    for (const [name, fx] of [
      ['SessionStart', 'SessionStart'],
      ['BeforeAgent', 'BeforeAgent'],
      ['AfterTool', 'AfterTool.replace'],
    ] as const) {
      const ev = must(a.parse(name, f(fx)));
      expect(out(a.render(ev, result({ context: 'ctx', userMessage: 'hi' })).stdout)).toEqual({
        hookSpecificOutput: { hookEventName: name, additionalContext: 'ctx' },
        systemMessage: 'hi',
      });
      expect(a.render(ev, result({})).stdout).toBe('');
    }
  });

  it('denies with a top-level decision and folds context into the reason', () => {
    const ev = must(a.parse('BeforeTool', f('BeforeTool.replace')));
    const r = a.render(ev, result({ decision: 'deny', reason: 'rule says no', context: 'ctx' }));
    expect(r.exitCode).toBe(0);
    expect(out(r.stdout)).toEqual({ decision: 'deny', reason: 'rule says no\n\nctx' });
  });

  it('asks for confirmation and shows the reason', () => {
    const ev = must(a.parse('BeforeTool', f('BeforeTool.write_file')));
    expect(out(a.render(ev, result({ decision: 'ask', reason: 'check first' })).stdout)).toEqual({
      decision: 'ask',
      reason: 'check first',
      systemMessage: 'check first',
    });
  });

  it('never emits allow, BeforeTool context, AfterAgent decisions or SessionEnd output', () => {
    const before = must(a.parse('BeforeTool', f('BeforeTool.write_file')));
    expect(a.render(before, result({ decision: 'allow', context: 'ctx' })).stdout).toBe('');
    const stop = must(a.parse('AfterAgent', f('AfterAgent')));
    expect(a.render(stop, result({ context: 'ctx' })).stdout).toBe('');
    expect(out(a.render(stop, result({ userMessage: 'bye' })).stdout)).toEqual({
      systemMessage: 'bye',
    });
    const end = must(a.parse('SessionEnd', f('SessionEnd')));
    expect(a.render(end, result({ context: 'ctx', userMessage: 'x' })).stdout).toBe('');
  });
});

describe('gemini install', () => {
  it('writes hooks and the MCP server to one settings file, idempotently', async () => {
    const home = tempDir();
    const file = join(home, '.gemini', 'settings.json');
    const steps = await install(opts(home));
    expect(steps.map((s) => s.file)).toEqual([file]);
    expect(steps[0]?.previous).toBeNull();

    const s = readJsonc(file);
    const hooks = s['hooks'] as Record<string, unknown[]>;
    expect(Object.keys(hooks)).toEqual([
      'SessionStart',
      'BeforeAgent',
      'BeforeTool',
      'AfterTool',
      'AfterAgent',
      'SessionEnd',
    ]);
    expect(hooks['BeforeTool']).toEqual([
      {
        matcher: GEMINI_TOOL_MATCHER,
        hooks: [
          {
            type: 'command',
            command: "'/opt/my tools/mindly' --profile 'it'\\''s' hook gemini BeforeTool",
            name: 'mindly-BeforeTool',
            timeout: 10000,
          },
        ],
      },
    ]);
    expect(hooks['SessionStart']?.[0]).not.toHaveProperty('matcher');
    expect(s['mcpServers']).toEqual({
      mindly: {
        command: '/opt/my tools/mindly',
        args: ['--profile', "it's", 'mcp', '--agent', 'gemini'],
      },
    });

    expect(await gemini.planInstall(opts(home))).toEqual([]);
    await uninstall(opts(home));
    expect(readJsonc(file)).toEqual({});
  });

  it('keeps comments, user hooks and other servers, and uninstall restores the file', async () => {
    const home = tempDir();
    const file = join(home, '.gemini', 'settings.json');
    const original = readFileSync(
      join(import.meta.dirname, 'fixtures', 'gemini', 'settings.comments.jsonc'),
      'utf8',
    );
    write(file, original);

    await install(opts(home));
    const text = readFileSync(file, 'utf8');
    for (const kept of [
      '// User settings',
      '/* servers used every day */',
      '// keep this one',
      '// trailing comment',
      '// my own audit hook',
    ]) {
      expect(text).toContain(kept);
    }
    expect(text).toContain('{"matcher": "run_shell_command", "hooks": [{"type": "command"');
    const s = readJsonc(file);
    expect(s['general']).toEqual({ vimMode: true });
    expect(Object.keys(s['mcpServers'] as object)).toEqual(['other', 'mindly']);
    const beforeTool = (s['hooks'] as Record<string, unknown[]>)['BeforeTool'];
    expect(beforeTool).toHaveLength(2);
    expect(beforeTool?.[0]).toEqual({
      matcher: 'run_shell_command',
      hooks: [{ type: 'command', command: '/usr/local/bin/audit.sh' }],
    });

    expect(await gemini.planInstall(opts(home))).toEqual([]);
    await uninstall(opts(home));
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('replaces hooks from an older Mindly install instead of duplicating them', async () => {
    const home = tempDir();
    const file = join(home, '.gemini', 'settings.json');
    await install({ ...opts(home), command: ['/old/mindly'] });
    await install(opts(home));
    const hooks = readJsonc(file)['hooks'] as Record<string, unknown[]>;
    expect(hooks['AfterAgent']).toHaveLength(1);
    expect(JSON.stringify(hooks)).not.toContain('/old/mindly');
  });

  it('keeps user hooks that share a group with a Mindly hook', async () => {
    const home = tempDir();
    const file = join(home, '.gemini', 'settings.json');
    const mine = { type: 'command', command: '/usr/local/bin/audit.sh' };
    const mindly = { type: 'command', command: '/old/mindly hook gemini BeforeTool' };
    write(
      file,
      JSON.stringify(
        { hooks: { BeforeTool: [{ matcher: '.*', hooks: [mine, mindly] }] } },
        null,
        2,
      ),
    );
    await uninstall(opts(home));
    expect(readJsonc(file)).toEqual({ hooks: { BeforeTool: [{ matcher: '.*', hooks: [mine] }] } });
  });

  it('leaves Mindly hooks of other agent kinds alone', async () => {
    const home = tempDir();
    const file = join(home, '.gemini', 'settings.json');
    const foreign = { hooks: [{ type: 'command', command: '/x/mindly hook claude-code Stop' }] };
    write(file, JSON.stringify({ hooks: { AfterAgent: [foreign] } }, null, 2));
    await install(opts(home));
    await uninstall(opts(home));
    expect(readJsonc(file)).toEqual({ hooks: { AfterAgent: [foreign] } });
  });

  it('writes project-scoped settings', async () => {
    const home = tempDir();
    const root = tempDir();
    const steps = await install(opts(home, root));
    expect(steps.map((s) => s.file)).toEqual([join(root, '.gemini', 'settings.json')]);
  });

  it('uninstall without a settings file is a no-op', async () => {
    expect(await gemini.planUninstall(opts(tempDir()))).toEqual([]);
  });

  it('refuses invalid JSON and a non-object hooks value', async () => {
    const home = tempDir();
    const file = join(home, '.gemini', 'settings.json');
    for (const bad of ['{ "hooks": ', '{ "hooks": [] }']) {
      write(file, bad);
      try {
        await gemini.planInstall(opts(home));
        throw new Error('expected a refusal');
      } catch (err) {
        expect(isMindlyError(err) && err.code === 'invalid_input').toBe(true);
      }
      expect(readFileSync(file, 'utf8')).toBe(bad);
    }
  });

  it('detects Gemini CLI by its config folder', async () => {
    const home = tempDir();
    const g = createGeminiAdapter({ homeDir: home, env: { PATH: '' } });
    expect(await g.detect()).toBe(false);
    mkdirSync(join(home, '.gemini'));
    expect(await g.detect()).toBe(true);
  });
});
