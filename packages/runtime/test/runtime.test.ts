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
