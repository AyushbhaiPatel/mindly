import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureHome, isDeniedPath, resolveInsideRoot, mindlyHome } from '../src/paths.js';

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

  it('rejects traversal, symlink escapes and NUL bytes', () => {
    expect(() => resolveInsideRoot(root, '../etc/passwd')).toThrow(/outside/);
    expect(() => resolveInsideRoot(root, '/etc/passwd')).toThrow(/outside/);
    expect(() => resolveInsideRoot(root, 'escape/x')).toThrow(/outside/);
    expect(() => resolveInsideRoot(root, 'a\0b')).toThrow(/NUL/);
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
  it.each([
    '.env',
    'config/.env.production',
    '.env-prod',
    'apps/web/.env_local',
    '.envrc',
    'keys/server.pem',
    'keys/id_dsa',
    'keys/id_ed25519.pub',
    'home/.ssh/config',
    '.npmrc',
  ])('denies %s', (p) => expect(isDeniedPath(p)).toBe(true));
  it('allows normal source and custom deny-lists', () => {
    expect(isDeniedPath('src/env.ts')).toBe(false);
    expect(isDeniedPath('src/.environment.ts')).toBe(false);
    expect(isDeniedPath('src/id_token.ts')).toBe(false);
    expect(isDeniedPath('vault/x.txt', ['vault/**'])).toBe(true);
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
