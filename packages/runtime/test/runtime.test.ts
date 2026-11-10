import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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

describe('linked worktrees', () => {
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
