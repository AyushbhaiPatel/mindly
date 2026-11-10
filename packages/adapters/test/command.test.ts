import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  classifyTool,
  hookCommand,
  isMindlyHookCommand,
  mcpLaunch,
  shellJoin,
  shellQuote,
} from '../src/index.js';

describe('shell quoting', () => {
  it('leaves safe arguments bare and quotes the rest', () => {
    expect(shellQuote('/usr/local/bin/mindly')).toBe('/usr/local/bin/mindly');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'");
  });

  it('round-trips through a real POSIX shell', () => {
    if (process.platform === 'win32') return;
    const argv = ['/bin/echo', "it's a test", '$HOME', '`x`', 'a"b', '\\n', '*'];
    // Test-only: verify quoting by letting /bin/sh parse the joined string.
    const echoed = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${shellJoin(argv.slice(1))}`], {
      encoding: 'utf8',
    });
    expect(echoed.split('\n').slice(0, -1)).toEqual(argv.slice(1));
  });

  it('rejects newline, CR and NUL', () => {
    expect(() => shellJoin(['a\nb'])).toThrowError(/newlines/);
    expect(() => shellJoin(['a\rb'])).toThrowError(/newlines/);
    expect(() => shellJoin(['a\0b'])).toThrowError(/NUL/);
    expect(() => shellJoin([])).toThrowError();
  });

  it('builds hook and MCP commands', () => {
    expect(hookCommand(['/bin/mindly'], 'codex', 'Stop')).toBe('/bin/mindly hook codex Stop');
    expect(mcpLaunch(['node', '/x/cli.js'], 'cursor')).toEqual({
      command: 'node',
      args: ['/x/cli.js', 'mcp', '--agent', 'cursor'],
    });
  });

  it('recognises Mindly hook commands per agent', () => {
    expect(isMindlyHookCommand('/bin/mindly hook codex Stop', 'codex')).toBe(true);
    expect(isMindlyHookCommand("'/a b/mindly' 'hook' 'codex' 'Stop'", 'codex')).toBe(true);
    expect(isMindlyHookCommand('/bin/mindly hook codex Stop', 'cursor')).toBe(false);
    expect(isMindlyHookCommand('/bin/mindly hook codex-x Stop', 'codex')).toBe(false);
    expect(isMindlyHookCommand('./notify.sh', 'codex')).toBe(false);
    expect(isMindlyHookCommand(42, 'codex')).toBe(false);
  });

  it('recognises the launchers Mindly writes, now and before', () => {
    const yes = [
      'mindly hook codex Stop',
      'C:/tools/mindly.cmd hook codex Stop',
      "'/opt/my tools/mindly' --profile 'it'\\''s' hook codex Stop",
      '/usr/bin/node /usr/lib/node_modules/mindly-cli/dist/main.js hook codex Stop',
      'node /src/mindly/apps/cli/dist/main.js hook codex Stop',
      'npx mindly-cli hook codex Stop',
      'npx -y mindly-cli hook codex Stop',
      // Pinned by an install run through npx, then upgraded: still Mindly's.
      'npx --yes mindly-cli@0.5.0 hook codex Stop',
      'npx --yes mindly-cli@latest hook codex Stop',
      'pnpm dlx mindly-cli@1.0.0-rc.1 hook codex Stop',
    ];
    for (const command of yes) expect(isMindlyHookCommand(command, 'codex'), command).toBe(true);
    // A launcher Mindly cannot know by name is its own only when it is the one in use.
    const custom = ['/usr/bin/node', '/x/main.js'];
    expect(isMindlyHookCommand('/usr/bin/node /x/main.js hook codex Stop', 'codex')).toBe(false);
    expect(isMindlyHookCommand('/usr/bin/node /x/main.js hook codex Stop', 'codex', custom)).toBe(
      true,
    );
  });

  it("leaves other tools' hook commands alone", () => {
    const no = [
      '/usr/local/bin/othertool hook codex Stop',
      'othertool --flag hook codex Stop',
      'node /opt/other/dist/main.js hook codex Stop',
      'git hook codex run',
      // The user's own wrappers around Mindly's command are theirs.
      'mindly hook codex Stop || true',
      'mindly hook codex Stop | tee /tmp/log',
      'mindly hook codex Stop extra',
      'mindly hook codex',
      'hook codex Stop',
      'echo mindly; othertool hook codex Stop',
      'npx --yes mindly-cli-extra@1.0.0 hook codex Stop',
      'npx --yes other-cli@1.0.0 hook codex Stop',
      'npx --yes mindly-cli@ hook codex Stop',
    ];
    for (const command of no) expect(isMindlyHookCommand(command, 'codex'), command).toBe(false);
  });
});

describe('classifyTool', () => {
  it('classifies writes and shell tools', () => {
    for (const n of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']) {
      expect(classifyTool(n).writes).toBe(true);
    }
    for (const n of ['Bash', 'shell', 'exec_command']) expect(classifyTool(n).shell).toBe(true);
    expect(classifyTool('Read')).toEqual({ writes: false, shell: false });
  });
});
