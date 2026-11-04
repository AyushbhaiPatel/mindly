import { describe, expect, it } from 'vitest';
import { codexAdapter as a, MAX_PATCH_BYTES, parseApplyPatch } from '../src/index.js';
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
      { path: 'a.ts', addedText: 'new', removedText: 'old', wholeFile: false },
    ]);
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
