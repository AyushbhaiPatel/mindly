import { describe, expect, it } from 'vitest';
import { mentionsPath, normalizeCommandLine, shellMayWrite } from '../src/hooks/shell.js';

describe('shell command reading (saves evidence)', () => {
  it('normalizes whitespace only', () => {
    expect(normalizeCommandLine('  npm   test\t--ci ')).toBe('npm test --ci');
    expect(normalizeCommandLine('npm test')).not.toBe(normalizeCommandLine('npm test --ci'));
  });

  it('finds the path or its basename as a word', () => {
    expect(mentionsPath('sed -i s/a/b/ src/auth.ts', 'src/auth.ts')).toBe(true);
    expect(mentionsPath('cp x auth.ts', 'src/auth.ts')).toBe(true);
    expect(mentionsPath('cp x /repo/src/auth.ts', 'src/auth.ts')).toBe(true);
    expect(mentionsPath('cp x oauth.ts', 'src/auth.ts')).toBe(false);
    expect(mentionsPath('cp x auth.tsx', 'src/auth.ts')).toBe(false);
  });

  it('treats commands that may write a named file as writes', () => {
    for (const cmd of [
      "sed -i 's/a/b/' src/auth.ts",
      'cp x src/generated/api.ts',
      'mv draft.ts src/auth.ts',
      'echo x > src/auth.ts',
      'cat a | tee src/auth.ts',
      'git checkout -- src/auth.ts',
      'perl -pi -e s/a/b/ src/auth.ts',
      'cat src/auth.ts > /tmp/x',
    ]) {
      expect(
        shellMayWrite(cmd, cmd.includes('api.ts') ? 'src/generated/api.ts' : 'src/auth.ts'),
        cmd,
      ).toBe(true);
    }
  });

  it('does not count reads, or commands that do not name the file', () => {
    for (const cmd of [
      'cat src/auth.ts',
      'grep -n login src/auth.ts 2>&1 | head -n 5',
      'git diff src/auth.ts',
      'wc -l src/auth.ts && ls src',
      'sed -i s/a/b/ src/other.ts',
    ]) {
      expect(shellMayWrite(cmd, 'src/auth.ts'), cmd).toBe(false);
    }
  });
});
