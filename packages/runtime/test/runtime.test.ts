import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UserConfigSchema } from '@mindly/core';
import { createGitPort, createNotifierPort, openMindly } from '../src/index.js';

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

describe('notifier port', () => {
  it("redacts with the user's patterns, reports what each channel did and logs a failure once", async () => {
    const bodies: string[] = [];
    let code = 200;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        bodies.push(body);
        res.statusCode = code;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const config = UserConfigSchema.parse({
        notify: { channels: [{ type: 'webhook', url: `http://127.0.0.1:${port}/hook` }] },
        redaction: { extraPatterns: ['ACME-[0-9]{6}'] },
      });
      const warned: unknown[] = [];
      const pager = createNotifierPort(config.notify, {
        redactPatterns: config.redaction.extraPatterns,
        log: { warn: (_m, fields) => warned.push(fields), debug: () => undefined },
      });
      const n = {
        trigger: 'check_failed' as const,
        title: 'A check fails',
        body: 'Check "deploy ACME-123456" failed in proj-ACME-654321.',
        projectName: 'proj-ACME-654321',
      };
      expect(await pager.send(n)).toEqual([{ channel: 'webhook', status: 'sent' }]);
      expect(bodies[0]).not.toMatch(/ACME-\d/);
      expect(JSON.parse(bodies[0]!)).toMatchObject({ project: 'proj-[REDACTED]' });

      code = 500;
      for (let i = 0; i < 2; i++) {
        expect(await pager.send(n)).toEqual([
          { channel: 'webhook', status: 'failed', reason: 'webhook returned HTTP 500' },
        ]);
      }
      expect(warned).toEqual([
        { channel: 'webhook', reason: 'webhook returned HTTP 500', trigger: 'check_failed' },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
