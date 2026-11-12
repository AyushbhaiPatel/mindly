import { describe, expect, it } from 'vitest';
import { redactText, sanitizeLine } from '@mindly/core';
import { event, setup, writeTool } from './helpers.js';

const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

describe('redaction keeps everything but the secret', () => {
  it('finds a secret split by a control character, so cleaning afterwards cannot rebuild it', () => {
    const split = TOKEN.slice(0, 10) + '\u0007' + TOKEN.slice(10);
    expect(sanitizeLine(redactText(`use ${split} please`))).not.toContain(TOKEN);
  });

  it('keeps a secret split by a control character out of the stored prompt summary', async () => {
    const { root, mindly } = setup();
    const split = TOKEN.slice(0, 10) + '\u000b' + TOKEN.slice(10);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: `use ${split} please` }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    const ev = mindly.store.events.query(pid, { types: ['prompt.submitted'] })[0]!;
    const summary = (ev.payload as { summary: string }).summary;
    expect(summary).not.toContain(TOKEN);
  });

  it('stores a prompt with joiners, variation selectors and soft hyphens as it was', async () => {
    const { root, mindly } = setup();
    const text = 'family 👨‍👩‍👧 · Persian می‌خواهم · name 葛\u{E0100}飾 · co­operate · ⚠️';
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'prompt', { prompt: text }));
    const pid = mindly.store.projects.list()[0]!.id;
    const ev = mindly.store.events.query(pid, { types: ['prompt.submitted'] })[0]!;
    expect((ev.payload as { prompt: string }).prompt).toBe(text);
  });
});

describe('paths shown to other agents', () => {
  it('carry no characters that render as nothing', async () => {
    const { root, mindly } = setup();
    const hidden = `docs/a\u200b\u200e\u{E0049}\u{E0067}\u{E006E}b.md`;
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool(hidden, 'x') }),
    );
    const res = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool(hidden, 'y') }),
    );
    const shown = res.context ?? '';
    expect(shown).toContain('Coordination warning');
    expect(shown).toContain('docs/ab.md');
    expect(shown).not.toMatch(/[\u200b\u200e]|[\u{E0000}-\u{E007F}]/u);
    const intents = mindly.store.intents.active(mindly.store.projects.list()[0]!.id);
    for (const i of intents) expect(i.summary).not.toMatch(/[\u200b\u200e]|[\u{E0000}-\u{E007F}]/u);
  });
});
