import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter as a, MAX_TEXT_CHARS } from '../src/index.js';
import { fixture, must, out, result } from './helpers.js';

const f = (name: string) => fixture('claude-code', name);

describe('claude-code parse', () => {
  it('parses SessionStart', () => {
    const ev = a.parse('SessionStart', f('SessionStart'));
    expect(ev).toMatchObject({
      agentKind: 'claude-code',
      event: 'session_start',
      nativeEvent: 'SessionStart',
      externalSessionId: '00893aaf-19fa-41d2-8238-13269b9b3ca0',
      cwd: '/Users/dev/shop',
      startSource: 'startup',
      tool: null,
    });
    expect(ev?.transcriptPath).toMatch(/\.jsonl$/);
  });

  it('parses UserPromptSubmit', () => {
    expect(a.parse('UserPromptSubmit', f('UserPromptSubmit'))).toMatchObject({
      event: 'prompt',
      prompt: 'Add a discount field to the checkout API',
    });
  });

  it('parses Edit into one FileEdit', () => {
    const ev = a.parse('PreToolUse', f('PreToolUse.Edit'));
    expect(ev?.event).toBe('pre_tool');
    expect(ev?.tool).toMatchObject({ name: 'Edit', writes: true, shell: false, command: null });
    expect(ev?.tool?.edits).toEqual([
      {
        path: '/Users/dev/shop/src/checkout.ts',
        addedText: 'total: number;\n  discount: number;',
        removedText: 'total: number;',
        wholeFile: false,
      },
    ]);
  });

  it('counts the files of a long edit list, not its edits, against the cap', () => {
    const edit = (path?: string) => ({
      ...(path ? { file_path: path } : {}),
      old_string: 'a',
      new_string: 'b',
    });
    const many = Array.from({ length: 700 }, () => edit());
    const one = a.parse('PreToolUse', {
      ...(f('PreToolUse.MultiEdit') as object),
      tool_input: { file_path: '/repo/src/a.ts', edits: many },
    })?.tool;
    expect(one?.edits).toHaveLength(500);
    expect(one?.editsCut).toBeUndefined();
    const other = a.parse('PreToolUse', {
      ...(f('PreToolUse.MultiEdit') as object),
      tool_input: { file_path: '/repo/src/a.ts', edits: [...many, edit('/repo/certs/a.pem')] },
    })?.tool;
    expect(other?.editsCut).toBe(true);
  });

  it('parses MultiEdit into one FileEdit per edit', () => {
    const edits = a.parse('PreToolUse', f('PreToolUse.MultiEdit'))?.tool?.edits;
    expect(edits).toHaveLength(2);
    expect(edits?.[1]).toEqual({
      path: '/Users/dev/shop/src/cart.ts',
      addedText: 'let b = 0;',
      removedText: 'let b;',
      wholeFile: false,
    });
  });

  it('parses Write as a whole-file edit', () => {
    expect(a.parse('PreToolUse', f('PreToolUse.Write'))?.tool?.edits).toEqual([
      {
        path: '/Users/dev/shop/src/new.ts',
        addedText: 'export const x = 1;\n',
        removedText: '',
        wholeFile: true,
      },
    ]);
  });

  it('parses NotebookEdit', () => {
    const tool = a.parse('PreToolUse', f('PreToolUse.NotebookEdit'))?.tool;
    expect(tool?.writes).toBe(true);
    expect(tool?.edits[0]).toMatchObject({
      path: '/Users/dev/shop/analysis.ipynb',
      addedText: 'df.describe()',
    });
  });

  it('parses Bash as a shell tool', () => {
    expect(a.parse('PreToolUse', f('PreToolUse.Bash'))?.tool).toMatchObject({
      name: 'Bash',
      shell: true,
      writes: false,
      edits: [],
      command: 'pnpm test --filter checkout',
    });
  });

  it('parses PostToolUse with output excerpt', () => {
    const tool = a.parse('PostToolUse', f('PostToolUse.Bash'))?.tool;
    expect(tool).toMatchObject({ failed: false, outputExcerpt: '12 passed' });
    expect(a.parse('PostToolUse', f('PostToolUse.Write'))?.tool?.edits).toHaveLength(1);
  });

  it('parses PostToolUseFailure as a failed post_tool', () => {
    const ev = a.parse('PostToolUseFailure', f('PostToolUseFailure'));
    expect(ev?.event).toBe('post_tool');
    expect(ev?.tool?.failed).toBe(true);
    expect(ev?.tool?.outputExcerpt).toContain('TS2304');
  });

  it('parses Stop and SessionEnd', () => {
    expect(a.parse('Stop', f('Stop'))).toMatchObject({
      event: 'stop',
      lastMessage: 'I added the discount field and updated the tests.',
    });
    expect(a.parse('SessionEnd', f('SessionEnd'))?.event).toBe('session_end');
  });

  it('returns null for unknown events and malformed payloads without throwing', () => {
    expect(a.parse('Notification', f('SessionStart'))).toBeNull();
    expect(a.parse('SessionStart', null)).toBeNull();
    expect(a.parse('SessionStart', 'nope')).toBeNull();
    expect(a.parse('SessionStart', [])).toBeNull();
    expect(a.parse('SessionStart', { cwd: '/x' })).toBeNull();
    expect(a.parse('SessionStart', { session_id: '', cwd: '/x' })).toBeNull();
    expect(a.parse('SessionStart', { session_id: 42, cwd: '/x' })).toBeNull();
    expect(a.parse('PreToolUse', { session_id: 's', cwd: '/x' })).toBeNull();
  });

  it('tolerates wrong types in optional fields', () => {
    const ev = a.parse('PreToolUse', {
      session_id: 's',
      cwd: '/x',
      tool_name: 'Edit',
      tool_input: { file_path: 7, old_string: [] },
      transcript_path: { bad: true },
    });
    expect(ev?.tool?.edits).toEqual([]);
    expect(ev?.transcriptPath).toBeNull();
    const multi = a.parse('PreToolUse', {
      session_id: 's',
      cwd: '/x',
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/x/a', edits: [null, 'x', { new_string: 'ok' }] },
    });
    expect(multi?.tool?.edits).toHaveLength(1);
  });

  it('caps oversized text fields', () => {
    const big = 'x'.repeat(MAX_TEXT_CHARS * 2);
    const ev = a.parse('UserPromptSubmit', { ...f('UserPromptSubmit'), prompt: big });
    expect(ev?.prompt).toHaveLength(MAX_TEXT_CHARS);
    const edit = a.parse('PreToolUse', {
      ...f('PreToolUse.Write'),
      tool_input: { file_path: '/x/a', content: big },
    });
    expect(edit?.tool?.edits[0]?.addedText).toHaveLength(MAX_TEXT_CHARS);
  });
});

describe('claude-code render', () => {
  const start = must(a.parse('SessionStart', f('SessionStart')));
  const pre = must(a.parse('PreToolUse', f('PreToolUse.Edit')));

  it('prints nothing for an empty result', () => {
    expect(a.render(start, result({}))).toEqual({ stdout: '', exitCode: 0 });
  });

  it('renders SessionStart context', () => {
    const r = a.render(start, result({ context: 'ctx' }));
    expect(r.exitCode).toBe(0);
    expect(out(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
    });
  });

  it('renders a PreToolUse deny with reason and exit 0', () => {
    const r = a.render(pre, result({ decision: 'deny', reason: 'rule: no edits here' }));
    expect(r.exitCode).toBe(0);
    expect(out(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'rule: no edits here',
      },
    });
  });

  it('renders ask, and never emits allow', () => {
    expect(out(a.render(pre, result({ decision: 'ask', reason: 'r' })).stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask' },
    });
    expect(a.render(pre, result({ decision: 'allow' })).stdout).toBe('');
  });

  it('echoes PostToolUseFailure as the hook event name', () => {
    const ev = must(a.parse('PostToolUseFailure', f('PostToolUseFailure')));
    expect(out(a.render(ev, result({ context: 'seen before' })).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'seen before' },
    });
  });

  it('uses systemMessage for user notices and no context on Stop', () => {
    const stop = must(a.parse('Stop', f('Stop')));
    expect(out(a.render(stop, result({ context: 'x', userMessage: 'hi' })).stdout)).toEqual({
      systemMessage: 'hi',
    });
    expect(a.render(stop, result({ context: 'x' })).stdout).toBe('');
  });

  it('caps context at 10 000 characters', () => {
    const r = out(a.render(start, result({ context: 'y'.repeat(50_000) })).stdout);
    const hso = r['hookSpecificOutput'] as Record<string, string>;
    expect(hso['additionalContext']).toHaveLength(10_000);
  });
});
