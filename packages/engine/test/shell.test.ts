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
  /**
   * Targets the text shows as written: `path`, with `/**` for a whole tree and `*` wildcards
   * kept; `(land)` where files of unknown names are put, `(restore)` / `(clean)` for paths git
   * brings back from the index or cleans.
   */
  const show = (t: ShellTarget): string[] => {
    if (t.how !== 'write') return [`${t.path} (${t.how})`];
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
      // A bare word is a path only when a file of that name exists, which the caller checks.
      // Paths that stand in for a question to git only count when git does not answer.
      expect(
        read(cmd).filter((t) => !t.ifExists && t.fallback === null),
        cmd,
      ).toEqual([]);
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
    const ask = (command: string) =>
      readShellWrites(command, { home: HOME, top: TOP }).questions.map(
        (q) =>
          `${q.cwd || '.'} | ${q.against.join(' ') || '(index)'} | ${q.pathspecs.join(' ') || '(all)'}${q.untracked ? ' | u' : ''}${q.ignored ? ' | i' : ''}${q.ifExists ? ' | if it exists' : ''}${q.mayFail ? ' | if a revision' : ''}`,
      );
    // What a command that brings files back changes is asked of git, with the pathspecs as
    // given: from the index, from HEAD (`--staged`, a stash), or from a revision.
    expect(ask('git checkout -- src/auth.ts')).toEqual(['. | (index) | src/auth.ts']);
    expect(ask("git checkout -- '*.pem'")).toEqual(['. | (index) | *.pem']);
    expect(ask("git restore ':(glob)**/*.pem'")).toEqual(['. | (index) | :(glob)**/*.pem']);
    expect(ask('git checkout --ours certs/a.pem')).toEqual(['. | (index) | certs/a.pem']);
    expect(ask('git restore -SW certs/a.pem')).toEqual(['. | HEAD | certs/a.pem']);
    expect(ask('git restore --staged --worktree .')).toEqual(['. | HEAD | .']);
    expect(ask('git restore --source=HEAD~1 prisma')).toEqual(['. | HEAD~1 | prisma']);
    expect(ask('git restore -sHEAD~1 prisma')).toEqual(['. | HEAD~1 | prisma']);
    expect(ask('git checkout stash@{0} -- prisma/a.sql')).toEqual(['. | stash@{0} | prisma/a.sql']);
    expect(ask("git stash push -- '*.pem'")).toEqual(['. | HEAD | *.pem']);
    expect(ask('git stash -u')).toEqual(['. | HEAD | (all) | u']);
    expect(ask('git stash -a')).toEqual(['. | HEAD | (all) | u | i']);
    expect(ask('git stash push -a -- .env')).toEqual(['. | HEAD | .env | u | i']);
    expect(ask('git stash')).toEqual(['. | HEAD | (all)']);
    expect(ask('git reset --hard')).toEqual(['. | HEAD | (all)']);
    expect(ask('git reset --hard HEAD~2')).toEqual(['. | HEAD~2 | (all)']);
    // `--keep` and `--merge` keep local changes: only what differs between the two commits.
    expect(ask('git reset --keep HEAD~2')).toEqual(['. | HEAD HEAD~2 | (all) | if a revision']);
    expect(ask('git reset -q --merge')).toEqual([]);
    expect(ask('cd src && git restore auth.ts')).toEqual(['src | (index) | auth.ts']);
    expect(ask('git -C packages/web restore src/a.ts')).toEqual([
      'packages/web | (index) | src/a.ts',
    ]);
    expect(ask('git -C packages -C web restore a.ts')).toEqual(['packages/web | (index) | a.ts']);
    // Several words and no `--`: the first is a revision when there is one of that name, and a
    // path like the others when such a file exists.
    expect(ask('git checkout HEAD~1 prisma')).toEqual([
      '. | (index) | HEAD~1 prisma | if it exists',
      '. | HEAD~1 | prisma | if a revision',
    ]);
    expect(ask('git checkout src/a.ts secret/key.txt')).toEqual([
      '. | (index) | src/a.ts secret/key.txt | if it exists',
      '. | src/a.ts | secret/key.txt | if a revision',
    ]);
    // One word is a path when such a file exists, and a branch to switch to when there is one.
    expect(ask('git checkout certs')).toEqual([
      '. | (index) | certs | if it exists',
      '. | HEAD certs | (all) | if a revision',
    ]);
    // A wildcard or magic can only be a pathspec.
    for (const spec of ['*.pem', '*', 'secret/*', ':/secret', ':(glob)**/*.txt', './x', 'x/']) {
      expect(ask(`git checkout '${spec}'`), spec).toEqual([`. | (index) | ${spec}`]);
    }
    // A branch switch writes what differs between HEAD and where it goes; forced, also every
    // local change. Making a branch first changes nothing more, whatever the order of the flags.
    expect(ask('git switch other')).toEqual(['. | HEAD other | (all) | if a revision']);
    expect(ask('git switch -')).toEqual(['. | HEAD @{-1} | (all) | if a revision']);
    expect(ask('git checkout -f')).toEqual(['. | HEAD | (all) | if a revision']);
    expect(ask('git checkout -f release')).toEqual([
      '. | (index) | release | if it exists',
      '. | release | (all) | if a revision',
    ]);
    expect(ask('git switch -f release')).toEqual(['. | release | (all) | if a revision']);
    expect(ask('git checkout -f -b tmp')).toEqual(['. | HEAD | (all) | if a revision']);
    expect(ask('git checkout -fb tmp')).toEqual(['. | HEAD | (all) | if a revision']);
    expect(ask('git checkout -f -B tmp other')).toEqual(['. | other | (all) | if a revision']);
    expect(ask('git checkout -b tmp other')).toEqual(['. | HEAD other | (all) | if a revision']);
    expect(ask('git switch -f -c tmp other')).toEqual(['. | other | (all) | if a revision']);
    expect(ask('git switch -c tmp other')).toEqual(['. | HEAD other | (all) | if a revision']);
    const guessed = readShellWrites('git switch other').questions[0];
    expect(guessed).toMatchObject({ guess: true });
    expect(readShellWrites('git switch -c tmp other').questions[0]).toMatchObject({ guess: false });
    // Moving the index, staying where HEAD is and dry runs write no file.
    for (const cmd of [
      'git restore --staged x',
      'git reset -- x',
      'git stash list',
      'git checkout -b tmp',
      'git switch -c tmp',
      'git checkout',
    ]) {
      expect(readShellWrites(cmd).questions, cmd).toEqual([]);
    }
    // Should git not answer, the paths given stand in for it; for the whole tree, the files of
    // the kinds the command touches that are there.
    expect(read("git checkout -- ':(glob)certs/*.pem'")).toEqual([
      expect.objectContaining({ path: 'certs/*.pem', glob: true, tree: true, fallback: 0 }),
    ]);
    expect(read('git reset --hard')).toEqual([
      expect.objectContaining({
        path: TOP,
        tree: true,
        fallback: 0,
        touches: { tracked: true, untracked: false, ignored: false },
      }),
    ]);
    expect(read(`cd ${TOP}/src && git reset --hard`)).toEqual([
      expect.objectContaining({ path: TOP, fallback: 0 }),
    ]);
    expect(read('cd src && git stash -u')).toEqual([
      expect.objectContaining({
        path: TOP,
        touches: { tracked: true, untracked: true, ignored: false },
      }),
    ]);
    expect(read('git checkout -- . ":!src"')).toEqual([
      expect.objectContaining({ path: '.', touches: expect.objectContaining({ tracked: true }) }),
    ]);
    expect(read("git checkout ':/secret'")).toEqual([
      expect.objectContaining({ path: `${TOP}/secret`, touches: null }),
    ]);
    // git's `*` also crosses folders.
    expect(read("git checkout -- '*.pem'").map((t) => t.path)).toEqual(['*.pem', '*/**/*.pem']);
    expect(read("git checkout -- 's*/key.txt'").map((t) => t.path)).toEqual(['s*/**/key.txt']);
    // `git rm` removes the tracked files its pathspecs match: git lists them.
    expect(readShellWrites("git rm -r --quiet 'certs/*'").questions).toEqual([
      expect.objectContaining({ pathspecs: ['certs/*'], tracked: true }),
    ]);
    expect(read('git -c a=b rm -r prisma/migrations')).toEqual([
      expect.objectContaining({
        path: 'prisma/migrations',
        tree: true,
        fallback: 0,
        touches: { tracked: true, untracked: false, ignored: false },
      }),
    ]);
    // Paths read from a file are not known: said, not guessed.
    for (const cmd of [
      'git rm --pathspec-from-file=list.txt',
      'echo x | git checkout --pathspec-from-file=-',
    ]) {
      const reading = readShellWrites(cmd);
      expect(reading.questions, cmd).toEqual([]);
      expect(reading.limit, cmd).toContain('from a file');
    }
    // Without a path it cleans where it runs; it only touches files that exist, and ignored
    // ones only with -x, or when an exclude pattern takes them back from what is ignored.
    expect(targets('git clean -fd')).toEqual(['. (clean)']);
    expect(targets('git clean -fdx')).toEqual(['. (clean)'.replace('clean', 'clean-ignored')]);
    expect(targets('git clean -fdx prisma')).toEqual(['prisma (clean-ignored)']);
    expect(targets("git clean -fd -e '!.env'")).toEqual(['. (clean-ignored)']);
    expect(targets("git clean -fd --exclude='!.env'")).toEqual(['. (clean-ignored)']);
    expect(targets('git clean -fd -e build')).toEqual(['. (clean)']);
    expect(targets('git mv prisma db')).toEqual(['db/[prisma]/**', 'prisma', 'prisma/**']);
  });

  it('does not take what git says for a later command once an earlier one moved things', () => {
    const asked = (command: string) =>
      readShellWrites(command, { home: HOME, top: TOP }).questions.filter((q) =>
        q.pathspecs.some((p) => p.endsWith('secret/key.txt')),
      ).length;
    const given = (command: string) =>
      read(command)
        .filter((t) => t.fallback === null)
        .map((t) => t.path);
    // A fetch, a reset of the index, a commit or a stash changes what git would answer.
    for (const cmd of [
      'git fetch && git checkout origin/main -- secret/key.txt',
      'git fetch origin main && git restore --source=origin/main secret/key.txt',
      'git reset && git checkout -- secret/key.txt',
      'git add -A && git commit -qm wip && git checkout HEAD~1 -- secret/key.txt',
      'git stash && git checkout stash@{0} -- secret/key.txt',
      'git branch -f main origin/main; git checkout main -- secret/key.txt',
      './sync.sh && git checkout -- secret/key.txt',
      'make && git checkout -- secret/key.txt',
      'bash -c "git pull" && git checkout -- secret/key.txt',
      'echo $(git stash) && git checkout -- secret/key.txt',
      'cd /elsewhere && cd - && git checkout -- secret/key.txt',
      'GIT_DIR=other.git git checkout -- secret/key.txt',
      'git --git-dir=other.git checkout -- secret/key.txt',
      'git --icase-pathspecs checkout -- secret/key.txt',
    ]) {
      expect(asked(cmd), cmd).toBe(0);
      expect(given(cmd), cmd).toEqual(['secret/key.txt']);
    }
    // The whole tree: the tracked files there.
    expect(read('git fetch origin && git reset --hard origin/main')).toEqual([
      expect.objectContaining({
        path: TOP,
        fallback: null,
        touches: { tracked: true, untracked: false, ignored: false },
      }),
    ]);
    expect(read('git fetch && git checkout -- .')).toEqual([
      expect.objectContaining({ path: '.', fallback: null, touches: expect.anything() }),
    ]);
    // Looking around first changes nothing, nor does a folder of the same tree.
    for (const cmd of [
      'git status && git checkout -- secret/key.txt',
      'git log -1 && git diff && git checkout -- secret/key.txt',
      'git branch && git stash list && git checkout -- secret/key.txt',
      'ls && cat a.txt && git checkout -- secret/key.txt',
      `cd ${TOP}/src && git checkout -- ../secret/key.txt`,
      'cd src && git checkout -- ../secret/key.txt',
      'echo x > notes.txt && git checkout -- secret/key.txt',
    ]) {
      expect(asked(cmd), cmd).toBe(1);
    }
    // A branch switch compares two revisions: only a moved ref changes what git says of it.
    const switches = (command: string) =>
      readShellWrites(command, { home: HOME, top: TOP }).questions.filter(
        (q) => q.against.length === 2,
      ).length;
    expect(switches('git add -A && git checkout -- x && git switch other')).toBe(1);
    expect(switches('git fetch && git switch other')).toBe(0);
    expect(switches('git commit -qm x && git switch other')).toBe(0);
    expect(read('git fetch && git switch other')).toEqual([
      expect.objectContaining({ path: TOP, fallback: null, certain: true }),
    ]);
    // Case is ignored with `--icase-pathspecs`.
    expect(read('git --icase-pathspecs checkout -- SECRET')[0]).toMatchObject({ nocase: true });
    expect(read("git checkout -- ':(icase)SECRET'")[0]).toMatchObject({ nocase: true });
    // A git command whose folder the text does not tell is said, not dropped.
    expect(readShellWrites('cd "$DIR" && git checkout -- .').limit).toContain('git command');
  });

  it('stands in for git commands it does not ask about', () => {
    const line = Array.from({ length: 9 }, (_, i) => `git checkout -- src/a${i}.ts`).join('; ');
    const reading = readShellWrites(`${line}; git checkout -- secret/key.txt`, {
      home: HOME,
      top: TOP,
    });
    // However many there are, each path given is written: none is only a warning.
    expect(reading.limit).toBeNull();
    for (let i = 0; i < 9; i++) {
      expect(reading.targets).toContainEqual(expect.objectContaining({ path: `src/a${i}.ts` }));
    }
    expect(reading.targets).toContainEqual(
      expect.objectContaining({ path: 'secret/key.txt', fallback: null, certain: true }),
    );
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
    expect(targets('rsync -a --delete --exclude node_modules /tmp/repo/ ./')).toEqual([
      '.',
      './**',
    ]);
    // What is moved away is gone from where it was.
    expect(targets('rsync -a --remove-source-files certs/ /tmp/c/')).toEqual([
      '/tmp/c/**',
      'certs',
      'certs/**',
    ]);
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
    // Several names, or a path test that only narrows them, keep it to those names; `-iname`
    // ignores case; a negation can let anything through.
    expect(targets("find . -name '*.log' -delete -o -name '*.tmp' -delete")).toEqual([
      '**/*.log',
      '**/*.log/**',
      '**/*.tmp',
      '**/*.tmp/**',
    ]);
    expect(read("find . -iname '*.PEM' -delete")[0]).toMatchObject({ nocase: true });
    expect(targets("find . -name '*.js' -path './dist/*' -delete")).toEqual([
      '**/*.js',
      '**/*.js/**',
    ]);
    expect(targets("find . -not -name '*.js' -delete")).toEqual(['.', './**']);
    expect(targets('find . -name node_modules -type d -prune -exec rm -rf {} +')).toEqual([
      '**/node_modules',
      '**/node_modules/**',
    ]);
    // Only empty directories can go: nothing is written.
    expect(read('find . -type d -empty -delete')).toEqual([]);
    expect(targets('find src -name "*.tmp" -exec rm {} \\;')).toEqual([
      'src/**/*.tmp',
      'src/**/*.tmp/**',
    ]);
    // A program it runs that Mindly does not know may change what it finds.
    expect(possible('find prisma -exec mytool {} \\;')).toEqual(['prisma', 'prisma/**']);
    expect(targets('find . -name "*.ts" -fprint list.txt')).toEqual(['list.txt']);
    // Unpacking puts files of unknown names into a directory: the current one by default.
    expect(targets('tar xf a.tar -C prisma/migrations')).toEqual(['prisma/migrations (land)']);
    expect(targets('tar -xzf a.tgz --directory=vendor')).toEqual(['vendor (land)']);
    expect(targets('tar xzfC a.tgz certs')).toEqual(['certs (land)']);
    expect(targets('unzip -o a.zip -d prisma/migrations')).toEqual(['prisma/migrations (land)']);
    expect(targets('unzip a.zip -dcerts')).toEqual(['certs (land)']);
    expect(targets('tar xzf a.tgz')).toEqual(['. (land)']);
    expect(targets('tar xzf a.tgz -C .')).toEqual(['. (land)']);
    expect(targets('unzip a.zip')).toEqual(['. (land)']);
    expect(targets('unzip a.zip -d .')).toEqual(['. (land)']);
    // Creating an archive writes the archive, whatever comes before its name.
    expect(targets('tar --exclude=node_modules -czf certs/server.pem .')).toEqual([
      'certs/server.pem',
    ]);
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
        dotfiles: false,
        nocase: false,
        tree: false,
        how: 'write',
        certain: true,
        entries: [],
        sources: [],
        only: null,
        ifExists: false,
        fallback: null,
        touches: null,
      },
    ]);
    // A shell's wildcard does not stand for a leading dot; a pattern a program expands does.
    expect(read('rm -f *.example')[0]).toMatchObject({ glob: true, dotfiles: false });
    expect(read("find . -name '*.example' -delete")[0]).toMatchObject({ dotfiles: true });
    // Braces become the words they stand for, before anything else.
    expect(targets('touch .env.{local,production}')).toEqual(['.env.local', '.env.production']);
    expect(targets('mkdir -p prisma/migrations/{002_a,003_b}')).toEqual([
      'prisma/migrations/002_a',
      'prisma/migrations/003_b',
    ]);
    expect(targets('rm -rf {a..c}erts')).toEqual([
      'aerts',
      'aerts/**',
      'berts',
      'berts/**',
      'certs',
      'certs/**',
    ]);
    expect(targets('rm f{1..3}.log')).toEqual(['f1.log', 'f2.log', 'f3.log']);
    expect(targets("rm '{a,b}.ts'")).toEqual(['{a,b}.ts']);
    // Too many words: the word is also a wildcard that matches all of them, and said not read.
    expect(read('rm f{1..100000}.log')[0]).toMatchObject({ path: 'f*.log', glob: true });
    expect(readShellWrites('rm f{1..100000}.log').limit).toContain('brace expansion');
    expect(read('rm -f {secret,certs}/x{,{1..200}}.txt').map((t) => t.path)).toEqual(['*/x*.txt']);
    // Too many alternatives: each plain alternative is still checked by name.
    const many = Array.from({ length: 300 }, (_, i) => `a${i}`).join(',');
    const big = readShellWrites(`rm -f {${many},certs/server.pem}`);
    expect(big.limit).toContain('brace expansion');
    expect(big.targets.map((t) => t.path)).toContain('certs/server.pem');
    expect(big.targets.map((t) => t.path)).toContain('*');
    // Where nothing is written, a large expansion is nothing to say.
    for (const cmd of [
      'for i in {1..1000}; do echo $i; done',
      'echo {1..300}',
      'seq 1 5 > /dev/null; printf "%s\\n" {a..z}{a..z}',
    ]) {
      expect(readShellWrites(cmd).limit, cmd).toBeNull();
    }
    expect(read('rm -rf dist/*')[0]).toMatchObject({ path: 'dist/*', glob: true, tree: true });
    expect(read('rm -f *.log')[0]).toMatchObject({ path: '*.log', glob: true, tree: false });
    expect(read('rm src/*.{ts,tsx}')[0]).toMatchObject({ path: 'src/*.ts', glob: true });
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
    expect(targets('deno eval "Deno.removeSync(\'a/b.ts\')"')).toEqual(['a/b.ts', 'a/b.ts/**']);
    expect(targets("bun -e \"require('fs').rmSync('a/b.ts')\"")).toEqual(['a/b.ts', 'a/b.ts/**']);
    expect(targets(`perl -e 'open(F,">a/b.txt")'`)).toEqual(['a/b.txt']);
    // A quoted name without a dot or slash is a path only when such a file exists.
    expect(read(`python3 -c "import shutil; shutil.rmtree('certs')"`)).toEqual([
      expect.objectContaining({ path: 'certs', tree: true, certain: true, ifExists: true }),
    ]);
    expect(targets(`python3 -c "import os; os.system('rm a/b.ts')"`)).toEqual(['a/b.ts']);
    // Code that only reads names the file without writing it.
    expect(targets(`python -c "print(open('a/b.ts').read())"`)).toEqual([]);
    expect(possible(`python -c "print(open('a/b.ts').read())"`)).toEqual([]);
    // Printing is not writing a file; a copy writes its destination, not its source.
    for (const code of [
      `node -e "process.stdout.write(require('fs').readFileSync('.env.example','utf8'))"`,
      `python3 -c "import sys; sys.stdout.write(open('.env.example').read())"`,
      `node -e "console.log(require('fs').readFileSync('certs/a.pem','utf8'))"`,
    ]) {
      expect(read(code), code).toEqual([]);
    }
    expect(targets(`python3 -c "import shutil; shutil.copy('.env.example','/tmp/x')"`)).toEqual([
      '/tmp/x',
      '/tmp/x/**',
    ]);
    expect(
      targets(
        `node -e "require('dotenv').config({path:'.env'}); require('fs').writeFileSync('/tmp/keys.json', '')"`,
      ),
    ).toEqual(['/tmp/keys.json']);
    expect(targets(`python3 -c "open('a.txt','a').write('x')"`)).toEqual(['a.txt']);
    expect(targets(`node -e "require('fs').renameSync('a/b.ts','a/c.ts')"`)).toEqual([
      'a/b.ts',
      'a/b.ts/**',
      'a/c.ts',
      'a/c.ts/**',
    ]);
    expect(
      targets(`python3 -c "from pathlib import Path; Path('a/b.ts').write_text('x')"`),
    ).toEqual(['a/b.ts']);
    expect(targets(`python3 -c "import subprocess; subprocess.run(['rm','a/b.ts'])"`)).toEqual([
      'a/b.ts',
    ]);
    // Modes given by keyword or by a variable, flags of os.open, and paths joined from literals.
    for (const code of [
      `python3 -c "open('certs/server.pem', mode='w').write('x')"`,
      `python3 -c "open(file='certs/server.pem', mode='w').write('x')"`,
      `python3 -c "m='w'; open('certs/server.pem', m).write('x')"`,
      `python3 -c "import io; io.open('certs/server.pem', 'w')"`,
      `python3 -c "import os; fd=os.open('certs/server.pem', os.O_WRONLY|os.O_TRUNC); os.close(fd)"`,
      `node -e "require('fs').writeFileSync(require('path').join('certs','server.pem'), 'x')"`,
      `python3 -c "import os; os.unlink(os.path.join('certs', 'server.pem'))"`,
      `python3 -c "from pathlib import Path; (Path('certs') / 'server.pem').unlink()"`,
      `python3 -c "import os; os.remove(f'certs/server.pem')"`,
      `python3 -c "import os; os.remove(r'certs/server.pem')"`,
    ]) {
      expect(targets(code), code).toContain('certs/server.pem');
    }
    for (const code of [
      `python3 -c "print(open('certs/server.pem', encoding='utf8').read())"`,
      `python3 -c "print(open('certs/server.pem', mode='r').read())"`,
      `python3 -c "import os; os.open('certs/server.pem', os.O_RDONLY)"`,
    ]) {
      expect(targets(code), code).toEqual([]);
    }
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
    // Known removers are certain writes, also when a package manager runs them.
    for (const cmd of [
      'rimraf prisma/migrations',
      'npx rimraf prisma/migrations',
      'busybox rm -rf prisma/migrations',
    ]) {
      expect(targets(cmd), cmd).toEqual(['prisma/migrations', 'prisma/migrations/**']);
    }
    // A bare word is a path only if such a file exists, which the caller checks.
    expect(read('mytool prisma')).toEqual([
      expect.objectContaining({ path: 'prisma', tree: true, certain: false, ifExists: true }),
    ]);
    // Text with spaces is a message or a command for somewhere else, not a local path.
    expect(read('ssh host "rm -rf /var/app/.env.bak"')).toEqual([]);
    expect(read("docker exec app sh -c 'rm -rf /srv/.env'")).toEqual([]);
    expect(read('mytool "fix the .env loading"')).toEqual([]);
    // A folder handed to a build or package tool is where it works, not what it writes.
    for (const cmd of [
      'pnpm --filter ./packages/api build',
      'pnpm -C packages/api build',
      'yarn --cwd packages/api build',
      'npm --prefix packages/api run build',
      'make -C packages/api',
      'docker build packages/api',
      'turbo run build --filter=./packages/api',
    ]) {
      expect(read(cmd), cmd).toEqual([]);
    }
    // Installing or cleaning in another folder writes inside it.
    for (const [cmd, dir] of [
      ['pnpm -C packages/api add left-pad', 'packages/api'],
      ['npm --prefix packages/api install', 'packages/api'],
      ['yarn --cwd packages/api install', 'packages/api'],
      ['make -C packages/api clean', 'packages/api'],
    ] as const) {
      expect(possible(cmd), cmd).toEqual([dir, `${dir}/**`]);
    }
    expect(read('make -C packages/api')).toEqual([]);
    // Known writers name what they write.
    expect(targets('curl -o certs/server.pem https://x/y')).toEqual(['certs/server.pem']);
    expect(targets('curl -sSLo certs/server.pem https://x/y')).toEqual(['certs/server.pem']);
    expect(targets('wget -qO certs/server.pem https://x/y')).toEqual(['certs/server.pem']);
    expect(targets(`perl -e 'unlink "certs/server.pem"'`)).toEqual(['certs/server.pem']);
    expect(targets('curl https://x/y --output=certs/a.pem')).toEqual(['certs/a.pem']);
    expect(targets('wget -O certs/server.pem https://x/y')).toEqual(['certs/server.pem']);
    expect(targets('openssl genrsa -out certs/server.pem 2048')).toEqual(['certs/server.pem']);
    expect(targets("gsed -i 's/a/b/' certs/server.pem")).toEqual(['certs/server.pem']);
    expect(read('docker compose up -d').every((t) => t.ifExists)).toBe(true);
    // Package managers run scripts: what they are given is not what they write.
    expect(read('pnpm install')).toEqual([]);
    expect(read('npm run build')).toEqual([]);
  });

  it('says when a limit cut the reading short', () => {
    expect(readShellWrites('rm a.ts')).toEqual({
      targets: [expect.anything()],
      questions: [],
      limit: null,
    });
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
