import { describe, expect, it } from 'vitest';
import { isLiteralScope, patternsMayOverlap } from '../src/hooks/scope.js';
import {
  mentionsPath,
  namesPathOrParent,
  normalizeCommandLine,
  pathNamer,
  readShellWrites,
  shellMayWrite,
  shellWriteTargets,
  type ShellTarget,
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
  const HOME = '/home/dev';
  const TOP = '/work/app';
  const read = (command: string) => shellWriteTargets(command, { home: HOME, top: TOP });
  /** Targets the text shows as written: `path`, with `/**` for a whole tree and `*` wildcards kept. */
  const show = (t: ShellTarget): string[] => {
    const whole = t.tree ? [`${t.path}/**`] : [];
    if (t.entries.length === 0) return [t.path, ...whole];
    // A copy: each entry lands inside the directory.
    return t.entries.map((e) =>
      e === '.' ? `${t.path}/**` : `${t.path}/[${e}]${t.tree ? '/**' : ''}`,
    );
  };
  const targets = (command: string) =>
    read(command)
      .filter((t) => t.certain)
      .flatMap(show)
      .sort();
  const possible = (command: string) =>
    read(command)
      .filter((t) => !t.certain)
      .flatMap(show)
      .sort();

  it('finds nothing in commands that read, check or only move streams', () => {
    for (const cmd of [
      'cat src/api/billing.ts',
      'cat src/api/billing.ts 2>/dev/null',
      'cat src/api/billing.ts || true',
      'sed -n 1,40p src/api/billing.ts',
      "sed -n '/-i/p' certs/server.pem",
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
      // Flags that mean something else for the program that gets them.
      'jest -w 4 src',
      'tsc -w -p src',
      'vitest run -u',
      'prettier --check prisma -u',
      'eslint --fix-dry-run prisma',
      "perl -Mstrict -ne 'print' certs/server.pem",
      "perl -MList::Util=sum -lane 'print' prisma/migrations/001/migration.sql",
      // The index moves, the file on disk stays.
      'git restore --staged .',
      'git restore --staged certs/server.pem',
      'git rm --cached certs/server.pem',
      'git rm -r --cached .',
      'git reset -- certs/server.pem',
      'git clean -n -fdx prisma',
      // Branches, not files.
      'git checkout main',
      'git checkout -b feature/x',
      'git switch release/1.2',
      'git stash',
      'git stash pop',
      // Shell words that write nothing they name.
      'for f in src/*.ts; do echo $f; done',
      'export SSL_CERT_FILE=certs/server.pem',
      'NODE_EXTRA_CA_CERTS=certs/server.pem node x.js',
      'command -v rm',
      '[ certs/server.pem -nt README.md ] && echo newer',
      '[[ a > b ]] && echo x',
      'if (( 3 > 2 )); then echo ok; fi',
      'echo $((3 > 2))',
      'psql < prisma/migrations/001/migration.sql',
      'scp certs/server.pem host:/etc/',
      'rsync -a src/ host:/srv/app/',
      'tar tf a.tar',
      'find . -name "*.ts"',
      'find prisma -type f | wc -l',
      'sort names.txt',
    ]) {
      expect(read(cmd), cmd).toEqual([]);
    }
  });

  it('finds redirections, with or without spaces and after a file descriptor', () => {
    expect(targets('echo x>src/api/billing.ts')).toEqual(['src/api/billing.ts']);
    expect(targets('echo all: > Makefile')).toEqual(['Makefile']);
    expect(targets('cat tpl >> src/app/page.ts 2>&1')).toEqual(['src/app/page.ts']);
    expect(targets('make &> build.log')).toEqual(['build.log']);
    expect(targets('git diff main -- src/a.ts > /tmp/a.diff')).toEqual(['/tmp/a.diff']);
    expect(targets("cat <<'EOF' > notes.md\nrm other.md\nEOF")).toEqual(['notes.md']);
    expect(targets('exec 3> out.log')).toEqual(['out.log']);
    expect(targets("echo x > $'a b.ts'")).toEqual(['a b.ts']);
    expect(targets("echo $'it\\'s'; rm a.ts")).toEqual(['a.ts']);
  });

  it('finds what writing programs are given', () => {
    expect(targets("sed -i 's/a/b/' src/auth.ts")).toEqual(['src/auth.ts']);
    expect(targets('sed -i "" s/a/b/ src/auth.ts')).toEqual(['src/auth.ts']);
    expect(targets('perl -pi -e s/a/b/ src/auth.ts')).toEqual(['src/auth.ts']);
    expect(targets('perl -i.bak -pe s/a/b/ src/auth.ts')).toEqual(['src/auth.ts']);
    expect(targets('cat a | tee src/auth.ts')).toEqual(['src/auth.ts']);
    expect(targets('rm src/a.ts src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(targets('rm -rf src/api')).toEqual(['src/api', 'src/api/**']);
    expect(targets('if [ -f a.txt ]; then rm a.txt; fi')).toEqual(['a.txt']);
    expect(targets('mv draft.ts src/auth.ts')).toEqual([
      'draft.ts',
      'draft.ts/**',
      'src/auth.ts/[draft.ts]/**',
    ]);
    expect(targets('dd if=/dev/zero of=src/generated/api.ts')).toEqual(['src/generated/api.ts']);
    expect(targets('sort -o names.txt names.txt')).toEqual(['names.txt']);
    expect(targets('sort --output=out.txt names.txt')).toEqual(['out.txt']);
    expect(targets('gzip notes.md')).toEqual(['notes.md']);
    expect(targets('tar czf out.tgz src')).toEqual(['out.tgz']);
    expect(targets('eslint --fix src/a.ts')).toEqual(['src/a.ts']);
    expect(targets('prettier -w src/a.ts')).toEqual(['src/a.ts']);
    // A change of mode leaves the content alone: a possible write, not a certain one.
    expect(targets('chmod +x scripts/run.sh')).toEqual([]);
    expect(possible('chmod +x scripts/run.sh')).toEqual(['scripts/run.sh']);
    expect(possible('chmod -R 755 .')).toEqual(['.', './**']);
  });

  it('reads through launchers, with their own options and values', () => {
    for (const cmd of [
      'FOO=1 sudo rm a.txt',
      'sudo -u root rm a.txt',
      'sudo -u root -g wheel -- rm a.txt',
      'doas -u root rm a.txt',
      'nice -n 10 rm a.txt',
      'ionice -c3 rm a.txt',
      'ionice -c 3 -n 7 rm a.txt',
      'env -u FOO rm a.txt',
      'env FOO=1 BAR=2 rm a.txt',
      'timeout 5 rm a.txt',
      'timeout -s KILL 5 rm a.txt',
      'nohup rm a.txt',
      'stdbuf -o0 rm a.txt',
      'time -p rm a.txt',
      'command rm a.txt',
      'builtin command rm a.txt',
      'exec rm a.txt',
      'chronic rm a.txt',
      'xargs -n 1 rm a.txt',
      'sudo nice -n 5 timeout 10 rm a.txt',
    ]) {
      expect(targets(cmd), cmd).toEqual(['a.txt']);
    }
    // A launcher that moves the program to another directory moves its paths too.
    expect(targets('env -C prisma rm -rf migrations')).toEqual([
      'prisma/migrations',
      'prisma/migrations/**',
    ]);
    expect(targets('sudo --chdir=prisma rm a.sql; rm b.sql')).toEqual(['b.sql', 'prisma/a.sql']);
    expect(targets('builtin cd prisma && rm -rf migrations')).toEqual([
      'prisma/migrations',
      'prisma/migrations/**',
    ]);
  });

  it('knows which git subcommands rewrite the files they are given', () => {
    const tree = (p: string) => [p, `${p}/**`];
    expect(targets('git checkout -- src/auth.ts')).toEqual(tree('src/auth.ts'));
    expect(targets('git checkout .')).toEqual(tree('.'));
    expect(targets('git checkout HEAD~1 prisma')).toEqual(tree('prisma'));
    expect(targets('git checkout stash@{0} -- prisma/a.sql')).toEqual(tree('prisma/a.sql'));
    expect(targets('git restore src/')).toEqual(tree('src'));
    expect(targets('git restore --source=HEAD~1 prisma')).toEqual(tree('prisma'));
    expect(targets('git restore -s HEAD~1 --staged --worktree prisma')).toEqual(tree('prisma'));
    expect(targets('git rm -r prisma')).toEqual(tree('prisma'));
    expect(targets('git -c a=b rm -r prisma/migrations')).toEqual(tree('prisma/migrations'));
    expect(targets('git clean -fdx prisma')).toEqual(tree('prisma'));
    expect(targets('git clean -fdx')).toEqual([]);
    expect(targets('git mv prisma db')).toEqual(['db/[prisma]/**', 'prisma', 'prisma/**']);
    expect(targets('git -C packages/web restore src/a.ts')).toEqual(tree('packages/web/src/a.ts'));
    expect(targets('git stash push -- prisma/a.sql')).toEqual(tree('prisma/a.sql'));
    // One word after `checkout` is a branch or a path: only a possible write.
    expect(targets('git checkout prisma/a.sql')).toEqual([]);
    expect(possible('git checkout prisma/a.sql')).toEqual(tree('prisma/a.sql'));
  });

  it('reports where copies land', () => {
    expect(targets('cp a.ts b.ts src/generated')).toEqual([
      'src/generated/[a.ts]',
      'src/generated/[b.ts]',
    ]);
    expect(targets('cp --target-directory=src/generated a.ts')).toEqual(['src/generated/[a.ts]']);
    expect(targets('cp -t src/generated a.ts')).toEqual(['src/generated/[a.ts]']);
    expect(targets('ln -sf /tmp/x certs/new.pem')).toEqual(['certs/new.pem/[x]']);
    expect(targets('install -m 644 /tmp/x prisma/a.sql')).toEqual(['prisma/a.sql/[x]']);
    // A recursive copy writes the tree each source becomes; `dir/.` and rsync's `dir/` pour in.
    expect(targets('cp -R /tmp/migrations prisma/')).toEqual(['prisma/[migrations]/**']);
    expect(targets('cp -r /tmp/prisma .')).toEqual(['./[prisma]/**']);
    expect(targets('cp -a /tmp/prisma/. prisma/')).toEqual(['prisma/**']);
    expect(targets('rsync -a /tmp/prisma/ prisma/')).toEqual(['prisma/**']);
    expect(targets('rsync -a /tmp/prisma prisma/')).toEqual(['prisma/[prisma]/**']);
    expect(targets('rsync -a --delete --exclude node_modules /tmp/repo/ ./')).toEqual(['./**']);
    expect(targets('rsync -a -e "ssh -p 22" host:/srv/app/ app/')).toEqual(['app/**']);
  });

  it('finds the trees that find, tar and unzip write', () => {
    expect(targets('find prisma/migrations -type f -delete')).toEqual([
      'prisma/migrations',
      'prisma/migrations/**',
    ]);
    expect(targets('find prisma -type f -exec rm -f {} +')).toEqual(['prisma', 'prisma/**']);
    expect(targets("find a b -exec sed -i 's/x/y/' {} \\;")).toEqual(['a', 'a/**', 'b', 'b/**']);
    expect(targets('find -delete')).toEqual(['.', './**']);
    // One `-name` test narrows what is touched to what the name matches.
    expect(targets("find . -name '*.js' -delete")).toEqual(['**/*.js', '**/*.js/**']);
    expect(targets('find src -name "*.tmp" -exec rm {} \\;')).toEqual([
      'src/**/*.tmp',
      'src/**/*.tmp/**',
    ]);
    // A program it runs that Mindly does not know may change what it finds.
    expect(possible('find prisma -exec mytool {} \\;')).toEqual(['prisma', 'prisma/**']);
    expect(targets('find . -name "*.ts" -fprint list.txt')).toEqual(['list.txt']);
    expect(targets('tar xf a.tar -C prisma/migrations')).toEqual([
      'prisma/migrations',
      'prisma/migrations/**',
    ]);
    expect(targets('tar -xzf a.tgz --directory=vendor')).toEqual(['vendor', 'vendor/**']);
    expect(targets('unzip -o a.zip -d prisma/migrations')).toEqual([
      'prisma/migrations',
      'prisma/migrations/**',
    ]);
    // Unpacking over the current directory may or may not land on a file that matters.
    expect(targets('tar xzf a.tgz')).toEqual([]);
    expect(possible('tar xzf a.tgz')).toEqual(['.', './**']);
    expect(possible('unzip a.zip')).toEqual(['.', './**']);
  });

  it('follows cd, pushd and popd, each in the shell it runs in', () => {
    expect(targets('cd src/api && sed -i s/a/b/ billing.ts')).toEqual(['src/api/billing.ts']);
    expect(targets('cd src; cd ..; rm a.ts')).toEqual(['a.ts']);
    expect(targets('cd src && cd - && rm certs/server.pem')).toEqual(['certs/server.pem']);
    expect(targets('cd a; cd b; cd -; rm x.ts')).toEqual(['a/x.ts']);
    expect(targets('cd /tmp; cd "$OLDPWD"; rm a.ts')).toEqual(['a.ts']);
    expect(targets('pushd /tmp && popd && rm certs/server.pem')).toEqual(['certs/server.pem']);
    expect(targets('pushd a; pushd b; popd; rm x.ts; popd; rm y.ts')).toEqual(['a/x.ts', 'y.ts']);
    expect(targets('pushd a && rm x.ts')).toEqual(['a/x.ts']);
    // What follows `cd … ||` runs only when the cd failed.
    expect(targets('cd /tmp || rm a.ts')).toEqual(['a.ts']);
    // A cd in a pipeline or in the background changes nothing for what follows.
    expect(targets('cd src | cat; rm a.ts')).toEqual(['a.ts']);
    expect(targets('cd /tmp &\nrm a.ts')).toEqual(['a.ts']);
    // Where a `cd` leads cannot be read: relative targets after it are unknown.
    expect(targets('cd "$DIR" && rm a.ts')).toEqual([]);
    expect(targets('rm "$FILE"')).toEqual([]);
  });

  it('keeps a cd inside a subshell or a function from leaking out of it', () => {
    expect(targets('(cd a && rm x.ts); rm y.ts')).toEqual(['a/x.ts', 'y.ts']);
    expect(targets('cd a; (cd b && rm x.ts); rm y.ts')).toEqual(['a/b/x.ts', 'a/y.ts']);
    expect(targets('(cd a; (cd b; rm x.ts); rm y.ts); rm z.ts')).toEqual([
      'a/b/x.ts',
      'a/y.ts',
      'z.ts',
    ]);
    expect(targets('(cd "$DIR" && rm x.ts); rm y.ts')).toEqual(['y.ts']);
    expect(targets('f() { cd /tmp; }; rm a.ts')).toEqual(['a.ts']);
    expect(targets('function f { cd /tmp; }; rm a.ts')).toEqual(['a.ts']);
    expect(targets('f() { rm a.ts; }; f')).toEqual(['a.ts']);
    expect(targets('a() ( cd /tmp ); a; rm a.ts')).toEqual(['a.ts']);
    // Braces group commands in the same shell: the directory stays changed.
    expect(targets('{ cd a && rm x.ts; }; rm y.ts')).toEqual(['a/x.ts', 'a/y.ts']);
    // An unmatched `)` (a case pattern) closes nothing.
    expect(targets('cd a; case $x in y) rm x.ts;; esac; rm z.ts')).toEqual(['a/x.ts', 'a/z.ts']);
    expect(targets('cd prisma && echo ")" && rm a.sql')).toEqual(['prisma/a.sql']);
  });

  it('places the working directory, the home directory and the repository root', () => {
    expect(targets('echo y > $PWD/src/generated/api.ts')).toEqual(['src/generated/api.ts']);
    expect(targets('echo y > "${PWD}/a b.ts"')).toEqual(['a b.ts']);
    expect(targets('cd src && rm $PWD/a.ts')).toEqual(['src/a.ts']);
    expect(targets('rm $(pwd)/certs/server.pem')).toEqual(['certs/server.pem']);
    expect(targets('cd src && rm "`pwd`/a.ts"')).toEqual(['src/a.ts']);
    expect(targets('rm ~+/a.ts')).toEqual(['a.ts']);
    expect(targets('rm $HOME/app/a.ts')).toEqual([`${HOME}/app/a.ts`]);
    expect(targets('rm "${HOME}/app/a.ts"')).toEqual([`${HOME}/app/a.ts`]);
    expect(targets('cd $HOME/app && rm a.ts')).toEqual([`${HOME}/app/a.ts`]);
    expect(targets('rm $(git rev-parse --show-toplevel)/certs/server.pem')).toEqual([
      `${TOP}/certs/server.pem`,
    ]);
    expect(targets('cd "$(git rev-parse --show-toplevel)" && rm a.ts')).toEqual([`${TOP}/a.ts`]);
    expect(targets('rm ~/work/app/prisma/migrations/001.sql')).toEqual([
      `${HOME}/work/app/prisma/migrations/001.sql`,
    ]);
    expect(targets('echo x > ~/notes.md')).toEqual([`${HOME}/notes.md`]);
    expect(targets("cd ~/work/app && sed -i 's/a/b/' src/auth.ts")).toEqual([
      `${HOME}/work/app/src/auth.ts`,
    ]);
    expect(targets('cd ~ && rm a.ts')).toEqual([`${HOME}/a.ts`]);
    expect(targets('cd && rm a.ts')).toEqual([`${HOME}/a.ts`]);
    // A quoted `~` is a file name, not the home directory.
    expect(targets('rm "~/a.ts"')).toEqual(['~/a.ts']);
    expect(targets("rm '~'/a.ts")).toEqual(['~/a.ts']);
    expect(targets('rm \\~/a.ts')).toEqual(['~/a.ts']);
    // Another user's home cannot be placed here: the path is kept as written, not dropped.
    expect(targets('rm ~ci/app/a.ts')).toEqual(['~ci/app/a.ts']);
    expect(targets('cd ~ci/app && rm a.ts')).toEqual(['~ci/app/a.ts']);
    // Without a home or a root nothing is guessed.
    expect(shellWriteTargets('rm ~/x.ts').map((t) => t.path)).toEqual(['~/x.ts']);
    expect(shellWriteTargets('rm $HOME/x.ts').map((t) => t.path)).toEqual(['~/x.ts']);
    expect(shellWriteTargets('rm $(git rev-parse --show-toplevel)/x.ts')).toEqual([]);
    expect(shellWriteTargets('cd && rm a.ts')).toEqual([]);
  });

  it('reads wildcards as patterns', () => {
    expect(read('rm src/generated/*.ts')).toEqual([
      {
        path: 'src/generated/*.ts',
        glob: true,
        tree: false,
        certain: true,
        entries: [],
        only: null,
        ifExists: false,
      },
    ]);
    expect(read('rm -rf dist/*')[0]).toMatchObject({ path: 'dist/*', glob: true, tree: true });
    expect(read('rm -f *.log')[0]).toMatchObject({ path: '*.log', glob: true, tree: false });
    expect(read('rm src/{a,b}.ts')[0]).toMatchObject({ glob: true });
    expect(read("rm 'src/*.ts'")[0]).toMatchObject({ path: 'src/*.ts', glob: false });
    // A class stands for one character, and for itself when nothing matches.
    expect(read('rm certs/server.p[e]m').map((t) => [t.path, t.glob])).toEqual([
      ['certs/server.p?m', true],
      ['certs/server.p[e]m', false],
    ]);
    expect(read("rm 'src/[id]/page.tsx'").map((t) => [t.path, t.glob])).toEqual([
      ['src/[id]/page.tsx', false],
    ]);
  });

  it('reads code handed to a shell or an interpreter, however it gets there', () => {
    expect(targets('bash -c "echo x > a/b.ts"')).toEqual(['a/b.ts']);
    expect(targets("bash <<'EOF'\nrm certs/server.pem\nEOF")).toEqual(['certs/server.pem']);
    expect(targets('sh <<EOF\ncd prisma && rm a.sql\nEOF\nrm b.sql')).toEqual([
      'b.sql',
      'prisma/a.sql',
    ]);
    expect(targets("bash <<< 'rm certs/server.pem'")).toEqual(['certs/server.pem']);
    expect(targets("echo 'rm certs/server.pem' | bash")).toEqual(['certs/server.pem']);
    expect(targets("cat <<'EOF' | sh\nrm certs/server.pem\nEOF")).toEqual(['certs/server.pem']);
    expect(targets('eval "rm a.ts"')).toEqual(['a.ts']);
    expect(targets("trap 'rm a.ts' EXIT")).toEqual(['a.ts']);
    expect(targets("alias x='rm a.ts'; x")).toEqual(['a.ts']);
    const py = "open('certs/server.pem','w').write('x')";
    expect(targets(`python -c "${py}"`)).toEqual(['certs/server.pem']);
    expect(targets(`python3 - <<EOF\n${py}\nEOF`)).toEqual(['certs/server.pem']);
    expect(targets("node <<'EOF'\nrequire('fs').writeFileSync('a/b.ts', '')\nEOF")).toEqual([
      'a/b.ts',
    ]);
    expect(targets('ruby -e "File.delete(\'a/b.rb\')"')).toEqual(['a/b.rb']);
    expect(targets('php -r "unlink(\'a/b.php\');"')).toEqual(['a/b.php']);
    expect(targets('deno eval "Deno.removeSync(\'a/b.ts\')"')).toEqual(['a/b.ts']);
    expect(targets("bun -e \"require('fs').rmSync('a/b.ts')\"")).toEqual(['a/b.ts']);
    expect(targets(`perl -e 'open(F,">a/b.txt")'`)).toEqual(['a/b.txt']);
    expect(targets(`python3 -c "import os; os.system('rm a/b.ts')"`)).toEqual(['a/b.ts']);
    // Code that only reads names the file without writing it.
    expect(targets(`python -c "print(open('a/b.ts').read())"`)).toEqual([]);
    expect(possible(`python -c "print(open('a/b.ts').read())"`)).toEqual(['a/b.ts']);
  });

  it('reads substitutions where they are written, quotes and all', () => {
    expect(targets('echo $(rm a/b.ts)')).toEqual(['a/b.ts']);
    expect(targets('x=$(rm certs/server.pem); cd /tmp && ls')).toEqual(['certs/server.pem']);
    expect(targets('echo `rm certs/server.pem`; cd /tmp')).toEqual(['certs/server.pem']);
    expect(targets('cd a; echo $(rm x.ts); cd ..; echo $(rm y.ts)')).toEqual(['a/x.ts', 'y.ts']);
    // A `)` inside quotes does not end the substitution.
    expect(targets("echo $(echo ')'); rm certs/server.pem")).toEqual(['certs/server.pem']);
    expect(targets('echo "$(echo ")")"; rm a.ts')).toEqual(['a.ts']);
    // The shell expands a here-document whose delimiter is not quoted.
    expect(targets('cat <<EOF\n$(rm a.ts)\nEOF')).toEqual(['a.ts']);
    expect(targets("cat <<'EOF'\n$(rm a.ts)\nEOF")).toEqual([]);
  });

  it('knows what a formatter rewrites, and only with its own fixing flag', () => {
    expect(read('prettier --write .')[0]).toMatchObject({ path: '.', tree: true, certain: true });
    expect(read('prettier --write .')[0]?.only).toContain('ts');
    expect(read('prettier --write .')[0]?.only).not.toContain('pem');
    expect(read('eslint --fix src')[0]).toMatchObject({ path: 'src', tree: true });
    expect(read('prettier --write "src/**/*.ts"')[0]).toMatchObject({ glob: true });
    expect(read('ruff check --fix app')[0]).toMatchObject({
      path: 'app',
      only: ['py', 'pyi', 'ipynb'],
    });
    expect(read('ruff format app')[0]).toMatchObject({ path: 'app', certain: true });
    expect(read('ruff format --check app')).toEqual([]);
    expect(read('black prisma')[0]).toMatchObject({ path: 'prisma', only: ['py', 'pyi'] });
    expect(read('gofmt -w prisma')[0]).toMatchObject({ path: 'prisma', only: ['go'] });
    expect(read('gofmt -l prisma')).toEqual([]);
    // A file of a kind the tool does not rewrite is only a possible write.
    expect(targets('prettier --write prisma/a.sql')).toEqual([]);
    expect(possible('prettier --write prisma/a.sql')).toEqual(['prisma/a.sql']);
    expect(targets('pnpm exec prettier --write src/a.ts')).toEqual(['src/a.ts']);
    expect(targets('npx eslint --fix src/a.ts')).toEqual(['src/a.ts']);
  });

  it('marks what unknown programs are given as possible, a directory with all it holds', () => {
    expect(targets('node scripts/gen.js src/generated/api.ts')).toEqual([]);
    // The script an interpreter runs is read, not written.
    expect(possible('node scripts/gen.js src/generated/api.ts')).toEqual([
      'src/generated/api.ts',
      'src/generated/api.ts/**',
    ]);
    expect(possible('psql -f prisma/migrations/001.sql').slice(0, 1)).toEqual([
      'prisma/migrations/001.sql',
    ]);
    expect(possible('mytool --out=dist/a.js').slice(0, 1)).toEqual(['dist/a.js']);
    expect(possible('curl https://example.com/a.json')).toEqual([]);
    expect(read('rimraf prisma/migrations')[0]).toMatchObject({ tree: true, certain: false });
    // A bare word is a path only if such a file exists, which the caller checks.
    expect(read('rimraf prisma')).toEqual([
      {
        path: 'prisma',
        glob: false,
        tree: true,
        certain: false,
        entries: [],
        only: null,
        ifExists: true,
      },
    ]);
    expect(read('docker compose up -d').every((t) => t.ifExists)).toBe(true);
    // Package managers run scripts: what they are given is not what they write.
    expect(read('pnpm install')).toEqual([]);
    expect(read('npm run build')).toEqual([]);
  });

  it('says when a limit cut the reading short', () => {
    expect(readShellWrites('rm a.ts')).toEqual({ targets: [expect.anything()], limit: null });
    const many = Array.from({ length: 700 }, (_, i) => `rm f${i}.ts`).join('; ');
    const cut = readShellWrites(many);
    expect(cut.targets).toHaveLength(500);
    expect(cut.limit).toContain('500');
    // The 61st target is no longer lost.
    const some = readShellWrites(Array.from({ length: 80 }, (_, i) => `rm f${i}.ts`).join('; '));
    expect(some.targets).toHaveLength(80);
    expect(some.limit).toBeNull();
    const long = `${'echo padding; '.repeat(20_000)}rm certs/server.pem`;
    expect(long.length).toBeGreaterThan(200_000);
    expect(readShellWrites(long).limit).toContain('200000');
    const medium = `${'echo padding; '.repeat(2000)}rm certs/server.pem`;
    expect(medium.length).toBeGreaterThan(20_000);
    expect(readShellWrites(medium)).toMatchObject({
      targets: [{ path: 'certs/server.pem' }],
      limit: null,
    });
    const deep = 'bash -c "bash -c \\"bash -c \\\\\\"bash -c x\\\\\\"\\""';
    expect(() => readShellWrites(deep)).not.toThrow();
    expect(readShellWrites('eval eval eval eval eval eval rm a.ts').limit).toContain('nested');
  });

  it('never throws and stays fast on hostile input', () => {
    for (const cmd of [
      '',
      "'",
      '"',
      '$(',
      '`',
      '<<',
      '>',
      '> >',
      '$((',
      'a\\',
      '{',
      ')))',
      '&>',
      "$'",
      '((',
      '<<<',
      'f()',
      '}',
    ]) {
      expect(() => readShellWrites(cmd), cmd).not.toThrow();
    }
    const started = performance.now();
    readShellWrites(`${'$('.repeat(5000)}rm a.ts`);
    readShellWrites('x '.repeat(200_000));
    readShellWrites(`${'( '.repeat(50_000)}rm a.ts`);
    readShellWrites(`cat <<EOF\n${'$(x) '.repeat(20_000)}\nEOF`);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('answers many paths for one command from its words', () => {
    const names = pathNamer('rm -rf ./src/generated/ && sed -i s/a/b/ /repo/src/auth.ts lib');
    expect(names('src/generated/deep/a.ts')).toBe(true);
    expect(names('src/auth.ts')).toBe(true);
    expect(names('pkg/auth.ts')).toBe(true);
    expect(names('lib/x.ts')).toBe(true);
    expect(names('src/other.ts')).toBe(false);
    expect(names('src/gen/a.ts')).toBe(false);
    expect(names('')).toBe(false);
    const started = performance.now();
    const paths = Array.from({ length: 5000 }, (_, i) => `p/q/r/s/t/u/v/file${i}.ts`);
    expect(paths.filter(names)).toHaveLength(0);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('matches a path by a directory above it', () => {
    expect(namesPathOrParent('rm -rf migrations', 'migrations/001.sql')).toBe(true);
    expect(namesPathOrParent('rm -rf ./src/generated/', 'src/generated/a/b.ts')).toBe(true);
    expect(namesPathOrParent('rm -rf src/gen', 'src/generated/a.ts')).toBe(false);
    expect(namesPathOrParent('npm run build', 'src/generated/a.ts')).toBe(false);
  });
});

describe('comparing a written directory or wildcard with a scope', () => {
  it('compares segment by segment, so depth matters', () => {
    for (const [a, b] of [
      ['prisma/**', 'prisma/migrations/**'],
      ['**', 'prisma/migrations/**'],
      ['dist/**', '**/*.pem'],
      ['dist/**', '*.pem'],
      ['packages/*/dist/**', 'packages/web/dist/keep.txt'],
      ['./*.log', '*.log'],
      ['src/w*/**', 'src/web/**'],
      ['src/*', 'src/web'],
      ['src/{api,web}/**', 'src/web/**'],
      ['**/dist/**', 'packages/a/dist/x'],
    ] as const) {
      expect(patternsMayOverlap(a, b), `${a} ~ ${b}`).toBe(true);
      expect(patternsMayOverlap(b, a), `${b} ~ ${a}`).toBe(true);
    }
    for (const [a, b] of [
      // One segment at the top cannot reach into a folder.
      ['./*.log', 'src/web/**'],
      ['./*.tsbuildinfo', '**/x/*.tsbuildinfo'],
      ['./*', 'src/web/**'],
      ['packages/*/dist/**', 'packages/db/prisma/**'],
      ['dist/**', 'prisma/migrations/**'],
      ['src/*.ts', 'src/generated/**'],
      ['src/api/**', 'src/web/**'],
      ['dist/**', '*.pem/x'],
      ['src/a*.ts', 'src/b*.ts'],
      ['src/*.ts', 'src/*.css'],
    ] as const) {
      expect(patternsMayOverlap(a, b), `${a} ~ ${b}`).toBe(false);
      expect(patternsMayOverlap(b, a), `${b} ~ ${a}`).toBe(false);
    }
    expect(patternsMayOverlap('SRC/WEB/**', 'src/web/**')).toBe(false);
    expect(patternsMayOverlap('SRC/WEB/**', 'src/web/**', { nocase: true })).toBe(true);
  });

  it('tells a rule that names its path from one that needs a look', () => {
    expect(isLiteralScope('prisma/migrations/**')).toBe(true);
    expect(isLiteralScope('config/prod.json')).toBe(true);
    expect(isLiteralScope('**/*.pem')).toBe(false);
    expect(isLiteralScope('*.pem')).toBe(false);
    expect(isLiteralScope('src/**/*.gen.ts')).toBe(false);
    expect(isLiteralScope('certs/*.pem')).toBe(false);
    expect(isLiteralScope('**')).toBe(false);
  });
});
