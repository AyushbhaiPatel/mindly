import { describe, expect, it } from 'vitest';
import { hasUnsafeChars } from '@mindly/core';
import { USER } from '../src/index.js';
import { event, setup, writeTool } from './helpers.js';

// U+FE0F (VS16) is part of ordinary emoji such as "⚠️" and "✔️".
const WARN = '⚠️';

describe('paths and prompts with format characters', () => {
  it('still refuses control characters and bidi overrides in a path', () => {
    for (const bad of ['a\u0000b', 'a\nb', 'a\u009bb', 'a\u202eb', 'a\u2066b']) {
      expect(hasUnsafeChars(bad)).toBe(true);
    }
  });

  it('accepts paths with emoji, ideographic variation sequences and flags', () => {
    const samples = {
      'docs/⚠️-notes.md': `docs/${WARN}-notes.md`,
      'src/✔️done.ts': 'src/✔️done.ts',
      'names/葛󠄀飾.md (IVS)': 'names/葛\u{E0100}飾.md',
      'flags/🏴󠁧󠁢󠁳󠁣󠁴󠁿.md (tag seq)':
        'flags/\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}.md',
    };
    const rejected = Object.entries(samples)
      .filter(([, v]) => hasUnsafeChars(v))
      .map(([k]) => k);
    expect(rejected).toEqual([]);
  });

  it('enforces a rule on a path with an emoji in it', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'src/generated is produced by codegen',
      scopePaths: ['src/generated/**'],
      source: USER,
      enforce: true,
    });
    const plain = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/generated/api.ts', 'x') }),
    );
    const emoji = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', {
        tool: writeTool(`src/generated/${WARN}api.ts`, 'x'),
      }),
    );
    expect(plain.decision).toBe('deny');
    expect(emoji.decision).toBe('deny');
  });

  it('warns two agents editing the same emoji-named file', async () => {
    const { root, mindly } = setup();
    const p = `docs/${WARN}-notes.md`;
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool(p, 'x') }),
    );
    const res = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool(p, 'y') }),
    );
    expect(res.context ?? '').toContain('Coordination warning');
  });

  const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

  it('does not store a token split by a variation selector in a prompt summary', async () => {
    const { root, mindly } = setup();
    const split = TOKEN.slice(0, 10) + '️' + TOKEN.slice(10);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: `use ${split} please` }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    const ev = mindly.store.events.query(pid, { types: ['prompt.submitted'] })[0]!;
    const summary = (ev.payload as { summary: string }).summary;
    expect(summary).not.toContain(TOKEN);
  });
});
