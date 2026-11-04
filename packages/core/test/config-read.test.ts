import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadProjectConfig, readRegularFileBounded } from '../src/config.js';

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
