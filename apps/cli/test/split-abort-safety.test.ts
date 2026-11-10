/*
 * `mindly split abort` against real git: what it must never delete without `--yes --discard`,
 * and what must not stop it.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as GitModule from '@mindly/git';
import { openMindly } from '@mindly/runtime';
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
    expect(a.keptBecause[page]).toBe('it got new work while the abort ran: src/app/late.ts');
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

  it('does not stop at a large ignored build folder', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', 'build/\n'));
    const page = partDir(sb, 'page');
    // Many folders and files: nothing walks them, git lists them once.
    for (let d = 0; d < 100; d++) {
      for (let f = 0; f < 100; f++) write(page, `build/d${d}/f${f}.o`, '');
    }
    expect((await cli(sb, ['split', 'abort', '--yes', '--keep-branches'])).code).toBe(0);
  });

  it('keeps a file written after the last check when git would not show untracked files', async () => {
    const sb = await splitSandbox();
    // A common setting in large repositories; worktrees share it.
    git(sb.repo, 'config', 'status.showUntrackedFiles', 'no');
    const page = partDir(sb, 'page');
    write(page, 'src/app/billing.ts', 'export const billing = 1;\n');
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
    expect(readFileSync(join(page, 'src/app/late.ts'), 'utf8')).toBe('export const late = 1;\n');
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

describe('split abort never deletes git data in a worktree, short of a discard', () => {
  interface Aborted {
    finished: boolean;
    keptWorktrees: string[];
    keptBranches: string[];
    keptBecause: Record<string, string>;
  }
  const HELD = (paths: string): string =>
    `it holds git data that abort never deletes: ${paths}. Move it out of the worktree (or delete it yourself if it is a throwaway checkout) and run mindly split abort again, or delete everything with mindly split abort --yes --discard`;

  /** `split abort --yes --json`: the page part must be kept, held for `paths`. */
  async function keptFor(sb: Sandbox, paths: string, args: string[] = []): Promise<Aborted> {
    const r = await cli(sb, ['split', 'abort', '--yes', '--json', ...args]);
    expect(r.code).toBe(1);
    const a = JSON.parse(r.stdout) as Aborted;
    const page = partDir(sb, 'page');
    expect(a.finished).toBe(false);
    expect(a.keptWorktrees).toEqual([page]);
    expect(a.keptBranches).toContain('mindly/billing/page');
    expect(a.keptBecause[page]).toBe(HELD(paths));
    return a;
  }

  /** A repository at `<dir>` with one commit of `files`. */
  function repoAt(dir: string, files: Record<string, string> = { 'a.ts': 'a\n' }): void {
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'only copy');
  }

  /** Marks every part done, as finished agents do, so that `split merge` may run. */
  async function allDone(sb: Sandbox): Promise<void> {
    const st = JSON.parse((await cli(sb, ['split', 'status', '--json'])).stdout) as {
      parts: { part: { taskId: string } }[];
    };
    const mindly = openMindly({ env: sb.env, disableNotify: true, disableLlm: true });
    try {
      for (const p of st.parts) mindly.tasks.update(p.part.taskId, { status: 'done' }, null);
    } finally {
      mindly.close();
    }
  }

  it('keeps a repository in an ignored folder, and finishes once it is moved out by hand', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', 'tools/\nnode_modules/\n'));
    const page = partDir(sb, 'page');
    // Next to an empty CACHEDIR.TAG or in node_modules: found all the same.
    write(page, 'tools/CACHEDIR.TAG', '');
    repoAt(join(page, 'tools/patched-dep'));
    repoAt(join(page, 'node_modules/dep'));
    const a = await keptFor(sb, 'node_modules/dep, tools/patched-dep');
    // The other part went.
    expect(existsSync(partDir(sb, 'api'))).toBe(false);
    expect(git(join(page, 'tools/patched-dep'), 'log', '--format=%s')).toBe('only copy\n');
    void a;
    // The user moves them out and runs the abort again.
    const away = tempDir('r10-away-');
    renameSync(join(page, 'tools/patched-dep'), join(away, 'patched-dep'));
    renameSync(join(page, 'node_modules/dep'), join(away, 'dep'));
    expect((await cli(sb, ['split', 'abort', '--yes'])).code).toBe(0);
    expect(existsSync(page)).toBe(false);
    expect(git(join(away, 'patched-dep'), 'log', '--format=%s')).toBe('only copy\n');
  });

  it('keeps a submodule with uncommitted edits, and a discard deletes it', async () => {
    const sub = tempDir('r10-sub-');
    repoAt(sub, { 'lib.ts': 'export const lib = 1;\n' });
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
    git(page, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'update', '--init');
    write(page, 'src/app/vendor/lib.ts', 'export const lib = 2; // hours of work\n');
    const admin = git(page, 'rev-parse', '--absolute-git-dir').trim();
    await keptFor(sb, `src/app/vendor, ${join(admin, 'modules')}`);
    expect(readFileSync(join(page, 'src/app/vendor/lib.ts'), 'utf8')).toContain('hours of work');
    expect((await cli(sb, ['split', 'abort', '--yes', '--discard'])).code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  it('keeps a deinitialised submodule whose git directory holds an unpushed commit', async () => {
    const sub = tempDir('r10-sub-');
    repoAt(sub, { 'x.ts': 'x\n' });
    const sb = await splitSandbox((s) => {
      git(s.repo, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 'mods/sub');
    });
    const page = partDir(sb, 'page');
    git(page, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'update', '--init');
    git(join(page, 'mods/sub'), 'commit', '-q', '--allow-empty', '-m', 'unpushed');
    git(page, 'submodule', 'deinit', '-q', '-f', 'mods/sub');
    const admin = git(page, 'rev-parse', '--absolute-git-dir').trim();
    for (let i = 0; i < 2; i++) await keptFor(sb, join(admin, 'modules'));
    // Only a discard deletes it, as it says.
    expect((await cli(sb, ['split', 'abort', '--yes', '--discard'])).code).toBe(0);
  });

  it('keeps a repository whose git directory is in an ignored folder', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', '.cache/\n'));
    const page = partDir(sb, 'page');
    const lib = join(page, 'lib');
    write(lib, 'a.ts', 'a\n');
    write(page, '.cache/keep', '');
    git(page, 'init', '-q', '--separate-git-dir', join(page, '.cache/lib.git'), lib);
    git(lib, 'add', '-A');
    git(lib, 'commit', '-q', '-m', 'only here');
    await keptFor(sb, '.cache/lib.git, lib');
    expect(git(lib, 'log', '--format=%s')).toBe('only here\n');
  });

  it('keeps files written into an uninitialised submodule folder, and a merge stops at them', async () => {
    const sub = tempDir('r10-sub-');
    repoAt(sub, { 'lib.ts': 'export const lib = 1;\n' });
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
    // `git worktree add` leaves the submodule folder empty; the agent writes into it.
    write(page, 'src/app/vendor/patch.ts', 'export const fix = 1; // hours of work\n');
    // git lists nothing under a gitlink, nor does its own check before removing a worktree.
    expect(git(page, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    const st = JSON.parse((await cli(sb, ['split', 'status', '--json'])).stdout) as {
      parts: { uncommitted: string[] }[];
    };
    expect(st.parts.map((p) => p.uncommitted)).toEqual([[], ['src/app/vendor/patch.ts']]);
    await allDone(sb);
    const merged = await cli(sb, ['split', 'merge']);
    expect(merged.code).not.toBe(0);
    expect(merged.stderr).toContain('src/app/vendor/patch.ts');
    // --force merges without them, and says so.
    const forced = await cli(sb, ['split', 'merge', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('src/app/vendor/patch.ts');
    await keptFor(sb, 'files in the uninitialised submodule folder src/app/vendor');
    expect(readFileSync(join(page, 'src/app/vendor/patch.ts'), 'utf8')).toContain('hours of work');
  });

  it('keeps a repository git does not accept, in an ignored folder', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', 'build/\n'));
    const page = partDir(sb, 'page');
    const r0 = join(page, 'build/r');
    repoAt(r0, { 'f.ts': 'f\n' });
    // HEAD a symlink: git no longer takes it for a repository, and never lists `.git` itself.
    writeFileSync(join(r0, '.git/HEAD.real'), 'ref: refs/heads/main\n');
    rmSync(join(r0, '.git/HEAD'));
    symlinkSync('HEAD.real', join(r0, '.git/HEAD'));
    await keptFor(sb, 'build/r');
    expect(existsSync(join(r0, '.git/objects'))).toBe(true);
  });

  it('does not take the worktree for a git directory: a HEAD beside tracked objects/ and refs/', async () => {
    const sb = await splitSandbox((s) => {
      write(s.repo, 'objects/a.txt', 'a\n');
      write(s.repo, 'refs/b.txt', 'b\n');
      write(s.repo, '.gitignore', 'HEAD\n');
    });
    write(partDir(sb, 'page'), 'HEAD', 'build output\n');
    const r = await cli(sb, ['split', 'abort', '--yes']);
    expect(r.stdout + r.stderr).not.toContain('git data');
    expect(r.code).toBe(0);
  });

  it('keeps a repository whose .git is a link into an ignored folder', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', '.repos/\n'));
    const page = partDir(sb, 'page');
    const lib = join(page, 'lib');
    write(lib, 'a.ts', 'a\n');
    git(page, 'init', '-q', '--bare', join(page, '.repos/lib.git'));
    symlinkSync('../.repos/lib.git', join(lib, '.git'));
    git(lib, 'config', 'core.bare', 'false');
    git(lib, 'add', '-A');
    git(lib, 'commit', '-q', '-m', 'only here');
    await keptFor(sb, '.repos/lib.git, lib');
    expect(git(lib, 'log', '--format=%s')).toBe('only here\n');
  });

  it('keeps a repository made in a folder the part tracks, with a commit only it has', async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    const app = join(page, 'src/app');
    git(app, 'init', '-q', '-b', 'main');
    git(app, 'add', '-A');
    git(app, 'commit', '-q', '-m', 'base');
    git(app, 'checkout', '-q', '-b', 'experiment');
    write(app, 'page.ts', 'export const page = 2; // the experiment\n');
    git(app, 'commit', '-q', '-am', 'experiment');
    git(app, 'checkout', '-q', 'main');
    // A staged change of the part's own, in that folder.
    write(page, 'src/app/new.ts', 'staged\n');
    git(page, 'add', 'src/app/new.ts');
    const staged = git(page, 'rev-parse', ':src/app/new.ts').trim();
    await keptFor(sb, 'src/app');
    expect(git(app, 'log', '--format=%s', 'experiment').split('\n')[0]).toBe('experiment');
    expect(git(page, 'rev-parse', ':src/app/new.ts').trim()).toBe(staged);
  });

  it("leaves a copy of the user's own linked worktree, and that worktree, alone", async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    const mine = `${sb.repo}-mine`;
    git(sb.repo, 'worktree', 'add', '-q', '-b', 'mine', mine);
    write(mine, 'wip.ts', 'my wip\n');
    git(mine, 'add', 'wip.ts');
    execFileSync('cp', ['-r', mine, join(page, 'scratch')]);
    const entry = (): string =>
      git(sb.repo, 'worktree', 'list', '--porcelain')
        .split('\n\n')
        .find((e) => e.startsWith(`worktree ${mine}\n`)) ?? '';
    const before = entry();
    expect(before).toContain('branch refs/heads/mine');
    const mineGit = readFileSync(join(mine, '.git'), 'utf8');
    await keptFor(sb, 'scratch');
    expect(readFileSync(join(mine, '.git'), 'utf8')).toBe(mineGit);
    git(sb.repo, 'worktree', 'prune');
    expect(entry()).toBe(before);
    expect(git(mine, 'status', '--porcelain')).toBe('A  wip.ts\n');
  });

  it('keeps a repository made after the yes, right before the worktree would go', async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    write(page, 'src/app/billing.ts', 'export const billing = 1;\n');
    let looks = 0;
    hook.afterBranchLook = (branch) => {
      if (branch === 'mindly/billing/page' && ++looks === 3) repoAt(join(page, 'src/app/late'));
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
    expect(a.keptBecause[page]).toBe(HELD('src/app/late'));
    expect(git(join(page, 'src/app/late'), 'log', '--format=%s')).toBe('only copy\n');
  });

  it('a merge stops at an edit in a folder holding a .git, a submodule bump or a new repository', async () => {
    const sub = tempDir('r10-sub-');
    repoAt(sub, { 'x.ts': 'x\n' });
    const sb = await splitSandbox((s) => {
      git(s.repo, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 'src/app/sub');
    });
    const page = partDir(sb, 'page');
    write(page, 'src/app/page.ts', 'export const page = 2;\n');
    git(join(page, 'src/api'), 'init', '-q');
    git(page, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'update', '--init');
    write(page, 'src/app/sub/x.ts', 'two\n');
    git(join(page, 'src/app/sub'), 'commit', '-q', '-am', 'two');
    repoAt(join(page, 'src/app/tool'));
    await allDone(sb);
    const merged = await cli(sb, ['split', 'merge']);
    expect(merged.code).not.toBe(0);
    for (const p of ['src/app/page.ts', 'src/app/sub', 'src/app/tool']) {
      expect(merged.stderr).toContain(p);
    }
    // --force merges without them, and says so.
    const forced = await cli(sb, ['split', 'merge', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('src/app/tool');
  });

  it('takes about as long with dependency checkouts full of files as without', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', 'deps/\n'));
    // The same commands on this machine, before the checkouts: what the bounds are relative to.
    const timed = async (argv: string[], opts = {}): Promise<number> => {
      const t = Date.now();
      await cli(sb, argv, opts);
      return Date.now() - t;
    };
    const base = Math.min(await timed(['split', 'status']), await timed(['split', 'status']));
    const blob = Buffer.alloc(16 * 1024, 7);
    for (const key of ['api', 'page']) {
      for (const name of ['a', 'b', 'c']) {
        const d = join(partDir(sb, key), 'deps', name);
        repoAt(d, { '.gitignore': 'node_modules/\n', 'index.js': 'module.exports = 1;\n' });
        for (let p = 0; p < 200; p++) {
          for (let f = 0; f < 30; f++) write(d, `node_modules/pkg${p}/lib/f${f}.js`, '');
        }
        writeFileSync(join(d, 'node_modules/pkg0/lib/f0.js'), blob);
      }
    }
    const status = await timed(['split', 'status']);
    const abort = await timed(['split', 'abort', '--keep-branches'], { answers: ['y'] });
    expect(existsSync(join(partDir(sb, 'page'), 'deps/a/.git'))).toBe(true);
    // Nothing in them is read, and git does not go into them: status costs what it did without
    // them, and an abort (which looks at each part twice more) a few times that.
    expect(status).toBeLessThan(2 * base + 300);
    expect(abort).toBeLessThan(4 * base + 500);
  }, 300_000);
});
