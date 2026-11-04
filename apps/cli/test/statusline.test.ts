import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '@mindly/store';
import {
  formatStatusLine,
  runStatusLine,
  sessionInfo,
  statusLineText,
  type StatusLineLimits,
} from '../src/statusline.js';
import { cli, sandbox, write, type Sandbox } from './helpers.js';

const FAST: StatusLineLimits = { stdinTimeoutMs: 100, busyTimeoutMs: 50 };

function stdinOf(text: string | null): AsyncIterable<Buffer> {
  return (async function* () {
    if (text !== null) yield Buffer.from(text, 'utf8');
  })();
}

/** A stdin that never ends, like a pipe whose writer hangs. */
function hangingStdin(): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Buffer>>(() => {}) }),
  };
}

function line(sb: Sandbox, stdin: AsyncIterable<Buffer>, cwd = sb.repo): Promise<string> {
  return statusLineText({ stdin, env: sb.env, cwd }, FAST);
}

function payload(sessionId: string, dir: string): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd: dir,
    workspace: { current_dir: dir, project_dir: dir },
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  });
}

/**
 * A store with one project, a Claude Code session "ext-1" on branch "feature", another session,
 * and rules, deliveries and conflicts that do and do not count for that session.
 */
function seed(sb: Sandbox): void {
  mkdirSync(sb.mindlyHome, { recursive: true });
  const store = Store.open(join(sb.mindlyHome, 'mindly.db'));
  try {
    const pid = store.projects.upsertByRoot(sb.repo, 'repo').id;
    const session = (externalId: string, agentKind: string, branch: string | null) =>
      store.sessions.upsert({
        projectId: pid,
        agentKind,
        externalId,
        worktree: sb.repo,
        branch,
        transcriptPath: null,
      }).session.id;
    const me = session('ext-1', 'claude-code', 'feature');
    const codex = session('ext-2', 'codex', 'main');
    const other = session('ext-3', 'claude-code', 'main');

    const user = { type: 'user' as const, sessionId: null, agentKind: null };
    const rule = (title: string, trust: 'approved' | 'verified' | 'proposed', branch?: string) =>
      store.memories.create({
        projectId: pid,
        kind: 'rule',
        title,
        body: '',
        trust,
        source: user,
        ...(branch !== undefined ? { scope: { branch } } : {}),
      });
    rule('Use pnpm', 'approved');
    rule('No default exports', 'verified');
    rule('Feature flag names', 'approved', 'feature');
    rule('Main-only rule', 'approved', 'main');
    rule('Agent guess', 'proposed');
    const archived = rule('Old rule', 'approved');
    store.db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);
    store.memories.create({
      projectId: pid,
      kind: 'fact',
      title: 'Not a rule',
      body: '',
      trust: 'approved',
      source: user,
    });

    const deliver = (
      title: string,
      target: { session?: string; agent?: string },
      source: string | null = codex,
      ttlMs = 60_000,
    ) =>
      store.deliveries.enqueue({
        projectId: pid,
        targetSessionId: target.session ?? null,
        targetAgentKind: target.agent ?? null,
        kind: 'message',
        title,
        body: '',
        sourceSessionId: source,
        ttlMs,
      });
    deliver('for me', { session: me });
    deliver('for Claude Code', { agent: 'claude-code' });
    deliver('for anyone', {});
    deliver('for Codex', { agent: 'codex' });
    deliver('for the other session', { session: other });
    deliver('my own broadcast', {}, me);
    deliver('expired', { session: me }, codex, -1);
    const delivered = deliver('already delivered', { session: me });
    store.deliveries.markDelivered([delivered.id], me);

    const conflict = (fingerprint: string, severity: 'info' | 'warning' | 'critical') =>
      store.conflicts.report({
        projectId: pid,
        kind: 'file_overlap',
        severity,
        title: fingerprint,
        detail: '',
        sessionIds: [me, codex],
        paths: ['src/a.ts'],
        fingerprint,
      }).conflict;
    conflict('critical', 'critical');
    conflict('fyi', 'info');
    store.conflicts.setStatus(conflict('seen', 'warning').id, 'acknowledged');
    store.conflicts.setStatus(conflict('done', 'critical').id, 'resolved');
  } finally {
    store.close();
  }
}

describe('statusline formatting', () => {
  it('formats counts with singular and plural words', () => {
    const counts = (rules: number, updates: number, conflicts: number) =>
      formatStatusLine({ kind: 'counts', counts: { rules, updates, conflicts } }, false);
    expect(counts(3, 1, 0)).toBe('mindly · 3 rules · 1 update · 0 conflicts');
    expect(counts(1, 0, 2)).toBe('mindly · 1 rule · 0 updates · 2 conflicts');
    expect(formatStatusLine({ kind: 'offline' }, false)).toBe('mindly · offline');
    expect(formatStatusLine({ kind: 'no-project' }, false)).toBe('mindly · no project');
  });

  it('colours only what needs attention', () => {
    const quiet = formatStatusLine(
      { kind: 'counts', counts: { rules: 2, updates: 0, conflicts: 0 } },
      true,
    );
    expect(quiet).toBe('\u001b[2mmindly\u001b[0m · 2 rules · 0 updates · 0 conflicts');
    const busy = formatStatusLine(
      { kind: 'counts', counts: { rules: 2, updates: 1, conflicts: 3 } },
      true,
    );
    expect(busy).toContain('\u001b[36m1 update\u001b[0m');
    expect(busy).toContain('\u001b[31m3 conflicts\u001b[0m');
  });

  it('reads the session id and directories from partial or invalid JSON', () => {
    expect(sessionInfo(payload('abc', '/w/app'), '/cwd')).toEqual({
      sessionId: 'abc',
      dirs: ['/w/app', '/cwd'],
    });
    expect(sessionInfo('not json', '/cwd')).toEqual({ sessionId: null, dirs: ['/cwd'] });
    expect(sessionInfo('', '/cwd')).toEqual({ sessionId: null, dirs: ['/cwd'] });
    expect(sessionInfo('[1,2]', '/cwd')).toEqual({ sessionId: null, dirs: ['/cwd'] });
    expect(
      sessionInfo(JSON.stringify({ session_id: 7, cwd: 'relative', workspace: null }), '/cwd'),
    ).toEqual({ sessionId: null, dirs: ['/cwd'] });
  });
});

describe('statusline counts', () => {
  it("counts the session's rules, updates and conflicts", async () => {
    const sb = sandbox();
    seed(sb);
    // Rules: 2 shared + 1 on the session's branch. Updates: direct, Claude Code, anyone.
    // Conflicts: the open critical one (FYI, acknowledged and resolved ones do not count).
    expect(await line(sb, stdinOf(payload('ext-1', sb.repo)))).toBe(
      'mindly · 3 rules · 3 updates · 1 conflict',
    );
  });

  it('falls back to the folder before Mindly has seen the session', async () => {
    const sb = sandbox();
    seed(sb);
    mkdirSync(join(sb.repo, 'src'));
    // Without a session only shared rules and broadcasts to Claude Code (or anyone) count.
    expect(await line(sb, stdinOf(payload('unknown', join(sb.repo, 'src'))))).toBe(
      'mindly · 2 rules · 3 updates · 1 conflict',
    );
  });

  it('says so when no project matches', async () => {
    const sb = sandbox();
    seed(sb);
    const elsewhere = sandbox().repo;
    expect(await line(sb, stdinOf(payload('unknown', elsewhere)), elsewhere)).toBe(
      'mindly · no project',
    );
  });
});

describe('statusline degraded paths', () => {
  it('uses the working directory when stdin is empty, not JSON or never ends', async () => {
    const sb = sandbox();
    seed(sb);
    const expected = 'mindly · 2 rules · 3 updates · 1 conflict';
    expect(await line(sb, stdinOf(null))).toBe(expected);
    expect(await line(sb, stdinOf('{"oops"'))).toBe(expected);
    const started = Date.now();
    expect(await line(sb, hangingStdin())).toBe(expected);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('prints offline when the store is missing, unusable or not Mindly', async () => {
    const sb = sandbox();
    expect(await line(sb, stdinOf(payload('ext-1', sb.repo)))).toBe('mindly · offline');
    expect(existsSync(join(sb.mindlyHome, 'mindly.db'))).toBe(false);

    mkdirSync(sb.mindlyHome, { recursive: true });
    writeFileSync(join(sb.mindlyHome, 'mindly.db'), 'this is not a database');
    expect(await line(sb, stdinOf(payload('ext-1', sb.repo)))).toBe('mindly · offline');

    const relative = { ...sb, env: { ...sb.env, MINDLY_HOME: 'relative/path' } };
    expect(await line(relative, stdinOf(null))).toBe('mindly · offline');
  });

  it('prints offline when the database is locked past the busy timeout', async () => {
    const sb = sandbox();
    seed(sb);
    const store = Store.open(join(sb.mindlyHome, 'mindly.db'));
    try {
      store.db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
      const started = Date.now();
      expect(await line(sb, stdinOf(payload('ext-1', sb.repo)))).toBe('mindly · offline');
      expect(Date.now() - started).toBeLessThan(2_000);
      store.db.exec('COMMIT');
    } finally {
      store.close();
    }
  });

  it('mindly statusline always exits 0 with one line', async () => {
    const sb = sandbox();
    const r = await cli(sb, ['statusline'], { stdin: 'garbage' });
    expect(r).toEqual({ code: 0, stdout: 'mindly · offline\n', stderr: '' });
    const out: string[] = [];
    const code = await runStatusLine(
      {
        stdin: stdinOf(null),
        stdout: { write: (s: string) => void out.push(s) },
        env: { ...sb.env, MINDLY_HOME: 'relative' },
        cwd: sb.repo,
      },
      FAST,
    );
    expect(code).toBe(0);
    expect(out).toEqual(['mindly · offline\n']);
  });
});

describe('statusline setup through init, doctor and uninstall', () => {
  const settingsFile = (sb: Sandbox) => join(sb.home, '.claude', 'settings.json');
  const statusLineOf = (sb: Sandbox) =>
    (JSON.parse(readFileSync(settingsFile(sb), 'utf8')) as { statusLine?: { command: string } })
      .statusLine;
  const doctorCheck = async (sb: Sandbox) =>
    (
      JSON.parse((await cli(sb, ['doctor', '--json'])).stdout) as {
        checks: { name: string; status: string; detail: string }[];
      }
    ).checks.find((c) => c.name === 'statusline');

  it('init --yes installs it, doctor reports it and uninstall removes it', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    expect(await doctorCheck(sb)).toMatchObject({ status: 'info', detail: /not installed/ });
    const r = await cli(sb, ['init', '--yes']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Show Mindly in the Claude Code status line');
    expect(statusLineOf(sb)?.command).toMatch(/ statusline$/);
    expect(await doctorCheck(sb)).toMatchObject({ status: 'ok' });

    const removed = await cli(sb, ['uninstall', '--agents', 'claude-code', '--yes']);
    expect(removed.code).toBe(0);
    expect(statusLineOf(sb)).toBeUndefined();
  });

  it('never clobbers a user status line and prints how to chain it', async () => {
    const sb = sandbox();
    const mine = { type: 'command', command: '~/.claude/statusline.sh', padding: 2 };
    write(sb.home, join('.claude', 'settings.json'), JSON.stringify({ statusLine: mine }));
    const r = await cli(sb, ['init', '--yes']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already has a status line');
    expect(r.stdout).toContain("sh -c '~/.claude/statusline.sh'");
    expect(statusLineOf(sb)).toEqual(mine);
    expect(await doctorCheck(sb)).toMatchObject({ status: 'info', detail: /another statusLine/ });
    await cli(sb, ['uninstall', '--agents', 'claude-code', '--yes']);
    expect(statusLineOf(sb)).toEqual(mine);
  });

  it('respects --no-statusline, --dry-run and a declined prompt', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.claude'));
    const dry = await cli(sb, ['init', '--agents', 'claude-code', '--dry-run']);
    expect(dry.stdout).toContain('Show Mindly in the Claude Code status line');
    expect(existsSync(settingsFile(sb))).toBe(false);

    expect(
      (await cli(sb, ['init', '--agents', 'claude-code', '--yes', '--no-statusline'])).code,
    ).toBe(0);
    expect(statusLineOf(sb)).toBeUndefined();

    const noTty = await cli(sb, ['init', '--agents', 'claude-code']);
    expect(noTty.code).toBe(0);
    expect(noTty.stdout).toContain('Status line not added');
    const declined = await cli(sb, ['init', '--agents', 'claude-code'], { answers: ['n'] });
    expect(declined.stdout).toContain('Status line not added.');
    expect(statusLineOf(sb)).toBeUndefined();
    await cli(sb, ['init', '--agents', 'claude-code'], { answers: ['y'] });
    expect(statusLineOf(sb)?.command).toMatch(/ statusline$/);
  });

  it('doctor warns when the installed launcher is gone', async () => {
    const sb = sandbox();
    write(
      sb.home,
      join('.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: '/gone/bin/mindly statusline' } }),
    );
    expect(await doctorCheck(sb)).toMatchObject({ status: 'warn', detail: /binary not found/ });
  });
});

const BUILT_MAIN = join(import.meta.dirname, '..', 'dist', 'main.js');

describe.skipIf(!existsSync(BUILT_MAIN))('statusline binary', () => {
  it('answers quickly and silently from the built CLI', () => {
    const sb = sandbox();
    seed(sb);
    const run = (input: string) =>
      spawnSync(process.execPath, [BUILT_MAIN, 'statusline'], {
        input,
        env: sb.env,
        cwd: sb.repo,
        encoding: 'utf8',
      });
    expect(run(payload('ext-1', sb.repo))).toMatchObject({
      status: 0,
      stdout: 'mindly · 3 rules · 3 updates · 1 conflict\n',
      stderr: '',
    });
    expect(run('{"oops"')).toMatchObject({ status: 0, stderr: '' });
  });
});
