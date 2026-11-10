import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitPort, openMindly } from '../src/index.js';

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-rt-')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd: dir,
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'auth.ts'), 'export function login(user: string) { return user; }\n');
  writeFileSync(
    join(dir, 'app.ts'),
    "import { login } from './auth';\nexport const x = login('a');\n",
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

describe('git port', () => {
  it('resolves repo info, export surfaces and dependents', async () => {
    const dir = repo();
    const git = createGitPort();
    expect(await git.findRepoRoot(dir)).toBe(dir);
    expect(await git.currentBranch(dir)).toBe('main');
    expect(await git.headCommit(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.dependentsOf(dir, 'auth.ts')).toEqual(['app.ts']);
    const before = git.exportSurface('export function login(user: string) {}', 'auth.ts');
    const after = git.exportSurface(
      'export function login(user: string, pw: string) {}',
      'auth.ts',
    );
    expect(before && after && git.diffExportSurface(before, after).changed).toEqual(['login']);
    expect(await git.isMerged?.(dir, 'main', 'main')).toBe(true);
  });

  it('fails soft outside a repository', async () => {
    const git = createGitPort();
    const dir = mkdtempSync(join(tmpdir(), 'mindly-norepo-'));
    expect(await git.findRepoRoot(dir)).toBeNull();
    expect(await git.changedFiles(dir)).toEqual([]);
  });
});

describe('openMindly', () => {
  it('opens a wired instance with default modules and handles a hook end to end', async () => {
    const dir = repo();
    const home = mkdtempSync(join(tmpdir(), 'mindly-home-'));
    const mindly = openMindly({ home, disableNotify: true });
    try {
      const res = await mindly.hooks.handle({
        agentKind: 'claude-code',
        event: 'session_start',
        externalSessionId: 's1',
        cwd: dir,
        transcriptPath: null,
        startSource: 'startup',
        prompt: null,
        tool: null,
        lastMessage: null,
      });
      expect(res.decision).toBeNull();
      const project = mindly.store.projects.findByRoot(dir);
      expect(project?.name).toBe(dir.split('/').pop());
      expect(mindly.store.sessions.list(project!.id)[0]?.branch).toBe('main');
    } finally {
      mindly.close();
    }
  });
});

/** A repository with enforced rules, and a way to ask the pre-tool hook about a command. */
function guarded(scopes: Record<string, string[]>) {
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), 'mindly-home-'));
  const mindly = openMindly({ home, disableNotify: true });
  const ready = (async () => {
    const project = await mindly.projects.resolve(dir);
    for (const [title, scopePaths] of Object.entries(scopes)) {
      mindly.memory.remember({
        projectId: project.project.id,
        projectRoot: dir,
        kind: 'rule',
        title,
        body: 'Ask first.',
        scopePaths,
        source: { type: 'user', sessionId: null, agentKind: null },
        enforce: true,
      });
    }
  })();
  // A test that stops before asking closes the store under it: that is not an error of its own.
  ready.catch(() => undefined);
  const shell = async (command: string, cwd = dir) => {
    await ready;
    return mindly.hooks.handle({
      agentKind: 'codex',
      event: 'pre_tool',
      externalSessionId: 'git',
      cwd,
      transcriptPath: null,
      startSource: null,
      prompt: null,
      lastMessage: null,
      tool: {
        name: 'Bash',
        writes: false,
        shell: true,
        edits: [],
        command,
        failed: false,
        outputExcerpt: null,
      },
    });
  };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'protocol.file.allow=always',
        ...args,
      ],
      { cwd: dir, stdio: 'pipe' },
    );
  return { dir, mindly, shell, git };
}

describe('git commands that bring files back', () => {
  it('asks git which files they would change, with the pathspecs as given', async () => {
    const { dir, mindly, shell, git } = guarded({
      'Certificates are issued by hand': ['**/*.pem'],
    });
    try {
      mkdirSync(join(dir, 'certs'));
      writeFileSync(join(dir, 'certs', 'server.pem'), 'k1\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'certs');
      // Nothing differs: nothing is brought back.
      for (const command of [
        'git checkout -- .',
        "git checkout -- '*.pem'",
        'git restore -SW certs/server.pem',
        'git reset --hard',
        'git stash',
      ]) {
        expect((await shell(command)).decision, command).toBeNull();
      }
      // A change in the working tree: every spelling that throws it away is refused, also the
      // ones whose pathspec only git can read.
      writeFileSync(join(dir, 'certs', 'server.pem'), 'k2\n');
      for (const command of [
        'git checkout -- .',
        "git checkout -- '*.pem'",
        "git checkout -- '*'",
        "git restore '*.pem'",
        "git restore ':(glob)**/*.pem'",
        "git stash push -- '*.pem'",
        'git reset --hard',
        'git checkout -f',
        'cd certs && git restore server.pem',
        "git rm -r --quiet 'certs/*'",
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
      // A staged change: the index already holds it, so restoring from the index changes
      // nothing, but restoring from HEAD (`-SW`) throws it away.
      git('add', 'certs/server.pem');
      expect((await shell('git restore certs/server.pem')).decision).toBeNull();
      expect((await shell('git restore -SW certs/server.pem')).decision).toBe('deny');
      expect((await shell('git restore --staged --worktree .')).decision).toBe('deny');
      expect((await shell('git restore --staged certs/server.pem')).decision).toBeNull();
      // From another revision, what differs from it.
      git('commit', '-q', '-m', 'k2');
      expect((await shell('git checkout HEAD~1 -- certs')).decision).toBe('deny');
      expect((await shell('git checkout HEAD -- certs')).decision).toBeNull();
      expect((await shell('git reset --hard HEAD~1')).decision).toBe('deny');
      // An untracked link to a protected file goes with `git stash -u`; the file stays.
      symlinkSync('certs/server.pem', join(dir, 'link'));
      expect((await shell('git stash -u')).decision).toBeNull();
      rmSync(join(dir, 'link'));
      // An untracked file goes with `git stash -u`, and stays with plain `git stash`.
      writeFileSync(join(dir, 'certs', 'new.pem'), 'n\n');
      expect((await shell('git stash')).decision).toBeNull();
      expect((await shell('git stash -u')).decision).toBe('deny');
    } finally {
      mindly.close();
    }
  });

  it('looks into nested repositories and submodules, which git does not list', async () => {
    const { dir, mindly, shell, git } = guarded({
      'Certificates are issued by hand': ['**/*.pem'],
    });
    try {
      const upstream = repo();
      mkdirSync(join(upstream, 'keys'));
      writeFileSync(join(upstream, 'keys', 'a.pem'), 'k\n');
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A'],
        {
          cwd: upstream,
        },
      );
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'keys'],
        { cwd: upstream },
      );
      git('submodule', 'add', '-q', upstream, 'vendor/lib');
      git('commit', '-q', '-m', 'sub');
      mkdirSync(join(dir, 'nested'));
      execFileSync('git', ['init', '-q'], { cwd: join(dir, 'nested') });
      writeFileSync(join(dir, 'nested', 'n.pem'), 'n\n');
      for (const command of [
        'rm -rf nested',
        'rm nested/*.pem',
        'rm -rf vendor',
        'rm vendor/lib/keys/*',
        'rm -rf *',
      ]) {
        expect((await shell(command)).decision, command).toBe('deny');
      }
      expect((await shell('rm -rf src')).decision).toBeNull();
    } finally {
      mindly.close();
    }
  });

  it('cleans what git clean cleans: untracked files, ignored ones only with -x', async () => {
    const { dir, mindly, shell, git } = guarded({
      'Certificates are issued by hand': ['**/*.pem'],
    });
    try {
      writeFileSync(join(dir, '.gitignore'), 'build/\n');
      mkdirSync(join(dir, 'certs'));
      writeFileSync(join(dir, 'certs', 'tracked.pem'), 't\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'certs');
      mkdirSync(join(dir, 'build'));
      writeFileSync(join(dir, 'build', 'out.pem'), 'o\n');
      expect((await shell('git clean -fd')).decision).toBeNull();
      expect((await shell('git clean -f -- certs/tracked.pem')).decision).toBeNull();
      expect((await shell('git clean -fdx')).decision).toBe('deny');
      writeFileSync(join(dir, 'certs', 'untracked.pem'), 'u\n');
      expect((await shell('git clean -fd')).decision).toBe('deny');
    } finally {
      mindly.close();
    }
  });
});

describe('git commands that switch branches or come after other commands', () => {
  const certs = () =>
    guarded({
      'Certificates are issued by hand': ['**/*.pem'],
      'Env files are edited by hand': ['.env'],
    });
  const setUp = (dir: string, git: (...args: string[]) => Buffer) => {
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    writeFileSync(join(dir, '.env'), 'E=1\n');
    mkdirSync(join(dir, 'certs'));
    writeFileSync(join(dir, 'certs', 'server.pem'), 'k1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'certs');
    git('branch', 'same');
    git('checkout', '-q', '-b', 'other');
    writeFileSync(join(dir, 'certs', 'server.pem'), 'k-other\n');
    git('commit', '-q', '-am', 'other');
    git('checkout', '-q', 'main');
  };

  it('writes what differs between HEAD and the branch it switches to', async () => {
    const { dir, mindly, shell, git } = certs();
    try {
      setUp(dir, git);
      for (const command of [
        'git checkout other',
        'git switch other',
        'git checkout -b tmp other',
        'git switch -c tmp other',
        'git checkout -f -B tmp other',
        'git checkout --detach other',
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
      // Nothing differs, or no branch of that name: nothing is written.
      for (const command of [
        'git checkout same',
        'git switch same',
        'git checkout -b tmp',
        'git checkout -f -b tmp',
        'git checkout no-such-branch',
        'git checkout certs',
        'git checkout -- certs',
      ]) {
        expect((await shell(command)).decision, command).toBeNull();
      }
      // A branch that only a remote has is made from it.
      const other = git('rev-parse', 'other').toString().trim();
      git('update-ref', 'refs/remotes/origin/feature', other);
      expect((await shell('git checkout feature')).decision).toBe('deny');
      expect((await shell('git switch feature')).decision).toBe('deny');
      // Forced, every local change goes too.
      writeFileSync(join(dir, 'certs', 'server.pem'), 'k2\n');
      for (const command of [
        'git checkout -f -b tmp',
        'git checkout -fb tmp',
        'git switch -f same',
        'git checkout -f same',
        // Words that are paths when such a file exists, whatever comes first.
        'git checkout certs/server.pem .gitignore',
        'git checkout .gitignore certs/server.pem',
        "git checkout '*.pem'",
        "git checkout ':(glob)**/*.pem'",
        "git checkout ':/certs'",
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
      // Paths come from the top whatever the configuration says.
      git('config', 'diff.relative', 'true');
      for (const command of ['git checkout -- .', 'git reset --hard', 'git stash']) {
        const r = await shell(command, join(dir, 'certs'));
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
    } finally {
      mindly.close();
    }
  });

  it('stands by the paths given once an earlier command may have changed things', async () => {
    const { dir, mindly, shell, git } = certs();
    try {
      setUp(dir, git);
      // Nothing differs now, but a fetch or a reset first may change that: the paths named are
      // written, and what is done to the whole tree is a possible write.
      for (const command of [
        'git fetch && git checkout origin/main -- certs/server.pem',
        'git fetch origin main && git restore --source=origin/main certs',
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
      for (const command of [
        'git fetch origin && git checkout origin/main -- .',
        'git fetch origin && git reset --hard origin/main',
        'git reset && git checkout -- .',
        'git fetch && git switch other',
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBeNull();
        expect(r.context, command).toContain('Certificates are issued by hand');
      }
      // The whole tree stands for the tracked files there: an ignored file is not touched.
      const env = guarded({ 'Env files are edited by hand': ['.env'] });
      try {
        writeFileSync(join(env.dir, '.gitignore'), '.env\n');
        writeFileSync(join(env.dir, '.env'), 'E=1\n');
        env.git('add', '-A');
        env.git('commit', '-q', '-m', 'ignore');
        for (const command of [
          'git fetch && git reset --hard',
          'git fetch && git checkout -- .',
          'git fetch && git stash',
          'git fetch && git stash -u',
          'git fetch && git clean -fd',
          'git clean -f .env',
        ]) {
          expect((await env.shell(command)).decision, command).toBeNull();
        }
        // Ignored files go with `git stash -a` and `git clean -x`, or once an exclude pattern
        // takes them back from what is ignored.
        for (const command of [
          'git stash -a',
          'git stash push -a -- .env',
          'git clean -fdx',
          "git clean -fd -e '!.env'",
        ]) {
          const r = await env.shell(command);
          expect(r.decision, command).toBe('deny');
          expect(r.reason, command).toContain('.env');
        }
        const after = await env.shell('git fetch && git stash -a');
        expect(after.decision).toBeNull();
        expect(after.context).toContain('Env files are edited by hand');
      } finally {
        env.mindly.close();
      }
    } finally {
      mindly.close();
    }
  });

  it('finds repositories nested deep in an untracked folder', async () => {
    const { dir, mindly, shell } = certs();
    try {
      for (const inner of ['tools/inner', 'tools/a/b/inner']) {
        mkdirSync(join(dir, inner), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: join(dir, inner) });
        writeFileSync(join(dir, inner, 'key.pem'), 'k\n');
      }
      for (const command of ['rm -rf tools', 'rm -rf tools/a', 'rm -rf tools/inner']) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('key.pem');
      }
      // git names them: a large untracked folder without one is not walked, nor held up.
      mkdirSync(join(dir, 'scratch', 'many'), { recursive: true });
      for (let i = 0; i < 5000; i++) writeFileSync(join(dir, 'scratch', 'many', `f${i}`), '');
      const large = await shell('rm -rf scratch');
      expect(large.decision).toBeNull();
      expect(large.context ?? '').not.toContain('could not search');
      expect((await shell('rm -rf *')).decision).toBe('deny');
      // A folder named with characters a pattern would read is matched by its name.
      for (const name of ['src/{a,b}', 'src/x*y', 'src/app/[id]']) {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, 'key.pem'), 'k\n');
        const r = await shell(`rm -rf '${name}'`);
        expect(r.decision, name).toBe('deny');
      }
    } finally {
      mindly.close();
    }
  });
});

describe('git commands whose files the line does not name', () => {
  /** A repository with a protected tracked file, a `feature` branch and an `origin` remote. */
  const setUp = () => {
    const g = guarded({ 'Certificates are issued by hand': ['**/*.pem'] });
    mkdirSync(join(g.dir, 'certs'));
    mkdirSync(join(g.dir, 'src'));
    writeFileSync(join(g.dir, 'certs', 'server.pem'), 'k1\n');
    writeFileSync(join(g.dir, 'src', 'a.ts'), 'x\n');
    g.git('add', '-A');
    g.git('commit', '-q', '-m', 'init');
    g.git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(g.dir, 'src', 'a.ts'), 'y\n');
    g.git('commit', '-qam', 'feature');
    g.git('checkout', '-q', 'main');
    return g;
  };

  it('brings back a stash: what it changed, and the untracked files it holds', async () => {
    const { dir, mindly, shell, git } = setUp();
    try {
      writeFileSync(join(dir, 'certs', 'server.pem'), 'k-stashed\n');
      git('stash', '-q');
      for (const command of ['git stash pop', 'git stash apply', 'git stash branch tmp']) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
      git('stash', 'drop', '-q');
      writeFileSync(join(dir, 'src', 'new.pem'), 'n\n');
      git('stash', '-q', '-u');
      expect((await shell('git stash pop')).decision).toBe('deny');
      git('stash', 'drop', '-q');
      writeFileSync(join(dir, 'src', 'a.ts'), 'z\n');
      git('stash', '-q');
      const plain = await shell('git stash pop');
      expect(plain.decision, plain.reason ?? '').toBeNull();
    } finally {
      mindly.close();
    }
  });

  it('reads a word as a path when the index has it, though the file is gone', async () => {
    const { dir, mindly, shell } = setUp();
    try {
      rmSync(join(dir, 'certs', 'server.pem'));
      for (const command of [
        'git checkout certs/server.pem',
        'git checkout certs/server.pem src/a.ts',
        'git checkout certs',
      ]) {
        expect((await shell(command)).decision, command).toBe('deny');
      }
    } finally {
      mindly.close();
    }
  });

  it('asks about a merge, a picked commit and a rebase; warns about a pull', async () => {
    const { dir, mindly, shell, git } = setUp();
    try {
      git('checkout', '-q', '-b', 'certs-change');
      writeFileSync(join(dir, 'certs', 'server.pem'), 'k2\n');
      git('commit', '-qam', 'certs');
      git('checkout', '-q', 'main');
      for (const command of [
        'git merge certs-change',
        'git cherry-pick certs-change',
        'git revert certs-change',
        'git rebase certs-change',
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
      for (const command of ['git merge feature', 'git cherry-pick feature']) {
        expect((await shell(command)).decision, command).toBeNull();
      }
      for (const command of ['git pull', 'git am x.mbox', 'git apply x.patch']) {
        const r = await shell(command);
        expect(r.decision, command).toBeNull();
        expect(r.context, command).toContain('Certificates are issued by hand');
      }
    } finally {
      mindly.close();
    }
  });

  it('warns about the whole tree after commands that may change what git says', async () => {
    const { dir, mindly, shell, git } = setUp();
    try {
      git('remote', 'add', 'origin', dir);
      git('fetch', '-q', 'origin');
      writeFileSync(join(dir, 'src', 'b.ts'), 'local work\n');
      writeFileSync(join(dir, 'certs', 'new.pem'), 'n\n');
      // Never a block for what is done to the whole tree, never silence.
      for (const command of [
        'git add -A && git commit -qm wip && git checkout feature',
        'git stash && git checkout feature && git stash pop',
        'git fetch && git checkout feature',
        'git commit -qam wip && git checkout -- .',
        'git add -A && git stash',
        'git add certs && git reset --hard',
        'git remote update && git reset --hard origin/main',
        "git add src && git checkout -- ':!src'",
        "git reset -q && git stash push -- ':!src'",
      ]) {
        const r = await shell(command);
        expect(r.decision, `${command}: ${r.reason}`).toBeNull();
        expect(r.context, command).toContain('Certificates are issued by hand');
      }
      // A path named is still blocked, and the first command is still asked exactly.
      const named = await shell('git fetch && git checkout origin/main -- certs/server.pem');
      expect(named.decision).toBe('deny');
      const first = await shell('git stash -u && git checkout feature && git stash pop');
      expect(first.reason).toContain('certs/new.pem');
    } finally {
      mindly.close();
    }
  });

  it('cleans what git clean pathspecs match', async () => {
    const { dir, mindly, shell } = setUp();
    try {
      mkdirSync(join(dir, 'newdir'));
      writeFileSync(join(dir, 'newdir', 'key.pem'), 'u\n');
      for (const [command, cwd] of [
        ['git clean -fd :/', dir],
        ['git clean -fdx :/', join(dir, 'src')],
        ["git clean -fx -- '*.pem'", dir],
      ] as const) {
        expect((await shell(command, cwd)).decision, command).toBe('deny');
      }
      expect((await shell("git clean -fx -- '*.ts'")).decision).toBeNull();
    } finally {
      mindly.close();
    }
  });
});

describe('linked worktrees', () => {
  it('lists every working tree of a repository in one call', async () => {
    const dir = repo();
    const wt = `${dir}-wt`;
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/list', wt], { cwd: dir });
    const git = createGitPort();
    const both = [dir, realpathSync(wt)].sort();
    expect((await git.workingTrees?.(dir))?.sort()).toEqual(both);
    expect((await git.workingTrees?.(realpathSync(wt)))?.sort()).toEqual(both);
    expect(await git.workingTrees?.(realpathSync(tmpdir()))).toBeNull();
  });

  it('applies an enforced rule to a write that reaches the project from outside its tree', async () => {
    const dir = repo();
    const wt = realpathSync(
      (() => {
        const path = `${dir}-wt2`;
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/reach', path], { cwd: dir });
        return path;
      })(),
    );
    const home = mkdtempSync(join(tmpdir(), 'mindly-home-'));
    const mindly = openMindly({ home, disableNotify: true });
    try {
      const project = await mindly.projects.resolve(dir);
      mindly.memory.remember({
        projectId: project.project.id,
        projectRoot: dir,
        kind: 'rule',
        title: 'Auth is frozen',
        body: 'Ask first.',
        scopePaths: ['auth.ts'],
        source: { type: 'user', sessionId: null, agentKind: null },
        enforce: true,
      });
      const shell = (cwd: string, command: string) =>
        mindly.hooks.handle({
          agentKind: 'codex',
          event: 'pre_tool',
          externalSessionId: 'reach',
          cwd,
          transcriptPath: null,
          startSource: null,
          prompt: null,
          lastMessage: null,
          tool: {
            name: 'Bash',
            writes: false,
            shell: true,
            edits: [],
            command,
            failed: false,
            outputExcerpt: null,
          },
        });
      // From the linked worktree into the main checkout, by an absolute path and from its root.
      expect((await shell(wt, `rm ${dir}/auth.ts`)).decision).toBe('deny');
      expect((await shell(wt, `cd ${dir} && rm -rf .`)).decision).toBe('deny');
      expect((await shell(join(dir), `rm $(git rev-parse --show-toplevel)/auth.ts`)).decision).toBe(
        'deny',
      );
      // Twenty places that are not the project: no limit is hit, nothing is refused.
      const elsewhere = Array.from({ length: 20 }, (_, i) => {
        const d = mkdtempSync(join(tmpdir(), `mindly-else-${i}-`));
        return join(d, 'auth.ts');
      });
      expect((await shell(wt, `rm -f ${elsewhere.join(' ')}`)).decision).toBeNull();
      expect((await shell(wt, `touch ${elsewhere.join(' ')} ${dir}/auth.ts`)).decision).toBe(
        'deny',
      );
      // git decides what a whole-tree command really touches: `git clean` leaves tracked files,
      // `git checkout .` only brings back what differs from the index.
      expect((await shell(dir, 'git clean -fdx')).decision).toBeNull();
      expect((await shell(dir, 'git checkout -- .')).decision).toBeNull();
      writeFileSync(join(dir, 'auth.ts'), 'export const changed = 1;\n');
      expect((await shell(dir, 'git checkout -- .')).decision).toBe('deny');
      expect((await shell(dir, 'git stash push auth.ts')).decision).toBe('deny');
      expect((await shell(dir, 'git restore --staged auth.ts')).decision).toBeNull();
    } finally {
      mindly.close();
    }
  });

  it('groups sessions from linked worktrees into one project with worktree-relative paths', async () => {
    const dir = repo();
    const wt = `${dir}-wt`;
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/x', wt], { cwd: dir });
    const home = mkdtempSync(join(tmpdir(), 'mindly-home-'));
    const mindly = openMindly({ home, disableNotify: true });
    try {
      const base = {
        transcriptPath: null,
        startSource: null,
        prompt: null,
        tool: null,
        lastMessage: null,
      };
      await mindly.hooks.handle({
        ...base,
        agentKind: 'claude-code',
        event: 'session_start',
        externalSessionId: 'a',
        cwd: dir,
      });
      await mindly.hooks.handle({
        ...base,
        agentKind: 'codex',
        event: 'session_start',
        externalSessionId: 'b',
        cwd: realpathSync(wt),
      });
      expect(mindly.store.projects.list()).toHaveLength(1);
      await mindly.hooks.handle({
        ...base,
        agentKind: 'codex',
        event: 'post_tool',
        externalSessionId: 'b',
        cwd: realpathSync(wt),
        tool: {
          name: 'Edit',
          writes: true,
          shell: false,
          edits: [
            {
              path: join(realpathSync(wt), 'auth.ts'),
              addedText: 'export const y = 1;',
              removedText: '',
              wholeFile: false,
            },
          ],
          command: null,
          failed: false,
          outputExcerpt: null,
        },
      });
      const pid = mindly.store.projects.list()[0]!.id;
      expect(mindly.store.fileChanges.forPath(pid, 'auth.ts')).toHaveLength(1);
      const branches = mindly.store.sessions
        .list(pid)
        .map((s) => s.branch)
        .sort();
      expect(branches).toEqual(['feat/x', 'main']);
    } finally {
      mindly.close();
    }
  });
});
