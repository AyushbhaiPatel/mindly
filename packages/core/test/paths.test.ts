import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deniedPathTest,
  ensureHome,
  isDeniedPath,
  resolveInsideRoot,
  mindlyHome,
} from '../src/paths.js';

describe('resolveInsideRoot', () => {
  const root = mkdtempSync(join(tmpdir(), 'syn-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'syn-out-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), '');
  symlinkSync(outside, join(root, 'escape'));

  it('resolves relative and absolute paths inside the root', () => {
    expect(resolveInsideRoot(root, 'src/a.ts').rel).toBe('src/a.ts');
    expect(resolveInsideRoot(root, join(root, 'src/a.ts')).rel).toBe('src/a.ts');
    expect(resolveInsideRoot(root, 'src/new/file.ts').rel).toBe('src/new/file.ts');
  });

  it('keeps names that only start with dots inside the root', () => {
    expect(resolveInsideRoot(root, '..cache/a.ts').rel).toBe('..cache/a.ts');
    expect(resolveInsideRoot(root, join(root, '...', 'b.ts')).rel).toBe('.../b.ts');
    expect(() => resolveInsideRoot(root, '..')).toThrow(/outside/);
    expect(() => resolveInsideRoot(root, '../..cache/a.ts')).toThrow(/outside/);
  });

  it('rejects traversal, symlink escapes and NUL bytes', () => {
    expect(() => resolveInsideRoot(root, '../etc/passwd')).toThrow(/outside/);
    expect(() => resolveInsideRoot(root, '/etc/passwd')).toThrow(/outside/);
    expect(() => resolveInsideRoot(root, 'escape/x')).toThrow(/outside/);
    expect(() => resolveInsideRoot(root, 'a\0b')).toThrow(/NUL/);
  });

  it('places a long path that is not there in time that grows with its length', () => {
    const best = (parts: number): number => {
      const input = `${'b/'.repeat(parts)}f`;
      let fastest = Infinity;
      for (let k = 0; k < 5; k++) {
        const started = performance.now();
        expect(resolveInsideRoot(root, input).rel).toBe(input);
        fastest = Math.min(fastest, performance.now() - started);
      }
      return fastest;
    };
    // Four times the parts may take four times as long, give or take; a walk that starts over
    // at each part takes sixteen. Measured against the shorter path, so a slow machine passes.
    const short = best(500);
    const long = best(2000);
    expect(long).toBeLessThan(Math.max(8 * short, 5));
    expect(long).toBeLessThan(250);
  });
});

describe('home', () => {
  it('requires an absolute MINDLY_HOME', () => {
    expect(() => mindlyHome({ MINDLY_HOME: 'rel' })).toThrow();
    expect(mindlyHome({ MINDLY_HOME: '/tmp/x' })).toBe('/tmp/x');
  });

  it.skipIf(process.platform === 'win32')('creates owner-only directories', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'syn-home-')), 'h');
    ensureHome(home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });
});

describe('isDeniedPath', () => {
  it.each(['.env', 'config/.env.production', 'keys/server.pem', 'home/.ssh/config', '.npmrc'])(
    'denies %s',
    (p) => expect(isDeniedPath(p)).toBe(true),
  );
  it('allows normal source and custom deny-lists', () => {
    expect(isDeniedPath('src/env.ts')).toBe(false);
    expect(isDeniedPath('vault/x.txt', ['vault/**'])).toBe(true);
  });
  it('says the same when compiled once for many paths', () => {
    const extra = [
      'vault/**',
      '*.sqlite',
      'docs/{a,b}.md',
      'build/x?.bin',
      'config/{local,prod/secret}.json',
    ];
    const denied = deniedPathTest(extra);
    for (const p of [
      '.env',
      './.env',
      'config/.env.production',
      'keys/server.pem',
      'keys/SERVER.PEM',
      'home/.ssh/config',
      '.npmrc',
      'src/env.ts',
      'src/pem.ts',
      'vault/x.txt',
      'a/vault/x.txt',
      'data/app.sqlite',
      'docs/a.md',
      'docs/c.md',
      'build/x1.bin',
      'build/x12.bin',
      'secrets/k.txt',
      'SECRETS/k.txt',
      'config/local.json',
      'config/prod/secret.json',
      'config/other.json',
    ]) {
      expect(denied(p), p).toBe(isDeniedPath(p, extra));
    }
  });
});

describe('security regressions', () => {
  it('matches the deny-list case-insensitively', () => {
    expect(isDeniedPath('.ENV')).toBe(true);
    expect(isDeniedPath('SECRETS/k.txt')).toBe(true);
    expect(isDeniedPath('Keys/Server.PEM')).toBe(true);
  });

  it('rejects paths with control or bidi characters', () => {
    const root = mkdtempSync(join(tmpdir(), 'syn-ctl-'));
    expect(() => resolveInsideRoot(root, 'a\nb')).toThrow(/control/);
    expect(() => resolveInsideRoot(root, `a${String.fromCharCode(0x202e)}b`)).toThrow(/control/);
  });
});
