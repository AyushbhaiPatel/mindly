import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cli, sandbox, tempDir, type Sandbox } from './helpers.js';

/** Puts a fake `claude` on the sandbox PATH that prints a successful result and changes nothing. */
function fakeClaude(sb: Sandbox): void {
  const dir = tempDir('mindly-cli-fake-');
  symlinkSync(process.execPath, join(dir, 'node'));
  writeFileSync(
    join(dir, 'claude'),
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'nothing to do', session_id: 's', num_turns: 1 }));
});
`,
    { mode: 0o755 },
  );
  sb.env['PATH'] = `${dir}:${sb.env['PATH']}`;
}

describe('mindly replay without the background service', () => {
  it('finds agents on the PATH of the command and says how each run ended', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['init', '--yes', '--agents', 'claude-code'])).code).toBe(0);
    fakeClaude(sb);
    // Codex is not on the sandbox PATH, whatever is installed on this machine.
    const r = await cli(sb, ['replay', '--prompt', 'add a file', '--agents', 'claude-code,codex']);
    expect(r.stderr).toContain('background service is not running');
    expect(r.stdout).toContain('Claude Code: finished, changed 0 files');
    expect(r.stdout).toContain('Codex: not installed, changed 0 files');
    expect(r.stdout).not.toContain('undefined');
    expect(r.code).toBe(1);
  });
});
