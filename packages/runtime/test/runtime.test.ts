import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

describe('git commands', () => {
  const RULE = 'Certificates are issued by hand';
  const certs = () => guarded({ [RULE]: ['**/*.pem'] });
  /** A repository with a protected tracked file, and a `feature` branch that changes another. */
  const setUp = () => {
    const g = certs();
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
  const warns = (r: { decision: string | null; context: string | null }) =>
    r.decision === null && (r.context ?? '').includes(RULE);

  it('blocks the paths a git command names, wherever it sits on the line', async () => {
    const { dir, mindly, shell } = setUp();
    try {
      for (const command of [
        'git checkout -- certs/server.pem',
        'git checkout HEAD~1 -- certs',
        'git restore --source=feature certs/server.pem',
        'git rm -q certs/server.pem',
        'git mv certs/server.pem certs/old.pem',
        'git stash push -- certs',
        "git checkout -- '*.pem'",
        "git checkout ':/certs'",
        'git checkout certs/server.pem src/a.ts',
        'git fetch && git commit -qam x && git checkout -- certs/server.pem',
        'git diff --output=certs/server.pem',
        "git rebase -q -x 'echo z > certs/server.pem' HEAD~1",
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
      // A file the index has but the disk does not is still named.
      rmSync(join(dir, 'certs', 'server.pem'));
      expect((await shell('git checkout -- certs/server.pem')).decision).toBe('deny');
    } finally {
      mindly.close();
    }
  });

  it('lets through what only moves the index or refs', async () => {
    const { mindly, shell } = setUp();
    try {
      for (const command of [
        'git add -A',
        'git restore --staged certs/server.pem',
        'git rm --cached certs/server.pem',
        'git commit -qam x',
        'git fetch',
        'git log -1 && git status && git diff && git show HEAD',
        'git branch tmp && git tag v1',
        'git checkout -b tmp',
        'git reset HEAD~1',
        'git checkout -- src/a.ts',
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBeNull();
        expect(r.context ?? '', command).not.toContain(RULE);
      }
    } finally {
      mindly.close();
    }
  });

  it('warns, never blocks, when a git command may change the whole tree', async () => {
    const { dir, mindly, shell, git } = setUp();
    try {
      git('clone', '-q', dir, `${dir}-clone`);
      for (const command of [
        'git checkout feature',
        'git switch feature',
        'git checkout -- .',
        'git reset --hard',
        'git stash',
        'git stash pop',
        'git merge feature',
        'git rebase feature',
        'git pull',
        'git cherry-pick feature',
        'git revert HEAD',
        'git am x.mbox',
        'git apply x.patch',
        'GIT_EDITOR=true git merge -q feature',
        'git merge -q --gpg-sign feature',
        // Whatever came before it on the line.
        'git stash && git checkout feature && git stash pop',
        'git branch --set-upstream-to=feature && git rebase',
        'git tag -a v1 -m rel feature && git checkout -q v1',
        `export GIT_DIR=${dir}-clone/.git && git checkout -- .`,
        "cd .git && echo 'ref: refs/heads/feature' > HEAD && cd .. && git reset -q --hard",
        `rm -rf .git && cp -r ${dir}-clone/.git .git && git reset -q --hard`,
        ': > .gitignore && git stash -q -u',
      ]) {
        const r = await shell(command);
        expect(warns(r), `${command}: ${r.reason ?? ''}`).toBe(true);
      }
    } finally {
      mindly.close();
    }
  });

  it('warns about a whole-tree change only when a covered file is there', async () => {
    const { mindly, shell } = guarded({ 'Env files are edited by hand': ['.env'] });
    try {
      for (const command of ['git reset --hard', 'git checkout -- .', 'git stash -a']) {
        expect((await shell(command)).context ?? '', command).not.toContain('Env files');
      }
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

  it('cleans what is there: untracked files, ignored ones only with -x', async () => {
    const { dir, mindly, shell, git } = certs();
    try {
      writeFileSync(join(dir, '.gitignore'), 'build/\n');
      mkdirSync(join(dir, 'certs'));
      writeFileSync(join(dir, 'certs', 'tracked.pem'), 't\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'certs');
      mkdirSync(join(dir, 'build'));
      writeFileSync(join(dir, 'build', 'out.pem'), 'o\n');
      // Named paths: what is there of the kinds it removes.
      expect((await shell('git clean -f -- certs/tracked.pem')).decision).toBeNull();
      expect((await shell('git clean -fdx build')).decision).toBe('deny');
      expect((await shell("git clean -fx -- '*.pem'")).decision).toBe('deny');
      // Without a path: a warning, when a file it would remove is there.
      expect((await shell('git clean -fd')).context ?? '').not.toContain(RULE);
      expect(warns(await shell('git clean -fdx'))).toBe(true);
      expect(warns(await shell('git clean -fd :/', join(dir, 'certs')))).toBe(false);
      writeFileSync(join(dir, 'certs', 'untracked.pem'), 'u\n');
      expect(warns(await shell('git clean -fd'))).toBe(true);
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
      // A git command that names the file is blocked; one that may change the whole tree warns.
      // `git clean` leaves tracked files alone.
      expect((await shell(dir, 'git clean -fdx')).decision).toBeNull();
      const whole = await shell(dir, 'git checkout -- .');
      expect(whole.decision).toBeNull();
      expect(whole.context).toContain('Auth is frozen');
      expect((await shell(dir, 'git checkout -- auth.ts')).decision).toBe('deny');
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
