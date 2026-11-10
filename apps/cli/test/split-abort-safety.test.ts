/*
 * `mindly split abort` against real git: what it must never delete without `--yes --discard`,
 * and what must not stop it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as GitModule from '@mindly/git';
import { cli, git, sandbox, tempDir, write, type Sandbox } from './helpers.js';

// Lets a test act while an abort runs: after each look at a part branch's commits, which abort
// makes last right before it removes the part's files and worktree.
const hook: { afterBranchLook?: (branch: string) => void } = {};
vi.mock('@mindly/git', async (importOriginal) => {
  const real = await importOriginal<typeof GitModule>();
  return {
    ...real,
    branchOnlyWork: async (...args: Parameters<typeof real.branchOnlyWork>) => {
      const r = await real.branchOnlyWork(...args);
      hook.afterBranchLook?.(args[1]);
      return r;
    },
  };
});

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

describe('split abort removes what was confirmed, and copes with what git will not remove', () => {
  it('a confirmed abort on the terminal removes the untracked work it listed', async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    // The agent wrote a new file and did not commit it (the ordinary state of a part).
    write(page, 'src/app/billing.ts', 'export const billing = 1;\n');
    const r = await cli(sb, ['split', 'abort'], { answers: ['y'] });
    expect(r.stderr).toContain('Part "Billing page": src/app/billing.ts');
    expect(r.code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  it('a secret in a folder that only looks like build output is not removed without --discard', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', 'env/\nbuild/\n'));
    const page = partDir(sb, 'page');
    write(page, 'env/.env', 'STRIPE_KEY=sk_live_only_copy\n');
    write(page, 'deploy/build/signing.key', '-----BEGIN PRIVATE KEY-----\nabc\n');
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('deploy/build/signing.key, env/.env');
    expect(existsSync(join(page, 'env/.env'))).toBe(true);
    expect(existsSync(join(page, 'deploy/build/signing.key'))).toBe(true);
  });

  it('a locked worktree is kept with a way out, and --yes --discard removes it', async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    git(sb.repo, 'worktree', 'lock', '--reason', 'agent running', page);
    const r1 = await cli(sb, ['split', 'abort', '--yes', '--json']);
    expect(r1.code).toBe(1);
    const a = JSON.parse(r1.stdout) as {
      finished: boolean;
      removedWorktrees: string[];
      keptBecause: Record<string, string>;
    };
    expect(a.finished).toBe(false);
    expect(a.removedWorktrees).toEqual([partDir(sb, 'api')]);
    expect(a.keptBecause[page]).toBe(
      `it is locked; run git worktree unlock ${page}, or remove it anyway: mindly split abort --yes --discard`,
    );
    expect(existsSync(page)).toBe(true);
    const r2 = await cli(sb, ['split', 'abort', '--yes', '--discard']);
    expect(r2.stderr).toBe('');
    expect(r2.code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });
});

describe('split abort leaves the last word to git, confirmed or not', () => {
  interface Aborted {
    finished: boolean;
    keptWorktrees: string[];
    keptBecause: Record<string, string>;
  }

  it('a confirmed abort keeps a repository committed into the part (no .gitmodules)', async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    // The agent makes a repository in its part, commits in it and records it on the part branch.
    const nested = join(page, 'src/app/vendor');
    write(page, 'src/app/vendor/lib.ts', 'export const lib = 1;\n');
    git(nested, 'init', '-q', '-b', 'main');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-q', '-m', 'nested work');
    git(page, 'add', 'src/app/vendor');
    git(page, 'commit', '-q', '-m', 'add vendor');
    // Uncommitted work in it, which no listing of the part shows, and a file that is listed.
    write(page, 'src/app/vendor/wip.ts', 'export const wip = 1;\n');
    write(page, 'src/app/billing.ts', 'export const billing = 1;\n');
    const r = await cli(sb, ['split', 'abort', '--keep-branches', '--json'], { answers: ['y'] });
    expect(r.stderr).toContain('src/app/billing.ts');
    expect(r.code).toBe(1);
    const a = JSON.parse(r.stdout) as Aborted;
    expect(a.finished).toBe(false);
    expect(a.keptWorktrees).toEqual([page]);
    expect(a.keptBecause[page]).toMatch(/^git did not remove it: .*submodules/);
    // The confirmed file went; the repository and its work stay.
    expect(existsSync(join(page, 'src/app/billing.ts'))).toBe(false);
    expect(existsSync(join(nested, 'wip.ts'))).toBe(true);
    expect(existsSync(join(nested, '.git'))).toBe(true);
    expect((await cli(sb, ['split', 'abort', '--yes', '--discard'])).code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  it('a confirmed abort keeps a file written after its last check', async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    write(page, 'src/app/billing.ts', 'export const billing = 1;\n');
    write(page, 'src/app/page.ts', 'export const page = 2;\n');
    // The page branch is looked at by the listing, by abort's own check and, last, right before
    // the part's files go. Then the agent, still running, saves a new file.
    let looks = 0;
    hook.afterBranchLook = (branch) => {
      if (branch === 'mindly/billing/page' && ++looks === 3) {
        write(page, 'src/app/late.ts', 'export const late = 1;\n');
      }
    };
    let r: Awaited<ReturnType<typeof cli>>;
    try {
      r = await cli(sb, ['split', 'abort', '--json'], { answers: ['y'] });
    } finally {
      delete hook.afterBranchLook;
    }
    expect(looks).toBe(3);
    expect(r.code).toBe(1);
    const a = JSON.parse(r.stdout) as Aborted;
    expect(a.finished).toBe(false);
    expect(a.keptWorktrees).toEqual([page]);
    expect(a.keptBecause[page]).toMatch(/^git did not remove it: .*modified or untracked/);
    expect(readFileSync(join(page, 'src/app/late.ts'), 'utf8')).toBe('export const late = 1;\n');
    // What was confirmed went: the new file, and the edit (the committed file is back).
    expect(existsSync(join(page, 'src/app/billing.ts'))).toBe(false);
    expect(readFileSync(join(page, 'src/app/page.ts'), 'utf8')).toBe('export const page = 1;\n');
    // The rerun lists the late file, and a confirmation of it finishes the abort.
    const again = await cli(sb, ['split', 'abort'], { answers: ['y'] });
    expect(again.stderr).toContain('src/app/late.ts');
    expect(again.code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  it('keeps a nested repository in an ignored folder, confirmed or not', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', 'tools/\n'));
    const page = partDir(sb, 'page');
    const nested = join(page, 'tools/patched-dep');
    write(page, 'tools/patched-dep/fix.ts', 'export const fix = 1;\n');
    git(nested, 'init', '-q', '-b', 'main');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-q', '-m', 'local fix, never pushed');
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('tools/patched-dep');
    const confirmed = await cli(sb, ['split', 'abort', '--keep-branches'], { answers: ['y'] });
    expect(confirmed.code).toBe(1);
    expect(existsSync(join(nested, '.git'))).toBe(true);
    expect((await cli(sb, ['split', 'abort', '--yes', '--discard'])).code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  it('counts an edit to a file flagged skip-worktree, and removes it once confirmed', async () => {
    const sb = await splitSandbox((s) => write(s.repo, 'config/local.json', '{"db":""}\n'));
    const page = partDir(sb, 'page');
    // The usual way to keep a local config out of commits.
    git(page, 'update-index', '--skip-worktree', 'config/local.json');
    write(page, 'config/local.json', '{"db":"postgres://me:pw@host/db"}\n');
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('config/local.json');
    expect(readFileSync(join(page, 'config/local.json'), 'utf8')).toContain('postgres://');
    const confirmed = await cli(sb, ['split', 'abort', '--keep-branches'], { answers: ['y'] });
    expect(confirmed.stderr).toContain('config/local.json');
    expect(confirmed.code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  it('git sees an edit to a flagged file made after the last check', async () => {
    const sb = await splitSandbox((s) => write(s.repo, 'config/local.json', '{"db":""}\n'));
    const page = partDir(sb, 'page');
    git(page, 'update-index', '--skip-worktree', 'config/local.json');
    let looks = 0;
    hook.afterBranchLook = (branch) => {
      if (branch === 'mindly/billing/page' && ++looks === 3) {
        write(page, 'config/local.json', '{"db":"postgres://me:pw@host/db"}\n');
      }
    };
    let r: Awaited<ReturnType<typeof cli>>;
    try {
      r = await cli(sb, ['split', 'abort', '--yes', '--json']);
    } finally {
      delete hook.afterBranchLook;
    }
    expect(looks).toBe(3);
    expect(r.code).toBe(1);
    const a = JSON.parse(r.stdout) as Aborted;
    expect(a.keptWorktrees).toEqual([page]);
    expect(a.keptBecause[page]).toMatch(/^git did not remove it: .*modified or untracked/);
    expect(readFileSync(join(page, 'config/local.json'), 'utf8')).toContain('postgres://');
    expect(git(page, 'ls-files', '-v', 'config/local.json')).toBe('S config/local.json\n');
  });
});
