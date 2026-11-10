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
      expect(
        read(cmd).filter((t) => !t.ifExists && t.certain),
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

  it('reads git commands by the paths they name', () => {
    // Paths a git command names as files are written, wherever it sits on the line.
    expect(targets('git checkout -- src/auth.ts')).toEqual(['src/auth.ts', 'src/auth.ts/**']);
    expect(targets('git checkout HEAD~1 -- prisma')).toEqual(['prisma', 'prisma/**']);
    expect(targets('git checkout stash@{0} -- prisma/a.sql')).toEqual([
      'prisma/a.sql',
      'prisma/a.sql/**',
    ]);
    expect(targets('git restore --source=HEAD~1 prisma')).toEqual(['prisma', 'prisma/**']);
    expect(targets('git restore -sHEAD~1 prisma')).toEqual(['prisma', 'prisma/**']);
    expect(targets('git restore -SW certs/a.pem')).toEqual(['certs/a.pem', 'certs/a.pem/**']);
    expect(targets('git checkout --ours certs/a.pem')).toEqual(['certs/a.pem', 'certs/a.pem/**']);
    expect(targets('git stash push -- prisma')).toEqual(['prisma', 'prisma/**']);
    expect(targets('git -C packages/web restore src/a.ts')).toEqual([
      'packages/web/src/a.ts',
      'packages/web/src/a.ts/**',
    ]);
    expect(targets('git -C packages -C web restore a.ts')).toEqual([
      'packages/web/a.ts',
      'packages/web/a.ts/**',
    ]);
    expect(targets('git fetch && git commit -qam x && git checkout -- secret/key.txt')).toEqual([
      'secret/key.txt',
      'secret/key.txt/**',
    ]);
    // `git rm` removes the tracked files its pathspecs match.
    expect(read('git -c color.ui=never rm -r prisma/migrations')).toEqual([
      expect.objectContaining({
        path: 'prisma/migrations',
        tree: true,
        certain: true,
        touches: { tracked: true, untracked: false, ignored: false },
      }),
    ]);
    // Several words and no `--`: the first is a path when one exists (else a revision).
    expect(read('git checkout HEAD~1 prisma').map((x) => [x.path, x.ifExists])).toEqual([
      ['HEAD~1', true],
      ['prisma', false],
    ]);
    // git's own wildcards and magic: `*` crosses folders, `:/` is the top, case may not count.
    expect(read("git checkout -- '*.pem'").map((x) => x.path)).toEqual(['*.pem', '*/**/*.pem']);
    expect(read("git checkout -- 's*/key.txt'").map((x) => x.path)).toEqual(['s*/**/key.txt']);
    expect(read("git checkout -- ':(glob)certs/*.pem'")).toEqual([
      expect.objectContaining({ path: 'certs/*.pem', glob: true, tree: true, certain: true }),
    ]);
    expect(read("git checkout ':/secret'")).toEqual([
      expect.objectContaining({ path: `${TOP}/secret`, certain: true }),
    ]);
    expect(read('git --icase-pathspecs checkout -- SECRET')[0]).toMatchObject({ nocase: true });
    expect(read("git checkout -- ':(icase)SECRET'")[0]).toMatchObject({ nocase: true });
    // git clean: untracked files there; ignored ones with -x.
    expect(targets('git clean -fdx prisma')).toEqual(['prisma (clean-ignored)']);
    expect(targets("git clean -fx -- '*.pem'")).toEqual([
      '*.pem (clean-ignored)',
      '*/**/*.pem (clean-ignored)',
    ]);
    expect(targets('git mv prisma db')).toEqual(['db/[prisma]/**', 'prisma', 'prisma/**']);
    // Paths read from a file are not known: said, not guessed.
    for (const cmd of [
      'git rm --pathspec-from-file=list.txt',
      'git checkout --pathspec-from-file=- < list.txt',
      'git checkout-index -f --stdin < list.txt',
      'make-list | git checkout-index --std',
    ]) {
      const reading = readShellWrites(cmd);
      expect(
        reading.targets.filter((t) => t.path !== 'make-list'),
        cmd,
      ).toEqual([]);
      expect(reading.limit, cmd).toContain('from a file');
    }
    // Those an `echo` gives it are read.
    expect(targets('echo certs/a.pem | git checkout --pathspec-from-file=-')).toEqual([
      'certs/a.pem',
      'certs/a.pem/**',
    ]);
    expect(targets('echo certs/a.pem | git checkout-index -f --stdin')).toEqual(['certs/a.pem']);
    // A git command whose folder the text does not tell is said, not dropped.
    expect(readShellWrites('cd "$DIR" && git checkout -- .').limit).toContain('git command');
  });

  it('reads what a git command writes besides the tree', () => {
    // Output written to a file it is given.
    expect(targets('git diff --output=certs/server.pem')).toEqual(['certs/server.pem']);
    expect(targets('git log -p --output certs/a.pem')).toEqual(['certs/a.pem']);
    // Patch files, told by a sample name with the suffix they get, where they go.
    expect(targets('git format-patch -o patches HEAD~2')).toEqual(['patches/0001-patch.patch']);
    expect(targets('git -C vendor format-patch -2')).toEqual(['vendor/0001-patch.patch']);
    expect(targets('git format-patch --suffix=.pem -1')).toEqual(['0001-patch.pem']);
    expect(targets('git format-patch --numbered-files -o out -1')).toEqual(['out/1']);
    expect(targets('git format-patch --stdout -1')).toEqual([]);
    // A rebase runs its `--exec` commands like any other shell code.
    expect(targets("git rebase -q -x 'echo z > certs/server.pem' HEAD~1")).toEqual([
      'certs/server.pem',
    ]);
    expect(targets("git rebase --exec='rm -f certs/a.pem' main")).toEqual(['certs/a.pem']);
    // Option values never shift which words are paths, `--opt=value` least of all.
    expect(targets("git stash push -m 'a b' -- certs")).toEqual(['certs', 'certs/**']);
    expect(targets('git stash push --message=x certs')).toEqual(['certs', 'certs/**']);
    expect(targets('git restore --source HEAD~1 certs')).toEqual(['certs', 'certs/**']);
    expect(targets('git restore --source=HEAD~1 certs')).toEqual(['certs', 'certs/**']);
    expect(targets('git -C sub -c x=y checkout -- certs')).toEqual(['sub/certs', 'sub/certs/**']);
    for (const cmd of [
      'git merge -q --gpg-sign certs-change',
      'git merge -s ours -X theirs -m msg x',
      'git rebase -q --gpg-sign certs-change',
      'git cherry-pick -m 1 -S x',
      'GIT_EDITOR=true git merge -q feature',
    ]) {
      expect(targets(cmd), cmd).toEqual([]);
    }
  });

  it('reads git option values as values, never as flags or paths', () => {
    expect(targets('git restore -sSTABLE certs/a.pem')).toEqual(['certs/a.pem', 'certs/a.pem/**']);
    expect(targets('git restore --sou v1 certs/a.pem')).toEqual(['certs/a.pem', 'certs/a.pem/**']);
    expect(targets('git --attr-source HEAD restore certs/a.pem')).toEqual([
      'certs/a.pem',
      'certs/a.pem/**',
    ]);
    expect(targets('git config -f certs/a.pem a.b c')).toEqual(['certs/a.pem']);
    expect(targets('git archive -o certs/a.pem HEAD')).toEqual(['certs/a.pem']);
    expect(targets('git merge-file certs/a.pem base other')).toEqual(['certs/a.pem']);
    expect(targets('git checkout-index -f certs/a.pem')).toEqual(['certs/a.pem']);
    for (const cmd of [
      'git stash push -um wip',
      'git stash push -km "wip"',
      'git clean -fdeconfig.json',
      'git merge --stat --no-edit main',
      'git rebase --summary main',
      'git apply --stat --apply p.diff',
      'git bisect start HEAD v2',
      'git sparse-checkout set src',
      'git checkout-index -f -a',
      'git read-tree -u --reset v1',
      'git checkout -p',
      'git restore -p',
      'git some-alias',
    ]) {
      expect(
        read(cmd).filter((x) => x.certain),
        cmd,
      ).toEqual([]);
      expect(
        read(cmd).some((x) => !x.certain),
        cmd,
      ).toBe(true);
    }
    // Case does not count with icase pathspecs.
    expect(read("git checkout -- ':(icase)CERTS/A.PEM'")[0]).toMatchObject({ nocase: true });
    // Paths in a working tree named apart; one outside the tree is said.
    expect(targets('git --work-tree=sub checkout -- a.pem')).toEqual(['sub/a.pem', 'sub/a.pem/**']);
    expect(readShellWrites('git --work-tree=/elsewhere checkout -- a.pem').limit).toContain(
      'another working tree',
    );
  });

  it('reads git commands that only move the index or refs as writing nothing', () => {
    for (const cmd of [
      'git add -A',
      'git add src && git commit -qm wip',
      'git restore --staged x',
      'git rm --cached x',
      'git commit -qa --amend --no-edit',
      'git fetch origin main',
      'git remote update',
      'git log -1',
      'git status',
      'git diff HEAD',
      'git show HEAD:x',
      'git branch -f main origin/main',
      'git tag v1',
      'git reset -- x',
      'git reset HEAD~1',
      'git stash list',
      'git stash drop',
      'git checkout -b tmp',
      'git switch -c tmp',
      'git checkout',
      'git apply --check x.patch',
      'git clean -n',
      'git rm -n certs/a.pem',
      'git mv -n a b',
      'git config --get a.b',
      'git config -f tool.ini --list',
      'git bisect log',
      'git stash show -p',
      'git remote -v',
      // Options and settings that keep it so.
      'git fetch',
      'git fetch --prune --tags origin',
      'git push origin main',
      'git push -u origin HEAD',
      'git push --force-with-lease origin feature',
      'git -c color.ui=always log',
      'git -c core.pager=cat log -p',
      'git --no-pager -c log.showSignature=false log --oneline',
      'GIT_PAGER=cat git log',
      'GIT_EDITOR=true git commit -qam x',
      'GIT_AUTHOR_DATE=2020-01-01 GIT_COMMITTER_DATE=2020-01-01 git commit -m x',
      'export GIT_PAGER=cat && git log',
      'git -c user.name=x -c user.email=y commit -m z',
      'git diff-tree -r HEAD',
      'git diff-index --cached HEAD',
      'git rev-list --count HEAD',
      'git shortlog -sn',
      'git grep foo',
      'git grep -n -e foo -- src',
      'git grep -C 2 foo',
      'git blame x',
      'git blame -L 1,2 -M -C x',
      'git log -Gfoo -n5 --stat',
      'git log -S foo --pretty=format:%h',
      'git diff -M50% HEAD',
      'git status -uno',
      'git status --porcelain=v1',
      'git ls-remote origin',
      'git config user.name x',
      'git config --global init.defaultBranch main',
      'git archive --format=tar HEAD',
    ]) {
      expect(read(cmd), cmd).toEqual([]);
    }
  });

  it('reads a git command as only looking only when each of its options keeps it so', () => {
    const whole = (command: string) =>
      read(command)
        .filter((x) => !x.certain)
        .map((x) => x.path);
    // An option or a setting that runs a program or moves what git works on, an option not known
    // here, an abbreviation that cannot be told, a push into a repository on this machine: any
    // file in the tree may change.
    for (const cmd of [
      "git -c core.fsmonitor='touch x; false' status",
      "git -c diff.external='touch x' diff v1",
      "git -c core.sshCommand='touch x' fetch",
      'git -c core.hooksPath=h commit -qam msg',
      'git -c core.pager=vim log',
      'git --git-dir=../other/.git log',
      "GIT_EXTERNAL_DIFF='touch x' git diff",
      "env GIT_SSH_COMMAND='touch x' git fetch",
      'export GIT_DIR=../other/.git && git log',
      'GIT_DIR=../other/.git; git status',
      'declare -x GIT_WORK_TREE=/tmp/x && git status',
      "git fetch --upload-pack='touch x; git-upload-pack' . main",
      "git fetch --upload='touch x' . main",
      "git ls-remote --upload-pack='touch x' .",
      "git push --receive-pack='touch x' . HEAD:refs/heads/x",
      "git push --exec='touch x' origin main",
      'git push . ahead:main',
      'git push ../other main',
      'git push file:///srv/repo main',
      "git archive --remote=. --exec='touch x' -o out.tar HEAD",
      'git grep --open-files-in-pager=rm k2',
      'git grep --open=rm k2',
      'git grep -Orm k2',
      'git log --some-new-option',
      'git status --some-new-option',
      'git diff --ext-diff',
      'git config receive.denyCurrentBranch updateInstead',
      'git config core.hooksPath h',
      'git config --edit',
      'git reset --har v1',
      'git checkout --forc',
      'git checkout --some-new-option main',
      'git some-alias',
    ]) {
      expect(whole(cmd), cmd).toContain(TOP);
    }
    // `export` holds for the rest of the line.
    expect(whole('export GIT_DIR=../other/.git && git checkout -- .')).toEqual([TOP, '.']);
    // Output to a file it is given is a write of that file, whatever its abbreviation.
    for (const [cmd, file] of [
      ['git diff-tree --output=certs/new.pem -p v1 v2', 'certs/new.pem'],
      ['git diff-index --output=certs/new.pem -p v1', 'certs/new.pem'],
      ['git diff-files --output certs/new.pem', 'certs/new.pem'],
      ['git rev-list --output=certs/new.pem HEAD', 'certs/new.pem'],
      ['git shortlog --output=certs/new.pem HEAD', 'certs/new.pem'],
      ['git blame --output=certs/new.pem src/a.ts', 'certs/new.pem'],
      ['git annotate --output=certs/new.pem src/a.ts', 'certs/new.pem'],
      ['git diff --outp=certs/new.pem', 'certs/new.pem'],
      ['git archive -o certs/new.pem HEAD', 'certs/new.pem'],
      ['git -C sub log --output=new.pem', 'sub/new.pem'],
    ] as const) {
      expect(targets(cmd), cmd).toEqual([file]);
      expect(whole(cmd), cmd).toEqual([]);
    }
    // Abbreviations git takes are made whole.
    expect(targets('git restore --staged --work --source=v1 certs/server.pem')).toEqual([
      'certs/server.pem',
      'certs/server.pem/**',
    ]);
    expect(read('git restore --sta certs/server.pem')).toEqual([]);
    expect(whole('git reset --har v1')).toEqual([TOP]);
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
    expect(whole("git clone -u 'touch x' https://example.com/team/tool.git")).toBe(true);
    expect(lands('git clone -b main https://example.com/team/tool.git vendor/tool')).toEqual([
      'vendor/tool',
    ]);
    expect(lands('git worktree add vendor/wt v1')).toEqual(['vendor/wt']);
    expect(lands('git worktree add -b x vendor/wt v1')).toEqual(['vendor/wt']);
    expect(targets('git worktree remove vendor/wt')).toEqual(['vendor/wt', 'vendor/wt/**']);
    expect(read('git worktree list')).toEqual([]);
    expect(lands('git checkout-index -a --prefix=vendor/')).toEqual(['vendor']);
    expect(whole('git checkout-index -a --prefix=vendor/')).toBe(false);
    expect(lands('git checkout-index -a --prefix=vendor/x-')).toEqual(['vendor']);
    expect(lands('git read-tree --prefix=vendor/ -u v1')).toEqual(['vendor']);
    expect(read('git read-tree --prefix=vendor/ v1')).toEqual([]);
    expect(lands('git init vendor/repo')).toEqual(['vendor/repo']);
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
      'export LANG=C && git status',
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
    // shell gets it, and whether it comes before or after, is not followed.
    for (const cmd of [
      "HOME=fakehome sh -c 'true'; git status",
      'git status; export GIT_DIR=../other/.git',
      'f() { export GIT_DIR=x; }; git status',
      '(HOME=fakehome); git status',
      'for HOME in x; do :; done; git status',
      'read -r GIT_DIR < f; git status',
      'read -a PATH < f; git status',
      'printf -v HOME x; git status',
      'mapfile -t PATH < f; git status',
      'getopts ab GIT_DIR; git status',
      'let HOME=1; git status',
      '(( GIT_DIR = 1 )); git status',
      'echo $(( HOME += 1 )); git status',
      '(( PATH++ )); git status',
      'declare -n r=x; git status',
      'local -n r; git status',
      'declare -x msg=x; git status',
      'export msg; git status',
      'set -a; git status',
      'set -o allexport; git status',
      '. ./env.sh; git status',
      'eval "$cmd"; git status',
      'trap "$cmd" EXIT; git status',
      'declare "$name=x"; git status',
      'export "$name"; git status',
      'git status; GIT_PAGER=$p git log',
      'X[0]=1; git status',
    ]) {
      expect(whole(cmd), cmd).toBe(true);
    }
    // A lower-case variable that is not exported is the shell's own; harmless ones are harmless.
    for (const cmd of [
      'msg=fix; git status',
      'msg="fix"; git commit -qam "$msg"',
      'for f in a b; do git add "$f"; done',
      'while read -r line; do git add "$line"; done < list',
      'local out=$(git status); git status',
      'let i=i+1; git status',
      '(( n == 1 )); git status',
      'export LANG=C GIT_PAGER=cat; git status',
      'set -euo pipefail; git status',
      "trap 'rm -f x' EXIT; git status",
      'f() { echo hi; }; f; git status',
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
      expect(targets(cmd), cmd).toEqual(['certs/a.pem']);
    }
    // Several words to `bisect run` are a program and its arguments, read as they are.
    expect(targets("git bisect run rm 'certs/*.pem'")).toEqual(['certs/*.pem']);
  });

  it('reads git commands that change the whole tree as possible writes of what is there', () => {
    const whole = (command: string) =>
      read(command)
        .filter((x) => !x.certain)
        .map((x) => `${x.path}${x.how === 'write' ? '' : ` (${x.how})`}`);
    // No path, `.`, a branch switch, a reset, a stash, a merge: any tracked file may change. A
    // warning when a covered one is there, never a block.
    for (const cmd of [
      'git switch main',
      'git checkout -f',
      'git checkout -b tmp origin/main',
      'git checkout -f -b tmp',
      'git switch -c tmp other',
      'git switch --orphan x',
      'git reset --hard',
      'git reset --keep HEAD~1',
      'git stash',
      'git stash -u',
      'git stash pop',
      'git stash apply 1',
      'git stash branch tmp',
      'git merge other',
      'git rebase main',
      'git pull',
      'git cherry-pick a..b',
      'git revert HEAD',
      'git am x.mbox',
      'git apply x.patch',
      'git checkout -- .',
      'git restore .',
      'git fetch && git switch other',
      'git commit -qam x && git merge other',
      "cd .git && echo 'ref: refs/heads/x' > HEAD && cd .. && git reset -q --hard",
      'rm -rf .git && cp -r /tmp/clone/.git .git && git reset -q --hard',
      ': > .gitignore && git stash -q -u',
      'git branch --set-upstream-to=x && git rebase',
      'git tag -a v1 -m rel x && git checkout -q v1',
      'GIT_EDITOR=true git merge -q feature',
      "git checkout -- ':!src'",
      "git stash push -- ':!src'",
    ]) {
      expect(whole(cmd), cmd).toEqual([
        cmd.includes('-- .') || cmd.includes('restore .') ? '.' : TOP,
      ]);
      expect(
        // Only what other commands of the line write is certain.
        read(cmd).filter(
          (x) => x.certain && !x.ifExists && !/(^|\/)\.git(ignore)?(\/|$)/.test(x.path),
        ),
        cmd,
      ).toEqual([]);
    }
    // Any file that is there counts: what git calls tracked or ignored may change on the line.
    for (const cmd of ['git checkout -- .', 'git stash', 'git reset --hard']) {
      expect(read(cmd)[0], cmd).toMatchObject({
        touches: { tracked: true, untracked: true, ignored: true },
      });
    }
    expect(whole('cd src && git reset --hard')).toEqual([TOP]);
    // One word is a path when one exists, and a branch to switch to otherwise.
    expect(read('git checkout certs').map((x) => [x.path, x.certain, x.ifExists])).toEqual([
      [TOP, false, false],
      ['certs', true, true],
    ]);
    // git clean without a path: what is there, untracked (and ignored with -x or `-e '!x'`).
    expect(whole('git clean -fd')).toEqual(['. (clean)']);
    expect(whole('git clean -fdx')).toEqual(['. (clean-ignored)']);
    expect(whole("git clean -fd -e '!.env'")).toEqual(['. (clean-ignored)']);
    expect(whole('git clean -fd :/')).toEqual([`${TOP} (clean)`]);
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
