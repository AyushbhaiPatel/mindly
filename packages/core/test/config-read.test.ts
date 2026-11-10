import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadProjectConfig, readRegularFileBounded, UserConfigSchema } from '../src/config.js';

describe('llm settings', () => {
  it('reads an empty or blank model name as the default model', () => {
    for (const model of ['', '   ']) {
      const cfg = UserConfigSchema.parse({ llm: { provider: 'openai', model } });
      expect(cfg.llm.model).toBeUndefined();
    }
    expect(UserConfigSchema.parse({ llm: { model: ' gpt-4.1-mini ' } }).llm.model).toBe(
      'gpt-4.1-mini',
    );
  });
});

describe('bounded config reads', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses symlinks to devices and FIFOs without hanging',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'syn-cfg-'));
      mkdirSync(join(dir, '.mindly'));
      symlinkSync('/dev/zero', join(dir, '.mindly', 'config.json'));
      expect(() => loadProjectConfig(join(dir, '.mindly', 'config.json'))).toThrow(/regular file/);
      const fifo = join(dir, 'fifo');
      execFileSync('mkfifo', [fifo]);
      expect(() => readRegularFileBounded(fifo, 1024)).toThrow(/regular file/);
    },
  );

  it('caps the number of bytes read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syn-cfg-'));
    writeFileSync(join(dir, 'big.json'), 'x'.repeat(5000));
    expect(() => readRegularFileBounded(join(dir, 'big.json'), 1000)).toThrow(/too large/);
    expect(readRegularFileBounded(join(dir, 'big.json'), 10_000)).toHaveLength(5000);
  });
});
