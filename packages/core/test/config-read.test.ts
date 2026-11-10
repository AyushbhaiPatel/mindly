import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  loadProjectConfig,
  loadUserConfig,
  readRegularFileBounded,
  readUserConfig,
  UserConfigSchema,
} from '../src/config.js';
import { redactText } from '../src/redact.js';

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

describe('redaction settings that cannot be used', () => {
  const bad = ['', ' ', 'a*', 'x?', '(?:)', '|ACME', '['];

  it('refuses patterns that are empty, invalid or match empty text', () => {
    for (const pattern of bad) {
      const r = UserConfigSchema.safeParse({ redaction: { extraPatterns: [pattern] } });
      expect(r.success, JSON.stringify(pattern)).toBe(false);
    }
    for (const glob of ['', '  ', 'config/{prod,staging.json']) {
      const r = UserConfigSchema.safeParse({ redaction: { denyPaths: [glob] } });
      expect(r.success, JSON.stringify(glob)).toBe(false);
    }
    const ok = UserConfigSchema.safeParse({
      redaction: {
        extraPatterns: ['ACME-[A-Z0-9]{20,40}'],
        denyPaths: ['config/{prod,staging}.json'],
      },
    });
    expect(ok.success).toBe(true);
  });

  it('loads a hand-edited file without them, and says what was ignored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syn-cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        hooks: { timeoutMs: 1000 },
        redaction: {
          extraPatterns: ['', 'ACME-[A-Z0-9]{20,40}', ' '],
          denyPaths: ['secrets/**', 'config/{prod'],
        },
      }),
    );
    const { config, warnings } = readUserConfig(file);
    expect(config.redaction.extraPatterns).toEqual(['ACME-[A-Z0-9]{20,40}']);
    expect(config.redaction.denyPaths).toEqual(['secrets/**']);
    expect(config.hooks.timeoutMs).toBe(1000);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('redaction.extraPatterns: ignored the pattern ""');
    expect(warnings.join('\n')).toContain('redaction.denyPaths: ignored the glob "config/{prod"');
    // What is left redacts as meant, and leaves other text alone.
    const text = 'key ACME-ABCDEFGHIJKLMNOPQRST1 and Use pnpm';
    expect(redactText(text, { extraPatterns: loadUserConfig(file).redaction.extraPatterns })).toBe(
      'key [REDACTED] and Use pnpm',
    );
  });
});
