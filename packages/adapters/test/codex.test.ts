import { describe, expect, it } from 'vitest';
import {
  codexAdapter as a,
  MAX_PATCH_BYTES,
  parseApplyPatch,
  readApplyPatch,
} from '../src/index.js';
import { fixture, must, out, result } from './helpers.js';

const f = (name: string) => fixture('codex', name);

describe('codex parse', () => {
  it('parses lifecycle events', () => {
    expect(a.parse('SessionStart', f('SessionStart'))).toMatchObject({
      agentKind: 'codex',
      event: 'session_start',
      externalSessionId: '019a3b2c-7f10-7d42-9a51-0c1d2e3f4a5b',
      startSource: 'startup',
    });
    expect(a.parse('UserPromptSubmit', f('UserPromptSubmit'))?.prompt).toContain('discount');
    expect(a.parse('Stop', f('Stop'))?.lastMessage).toContain('one test still fails');
    expect(a.parse('SessionEnd', f('SessionEnd'))?.event).toBe('session_end');
  });

  it('extracts apply_patch edits', () => {
    const tool = a.parse('PreToolUse', f('PreToolUse.apply_patch'))?.tool;
    expect(tool).toMatchObject({ name: 'apply_patch', writes: true, shell: false });
    expect(tool?.edits).toEqual([
      {
        path: 'src/checkout.ts',
        addedText: '  currency: Currency;\n  discount: number;',
        removedText: '  currency: string;',
        wholeFile: false,
      },
      {
        path: 'src/discount.ts',
        addedText:
          'export function applyDiscount(total: number, pct: number): number {\n  return total * (1 - pct);\n}',
        removedText: '',
        wholeFile: true,
      },
      { path: 'src/legacy.ts', addedText: '', removedText: '', wholeFile: true },
    ]);
  });

  it('accepts apply_patch given as an argv array', () => {
    const fx = f('PreToolUse.apply_patch');
    const patch = (fx['tool_input'] as { command: string }).command;
    const ev = a.parse('PreToolUse', { ...fx, tool_input: { command: ['apply_patch', patch] } });
    expect(ev?.tool?.edits).toHaveLength(3);
  });

  it('detects heredoc patches in shell commands', () => {
    const ev = a.parse('PreToolUse', {
      ...f('PreToolUse.Bash'),
      tool_input: {
        command:
          "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\nEOF",
      },
    });
    expect(ev?.tool).toMatchObject({ shell: true, writes: true });
    expect(ev?.tool?.edits[0]).toMatchObject({ path: 'a.txt', addedText: 'hi' });
  });

  it('reads a shell line that only holds a patch as a shell line', () => {
    for (const command of [
      "rm certs/server.pem; echo '*** Begin Patch\n*** Add File: n.txt\n+x\n*** End Patch' >/dev/null",
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\nEOF\nrm x",
    ]) {
      const ev = a.parse('PreToolUse', { ...f('PreToolUse.Bash'), tool_input: { command } });
      expect(ev?.tool, command).toMatchObject({ shell: true, writes: false, edits: [], command });
    }
  });

  it('parses Bash and failed PostToolUse', () => {
    expect(a.parse('PreToolUse', f('PreToolUse.Bash'))?.tool).toMatchObject({
      shell: true,
      command: 'pnpm vitest run checkout',
    });
    expect(a.parse('PostToolUse', f('PostToolUse.Bash'))?.tool).toMatchObject({
      failed: true,
      outputExcerpt: 'FAIL src/checkout.test.ts > applies discount',
    });
  });

  it('returns null for malformed payloads', () => {
    expect(a.parse('PreToolUse', { cwd: '/x', tool_name: 'Bash' })).toBeNull();
    expect(a.parse('PreToolUse', undefined)).toBeNull();
    expect(a.parse('PermissionRequest', f('SessionStart'))).toBeNull();
  });
});

describe('apply_patch parser', () => {
  it('handles moves, context lines and CRLF', () => {
    const edits = parseApplyPatch(
      '*** Begin Patch\r\n*** Update File: a.ts\r\n*** Move to: b.ts\r\n@@\r\n ctx\r\n-old\r\n+new\r\n*** End of File\r\n*** End Patch',
    );
    expect(edits).toEqual([
      { path: 'b.ts', addedText: 'new', removedText: 'old', wholeFile: false },
      { path: 'a.ts', addedText: '', removedText: '', wholeFile: true },
    ]);
  });

  it('reports both sides of a move, and only the file when it moves onto itself', () => {
    const moved = parseApplyPatch(
      '*** Begin Patch\n*** Update File: src/auth.ts\n*** Move to: src/generated/api.ts\n-x\n+y\n*** End Patch',
    );
    expect(moved.map((e) => e.path)).toEqual(['src/generated/api.ts', 'src/auth.ts']);
    const same = parseApplyPatch(
      '*** Begin Patch\n*** Update File: a.ts\n*** Move to: a.ts\n-x\n+y\n*** End Patch',
    );
    expect(same).toEqual([{ path: 'a.ts', addedText: 'y', removedText: 'x', wholeFile: false }]);
    // A move line without a usable path, or outside an update section, changes nothing.
    const stray = parseApplyPatch(
      '*** Begin Patch\n*** Add File: n.ts\n*** Move to: elsewhere.ts\n+z\n*** Update File: u.ts\n*** Move to:   \n+w\n*** End Patch',
    );
    expect(stray.map((e) => e.path)).toEqual(['n.ts', 'u.ts']);
  });

  it('counts sections, not edits, against the cap, and says when a patch was cut', () => {
    const move = (i: number) =>
      `*** Update File: src/old${i}.ts\n*** Move to: src/new${i}.ts\n-x\n+y`;
    const moves = Array.from({ length: 250 }, (_, i) => move(i)).join('\n');
    const protectedEdit = '*** Update File: prisma/migrations/001/migration.sql\n-a\n+b';
    const patch = `*** Begin Patch\n${moves}\n${protectedEdit}\n*** End Patch`;
    const read = readApplyPatch(patch);
    // 250 moves are 500 edits; the section after them is still reported.
    expect(read.edits).toHaveLength(501);
    expect(read.edits.at(-1)?.path).toBe('prisma/migrations/001/migration.sql');
    expect(read.cut).toBe(false);
    expect(parseApplyPatch(patch)).toEqual(read.edits);

    const many = Array.from({ length: 501 }, (_, i) => `*** Add File: f${i}.ts\n+x`).join('\n');
    const over = readApplyPatch(`*** Begin Patch\n${many}\n*** End Patch`);
    expect(over.edits).toHaveLength(500);
    expect(over.cut).toBe(true);
    // The adapter passes that on, so the engine does not take the list for the whole write.
    const tool = (command: string) =>
      a.parse('PreToolUse', { ...(f('PreToolUse.apply_patch') as object), tool_input: { command } })
        ?.tool;
    expect(tool(`*** Begin Patch\n${many}\n*** End Patch`)?.editsCut).toBe(true);
    expect(tool(patch)?.editsCut).toBeUndefined();
    expect(tool(patch)?.edits).toHaveLength(501);
  });

  it('ignores malformed sections and junk', () => {
    expect(parseApplyPatch('')).toEqual([]);
    expect(parseApplyPatch('random text\n+not in a section')).toEqual([]);
    const edits = parseApplyPatch(
      '*** Begin Patch\n*** Update File:   \n+lost\n*** Frobnicate File: x\n*** Add File: ok.txt\n+kept\n*** End Patch\n+after end',
    );
    expect(edits).toEqual([
      { path: 'ok.txt', addedText: 'kept', removedText: '', wholeFile: true },
    ]);
  });

  it('is bounded for huge input', () => {
    const huge = `*** Begin Patch\n*** Add File: big.txt\n${'+abcdefghij\n'.repeat(400_000)}*** End Patch`;
    expect(huge.length).toBeGreaterThan(MAX_PATCH_BYTES);
    const started = Date.now();
    const edits = parseApplyPatch(huge);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(edits).toHaveLength(1);
    expect(must(edits[0]).addedText.length).toBeLessThanOrEqual(200_000);
  });
});

describe('codex render', () => {
  const pre = must(a.parse('PreToolUse', f('PreToolUse.apply_patch')));

  it('renders deny via permissionDecision', () => {
    expect(out(a.render(pre, result({ decision: 'deny', reason: 'no' })).stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'no',
      },
    });
  });

  it('downgrades ask (unsupported) to context', () => {
    expect(out(a.render(pre, result({ decision: 'ask', reason: 'check first' })).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'check first' },
    });
  });

  it('renders prompt context and stays silent when empty', () => {
    const ev = must(a.parse('UserPromptSubmit', f('UserPromptSubmit')));
    expect(out(a.render(ev, result({ context: 'c' })).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'c' },
    });
    expect(a.render(ev, result({})).stdout).toBe('');
    const end = must(a.parse('SessionEnd', f('SessionEnd')));
    expect(a.render(end, result({ context: 'c', userMessage: 'u' })).stdout).toBe('');
  });
});
