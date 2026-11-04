import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session } from '@mindly/core';
import type { RunnerPort } from '@mindly/runners';
import { createDaemon, type Daemon, type DaemonOptions } from '../src/index.js';

export const PORT = 47_878;
export const HOST = `127.0.0.1:${PORT}`;
export const ORIGIN = `http://${HOST}`;

/** A temp dir resolved through symlinks (macOS /var -> /private/var). */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
}

export function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A git repository with one commit containing `a.txt` and `b.txt`. */
export function repo(): string {
  const dir = tempDir('mindly-daemon-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'a.txt', 'line 1\nline 2\nline 3\n');
  write(dir, 'b.txt', 'b 1\nb 2\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** Adds a linked worktree on a new branch and returns its path. */
export function linkedWorktree(root: string, branch: string): string {
  const parent = tempDir('mindly-daemon-wt-');
  const path = join(parent, branch);
  git(root, 'worktree', 'add', '-q', '-b', branch, path);
  return realpathSync(path);
}

/** Fake runners: records calls, never launches a process. */
export function fakeRunners(overrides: Partial<RunnerPort> = {}): RunnerPort & {
  calls: { kind: string; input: unknown }[];
} {
  const calls: { kind: string; input: unknown }[] = [];
  return {
    calls,
    review: async (input) => {
      calls.push({ kind: 'review', input });
      return {
        reviewer: 'codex',
        status: 'completed',
        parsed: true,
        findings: [
          { severity: 'high', file: 'a.txt', line: 2, title: 'Bug', detail: 'off by one' },
        ],
        redactions: 0,
        diffTruncated: false,
        exitCode: 0,
        durationMs: 5,
        costUsd: null,
        usage: null,
        error: null,
      };
    },
    replay: async (input) => {
      calls.push({ kind: 'replay', input });
      return {
        runId: input.runId ?? 'x',
        baseCommit: 'a'.repeat(40),
        startedAt: 0,
        finishedAt: 1,
        results: input.agents.map((agent) => ({
          agent: agent as 'codex',
          status: 'completed' as const,
          exitCode: 0,
          durationMs: 10,
          costUsd: 0.5,
          usage: null,
          summary: 'done',
          resultCommit: null,
          resultRef: null,
          files: [],
          totals: { files: 2, added: 5, deleted: 1 },
          shortstat: '2 files changed',
          skipped: [],
          checks: null,
          error: null,
        })),
      };
    },
    launch: async (input) => {
      calls.push({ kind: 'launch', input });
      return {
        agent: 'codex',
        cwd: input.cwd,
        status: 'completed',
        exitCode: 0,
        durationMs: 1,
        summary: '',
        sessionId: null,
        costUsd: null,
        usage: null,
        error: null,
      };
    },
    available: async () => true,
    ...overrides,
  };
}

export interface TestDaemon {
  daemon: Daemon;
  home: string;
  runners: ReturnType<typeof fakeRunners>;
}

/** A daemon over a temp home, not listening (use `daemon.app.inject`), no background jobs. */
export async function testDaemon(options: DaemonOptions = {}): Promise<TestDaemon> {
  const home = options.home ?? tempDir('mindly-daemon-home-');
  const runners = fakeRunners();
  const daemon = await createDaemon({
    home,
    env: { MINDLY_HOME: home },
    port: PORT,
    dashboardDir: null,
    jobs: false,
    runners,
    runtime: { disableNotify: true, disableLlm: true },
    ...options,
  });
  return { daemon, home, runners };
}

/** Headers for a CLI request with the daemon token. */
export function bearer(d: Daemon, extra: Record<string, string> = {}): Record<string, string> {
  return { host: HOST, authorization: `Bearer ${d.token}`, ...extra };
}

/** Logs in like the dashboard and returns the session cookie header value. */
export async function login(d: Daemon): Promise<string> {
  const codeRes = await d.app.inject({
    method: 'POST',
    url: '/api/auth/codes',
    headers: bearer(d),
  });
  const { code } = codeRes.json() as { code: string };
  const res = await d.app.inject({
    method: 'POST',
    url: '/api/auth/exchange',
    headers: {
      host: HOST,
      origin: ORIGIN,
      'x-mindly-csrf': '1',
      'content-type': 'application/json',
    },
    payload: { code },
  });
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  return cookie;
}

/** Registers a project and a live session directly in the store. */
export function seedSession(
  d: Daemon,
  projectRoot: string,
  opts: { worktree?: string; agentKind?: string; externalId?: string } = {},
): Session {
  const project = d.mindly.store.projects.upsertByRoot(projectRoot, 'repo');
  return d.mindly.store.sessions.upsert({
    projectId: project.id,
    agentKind: opts.agentKind ?? 'claude-code',
    externalId: opts.externalId ?? `ext-${Math.random().toString(36).slice(2)}`,
    worktree: opts.worktree ?? projectRoot,
    branch: null,
    transcriptPath: null,
  }).session;
}
