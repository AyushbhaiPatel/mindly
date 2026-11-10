/*
 * `mindly split abort` against real git: what it must never delete without `--yes --discard`,
 * and what must not stop it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, git, sandbox, tempDir, write, type Sandbox } from './helpers.js';

const PLAN = {
  goal: 'Add billing: API, webhook handler, page',
  parts: [
    {
      key: 'api',
      title: 'Billing API',
      agent: 'claude-code',
      owns: ['src/api/**'],
      dependsOn: [],
      brief: 'a',
    },
    {
      key: 'page',
      title: 'Billing page',
      agent: 'claude-code',
      owns: ['src/app/**'],
      dependsOn: ['api'],
      brief: 'p',
    },
  ],
  contract: [{ name: 'GET /api/billing', owner: 'api', definition: 'returns { plan, id }' }],
};

async function splitSandbox(prepare?: (sb: Sandbox) => void): Promise<Sandbox> {
  const sb = sandbox();
  write(sb.repo, 'src/api/billing.ts', 'export const api = 1;\n');
  write(sb.repo, 'src/app/page.ts', 'export const page = 1;\n');
  prepare?.(sb);
  git(sb.repo, 'add', '-A');
  git(sb.repo, 'commit', '-q', '-m', 'files');
  expect((await cli(sb, ['init', '--yes', '--agents', 'claude-code'])).code).toBe(0);
  const plan = join(sb.home, 'plan.json');
  writeFileSync(plan, JSON.stringify(PLAN));
  const r = await cli(sb, ['split', '--plan', plan, '--name', 'billing', '--yes']);
  expect(r.code).toBe(0);
  return sb;
}

const partDir = (sb: Sandbox, key: string): string => join(`${sb.repo}.mindly`, `billing-${key}`);

describe('split abort keeps what it cannot account for', () => {
  it('keeps a worktree with uncommitted edits inside a submodule', async () => {
    const sub = tempDir('r10-sub-');
    git(sub, 'init', '-q', '-b', 'main');
    write(sub, 'lib.ts', 'export const lib = 1;\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-q', '-m', 'lib');
    const sb = await splitSandbox((s) => {
      git(
        s.repo,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        '-q',
        'add',
        sub,
        'src/app/vendor',
      );
    });
    const page = partDir(sb, 'page');
    // The agent initialises the submodule in its worktree and edits a file in it.
    git(page, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'update', '--init');
    write(page, 'src/app/vendor/lib.ts', 'export const lib = 2; // hours of work\n');
    write(page, 'src/app/vendor/new.ts', 'export const fresh = 1;\n');
    const r = await cli(sb, ['split', 'abort', '--yes', '--json']);
    // Without --discard nothing that no other branch has may be removed: git keeps it.
    expect(r.code).toBe(1);
    const a = JSON.parse(r.stdout) as {
      finished: boolean;
      keptWorktrees: string[];
      keptBecause: Record<string, string>;
    };
    expect(a.finished).toBe(false);
    expect(a.keptWorktrees).toEqual([page]);
    expect(a.keptBecause[page]).toMatch(/^git did not remove it: .*submodules/);
    expect(existsSync(join(page, 'src/app/vendor/new.ts'))).toBe(true);
    expect(git(sb.repo, 'branch', '--list', 'mindly/billing/page').trim()).not.toBe('');
    // The abort is not finished until that worktree goes: with --yes --discard, it does.
    const status = await cli(sb, ['split', 'status']);
    expect(status.stdout).toContain('finish the abort');
    const discard = await cli(sb, ['split', 'abort', '--yes', '--discard']);
    expect(discard.code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  it('counts ignored deny-listed files whatever their letter case', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', 'certs/\n'));
    const page = partDir(sb, 'page');
    write(page, 'certs/Prod.KEY', '-----BEGIN PRIVATE KEY-----\nabc\n');
    write(page, 'certs/.ENV', 'STRIPE_KEY=sk_live_x\n');
    const r = await cli(sb, ['split', 'abort', '--yes']);
    expect(r.code).toBe(1);
    expect(existsSync(join(page, 'certs/Prod.KEY'))).toBe(true);
  });

  it('never reads a file on redaction.denyPaths into a git object', async () => {
    const sb = await splitSandbox();
    expect((await cli(sb, ['config', 'set', 'redaction.denyPaths', '["**/*.secret"]'])).code).toBe(
      0,
    );
    const page = partDir(sb, 'page');
    const secret = 'DB_PASSWORD=hunter2-r10\n';
    write(page, 'src/app/prod.secret', secret);
    const blob = execFileSync('git', ['hash-object', '--stdin'], {
      input: secret,
      encoding: 'utf8',
    }).trim();
    const has = (): boolean => {
      try {
        git(sb.repo, 'cat-file', '-e', blob);
        return true;
      } catch {
        return false;
      }
    };
    expect(has()).toBe(false);
    expect((await cli(sb, ['split', 'status'])).code).toBe(0);
    const r = await cli(sb, ['split', 'abort', '--yes']);
    // Listed by name, never read: no git object holds its content.
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('src/app/prod.secret');
    expect(r.stderr).not.toContain('hunter2');
    expect(has()).toBe(false);
  });

  it('counts an ignored file on redaction.denyPaths as work', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', '*.secret\n'));
    expect((await cli(sb, ['config', 'set', 'redaction.denyPaths', '["**/*.secret"]'])).code).toBe(
      0,
    );
    const page = partDir(sb, 'page');
    write(page, 'local.secret', 'DB_PASSWORD=hunter2\n');
    const r = await cli(sb, ['split', 'abort', '--yes']);
    expect(r.code).toBe(1);
    expect(existsSync(join(page, 'local.secret'))).toBe(true);
  });
});

describe('split abort does not refuse for what loses nothing', () => {
  it("does not count deny-listed files inside dependency folders (a venv's cacert.pem)", async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', '.venv/\nnode_modules/\n'));
    for (const key of ['api', 'page']) {
      // What `python -m venv .venv && pip install requests` leaves in every worktree.
      write(partDir(sb, key), '.venv/lib/python3.12/site-packages/certifi/cacert.pem', 'CA\n');
      write(
        partDir(sb, key),
        '.venv/lib/python3.12/site-packages/pip/_vendor/certifi/cacert.pem',
        'CA\n',
      );
      write(partDir(sb, key), '.venv/lib/python3.12/site-packages/requests/__init__.py', 'x\n');
    }
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(0);
  });

  it('does not count a committed deny-listed file that was only touched', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.env.example', 'STRIPE_KEY=\n'));
    const page = partDir(sb, 'page');
    // Same content, newer mtime (an editor save, a formatter, a checkout of the same blob).
    const later = new Date(Date.now() + 5000);
    utimesSync(join(page, '.env.example'), later, later);
    const st = await cli(sb, ['split', 'status', '--json']);
    const parts = (JSON.parse(st.stdout) as { parts: { uncommitted: string[] }[] }).parts;
    expect(parts.map((p) => p.uncommitted)).toEqual([[], []]);
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(0);
  });
});
