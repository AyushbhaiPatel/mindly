import { describe, expect, it } from 'vitest';
import { cli, sandbox } from './helpers.js';

describe('mindly config and the model settings', () => {
  it('lets the user clear the model name to go back to the default', async () => {
    const sb = sandbox();
    expect((await cli(sb, ['config', 'set', 'llm.model', '"gpt-4.1"'])).code).toBe(0);
    const cleared = await cli(sb, ['config', 'set', 'llm.model', '""']);
    expect(cleared.stderr).toBe('');
    expect(cleared.code).toBe(0);
    expect((await cli(sb, ['config', 'get', 'llm.model'])).stdout.trim()).toBe('""');
  });
});
