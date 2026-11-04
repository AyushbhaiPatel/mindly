import { describe, expect, it } from 'vitest';
import { isMindlyError } from '@mindly/core';
import {
  assertSafeRelativePath,
  assertValidBranchName,
  assertValidRevision,
  assertValidSnapshotId,
  hardenedGitEnv,
  isValidRefName,
  parseGitVersion,
  runGit,
  versionAtLeast,
} from '../src/index.js';
import { makeRepo, tempDir } from './helpers.js';

describe('ref name validation', () => {
  it.each([
    '-x',
    '--upload-pack=evil',
    'a..b',
    'refs/../x',
    'a b',
    'a\tb',
    'a\nb',
    'a\u0001b',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    '/a',
    'a/',
    'a//b',
    'a.',
    '.a',
    'refs/.hidden',
    'a.lock',
    'refs/heads/x.lock/y',
    'a@{1}',
    '@',
    '',
  ])('rejects %j', (name) => {
    expect(isValidRefName(name)).toBe(false);
  });

  it.each(['main', 'feature/x-1', 'refs/heads/main', 'v1.2.3', 'a@b', 'user/foo_bar'])(
    'accepts %j',
    (name) => expect(isValidRefName(name)).toBe(true),
  );

  it('throws typed errors for branch names, revisions and snapshot ids', () => {
    const codeOf = (fn: () => void): string | undefined => {
      try {
        fn();
        return undefined;
      } catch (err) {
        return isMindlyError(err) ? err.code : 'other';
      }
    };
    expect(codeOf(() => assertValidBranchName('-x'))).toBe('invalid_input');
    expect(codeOf(() => assertValidBranchName('HEAD'))).toBe('invalid_input');
    expect(codeOf(() => assertValidBranchName('ok/branch'))).toBeUndefined();
    expect(codeOf(() => assertValidRevision('HEAD~1'))).toBe('invalid_input');
    expect(codeOf(() => assertValidRevision('abc123'))).toBeUndefined();
    expect(codeOf(() => assertValidSnapshotId('../x'))).toBe('invalid_input');
    expect(codeOf(() => assertValidSnapshotId('snap_01-a'))).toBeUndefined();
  });

  it('validates repository-relative paths', () => {
    expect(assertSafeRelativePath('src/a.ts')).toBe('src/a.ts');
    for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a//b', '.git/config', 'a\0b', 'C:/x']) {
      expect(() => assertSafeRelativePath(bad), bad).toThrow();
    }
  });
});

describe('runGit', () => {
  it('builds a minimal hardened environment', () => {
    const env = hardenedGitEnv(
      { GIT_INDEX_FILE: '/tmp/i' },
      { PATH: '/bin', HOME: '/h', GIT_DIR: '/evil', GIT_SSH_COMMAND: 'evil', SECRET_TOKEN: 'x' },
    );
    expect(env['PATH']).toBe('/bin');
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GIT_INDEX_FILE']).toBe('/tmp/i');
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env['GIT_SSH_COMMAND']).toBeUndefined();
    expect(env['SECRET_TOKEN']).toBeUndefined();
    expect(() => hardenedGitEnv({ 'bad key': 'x' })).toThrow();
  });

  it('runs git and applies the hardening config', async () => {
    const root = makeRepo();
    const hooks = await runGit(['config', '--get', 'core.hooksPath'], { cwd: root });
    expect(hooks.stdout.trim()).toBe('/dev/null');
    const proto = await runGit(['config', '--get', 'protocol.allow'], { cwd: root });
    expect(proto.stdout.trim()).toBe('never');
  });

  it('maps failures to typed errors without echoing arguments', async () => {
    const root = makeRepo();
    await expect(
      runGit(['rev-parse', '--verify', 'secret-value-xyz'], { cwd: root }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMindlyError(err, 'internal') &&
        !err.message.includes('secret-value-xyz') &&
        err.message.includes('rev-parse'),
    );
    await expect(runGit(['status'], { cwd: 'relative/dir' })).rejects.toSatisfy((err: unknown) =>
      isMindlyError(err, 'invalid_input'),
    );
    await expect(runGit(['status'], { cwd: '/definitely/not/here' })).rejects.toSatisfy(
      (err: unknown) => isMindlyError(err, 'not_found'),
    );
    const notRepo = tempDir();
    const res = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: notRepo,
      okExitCodes: [128],
    });
    expect(res.exitCode).toBe(128);
  });

  it('refuses arguments containing NUL bytes', async () => {
    const root = makeRepo();
    await expect(runGit(['log', 'a\0b'], { cwd: root })).rejects.toSatisfy((err: unknown) =>
      isMindlyError(err, 'invalid_input'),
    );
  });

  it('parses git versions', () => {
    const v = parseGitVersion('git version 2.39.3 (Apple Git-145)');
    expect(v).toMatchObject({ major: 2, minor: 39, patch: 3 });
    expect(versionAtLeast(v, 2, 38)).toBe(true);
    expect(versionAtLeast(v, 2, 40)).toBe(false);
    expect(versionAtLeast(parseGitVersion('git version 3.0'), 2, 99)).toBe(true);
  });
});
