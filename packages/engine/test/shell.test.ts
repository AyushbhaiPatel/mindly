import { describe, expect, it } from 'vitest';
import { isLiteralScope, patternsMayOverlap } from '../src/hooks/scope.js';
import { limitTo } from '../src/hooks/search.js';
import {
  mayHold,
  mentionsPath,
  partNames,
  namesPathOrParent,
  normalizeCommandLine,
  pathNamer,
  readShellWrites,
  SHELL_BUILTINS,
  shellMayWrite,
  shellWriteTargets,
  type ShellTarget,
  understoodLine,
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
    expect(read('git -c color.ui=never rm -r prisma/migrations')).toEqual([
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
      'git checkout --pathspec-from-file=- < list.txt',
      'git checkout-index -f --stdin < list.txt',
    ]) {
      const reading = readShellWrites(cmd);
      expect(reading.questions, cmd).toEqual([]);
      expect(reading.targets, cmd).toEqual([]);
      expect(reading.limit, cmd).toContain('from a file');
    }
    // Those an `echo` gives it are read.
    expect(ask('echo certs/a.pem | git checkout --pathspec-from-file=-')).toEqual([
      '. | (index) | certs/a.pem',
    ]);
    expect(targets('echo certs/a.pem | git checkout-index -f --stdin')).toEqual(['certs/a.pem']);
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

  it('reads a git command as only looking only when each of its options keeps it so', () => {
    const whole = (command: string) =>
      read(command)
        .filter((x) => !x.certain)
        .map((x) => x.path);
    for (const cmd of [
      'git log -1',
      'git fetch',
      'git fetch --prune --tags origin',
      'git push origin main',
      'git push -u origin HEAD',
      'git -c color.ui=always log',
      'git -c core.pager=cat log -p',
      'GIT_PAGER=cat git log',
      'GIT_EDITOR=true git commit -qam x',
      'GIT_AUTHOR_DATE=2020-01-01 git commit -m x',
      'git -c user.name=x -c user.email=y commit -m z',
      'git diff-tree -r HEAD',
      'git rev-list --count HEAD',
      'git shortlog -sn',
      'git grep -n -e foo -- src',
      'git grep -C 2 foo',
      'git blame -L 1,2 -M -C x',
      'git log -Gfoo -n5 --stat',
      'git diff -M50% HEAD',
      'git status -uno',
      'git status --porcelain=v1',
      'git config user.name x',
      'git archive --format=tar HEAD',
    ]) {
      expect(read(cmd), cmd).toEqual([]);
    }
    // An option or a setting that runs a program or moves what git works on, an option not known
    // here, an abbreviation that cannot be told, a push into a repository on this machine: any
    // file in the tree may change.
    for (const cmd of [
      "git -c core.fsmonitor='touch x; false' status",
      "git -c diff.external='touch x' diff v1",
      "git -c core.sshCommand='touch x' fetch",
      'git -c core.hooksPath=h commit -qam msg',
      'git --git-dir=../other/.git log',
      "GIT_EXTERNAL_DIFF='touch x' git diff",
      "env GIT_SSH_COMMAND='touch x' git fetch",
      'export GIT_DIR=../other/.git && git log',
      'GIT_DIR=../other/.git; git status',
      "git fetch --upload-pack='touch x; git-upload-pack' . main",
      "git ls-remote --upload-pack='touch x' .",
      "git push --receive-pack='touch x' . HEAD:refs/heads/x",
      'git push . ahead:main',
      'git push ../other main',
      "git archive --remote=. --exec='touch x' -o out.tar HEAD",
      'git grep --open-files-in-pager=rm k2',
      'git grep -Orm k2',
      'git log --some-new-option',
      'git status --some-new-option',
      'git config receive.denyCurrentBranch updateInstead',
      'git config core.hooksPath h',
      'git checkout --some-new-option main',
    ]) {
      expect(whole(cmd), cmd).toContain(TOP);
    }
    // Output to a file it is given is a write of that file, whatever its abbreviation.
    for (const [cmd, file] of [
      ['git diff-tree --output=certs/new.pem -p v1 v2', 'certs/new.pem'],
      ['git diff-index --output=certs/new.pem -p v1', 'certs/new.pem'],
      ['git rev-list --output=certs/new.pem HEAD', 'certs/new.pem'],
      ['git shortlog --output=certs/new.pem HEAD', 'certs/new.pem'],
      ['git blame --output=certs/new.pem src/a.ts', 'certs/new.pem'],
      ['git diff --outp=certs/new.pem', 'certs/new.pem'],
      ['git archive -o certs/new.pem HEAD', 'certs/new.pem'],
      ['git -C sub log --output=new.pem', 'sub/new.pem'],
    ] as const) {
      expect(targets(cmd), cmd).toEqual([file]);
      expect(whole(cmd), cmd).toEqual([]);
    }
    // Abbreviations git takes are made whole.
    const asked = (command: string) =>
      readShellWrites(command).questions.map((q) => `${q.against.join(' ')} | ${q.pathspecs}`);
    expect(asked('git restore --staged --work --source=v1 certs/a.pem')).toEqual([
      'v1 | certs/a.pem',
    ]);
    expect(read('git restore --sta certs/a.pem')).toEqual([]);
    expect(asked('git reset --har v1')).toEqual(['v1 | ']);
    expect(asked('git checkout --forc')).toEqual(['HEAD | ']);
    // Patch files, told by a sample name with the suffix they get, where they go.
    expect(targets('git format-patch -o patches HEAD~2')).toEqual(['patches/0001-patch.patch']);
    expect(targets('git -C vendor format-patch -2')).toEqual(['vendor/0001-patch.patch']);
    expect(targets('git format-patch --suffix=.pem -1')).toEqual(['0001-patch.pem']);
    expect(targets('git format-patch --stdout -1')).toEqual([]);
  });

  it('reads the folders git fills as written as a whole', () => {
    const lands = (command: string) =>
      read(command)
        .filter((x) => x.how === 'land')
        .map((x) => x.path);
    const whole = (command: string) => read(command).some((x) => !x.certain && x.path === TOP);
    expect(lands('git clone -q . vendor/lib')).toEqual(['vendor/lib']);
    expect(whole('git clone -q . vendor/lib')).toBe(true);
    expect(lands('git clone https://example.com/team/tool.git')).toEqual(['tool']);
    expect(whole('git clone https://example.com/team/tool.git')).toBe(false);
    expect(lands('git worktree add vendor/wt v1')).toEqual(['vendor/wt']);
    expect(lands('git worktree add -b x vendor/wt v1')).toEqual(['vendor/wt']);
    expect(targets('git worktree remove vendor/wt')).toEqual(['vendor/wt', 'vendor/wt/**']);
    expect(read('git worktree list')).toEqual([]);
    expect(lands('git checkout-index -a --prefix=vendor/')).toEqual(['vendor']);
    expect(whole('git checkout-index -a --prefix=vendor/')).toBe(false);
    expect(lands('git read-tree --prefix=vendor/ -u v1')).toEqual(['vendor']);
    expect(read('git read-tree --prefix=vendor/ v1')).toEqual([]);
    expect(lands('git init vendor/repo')).toEqual(['vendor/repo']);
  });

  it('reads every builtin and keyword of the shells as harmless or as setting what git runs with', () => {
    const whole = (command: string) => read(command).some((x) => !x.certain && x.path === TOP);
    // The list is the test's data: a builtin or keyword added to it is checked here too. Each
    // is given before a git command that names no path, with words that keep a harmless one
    // harmless (a lower-case loop variable for `for`, no option for the others).
    const names = Object.keys(SHELL_BUILTINS);
    for (const name of [
      // bash 5.2: `enable -a`.
      ...'. : [ alias bg bind break builtin caller cd command compgen complete compopt'.split(' '),
      ...'continue declare dirs disown echo enable eval exec exit export false fc fg'.split(' '),
      ...'getopts hash help history jobs kill let local logout mapfile popd printf'.split(' '),
      ...'pushd pwd read readarray readonly return set shift shopt source suspend test'.split(' '),
      ...'times trap true type typeset ulimit umask unalias unset wait'.split(' '),
      // bash 5.2: `compgen -k`.
      ...'if then else elif fi case esac for select while until do done in function'.split(' '),
      ...'time { } ! [[ ]] coproc'.split(' '),
      // zsh and ksh besides.
      ...'setopt unsetopt emulate autoload typeset integer float nameref print whence'.split(' '),
    ]) {
      expect(names, name).toContain(name);
    }
    for (const [name, kind] of Object.entries(SHELL_BUILTINS)) {
      const line = `${name}${name === 'for' ? ' f in a b' : ''}; git status`;
      expect(whole(line), line).toBe(kind === 'taints');
    }
    // The harmless ones, given what sets a variable or runs a command.
    for (const line of [
      'printf -v x y; git status',
      'print -v x y; git status',
      'wait -p x; git status',
      'jobs -x true; git status',
      'umask 022; git status',
      'for HOME in a; do :; done; git status',
      'for $x in a; do :; done; git status',
    ]) {
      expect(whole(line), line).toBe(true);
    }
  });

  it('reads what git is given besides its options: variables, files it reads, code it runs', () => {
    const whole = (command: string) => read(command).some((x) => !x.certain && x.path === TOP);
    const lands = (command: string) =>
      read(command)
        .filter((x) => x.how === 'land')
        .map((x) => x.path);
    // Variables, settings and subcommands that change nothing git does to files.
    for (const cmd of [
      'LANG=C git status',
      'TZ=UTC LC_ALL=C git log -1',
      'PAGER=cat git log',
      'NO_COLOR=1 TERM=dumb git diff',
      'EDITOR=true git commit -qm x',
      'VISUAL=: git commit -qm x',
      'git -c commit.gpgsign=false commit -qm x',
      'git log main --not v1',
      'git log --onel -3',
      'git diff --compact-summary',
      'git fetch -o x origin',
      'git config --global user.name x',
      'git submodule status',
      'git submodule',
    ]) {
      expect(read(cmd), cmd).toEqual([]);
    }
    // Any other variable may point git at other settings or run a program, also given to a
    // shell that runs git, or exported before it.
    for (const cmd of [
      "EDITOR='touch x' git commit",
      "VISUAL='touch x' git commit",
      'HOME=fakehome git commit -qm x',
      'XDG_CONFIG_HOME=xdg git commit -qm x',
      'PATH=/tmp/bin:$PATH git status',
      'SSH_ASKPASS=./x git fetch',
      'PAGER=./show git log',
      'SOME_SETTING=1 git status',
      'export HOME=/tmp/elsewhere && git status',
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=hk bash -c 'git commit -qm x'",
      "env GIT_DIR=../other/.git sh -c 'git log'",
      "HOME=fakehome sh -c 'cd src && git commit -qm x'",
      // Settings git reads later, and subcommands with no option table here.
      'git init -q --template=tpl',
      'git config --file=.git/config core.hooksPath hk',
      'git config -f .git/config core.fsmonitor x',
      'git config --global core.hooksPath hk',
      'git config -f ~/.gitconfig core.pager x',
      'git config -f "$GIT_DIR/config" core.editor x',
      'git submodule update --init',
      'git difftool',
      'git some-alias -b x',
    ]) {
      expect(whole(cmd), cmd).toBe(true);
    }
    // A file of its own is only that file.
    expect(targets('git config -f tool.ini a.b c')).toEqual(['tool.ini']);
    expect(whole('git config -f tool.ini a.b c')).toBe(false);
    expect(whole('git config -f .git/config user.email x@example.invalid')).toBe(false);
    // A variable git reads, set anywhere on the line, counts for every git command on it: which
    // shell gets it, and whether it comes before or after, is not followed. Only builtins,
    // keywords and expansions can set one in this shell: any not known to be harmless counts.
    for (const cmd of [
      "HOME=fakehome sh -c 'true'; git status",
      'git status; export GIT_DIR=../other/.git',
      'f() { export GIT_DIR=x; }; git status',
      '(HOME=fakehome); git status',
      'for HOME in x; do :; done; git status',
      'read -r line < f; git status',
      'printf -v x y; git status',
      "printf -v 'a[HOME=5]' x; git status",
      'mapfile -t lines < f; git status',
      "mapfile -C 'HOME=x; :' -c1 a < f; git status",
      'getopts ab opt; git status',
      'let i=i+1; git status',
      '(( n == 1 )); git status',
      'echo $(( 1 + 1 )); git status',
      'echo $[ 1 + 1 ]; git status',
      '[[ -f x ]]; git status',
      '[[ 1 -eq HOME=5 ]]; git status',
      'declare -n r=x; git status',
      'typeset -i n=HOME=5; git status',
      'local x; git status',
      'export LANG=C; git status',
      'set -a; git status',
      'set -k; git status HOME=x',
      'set -euo pipefail; git status',
      'shopt -s expand_aliases; git status',
      'setopt allexport; git status',
      '. ./env.sh; git status',
      'source ./env.sh; git status',
      'eval "$cmd"; git status',
      "trap 'rm -f x' EXIT; git status",
      'alias git=x; git status',
      'hash -p ./g.sh git; git status',
      'unset GIT_DIR; git status',
      'command git status',
      'builtin cd x; git status',
      'exec 3>x; git status',
      'git status; GIT_PAGER=$p git log',
      'X[0]=1; git status',
      'a[HOME=5]=1; git status',
      'x=( [HOME=5]=1 ); git status',
      'x=(a b); git status',
      'echo ${a[HOME=5]}; git status',
      'echo ${x:HOME=5}; git status',
      'echo ${x:=y}; git status',
      'echo ${!x}; git status',
      'f=export; $f HOME=x; git status',
      '$(echo export) HOME=x; git status',
      'v=HOME=x; env "$v" git status',
      'env $(echo HOME=x) git status',
      "env -S 'HOME=x git status'",
      'echo status | HOME=x xargs git',
      'echo status | xargs git',
      'echo x | xargs -I{} env {} git status',
      "bash -c -- 'export GIT_DIR=x'; git status",
      "bash -ce 'export GIT_DIR=x'; git status",
      "bash -c -e 'export GIT_DIR=x'; git status",
      "bash -o pipefail -c 'export GIT_DIR=x'; git status",
      "rbash -c 'export GIT_DIR=x'; git status",
      'bash -c "$cmd"; git status',
      'bash -c; git status',
      'cat <<EOF\n$((HOME=5))\nEOF\ngit status',
      'o=-v; printf "$o" HOME x; git status',
      'printf "$(echo -v)" HOME x; git status',
      'o=-x; jobs "$o" true; git status',
      'wait "$o" x; git status',
      'test "$o" "$n"; git status',
      '[ "$o" \'a[i=1]\' ]; git status',
      "echo 'a[$(x)]'; git status",
      'taskset -c 0 git status',
      'strace -f -o /dev/null git status',
      "flock lk -c 'export GIT_DIR=x'; git status",
      'c=x; bash <<< "$c"; git status',
      'echo "$c" | bash; git status',
      'cat x.sh | bash; git status',
      'bash; git status',
      "echo 'echo hi' | bash -s; git status",
      "bash <(echo 'echo hi'); git status",
      'source <(cat x); git status',
    ]) {
      expect(whole(cmd), cmd).toBe(true);
    }
    // A lower-case variable that is not exported is the shell's own; plain words and the
    // builtins known to be harmless change nothing git runs with.
    for (const cmd of [
      'msg=fix; git status',
      'msg="fix"; git commit -qam "$msg"',
      'git add -A && git commit -m "fix $thing"',
      'npm test && git commit -m x',
      'cd sub && git status',
      'if git diff --quiet; then echo ok; fi',
      'for f in a b; do git add "$f"; done',
      'f() { echo hi; }; f; git status',
      'echo "$?" "$1" "${1}" "$@" "${@}" "$#"; git status',
      'test -f x && [ -d y ] && git status',
      'pushd x && popd && pwd && git status',
      'git log | head -1; true; false; :; git status',
      'printf "%s\\n" x; git status',
      'wait; type git; which git; git status',
      'git --version',
      'time git status',
      '! git diff --quiet',
      'out=$(git status); echo "$out"',
      'cat <<EOF\n$HOME ${HOME} $(date)\nEOF\ngit status',
      'case $x in a) git status;; esac',
      'nice -n 5 git status',
      'timeout 60 git fetch -q',
      '[ -f "$f" ] && [ "$a" = "$b" ] && git status',
      'diff <(git show HEAD:a) <(git show HEAD~1:a); git status',
      'bash scripts/check.sh && git status',
      "bash -s x <<< 'echo hi'; git status",
      'man git; brew install git',
    ]) {
      expect(whole(cmd), cmd).toBe(false);
    }
    // Files and folders git fills.
    expect(targets('git read-tree --index-output=certs/idx.pem HEAD')).toEqual(['certs/idx.pem']);
    expect(lands('git init -q -b main --bare vendor')).toEqual(['vendor']);
    expect(lands('git init -q --separate-git-dir=vendor y')).toEqual(['y', 'vendor']);
    expect(lands('git clone -q --separate-git-dir vendor https://example.com/t/x.git')).toEqual([
      'x',
      'vendor',
    ]);
    expect(lands('git clone -q vendor.bundle')).toEqual(['vendor']);
    expect(lands('git clone https://example.com/team/tool.git/')).toEqual(['tool']);
    expect(lands('git clone git@example.com:team/tool.git')).toEqual(['tool']);
    expect(whole('git clone git@example.com:team/tool.git')).toBe(false);
    for (const local of ['git clone repo', 'git clone ../repo x', 'git clone file:///srv/r.git']) {
      expect(whole(local), local).toBe(true);
    }
    expect(lands('git submodule add -q ./ vendor/lib')).toEqual(['vendor/lib']);
    expect(lands('git submodule add -b main https://example.com/team/lib.git')).toEqual(['lib']);
    // Code git runs is read like any other shell code.
    for (const cmd of [
      'git bisect run rm certs/a.pem',
      "git bisect run 'rm certs/a.pem && make test'",
      "git difftool -x 'rm certs/a.pem'",
      "git difftool --extcmd='rm certs/a.pem' HEAD",
      "git -c alias.wipe='!rm certs/a.pem' wipe",
      "git submodule foreach 'rm -f certs/a.pem'",
      "git rebase -x 'rm certs/a.pem' main",
    ]) {
      expect(targets(cmd), cmd).toContain('certs/a.pem');
    }
    // Several words to `bisect run` are a program and its arguments, read as they are.
    expect(targets("git bisect run rm 'certs/*.pem'")).toContain('certs/*.pem');
  });

  it('asks git only when nothing earlier on the line can have changed its answer', () => {
    const questions = (command: string) =>
      readShellWrites(command, { home: HOME, top: TOP }).questions;
    const given = (command: string) =>
      read(command)
        .filter((t) => t.fallback === null && t.certain)
        .map((t) => t.path);
    // Anything that changes what git would answer comes first: git is not asked. The paths a
    // later command names are certain writes.
    for (const cmd of [
      'git reset && git checkout -- secret/key.txt',
      'git add -A && git checkout -- secret/key.txt',
      'git commit -qm wip && git checkout HEAD~1 -- secret/key.txt',
      'git stash && git checkout stash@{0} -- secret/key.txt',
      'git fetch && git checkout origin/main -- secret/key.txt',
      'git remote update && git checkout origin/main -- secret/key.txt',
      'git branch -f main origin/main; git checkout main -- secret/key.txt',
      'git switch other && git checkout -- secret/key.txt',
      'git -C . stash drop && git checkout -- secret/key.txt',
      './sync.sh && git checkout -- secret/key.txt',
      'make && git checkout -- secret/key.txt',
      'bash -c "git pull" && git checkout -- secret/key.txt',
      'echo $(git stash drop) && git checkout -- secret/key.txt',
      'git pull && git checkout -- secret/key.txt',
      'cd /elsewhere && cd - && git checkout -- secret/key.txt',
      'GIT_DIR=other.git git checkout -- secret/key.txt',
      'git --git-dir=other.git checkout -- secret/key.txt',
      'git --icase-pathspecs checkout -- secret/key.txt',
      // A variable git reads, set anywhere on the line: after it, or in a shell of its own.
      'git checkout -- secret/key.txt; export GIT_DIR=other.git',
      'git checkout -- secret/key.txt; f() { export GIT_INDEX_FILE=x; }',
      '(HOME=elsewhere); git checkout -- secret/key.txt',
      'git checkout -- secret/key.txt; for GIT_DIR in other.git; do :; done',
    ]) {
      const later = questions(cmd).filter((x) => x.pathspecs.some((p) => p.endsWith('key.txt')));
      expect(later, cmd).toEqual([]);
      expect(given(cmd), cmd).toEqual(['secret/key.txt']);
    }
    // What it does to the whole tree (a reset, a switch, a merge, a pop) is a possible write: a
    // warning when a covered file is there, never a block.
    for (const cmd of [
      'git fetch origin && git reset --hard origin/main',
      'git stash && git checkout feature && git stash pop',
      'git stash pop stash@{1} && git stash pop',
      'git stash branch tmp && git stash pop',
      'git -C src stash drop && git stash pop',
      'git switch feature && git merge --no-edit certs-change',
      'git checkout -b fix && git commit -qam fix && git checkout main && git merge fix',
      'git fetch -q origin && git merge --no-edit origin/feature',
      'git fetch -q origin && git rebase origin/feature',
      'git commit -qa --amend --no-edit && git checkout feature',
      "git reset -q && git stash push -- ':!src'",
    ]) {
      const stand = read(cmd).filter((x) => x.fallback === null && x.path === TOP);
      expect(stand.length, cmd).toBeGreaterThan(0);
      expect(
        stand.every((x) => !x.certain),
        cmd,
      ).toBe(true);
    }
    // The first command of such a line is still asked.
    expect(questions('git stash && git checkout feature && git stash pop')).toEqual([
      expect.objectContaining({ against: ['HEAD'] }),
    ]);
    // Looking around first changes nothing, nor does writing a file of the project.
    for (const cmd of [
      'git status && git checkout -- secret/key.txt',
      'git log -1 && git diff && git checkout -- secret/key.txt',
      'git branch && git stash list && git checkout -- secret/key.txt',
      'git config --get user.name && git checkout -- secret/key.txt',
      'ls && cat a.txt && git checkout -- secret/key.txt',
      `cd ${TOP}/src && git checkout -- ../secret/key.txt`,
      'cd src && git checkout -- ../secret/key.txt',
      'echo x > notes.txt && git checkout -- secret/key.txt',
    ]) {
      expect(questions(cmd), cmd).toHaveLength(1);
    }
    // A write inside `.git` itself is a change.
    expect(questions('echo x > .git/HEAD && git checkout -- secret/key.txt')).toEqual([]);
    // Case is ignored with `--icase-pathspecs`.
    expect(read('git --icase-pathspecs checkout -- SECRET')[0]).toMatchObject({ nocase: true });
    expect(read("git checkout -- ':(icase)SECRET'")[0]).toMatchObject({ nocase: true });
    // A git command whose folder the text does not tell is said, not dropped.
    expect(readShellWrites('cd "$DIR" && git checkout -- .').limit).toContain('git command');
  });

  it('asks about what a stash, a merge or a picked commit brings in', () => {
    const ask = (command: string) =>
      readShellWrites(command, { home: HOME, top: TOP }).questions.map(
        (q) => `${q.against.join(' ')}${q.listTree ? ' (all of it)' : ''}`,
      );
    expect(ask('git stash pop')).toEqual(['stash@{0}^1 stash@{0}', 'stash@{0}^3 (all of it)']);
    expect(ask('git stash apply 2')).toEqual(['stash@{2}^1 stash@{2}', 'stash@{2}^3 (all of it)']);
    expect(ask('git stash branch tmp stash@{1}')).toEqual([
      'HEAD stash@{1}^1',
      'stash@{1}^1 stash@{1}',
      'stash@{1}^3 (all of it)',
    ]);
    expect(ask('git merge other')).toEqual(['HEAD...other']);
    expect(ask('git merge -m msg a b')).toEqual(['HEAD...a', 'HEAD...b']);
    expect(ask('git cherry-pick -x abc123')).toEqual(['abc123^1 abc123']);
    expect(ask('git cherry-pick -m 2 abc123')).toEqual(['abc123^2 abc123']);
    expect(ask('git revert a..b')).toEqual(['a...b']);
    expect(ask('git cherry-pick ..b')).toEqual(['HEAD...b']);
    expect(ask('git cherry-pick a...b')).toEqual(['a...b', 'b...a']);
    expect(ask('git merge -')).toEqual(['HEAD...@{-1}']);
    // A rebase writes what differs between the branch and where it goes, and what its own
    // commits touch; a branch named is checked out first.
    expect(ask('git rebase main')).toEqual(['HEAD main', 'main...HEAD']);
    expect(ask('git rebase')).toEqual(['HEAD @{upstream}', '@{upstream}...HEAD']);
    expect(ask('git rebase main topic')).toEqual(['HEAD topic', 'topic main', 'main...topic']);
    expect(ask('git rebase --onto HEAD~2 HEAD~1')).toEqual(['HEAD HEAD~2', 'HEAD~1...HEAD']);
    expect(ask('git rebase --autostash main')).toEqual(['HEAD', 'HEAD main', 'main...HEAD']);
    // Already on the upstream, it stays: unless forced, or onto somewhere else.
    expect(readShellWrites('git rebase main').questions[0]?.unlessAncestor).toEqual([
      'main',
      'HEAD',
    ]);
    expect(readShellWrites('git rebase -f main').questions[0]?.unlessAncestor).toBeUndefined();
    expect(
      readShellWrites('git rebase --onto x main').questions[0]?.unlessAncestor,
    ).toBeUndefined();
    // What cannot be asked is a possible write of the tracked files: a warning at most.
    for (const cmd of ['git pull', 'git am x.mbox', 'git apply x.patch', 'git merge --abort']) {
      const reading = readShellWrites(cmd, { home: HOME, top: TOP });
      expect(reading.questions, cmd).toEqual([]);
      expect(reading.targets, cmd).toEqual([
        expect.objectContaining({ path: TOP, certain: false, touches: expect.anything() }),
      ]);
    }
    expect(readShellWrites('git apply --check x.patch').targets).toEqual([]);
    // git clean reads pathspecs as git does.
    expect(read('git clean -fd :/').map((t) => [t.path, t.how])).toEqual([[TOP, 'clean']]);
    expect(read("git clean -fx -- '*.pem'").map((t) => t.path)).toEqual(['*.pem', '*/**/*.pem']);
    // Pathspecs that only leave files out stand for everything else.
    expect(read("git stash push -- ':!src'")).toEqual([
      expect.objectContaining({ path: TOP, fallback: 0 }),
    ]);
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
    // A quoted `~` is a file name, not the home directory: told apart as `./~`.
    expect(targets('rm "~/a.ts"')).toEqual(['./~/a.ts']);
    expect(targets("rm '~'/a.ts")).toEqual(['./~/a.ts']);
    expect(targets('rm \\~/a.ts')).toEqual(['./~/a.ts']);
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
        unplaced: false,
        noFollow: false,
        asWritten: false,
        follows: false,
        intoFolder: false,
        parents: false,
        nested: false,
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
    // What a pipe feeds a shell is not read as code: said as not shown.
    for (const cmd of ["echo 'rm certs/server.pem' | bash", "cat <<'EOF' | sh\nrm x\nEOF"]) {
      expect(readShellWrites(cmd).limit, cmd).toContain('does not show');
    }
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
    // Shell code from a shell's or `source`'s own here-string or here-document.
    expect(targets("bash -s x <<< 'rm a.ts'")).toEqual(['a.ts']);
    expect(targets("bash /dev/stdin <<< 'rm a.ts'")).toEqual(['a.ts']);
    expect(targets("bash -s <<'EOF'\nrm a.ts\nEOF")).toEqual(['a.ts']);
    expect(targets("flock lk -c 'rm a.ts'")).toEqual(['a.ts']);
    expect(targets('taskset -c 0 git checkout v1 -- a.ts')).toContain('a.ts');
    // Code the text does not show is said: a value, a pipe, a process substitution.
    for (const cmd of [
      'c=x; bash <<< "$c"',
      'echo "$c" | bash',
      'eval "$c"',
      'cat x | sh',
      "echo 'rm a.ts' | bash -s x",
      "bash <(echo 'rm a.ts')",
      "source <(printf '%s\\n' 'rm a.ts')",
    ]) {
      expect(readShellWrites(cmd).limit, cmd).toContain('does not show');
    }
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

  it('tells a line it reads fully from one it does not', () => {
    for (const line of [
      'git status',
      'git add -A && git commit -m "fix the parser" || true',
      "git commit -qm 'run git status first'",
      'msg=fix; git commit -m fix',
      'LANG=C git status -s',
      'cd sub && git status && pwd',
      'cd ./a/b && rm -rf dist && mkdir dist > log.txt 2>&1',
      'cd /srv/app && ls',
      "cd 'my folder' && ls",
      'cd sub && ls\n',
      // A `#` that starts a word hides the rest of its line; inside a word or quotes it is
      // a character like any other.
      '# a comment',
      '  # a comment after blanks\n# and another',
      'echo a # b',
      'git status # what changed; rm -rf $x',
      'git status; # then nothing',
      'git status && # then\ngit log',
      'echo a#b "#c" \'# d\'',
      'cd sub && ls # in there',
      // A pipe joins commands that run together or not at all.
      'cd sub && ls | head',
      'cd sub && git log --oneline | head -5 && pwd',
      // `cd` as a word given to another program is not a `cd`.
      'echo cd sub; git log cd',
      'if git diff --quiet; then echo ok; else echo changed; fi',
      'git log --oneline | head -5 | grep fix',
      'git log > log.txt 2>&1',
      'git status </dev/null 2>/dev/null',
      'echo x >&2 3>x.log',
      'rm -rf build/* dist',
      'mkdir -p out && cp -r src out/ && mv out/src out/lib && rm -f out/lib/x.ts',
      'ln -sf a b; touch c; chmod -R u+w out; chown -R me out; rmdir -v empty',
      'cat a.ts | grep -n x | wc -l; ls -la; tail -n 5 a.ts',
      '[ -f a.ts ] && test -d src && echo yes',
      "printf '%s\\n' a b",
      "a='' git status",
      'a="x y" env b=1 LANG=C git status',
      '',
    ]) {
      expect(understoodLine(line), line).toBe(true);
    }
    for (const line of [
      'echo $HOME',
      'git commit -m "$msg"',
      // Only a `cd <folder>` that is the first thing on the line, with nothing but `&&` between
      // the commands after it, is read.
      'cd a; ls',
      'cd a',
      'cd sub && git status; pwd',
      'cd sub && ls\nrm x',
      'cd sub && ls || true',
      'cd sub && ls | head; pwd',
      'cd sub && if true; then ls; fi',
      'ls; cd a && ls',
      '>x || cd a && ls',
      '> x && cd a && ls',
      '2>/dev/null || cd a && ls',
      '</dev/null || cd a && ls',
      '2>&1 || cd a && ls',
      'cd a > x && ls',
      '\ncd a && ls',
      'x=1 cd a && ls',
      "'cd' a && ls",
      'env cd a && ls',
      'env x=1 cd a; ls',
      'command cd a && ls',
      'builtin cd a && ls',
      'sudo cd a && ls',
      'if cd a; then ls; fi',
      // An operand that does not name its folder as written.
      'cd ~ && ls',
      'cd ~/a && ls',
      'cd ~- && ls',
      'cd ~+ && ls',
      'cd ~user && ls',
      'cd a/nosuch/.. && ls',
      'cd a/../b && ls',
      'cd ./a/.. && ls',
      // The shell takes `..` off its own spelling of the folder it is in.
      'cd .. && ls',
      'cd ../.. && ls',
      'cd ../a && ls',
      'cd ./../a && ls',
      'cd /a/.. && ls',
      'cd a* && ls',
      'cd a? && ls',
      "cd '' && ls",
      'cd -- a && ls',
      // A character the reader keeps for its own marks, or any other in private use.
      'cd \ue000 && ls',
      'rm \ue000/x',
      "echo '\uf8ff'",
      'ls \ufdd0 \uffff',
      'ls \u{10fffd}',
      'ls && cd a && ls',
      'cd a && cd b && ls',
      'cd a b && ls',
      'cd -P a && ls',
      'cd - && ls',
      'pushd a && ls',
      'popd && ls',
      'mkdir x && cd x && ls',
      'if true; then cd a; fi; ls',
      // Programs whose writes are not modelled completely, or options not known here.
      'npm test 2>&1 | tail -20',
      'pnpm build > build.log 2>&1',
      'git diff | tee out.diff',
      'timeout 60 git fetch -q',
      'npx prettier --write src',
      'npx -c "rm x"',
      'python -c "print(1)"',
      'node -e "1"',
      'sort -o out a',
      'uniq a b',
      'awk 1 a',
      'sed -n 1p a',
      'rg --pre rm k',
      'tsc --outFile out a.ts',
      'env --spl "rm x"',
      'env -i git status',
      'cp -b a b',
      'cp -rT d certs',
      'cp -r --no-target-directory d certs',
      'mv -T d certs',
      'ln -f ../d/server.pem',
      'ln -sf ../d/server.pem',
      'cp --parents a/b c',
      'rm --rec x',
      'touch -r ref x',
      'chmod -x a.sh',
      'rmdir -p a/b',
      'grep -r x .',
      './rm x',
      '/usr/bin/rm x',
      // Assignments by the shell's rules, whatever the quoting of their value.
      "A='' bash -c 'rm x'",
      'A="" sh -c x',
      "A='' eval 'rm x'",
      'env A="" bash -c x',
      'HOME=certs; rm ~/x',
      'HOME=certs; cd; rm x',
      'CDPATH=x cd a',
      'PWD=/ git status',
      'GIT_DIR=x git status',
      'echo `date`',
      'echo a\\ b',
      '(cd a && ls)',
      '{ ls; }',
      'f() { ls; }',
      'for f in a; do echo; done',
      'cat <<EOF\nx\nEOF',
      'bash <<< x',
      'diff <(ls) <(ls)',
      'rm a[12].ts',
      'echo {a,b}',
      '! git diff --quiet',
      'sleep 1 &',
      'export X=1',
      'set -e',
      'source x.sh',
      "bash -c 'git status'",
      'git log | xargs echo',
      'git log |& cat',
      'taskset -c 0 git status',
      "script -qec 'git status' /dev/null",
      'env -S "git status"',
      'echo x <&3',
      'echo x >| f',
      'cat < file',
      // A comment hides nothing that is run after its line, nor a redirection's target.
      'git status # then\nrm $x',
      'echo x > # nowhere',
      'echo "unclosed # not a comment',
      'printf -v x y',
      'test -v x',
      'git status;;',
      'echo "unclosed',
      'echo x |',
    ]) {
      expect(understoodLine(line), line).toBe(false);
    }
    // With a `CDPATH` in the shell, a bare name may be found in one of its folders.
    for (const line of ['cd a && ls', 'cd a/b && ls']) {
      expect(understoodLine(line, { cdpath: true }), line).toBe(false);
    }
    for (const line of ['cd ./a && ls', 'cd ./a/b && ls', 'cd /a && ls', 'cd . && ls', 'ls a']) {
      expect(understoodLine(line, { cdpath: true }), line).toBe(true);
    }
    // An `mv` of the folder the line runs in, or of one above it: what follows runs elsewhere.
    for (const [line, fully] of [
      ['cd a/b && mv ../../a ../../c && touch x', false],
      ['cd a && mv ../a ../c && touch x', false],
      ['cd a && mv ../? ../c && touch x', false],
      ['cd a/b && git mv ../../a ../../c && touch x', false],
      ['mv ../a ../c && touch x', false],
      ['ln -s .. up && mv up/a c && touch x', false],
      ['cd a && mv b ../c && touch x', true],
      ['cd a && mv * ../c', true],
      ['mv a b && mv c d', true],
      ['mkdir -p out && mv out/a b', true],
      ['echo x > tmp && mv tmp a', true],
      // A path through something made earlier on the line may lead anywhere.
      ['ln -s certs l && rm -f l/x', false],
      ['ln -s certs l && echo x > l/y', false],
      ['ln -s certs l && touch l/', false],
      ['cd sub && ln -s ../certs l && rm -f l/x', false],
      ['cp -r a b && rm b/x', false],
      ['mv a b && rm b/x', false],
      ['git checkout v1 -- l && rm -f l/x', false],
      // git does not follow a link in its tree: its own pathspecs lead where they say.
      ['ln -s certs l && git checkout v1 -- l/x', true],
      ['ln -s certs l && git rm -q l/x', true],
      ['ln -s certs l && git mv a l/', false],
      ['echo x > f && rm f/y', false],
      ['touch f && cat f/y > out', true],
      ['cp -a l/* . && rm -f k/x', false],
      // A write onto what a command that may make a link made goes where the link leads.
      ['ln -s certs/k f && echo x > f', false],
      ['ln certs/k f && echo x > f', false],
      ['ln certs/k f && chmod 600 f', false],
      ['cp -a l f && echo x > f', false],
      ['mv a b && echo x >> b', false],
      ['echo a > f && echo b >> f && chmod 755 f', true],
      ['touch f && rm f', true],
      ['cp a b && chmod 755 b', true],
      // A folder `mkdir` made is one, unless something else made that path.
      ['mkdir -p out/a && touch out/a/x && rm -f y', true],
      ['mkdir build && cp a.txt build/a.txt', true],
      ['rm -rf d && mkdir d && cp a d/a', true],
      ['mkdir d && chmod 755 d && cp a d/x', true],
      ['mkdir d && rmdir d && ln -s certs d && rm -f d/x', false],
      ['rm -rf d && ln -s certs d && mkdir d; rm -f d/x', false],
      ['ln -s certs d; mkdir -p d/e; rm -f d/x', false],
      ['mkdir d && ln -s ../certs d && rm -f d/certs/x', false],
      ['mkdir d && cp a d && cp b d', true],
      ['mkdir d && mv a d/ && mv b d/', true],
      ['mkdir d && mv a d && mv b d', false],
      // A destination written with a `/` is a folder: what lands in it is made, not the folder.
      ['cp a d/ && echo x > d/y', true],
      ['cp a d/ && echo x >> d/a', true],
      ['ln -s ../certs d/ && rm -f d/certs/x', false],
      // What lands on a name a command that may make a link made may go through it.
      ['cp -P l d/ && cp -r x/l d/', false],
      ['cp a d/ && cp b d/', true],
      // A path the text does not settle: `..` after a folder's name, a `~` that is not the
      // user's own home.
      ['rm -f deep/../x', false],
      ['echo x > a/b/../c', false],
      ['cp a.txt deep/..', false],
      ['cp deep/../a.txt b', false],
      ['cd sub && rm -f lk/../x', false],
      ['git checkout v1 -- a/../x', false],
      ['rm -f ../../x', true],
      ['rm -f ./a/x', true],
      ['rm -f ~-/x', false],
      ['rm -f ~+/x', false],
      ['rm -f ~someone/x', false],
      ['echo x > ~other', false],
      ['rm -f ~/x', true],
      ["rm -f '~x'", true],
      // A folder git is sent to that is, or is reached through, something the line made.
      ['ln -s . d && git --work-tree=d checkout v1 -- x', false],
      ['ln -s . d && git -C d status', false],
      ['ln -s . d && git -C d/sub status', false],
      ['ln -s x d && git --git-dir=d/.git status', false],
      ['cp -r a b && git -C b status', false],
      ['git -C a/../b status', false],
      ['git -C ~other status', false],
      ['mkdir wt && git -C wt status', true],
      ['git -C sub status && git --work-tree=. status', true],
      // What a tree holds after git may have changed any of it is made by git.
      ['git pull && rm -f x', false],
      ['git reset --hard && echo x > a/b', false],
      ['git stash pop && cp a b', false],
      ['git checkout v1 -- . && rm -f x', false],
      ['git checkout main && git stash pop && git status', true],
      ['git pull && git checkout -- x', true],
      ['git status && rm -f x', true],
      ['git add -A && git commit -m x && rm -f x', true],
      // More sources than are kept by name.
      [`cp ${Array.from({ length: 65 }, (_, i) => `s${i}`).join(' ')} dest/`, false],
      [`cp ${Array.from({ length: 64 }, (_, i) => `s${i}`).join(' ')} dest/`, true],
      // A wildcard with more runs of `*` than are matched may match what the line made.
      ['rm -f *a*a*a*a*b && cp a.txt c', false],
      ['rm -f *a*b && cp a.txt c', true],
      ['mkdir aaa && cp a.txt *a*a*a*a*b/', false],
      // What is only removed, or changed in mode, is not made.
      ['rm -rf d && touch d/x', true],
      ['chmod -R 755 d && rm d/x', true],
    ] as const) {
      expect(readShellWrites(line, { understoodOnly: true }).understood, line).toBe(fully);
    }
    // A path told from the folder the line starts in and an absolute one are the same place.
    const from = (line: string) =>
      readShellWrites(line, { understoodOnly: true, cwd: '/w', top: '/w' }).understood;
    expect(from('ln -s certs /w/l && rm -f l/x')).toBe(false);
    expect(from('ln -s certs l && rm -f /w/l/x')).toBe(false);
    expect(from('ln -s certs /v/l && rm -f l/x')).toBe(true);
    // A folder on disk that the line has not touched takes what is copied into it.
    const onDisk = (line: string, linked = false) =>
      readShellWrites(line, {
        understoodOnly: true,
        cwd: '/w',
        isDir: (path) => path === 'docs',
        linked: () => linked,
      }).understood;
    expect(onDisk('cp a docs && echo x > docs/y')).toBe(true);
    expect(onDisk('ln -s ../certs docs && rm -f docs/certs/x')).toBe(false);
    expect(onDisk('ln -sfn certs docs && rm -f docs/x', true)).toBe(false);
    expect(onDisk('rm -rf docs && ln -s certs docs && rm -f docs/x')).toBe(false);
    // What a comment hides is not read; the line after it is.
    expect(targets('# rm a.ts\nrm b.ts')).toEqual(['b.ts']);
    expect(targets('rm a.ts # rm b.ts')).toEqual(['a.ts']);
    expect(readShellWrites('cd sub && ls # x\nrm y', { understoodOnly: true }).understood).toBe(
      false,
    );
    // A name that merely starts with `~` is a path like any other, given as `./~…`; one the
    // shell expands to a home that is not known here keeps its `~`, is marked, and not placed.
    const placed = (line: string) =>
      readShellWrites(line).targets.map((t) => `${t.path}${t.unplaced ? ' unplaced' : ''}`);
    expect(placed('rm -f ./~/k.pem')).toEqual(['./~/k.pem']);
    expect(placed("rm -f '~'/k.pem")).toEqual(['./~/k.pem']);
    expect(placed('rm -f ./~old.pem "~new.pem"')).toEqual(['./~old.pem', './~new.pem']);
    expect(placed('rm -f ~other/k.pem')).toEqual(['~other/k.pem unplaced']);
    // The shell expands a `~` only as the first character of a word, with nothing quoted (not
    // even an empty string) before the first `/`, and never after the `=` of an option.
    for (const line of [
      "rm -f ~''/k.pem",
      "rm -f ~'/k.pem'",
      "rm -f ''~/k.pem",
      'rm -f ~""/k.pem',
      'rm -f "~"/k.pem',
      'rm -f \\~/k.pem',
    ]) {
      expect(placed(line), line).toEqual(['./~/k.pem']);
    }
    expect(placed('git diff --output=~/n.pem v1 v2')).toEqual(['./~/n.pem']);
    expect(placed('rm -f ~/\'k.pem\' ~/"k.pem"')).toEqual(['~/k.pem unplaced']);
    expect(placed('rm -f ~/k.pem')).toEqual(['~/k.pem unplaced']);
    expect(readShellWrites('rm -f ~/k.pem', { home: '/home/u' }).targets[0]).toMatchObject({
      path: '/home/u/k.pem',
      unplaced: false,
    });
    expect(readShellWrites('cd ./~ && rm -f k.pem', { understoodOnly: true })).toMatchObject({
      understood: true,
      targets: [{ path: './~/k.pem', unplaced: false }],
    });
    // A wildcard the shell may match against a symbolic link leads where the link does: a
    // folder on the way, whatever the command; the last part, for a write in place or a removal
    // with a `/` after it.
    const links: string[] = [];
    const withLinks = (line: string) =>
      readShellWrites(line, {
        understoodOnly: true,
        cwd: '/w',
        strays: ({ path, kind }) => {
          links.push(`${kind} ${path}`);
          return kind === 'link' ? /^l\?k|^sub\/\*/.test(path) : /^l\?k/.test(path);
        },
      }).understood;
    for (const [line, fully] of [
      ['rm -f l?k/server.pem', false],
      ['rm -f sub/*/server.pem', false],
      ['cat l?k/server.pem > out.txt', true],
      ['rm -rf l?k/', false],
      ['rm -rf l?k', true],
      ['rm -f *.tmp', true],
      ['chmod 600 l?k', false],
      ['echo x > l?k', false],
      ['rm -rf packages/*/dist', true],
      ["git checkout -- 'l?k/x'", true],
      // A wildcard in the destination of a copy, move or link: what is brought lands in a
      // folder the wildcard matches, or under the name as written when nothing matches.
      ['mv b.txt l?k', false],
      ['mv -t l?k b.txt', false],
      ['ln -s ../a.txt l?k', false],
      ['cp b.txt l?k', false],
      ['mv b.txt d?r', false],
      ['cp b.txt out/*/', false],
      ['mv *.log logs/', true],
      ['chmod 600 d?r', true],
    ] as const) {
      expect(withLinks(line), line).toBe(fully);
    }
    // A wildcard in a name a command makes itself stays as written when nothing matches: the
    // name is read both ways, as what it matches and as the name itself.
    const both = (line: string) =>
      readShellWrites(line, { understoodOnly: true }).targets.map(
        (t) => `${t.path}${t.glob ? ' (wildcard)' : ''}`,
      );
    expect(both('touch certs/zz*')).toEqual(['certs/zz* (wildcard)', 'certs/zz*']);
    expect(both('echo x > certs/new?.pem')).toEqual([
      'certs/new?.pem (wildcard)',
      'certs/new?.pem',
    ]);
    expect(both('mkdir -p out/n?w')).toEqual(['out/n?w (wildcard)', 'out/n?w']);
    expect(both('rm -f certs/*.pem')).toEqual(['certs/*.pem (wildcard)']);
    expect(both('chmod 600 certs/*.pem')).toEqual(['certs/*.pem (wildcard)']);
    links.length = 0;
    withLinks('rm -rf packages/*/dist/*.js && rm -rf out/*/');
    expect(links).toEqual(['link packages/*/dist', 'link out/*']);
    // A pathspec git matches by rules of its own may name anything in its tree.
    for (const [line, fully] of [
      ["git checkout other -- ':(icase)LNK' && rm -f lnk/x", false],
      ["git checkout other -- ':(glob)**/lnk' && rm -f lnk/x", false],
      ["git restore -s other ':/lnk' && echo x > lnk/y", false],
      ['git --icase-pathspecs checkout other -- LNK && rm -f lnk/x', false],
      ["git --glob-pathspecs checkout other -- '**/lnk' && rm -f lnk/x", false],
      ['git --literal-pathspecs checkout other -- lnk && rm -f other/x', false],
      ['git checkout other -- lnk && rm -f other/x', true],
      ["git checkout other -- ':(icase)LNK' && git status", true],
    ] as const) {
      expect(readShellWrites(line, { understoodOnly: true }).understood, line).toBe(fully);
    }
    // A file with another name is written under both: a line that writes one in place is
    // not read fully. A name taken away, or given to something else, leaves the file be.
    const asked: string[] = [];
    const withNames = (line: string) =>
      readShellWrites(line, {
        understoodOnly: true,
        cwd: '/w',
        isDir: (path) => path === 'dir',
        strays: ({ path, kind, glob, from }) => {
          asked.push(`${kind} ${path}${glob ? ' glob' : ''}${from ? ` from ${from}` : ''}`);
          return (
            path === 'f' ||
            path === 'sub/f' ||
            path === 'dir/f' ||
            (kind === 'tree' && path === 'dir') ||
            (kind === 'copy' && path === 'dir/a')
          );
        },
      }).understood;
    for (const [line, fully] of [
      ['echo x > f', false],
      ['echo x >> f', false],
      ['cp a.txt f', false],
      ['cp -f a.txt f', false],
      ['touch f', false],
      ['chmod 600 f', false],
      ['chown me f', false],
      ['cd sub && echo x > f', false],
      ['chmod -R 600 dir', false],
      ['chown -R me dir', false],
      ['cp f dir', false],
      ['cp -r a dir/', false],
      ['git diff --output=f HEAD', false],
      // Not in place.
      ['rm -f f', true],
      ['mv a.txt f', true],
      ['ln -sf a.txt f', true],
      ['ln -f a.txt f', true],
      ['cp --remove-destination a.txt f', true],
      ['git checkout v1 -- f', true],
      ['chmod 600 dir', true],
      ['echo x > new.txt', true],
      ['cat f', true],
    ] as const) {
      expect(withNames(line), line).toBe(fully);
    }
    asked.length = 0;
    withNames(
      'touch d*/f && cp a b && cp -r src/. out && git format-patch -o patches -1 && git clone u c',
    );
    expect(asked).toEqual([
      'link d* glob',
      'file d*/f glob',
      // The name as written too: it is made when the wildcard matches nothing.
      'file d*/f',
      'file b',
      'copy b/a from a',
      'file out',
      'copy out from src',
      'file patches/*.patch glob',
      'land c',
    ]);
    for (const [part, name, names] of [
      ['a*', 'abc', true],
      ['*c', 'abc', true],
      ['a*c', 'abc', true],
      ['a*b*c', 'a-b-c', true],
      ['a*b*c', 'a-c-b', false],
      ['a?c', 'abc', true],
      ['a?c', 'ac', false],
      ['*?*', '', false],
      ['*', '', true],
      ['a*a', 'a', false],
      ['*.t?', 'x.ts', true],
      ['*a?c*', 'xxabcxx', true],
      ['*a?c*', 'xxabxx', false],
      ['abc', 'abc', true],
      ['abc', 'abd', false],
      // More runs of `*` than are matched: any name.
      ['*a*a*a*b', 'zzz', true],
      ['*a*a*b', 'zzz', false],
    ] as const) {
      expect(partNames(part, name), `${part} ~ ${name}`).toBe(names);
    }
    // Linear in the name: a pattern that sends an expression back and forth is matched at once.
    const started = performance.now();
    for (let i = 0; i < 2000; i++) partNames('*a*a*b', 'a'.repeat(4000));
    expect(performance.now() - started).toBeLessThan(500);
    expect(mayHold('/w/a', '/w/a/b')).toBe(true);
    expect(mayHold('/w/a/b', '/w/a/b')).toBe(true);
    expect(mayHold('/w/?', '/w/a/b')).toBe(true);
    expect(mayHold('/w/a/b/c', '/w/a/b')).toBe(false);
    expect(mayHold('/w/c', '/w/a/b')).toBe(false);
    expect(mayHold('/w/a/*', '/w/a')).toBe(false);
    // A copy into a folder made earlier on the line lands inside it.
    const into = readShellWrites('mkdir vendor && cp src/a.ts vendor', { understoodOnly: true });
    expect(into.understood).toBe(true);
    expect(into.targets).toMatchObject([{ path: 'vendor', intoFolder: true, entries: ['a.ts'] }]);
    expect(readShellWrites('touch v && cp a.ts v', { understoodOnly: true }).understood).toBe(
      false,
    );
    // Not read fully, a line stands for the whole tree, a possible write, and nothing else.
    const unread = readShellWrites('rm $(cat list)', { top: '/w', understoodOnly: true });
    expect(unread.understood).toBe(false);
    expect(unread.targets).toMatchObject([{ path: '/w', tree: true, certain: false }]);
    // The first few paths it names are kept.
    const few = Array.from({ length: 32 }, (_, i) => `f${i}`).join(' ');
    const more = readShellWrites(`touch ${few}; echo "$x" > .env`, {
      top: '/w',
      understoodOnly: true,
    });
    expect(more.targets.map((t) => t.path)).toContain('f31');
    expect(more.targets.map((t) => t.path)).not.toContain('.env');
    // A character of the reader's own marks, written in the line, is not one of them.
    expect(readShellWrites('rm \ue000/x').targets).toEqual([]);
    expect(readShellWrites('rm "$PWD/x"').targets.map((t) => t.path)).toEqual(['x']);
  });

  it('reads what stands after --, a colon in a name and paths the system makes up as they are', () => {
    const copy = (line: string) =>
      readShellWrites(line).targets.map(
        (t) => `${t.path} <- ${t.entries.join(',')}${t.noFollow ? ' (the name itself)' : ''}`,
      );
    // After `--` a word is an operand, whatever it looks like.
    expect(copy('ln -sf -- -n out/dl')).toEqual(['out/dl <- -n']);
    expect(copy('ln -sf -t out/dl -- -n')).toEqual(['out/dl <- -n']);
    expect(copy('cp -- b.txt -t out2 certs')).toEqual(['certs <- b.txt,-t,out2']);
    expect(copy('cp -- cur --remove-destination hl/')).toEqual(['hl <- cur,--remove-destination']);
    expect(readShellWrites('cp -- cur --remove-destination f').targets).toHaveLength(1);
    // `ln -n` takes a link to a folder as a name, unless a `/` follows it or there are sources.
    expect(copy('ln -sfn b.txt lk')).toEqual(['lk <- b.txt (the name itself)']);
    expect(copy('ln -sfn b.txt lk/')).toEqual(['lk <- b.txt']);
    expect(copy('ln -sfn b.txt lk/.')).toEqual(['lk <- b.txt']);
    expect(copy('ln -sfn b.txt c.txt lk')).toEqual(['lk <- b.txt,c.txt']);
    // Only scp and rsync take `host:path`; to `mv` and `cp` a colon is part of a name.
    const paths = (line: string) => readShellWrites(line).targets.map((t) => t.path);
    expect(paths('mv k:1.pem x.txt')).toEqual(['k:1.pem', 'x.txt']);
    expect(readShellWrites('cp k:1.pem x.txt').targets[0]?.sources).toEqual(['k:1.pem']);
    expect(paths('scp host:k.pem x.txt')).toEqual(['x.txt']);
    expect(readShellWrites('scp host:k.pem x.txt').targets[0]?.sources).toEqual([null]);
    // Where a write goes nowhere is no file; any other path under /dev, /proc or /sys leads
    // where the text does not tell.
    const fully = (line: string) => readShellWrites(line, { understoodOnly: true }).understood;
    for (const sink of ['/dev/null', '/dev/stderr', '/dev/stdout', '/dev/tty', '/dev/fd/2']) {
      expect(paths(`echo x > ${sink}`), sink).toEqual([]);
      expect(fully(`echo x > ${sink}`), sink).toBe(true);
    }
    for (const line of [
      'rm -f /proc/self/cwd/certs/server.pem',
      'echo x > /proc/self/root/w/certs/server.pem',
      'touch /dev/shm/x',
      'echo 1 > /sys/kernel/x',
    ]) {
      expect(fully(line), line).toBe(false);
    }
    // A home that is set and empty: the shell takes `~/x` as `/x`.
    expect(readShellWrites('rm -f ~/w/k.pem $HOME/w/l.pem', { home: '' }).targets).toMatchObject([
      { path: '/w/k.pem', unplaced: false },
      { path: '/w/l.pem', unplaced: false },
    ]);
  });

  it('holds a name that starts with ~, and a link that was there, against what the line made', () => {
    const fully = (line: string, links: readonly string[] = []) =>
      readShellWrites(line, {
        understoodOnly: true,
        cwd: '/w',
        viaLink: (path) => links.some((l) => path === l || path.startsWith(`${l}/`)),
      }).understood;
    // A link the line made is one whatever its name starts with.
    for (const line of [
      "ln -s certs '~x'; rm -f '~x'/server.pem",
      'ln -s certs "~" && rm -f "~"/server.pem',
      'ln -s certs ./~l && rm -f ./~l/server.pem',
      "ln -s certs ~''l && touch ~''l/new.pem",
      "mkdir '~'; ln -s ../certs '~'/l; rm -f '~'/l/server.pem",
      "ln -s certs '~l' && cp b.txt '~l'",
      "cd '~d' && ln -s ../certs l && rm -f l/server.pem",
    ]) {
      expect(fully(line), line).toBe(false);
    }
    expect(fully("mkdir '~d' && touch '~d'/x && rm -f '~e'/y")).toBe(true);
    // Once the line has made something, a link that was there may lead to it.
    for (const [line, read] of [
      ['ln -s ../../certs d/a/sub; rm -f lnk/sub/server.pem', false],
      ['mkdir secrets && mv b.txt lnk/k', false],
      ['mkdir secrets && mv b.txt lnk', false],
      ['echo x > f && cp b.txt out/lnk', false],
      // Not for what git is given in its tree, and not before anything is made.
      ['mkdir secrets && git checkout -- lnk/x', true],
      ['rm -f lnk/sub/server.pem', true],
      ['rm -f lnk/a && rm -f lnk/b', true],
      ['mkdir -p out/a/b && touch out/a/b/x', true],
    ] as const) {
      expect(fully(line, ['lnk', 'out/lnk']), line).toBe(read);
    }
    // Folders `mkdir -p` makes on the way are folders for a later copy, however many.
    const lands = (line: string) =>
      readShellWrites(line, { understoodOnly: true, cwd: '/w' }).targets.map((t) => t.path);
    expect(lands('mkdir -p a/b/c a/b/d && cp x.txt a/b')).toEqual(['a/b/c', 'a/b/d', 'a/b']);
    expect(
      readShellWrites('mkdir -p a/b/c && cp x.txt y.txt a/b', { understoodOnly: true }).targets[1],
    ).toMatchObject({ path: 'a/b', intoFolder: true, entries: ['x.txt', 'y.txt'] });
  });

  it('holds the sources of a copy against what the line wrote', () => {
    const fully = (line: string, links: readonly string[] = []) =>
      readShellWrites(line, {
        understoodOnly: true,
        cwd: '/w',
        viaLink: (path) => links.some((l) => path === l || path.startsWith(`${l}/`)),
      }).understood;
    for (const [line, read] of [
      // A wildcard that may match what the line made.
      ['echo x > n.key && cp *.key certs/', false],
      ['echo x > n.key && cp -t certs *.key', false],
      ['echo x > n.key && ln *.key certs/', false],
      ['touch n.key; cp n* certs/', false],
      ['mkdir zq && echo x > zq/n.key && cp -r z* certs/', false],
      ['echo x > n.key && cp *.txt certs/', true],
      // A folder the line wrote into, copied with what it holds.
      ['echo x > out/n.key && cp -r out/. certs/', false],
      ['echo x > out/n.key && cp -r out certs/', false],
      ['echo x > out/n.key && cp out/* certs/', false],
      ['echo x > out/n.key && mv out certs/', false],
      ['mkdir -p a/b && cp -r a x/', false],
      ['echo x > out/n.key && cp -r src certs/', true],
      ['echo x > out/n.key && cp -r out/sub certs/', true],
      // What the line made, copied with what it holds or leads to.
      ['ln -s pems pp; cp -r pp/. out/', false],
      ['ln -s pems pp; cp -r pp/ out/', false],
      ['ln -s pems pp; cp -rL pp out/', false],
      ['cp -r a b && cp -r b c', false],
      ['rm -rf out && cp -r out x/', false],
      // A file the line made, or a folder `mkdir` made, brings its name and no more.
      ['echo x > n.key && cp n.key certs/', true],
      ['echo x > n.key && mv n.key certs/', true],
      ['touch n.key && ln n.key certs/', true],
      ['mkdir d && cp -r d certs/', true],
      ['ln -s pems pp; cp pp out/', true],
      // What a folder `mkdir -p` found there is as it was.
      ['mkdir -p out && mv out/a b', true],
      ['mkdir -p out && cp -r out/a b', true],
      ['mkdir -p dist && cp a.txt dist/', true],
      ['cp -r src out', true],
    ] as const) {
      expect(fully(line), line).toBe(read);
    }
    // Once the line has made something, a link that was there may lead to it.
    expect(fully('ln -s ../../pems d/a/sub; cp -r lnk/sub/. out/', ['lnk'])).toBe(false);
    expect(fully('ln -s ../../pems d/a/sub; cp lnk/sub/* out/', ['lnk'])).toBe(false);
    expect(fully('mkdir tmp && cp lnk/a.txt tmp/', ['lnk'])).toBe(false);
    expect(fully('cp lnk/a.txt tmp/', ['lnk'])).toBe(true);
    // What a command makes at a path with such a link is somewhere the text does not tell:
    // nothing written after it is read. Read alone, or before a command that only reads, it is.
    for (const [line, read] of [
      ['ln -s ../certs current/x && rm -f stage/x/server.pem', false],
      ['echo x > current/app.json && cp -r stage/. conf/', false],
      ['cp a.txt current/app.json && mv stage/* conf/', false],
      ['echo x > current/app.json', true],
      ['echo x > current/app.json && ls stage', true],
      ['rm -f current/app.json && rm -f stage/x', true],
      // A folder `mkdir` made there holds nothing and leads nowhere.
      ['mkdir current/d && rm -f stage/x', true],
    ] as const) {
      expect(fully(line, ['current']), line).toBe(read);
    }
    // A folder `mkdir` made through such a link is a folder under another spelling too: a copy
    // to what is neither on disk nor a folder the line made by that spelling is not read.
    expect(fully('mkdir -p current/n && cp certs/server.pem stage/n', ['current'])).toBe(false);
    expect(fully('mkdir -p current/n && cp a.txt stage/n/', ['current'])).toBe(false);
    expect(fully('mkdir -p dist/assets && cp a.txt dist/assets/', ['current'])).toBe(true);
    // A target named twice keeps what either mention says of it.
    const twice = (line: string) => readShellWrites(line, { understoodOnly: true });
    expect(twice('cp -r a out/ && cp -rL docs out/').targets[0]).toMatchObject({ follows: true });
    expect(twice('mkdir x/k/b; mkdir -p x/k/b').targets[0]).toMatchObject({ parents: true });
    // A destination a copy may fill as a folder holds names not known, and is no plain file.
    expect(fully('cp tpl/* stage && cp -r stage/. conf/')).toBe(false);
    expect(fully('cp -t stage tpl/* && cp -a stage/. conf/')).toBe(false);
    expect(fully('cp -r tpl stage && mv stage conf/')).toBe(false);
    expect(fully('cp a.txt b.txt && mv b.txt conf/')).toBe(true);
    // The content of a source found by a wildcard in a folder on its way is not looked up.
    expect(fully('cp -r pkg/*/keys out/')).toBe(false);
    expect(fully('cp -r */a/keys/. out/')).toBe(false);
    expect(fully('cp pkg/*/keys/k.pem out/')).toBe(true);
    expect(fully('cp -r pkg/a/keys out/')).toBe(true);
    // What the caller is told of a copy that follows links, and of `mkdir -p`.
    expect(readShellWrites('cp -rL docs out/').targets[0]).toMatchObject({ follows: true });
    expect(readShellWrites('cp -r docs out/').targets[0]).toMatchObject({ follows: false });
    expect(readShellWrites('mkdir -p a/b/c').targets[0]).toMatchObject({ parents: true });
    expect(readShellWrites('mkdir a/b/c').targets[0]).toMatchObject({ parents: false });
    // `ln -s` makes a link under each source's name as written, there or not.
    const written = (line: string) =>
      readShellWrites(line).targets.map(
        (t) => `${t.path} <- ${t.entries.join(',')}${t.asWritten ? ' (as written)' : ''}`,
      );
    expect(written('ln -s shared/*.pem certs/')).toEqual(['certs <- *.pem (as written)']);
    expect(written('ln -s -t certs nothing*')).toEqual(['certs <- nothing* (as written)']);
    expect(written('ln shared/*.pem certs/')).toEqual(['certs <- *.pem']);
    expect(written('cp shared/*.pem certs/')).toEqual(['certs <- *.pem']);
    // A wildcard in a folder git is sent to, or fills with files of its own naming.
    for (const [line, read] of [
      ['git -C cert? rm -q -f server.pem', false],
      ['git -C cert? status', false],
      ['git --work-tree=cert? checkout -- x', false],
      ['git --git-dir=.gi? status', false],
      ['git format-patch -1 -o cert?', false],
      ['git format-patch -1 --output-directory c*s', false],
      ["git -C 'cert?' status", true],
      ['git -C certs status', true],
      ['git format-patch -1 -o patches', true],
    ] as const) {
      expect(readShellWrites(line, { understoodOnly: true }).understood, line).toBe(read);
    }
    // What follows `--` is an operand: a mode, or a name, that starts with a dash.
    const paths = (line: string) => readShellWrites(line).targets.map((t) => t.path);
    expect(paths('chmod -- -w certs/server.pem')).toEqual(['certs/server.pem']);
    expect(paths('chmod -R -- -w certs')).toEqual(['certs']);
    expect(paths('chmod 600 -- -old.pem')).toEqual(['-old.pem']);
    expect(paths('chown -- root -old.pem')).toEqual(['-old.pem']);
    expect(paths('rm -- -old.pem -f')).toEqual(['-old.pem', '-f']);
    expect(paths('rm -f -- -old.pem')).toEqual(['-old.pem']);
    expect(paths('touch -- -new.pem')).toEqual(['-new.pem']);
    expect(paths('mkdir -p -- -d')).toEqual(['-d']);
    expect(paths('rmdir -- -d')).toEqual(['-d']);
    expect(paths('chmod +x scripts/build.sh')).toEqual(['scripts/build.sh']);
  });

  it('answers a line of 200,000 characters of any shape in good time', () => {
    for (const unit of [
      'mkdir x && cd x && ',
      'echo cd ',
      'x cd ',
      'git log cd ',
      'xargs -i ',
      'echo $(x) ',
      'a[$(b)] ',
      'git checkout -- a ',
      'cd a; ',
      '"$x" ',
      'echo a | grep b; ',
      'x=1 ',
      "echo 'a b' ",
      'a/*/b ',
      'cp -r a b; ',
      'env -S x ',
      '((',
      '$(',
    ]) {
      const line = `${unit.repeat(Math.floor(199_000 / unit.length))}git status`;
      // The best of a few runs, so a busy machine does not decide it.
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const started = performance.now();
        readShellWrites(line, { top: '/w', understoodOnly: true });
        best = Math.min(best, performance.now() - started);
      }
      // 100 ms is the aim; the bound leaves room for a busy runner. A line of `cd` commands
      // costs a fixed 130 ms or so here whatever its length, and twice that on a slow runner.
      expect(best, unit).toBeLessThan(400);
    }
  });

  it('says when a limit cut the reading short', () => {
    expect(readShellWrites('rm a.ts')).toEqual({
      targets: [expect.anything()],
      questions: [],
      limit: null,
      understood: true,
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
    // A long run of slashes is read in linear time.
    const slashes = performance.now();
    pathNamer(`cat ${'/'.repeat(199_990)}x`);
    readShellWrites(`git clone https://e.invalid${'/'.repeat(199_950)}x`);
    readShellWrites(`git submodule add https://e.invalid${'/'.repeat(199_950)}x`);
    expect(performance.now() - slashes).toBeLessThan(500);
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

  it('limits a rule that starts with ** to the folder written, the folder itself included', () => {
    // The rule's folder may be the folder written, or one above it: its files are right there.
    expect(limitTo('certs', '**/certs/**')).toBe('certs/**');
    expect(limitTo('pkg/certs', '**/certs/**')).toBe('pkg/certs/**');
    expect(limitTo('certs', '**/certs/*.pem')).toBe('certs/**/*.pem');
    expect(limitTo('config', '**/config/secrets.json')).toBe('config/**/secrets.json');
    expect(limitTo('pkg/certs', '**/pkg/**/p.pem')).toBe('pkg/certs/**/p.pem');
    expect(limitTo('a/x', 'a/**/x/**')).toBe('a/x/**');
    // A rule that names no folder of the one written lies below it, as before.
    expect(limitTo('packages', '**/secret1/**')).toBe('packages/**/secret1/**');
    expect(limitTo('dist', '**/*.pem')).toBe('dist/**/*.pem');
    expect(limitTo('prisma', '**/migrations/**')).toBe('prisma/**/migrations/**');
    expect(limitTo('prisma/migrations', '**/migrations/**')).toBe('prisma/migrations/**');
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
