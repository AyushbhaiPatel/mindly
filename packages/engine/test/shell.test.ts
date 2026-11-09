import { describe, expect, it } from 'vitest';
import {
  mentionsPath,
  namesPathOrParent,
  normalizeCommandLine,
  shellMayWrite,
  shellWriteTargets,
} from '../src/hooks/shell.js';

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
      'cat src/auth.ts 2>/dev/null',
      'cat src/auth.ts || true',
      'sed -n 1,40p src/auth.ts',
      'grep -n login src/auth.ts | sort | uniq',
      'cd src && cat auth.ts',
    ]) {
      expect(shellMayWrite(cmd, 'src/auth.ts'), cmd).toBe(false);
    }
  });
});

describe('write targets of a shell command', () => {
  const targets = (command: string) =>
    shellWriteTargets(command)
      .filter((t) => t.certain)
      .map((t) => t.path)
      .sort();
  const possible = (command: string) =>
    shellWriteTargets(command)
      .filter((t) => !t.certain)
      .map((t) => t.path)
      .sort();

  it('finds none in commands that read, check or only move streams', () => {
    for (const cmd of [
      'cat src/api/billing.ts',
      'cat src/api/billing.ts 2>/dev/null',
      'cat src/api/billing.ts || true',
      'sed -n 1,40p src/api/billing.ts',
      'grep -n plan src/api/billing.ts | sort | uniq',
      'npx vitest run src/api/billing.test.ts',
      'pnpm vitest run src/api/billing.test.ts',
      'pnpm test -- src/api/billing.test.ts',
      'npx tsc --noEmit -p src/api/tsconfig.json',
      'eslint src/api',
      'prettier --check "src/**/*.ts"',
      'python -m pytest tests/test_api.py',
      'git diff main -- src/api/billing.ts',
      'git add src/api/billing.ts && git commit -m "x"',
      'cmd 2>&1 >/dev/null',
      "cat <<'EOF'\nrm -rf src/api\necho x > src/api/billing.ts\nEOF",
    ]) {
      expect(shellWriteTargets(cmd), cmd).toEqual([]);
    }
  });

  it('finds redirections, with or without spaces and after a file descriptor', () => {
    expect(targets('echo x>src/api/billing.ts')).toEqual(['src/api/billing.ts']);
    expect(targets('echo all: > Makefile')).toEqual(['Makefile']);
    expect(targets('cat tpl >> src/app/page.ts 2>&1')).toEqual(['src/app/page.ts']);
    expect(targets('make &> build.log')).toEqual(['build.log']);
    expect(targets('git diff main -- src/a.ts > /tmp/a.diff')).toEqual(['/tmp/a.diff']);
    expect(targets("cat <<'EOF' > notes.md\nrm other.md\nEOF")).toEqual(['notes.md']);
  });

  it('finds what writing programs are given', () => {
    expect(targets("sed -i 's/a/b/' src/auth.ts")).toEqual(['src/auth.ts']);
    expect(targets('sed -i "" s/a/b/ src/auth.ts')).toEqual(['src/auth.ts']);
    expect(targets('perl -pi -e s/a/b/ src/auth.ts')).toEqual(['src/auth.ts']);
    expect(targets('cat a | tee src/auth.ts')).toEqual(['src/auth.ts']);
    expect(targets('rm -rf src/api')).toEqual(['src/api']);
    expect(targets('FOO=1 sudo rm a.txt')).toEqual(['a.txt']);
    expect(targets('if [ -f a.txt ]; then rm a.txt; fi')).toEqual(['a.txt']);
    expect(targets('mv draft.ts src/auth.ts')).toEqual(['draft.ts', 'src/auth.ts']);
    expect(targets('dd if=/dev/zero of=src/generated/api.ts')).toEqual(['src/generated/api.ts']);
    expect(targets('git checkout -- src/auth.ts')).toEqual(['src/auth.ts']);
    expect(targets('git -C packages/web restore src/a.ts')).toEqual(['packages/web/src/a.ts']);
    expect(targets('eslint --fix src/a.ts')).toEqual(['src/a.ts']);
    expect(targets('chmod +x scripts/run.sh')).toEqual(['scripts/run.sh']);
  });

  it('reports where copies land when the destination is a directory', () => {
    const [cp] = shellWriteTargets('cp a.ts b.ts src/generated');
    expect(cp).toMatchObject({ path: 'src/generated', entries: ['a.ts', 'b.ts'], certain: true });
    const [into] = shellWriteTargets('cp --target-directory=src/generated a.ts');
    expect(into).toMatchObject({ path: 'src/generated', entries: ['a.ts'] });
  });

  it('follows cd, the working directory variable, wildcards and nested commands', () => {
    expect(targets('cd src/api && sed -i s/a/b/ billing.ts')).toEqual(['src/api/billing.ts']);
    expect(targets('cd src; cd ..; rm a.ts')).toEqual(['a.ts']);
    expect(targets('echo y > $PWD/src/generated/api.ts')).toEqual(['src/generated/api.ts']);
    expect(targets('echo y > "${PWD}/a b.ts"')).toEqual(['a b.ts']);
    expect(shellWriteTargets('rm src/generated/*.ts')).toEqual([
      { path: 'src/generated/*.ts', glob: true, tree: true, certain: true, entries: [] },
    ]);
    expect(shellWriteTargets("rm 'src/[id]/*.ts'")[0]).toMatchObject({ glob: false });
    expect(targets('bash -c "echo x > a/b.ts"')).toEqual(['a/b.ts']);
    expect(targets('echo $(rm a/b.ts)')).toEqual(['a/b.ts']);
    // Where a `cd` leads cannot be read: relative targets after it are unknown.
    expect(targets('cd "$DIR" && rm a.ts')).toEqual([]);
    expect(targets('rm "$FILE" ~/x.ts')).toEqual([]);
  });

  it('marks paths given to unknown programs as possible, not certain', () => {
    expect(targets('node scripts/gen.js src/generated/api.ts')).toEqual([]);
    // The script an interpreter runs is read, not written.
    expect(possible('node scripts/gen.js src/generated/api.ts')).toEqual(['src/generated/api.ts']);
    expect(possible('psql -f prisma/migrations/001.sql')).toEqual(['prisma/migrations/001.sql']);
    expect(possible('mytool --out=dist/a.js')).toEqual(['dist/a.js']);
    expect(possible('curl https://example.com/a.json')).toEqual([]);
    expect(targets(`python -c "open('src/generated/api.ts','w').write('x')"`)).toEqual([
      'src/generated/api.ts',
    ]);
    expect(possible(`python -c "print(open('src/generated/api.ts').read())"`)).toEqual([
      'src/generated/api.ts',
    ]);
  });

  it('never throws and stays bounded on hostile input', () => {
    for (const cmd of ['', "'", '"', '$(', '`', '<<', '>', '> >', '$((', 'a\\', '{', ')))', '&>']) {
      expect(() => shellWriteTargets(cmd), cmd).not.toThrow();
    }
    const many = Array.from({ length: 500 }, (_, i) => `rm f${i}.ts`).join('; ');
    expect(shellWriteTargets(many).length).toBeLessThanOrEqual(60);
    const started = performance.now();
    shellWriteTargets(`${'$('.repeat(5000)}rm a.ts`);
    shellWriteTargets('x '.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('matches a path by a directory above it', () => {
    expect(namesPathOrParent('rm -rf migrations', 'migrations/001.sql')).toBe(true);
    expect(namesPathOrParent('rm -rf ./src/generated/', 'src/generated/a/b.ts')).toBe(true);
    expect(namesPathOrParent('rm -rf src/gen', 'src/generated/a.ts')).toBe(false);
    expect(namesPathOrParent('npm run build', 'src/generated/a.ts')).toBe(false);
  });
});
