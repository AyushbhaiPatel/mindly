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
import { isDeniedPath } from '../src/paths.js';
import { redact, redactText } from '../src/redact.js';

describe('llm settings', () => {
  it('keeps an empty or blank model name as an empty one (the provider then uses its default)', () => {
    for (const model of ['', '   ']) {
      const cfg = UserConfigSchema.parse({ llm: { provider: 'openai', model } });
      // Kept, not dropped: `mindly config set llm.model ""` must still find the setting.
      expect(cfg.llm.model).toBe('');
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

describe('redaction settings that cannot be used', () => {
  const bad = [
    '',
    ' ',
    'a*',
    'x?',
    '(?:)',
    '|ACME',
    '[',
    '\\b',
    '(?=.)',
    '(?<=a)',
    '(?=x)',
    '$',
    '^',
    // Lookarounds on text the samples do not contain: they match nothing either.
    ...['(?=z)', '(?=password)', '(?=\\d{5})', '(?=AKIA)', '(?<=Z)', '\\B(?=q)', '(?:(?!x)|^)'],
    // Spaces at the ends are a typing mistake.
    ...[' ACME-\\d+', 'ACME-\\d+ '],
  ];

  it('refuses patterns that are empty, invalid or match empty text', () => {
    for (const pattern of bad) {
      const r = UserConfigSchema.safeParse({ redaction: { extraPatterns: [pattern] } });
      expect(r.success, JSON.stringify(pattern)).toBe(false);
    }
    for (const glob of ['', '  ', 'config/{prod,staging.json', 'config/*.secret ', ' build/**']) {
      const r = UserConfigSchema.safeParse({ redaction: { denyPaths: [glob] } });
      expect(r.success, JSON.stringify(glob)).toBe(false);
    }
    for (const pattern of [
      '\\bsecret\\b',
      'ACME-[A-Z0-9]{20,40}',
      'x+',
      '(?<=key=)\\w+',
      'password(?=:)\\S+',
      '\\u{1F511}',
      '[^]',
      '(?<tok>tk_\\w+)',
      'a{2}',
    ]) {
      const r = UserConfigSchema.safeParse({ redaction: { extraPatterns: [pattern] } });
      expect(r.success, pattern).toBe(true);
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

describe('redacting with a pattern that matches empty text', () => {
  it('never puts a marker where no text matched', () => {
    const text = 'my password is hunter2, password again';
    for (const pattern of ['(?=password)', '(?=z)', '(?=\\d{5})', '(?<=Z)', '\\B(?=q)']) {
      const r = redact(text, { extraPatterns: [pattern] });
      expect(r.text, pattern).toBe(text);
      expect(r.count, pattern).toBe(0);
    }
    // A pattern that can match either way only replaces what it really covers.
    expect(redactText('id: ab-12 x', { extraPatterns: ['ab-\\d*'] })).toBe('id: [REDACTED] x');
  });

  it('ignores it instead of marking every position', () => {
    for (const pattern of ['\\b', '(?=.)', '', 'a*']) {
      expect(redactText('deploy to prod', { extraPatterns: [pattern] }), pattern).toBe(
        'deploy to prod',
      );
    }
    expect(redactText('key ACME-1234 ok', { extraPatterns: ['\\bACME-\\d+\\b'] })).toBe(
      'key [REDACTED] ok',
    );
  });
});

describe('project config ignore globs', () => {
  it('leaves out a glob that does not parse, and says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syn-cfg-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ ignore: ['config/{prod', 'dist/**', ''] }));
    const loaded = loadProjectConfig(file);
    expect(loaded.config.ignore).toEqual(['dist/**']);
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings[0]).toContain('left out the glob "config/{prod"');
    expect(loaded.hash).toEqual(expect.any(String));
  });

  it('a path check skips a glob that does not parse instead of throwing', () => {
    expect(() => isDeniedPath('src/a.ts', ['config/{prod'])).not.toThrow();
    expect(isDeniedPath('src/a.ts', ['config/{prod'])).toBe(false);
    expect(isDeniedPath('dist/x.js', ['config/{prod', 'dist/**'])).toBe(true);
    expect(isDeniedPath('.env', ['config/{prod'])).toBe(true);
  });
});
