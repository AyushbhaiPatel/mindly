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
  it('lists a submodule with uncommitted edits, and removes it only on a confirmation', async () => {
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
    const r = await cli(sb, ['split', 'abort', '--yes']);
    // Without a confirmation or --discard, nothing that no other branch has may be removed.
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('git repositories, with their commits and changes: src/app/vendor');
    expect(existsSync(join(page, 'src/app/vendor/new.ts'))).toBe(true);
    expect(git(sb.repo, 'branch', '--list', 'mindly/billing/page').trim()).not.toBe('');
    // Shown and confirmed on the terminal, it goes, its git directory in the worktree's too.
    const confirmed = await cli(sb, ['split', 'abort', '--keep-branches'], { answers: ['y'] });
    expect(confirmed.stderr).toContain('src/app/vendor');
    expect(confirmed.code).toBe(0);
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

  it('a repository committed into the part (no .gitmodules) goes only as it was confirmed', async () => {
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
    write(page, 'src/app/vendor/wip.ts', 'export const wip = 1;\n');
    write(page, 'src/app/billing.ts', 'export const billing = 1;\n');
    // Uncommitted work is written in it after the confirmation, right before it goes.
    let looks = 0;
    hook.afterBranchLook = (branch) => {
      if (branch === 'mindly/billing/page' && ++looks === 3) {
        write(page, 'src/app/vendor/wip.ts', 'export const wip = 2; // more work\n');
      }
    };
    let r: Awaited<ReturnType<typeof cli>>;
    try {
      r = await cli(sb, ['split', 'abort', '--json'], { answers: ['y'] });
    } finally {
      delete hook.afterBranchLook;
    }
    expect(looks).toBe(3);
    expect(r.stderr).toContain('git repositories, with their commits and changes: src/app/vendor');
    expect(r.code).toBe(1);
    const a = JSON.parse(r.stdout) as Aborted;
    expect(a.keptBecause[page]).toBe(
      'a file it listed changed after the abort was confirmed: src/app/vendor',
    );
    expect(readFileSync(join(nested, 'wip.ts'), 'utf8')).toContain('more work');
    expect(existsSync(join(nested, '.git'))).toBe(true);
    // As it is now, shown and confirmed again: it goes.
    const again = await cli(sb, ['split', 'abort'], { answers: ['y'] });
    expect(again.code).toBe(0);
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

  it('lists a nested repository in an ignored folder, whatever is next to it', async () => {
    const sb = await splitSandbox((s) =>
      write(s.repo, '.gitignore', 'tools/\nnode_modules/\nlib/\n'),
    );
    const page = partDir(sb, 'page');
    // Neither an empty CACHEDIR.TAG nor an installed-packages folder hides one.
    write(page, 'tools/CACHEDIR.TAG', '');
    for (const rel of [
      'tools/patched-dep',
      'node_modules/dep',
      'lib/python3.12/site-packages/pkg',
    ]) {
      write(page, `${rel}/fix.ts`, 'export const fix = 1;\n');
      git(join(page, rel), 'init', '-q', '-b', 'main');
      git(join(page, rel), 'add', '-A');
      git(join(page, rel), 'commit', '-q', '-m', 'local fix, never pushed');
    }
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'lib/python3.12/site-packages/pkg, node_modules/dep, tools/patched-dep',
    );
    expect(existsSync(join(page, 'tools/patched-dep/.git'))).toBe(true);
    // Listed, it can be confirmed.
    const confirmed = await cli(sb, ['split', 'abort', '--keep-branches'], { answers: ['y'] });
    expect(confirmed.code).toBe(0);
    expect(existsSync(page)).toBe(false);
  });

  it('lists a clean dependency checkout too, and a confirmation removes it', async () => {
    const upstream = tempDir('r10-dep-');
    git(upstream, 'init', '-q', '-b', 'main');
    write(upstream, 'mix.exs', 'x\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'dep');
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', '/deps\n/_build\n'));
    // What `mix deps.get` leaves for a git dependency: nothing local proves it can be fetched
    // again, so it is listed like any other repository; a script removes it with --discard.
    for (const key of ['api', 'page']) {
      git(sb.repo, 'clone', '-q', upstream, join(partDir(sb, key), 'deps/jason'));
    }
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('git repositories, with their commits and changes: deps/jason');
    const confirmed = await cli(sb, ['split', 'abort', '--keep-branches'], { answers: ['y'] });
    expect(confirmed.code).toBe(0);
    expect(existsSync(partDir(sb, 'page'))).toBe(false);
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

describe('split abort counts every nested repository, and all that deleting it destroys', () => {
  /** An upstream repository cloned into `<page>/vendor/lib` (ignored by the outer one). */
  function cloneVendor(page: string, prepare?: (up: string) => void): string {
    const up = tempDir('r10-up-');
    git(up, 'init', '-q', '-b', 'main');
    write(up, 'lib.ts', 'export const lib = 1;\n');
    prepare?.(up);
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'lib');
    git(page, 'clone', '-q', up, 'vendor/lib');
    return join(page, 'vendor/lib');
  }
  const ignoreVendor = (s: Sandbox): void => write(s.repo, '.gitignore', 'vendor/\n');

  async function refused(sb: Sandbox, lib: string): Promise<string> {
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(1);
    expect(existsSync(lib)).toBe(true);
    return r.stderr;
  }

  it('a commit only a local tag reaches', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'));
    write(lib, 'lib.ts', 'export const lib = 2;\n');
    git(lib, 'commit', '-q', '-am', 'patch');
    git(lib, 'tag', 'my-patch');
    expect(await refused(sb, lib)).toContain('vendor/lib');
  });

  it('a commit only a hand-made remote-tracking ref reaches', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'));
    write(lib, 'lib.ts', 'export const lib = 2;\n');
    git(lib, 'commit', '-q', '-am', 'patch');
    git(lib, 'update-ref', 'refs/remotes/origin/wip', 'HEAD');
    await refused(sb, lib);
  });

  it('an ignored .env in a clean, pushed nested repository', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'), (up) => write(up, '.gitignore', '.env\n'));
    write(lib, '.env', 'STRIPE_KEY=sk_live_only_copy\n');
    await refused(sb, lib);
    expect(existsSync(join(lib, '.env'))).toBe(true);
  });

  it("a nested repository's own ignored repository, shown under it", async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'), (up) => write(up, '.gitignore', 'deps/\n'));
    git(lib, 'init', '-q', '-b', 'main', 'deps/inner');
    write(lib, 'deps/inner/a.ts', 'export const a = 1;\n');
    git(join(lib, 'deps/inner'), 'add', '-A');
    git(join(lib, 'deps/inner'), 'commit', '-q', '-m', 'only copy');
    expect(await refused(sb, lib)).toContain('vendor/lib (holding vendor/lib/deps/inner)');
  });

  it('an edit to a skip-worktree file in a clean, pushed nested repository', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'));
    git(lib, 'update-index', '--skip-worktree', 'lib.ts');
    write(lib, 'lib.ts', 'export const lib = 42;\n');
    await refused(sb, lib);
  });

  it('an unpushed commit, with nothing else', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'));
    write(lib, 'lib.ts', 'export const lib = 2;\n');
    git(lib, 'commit', '-q', '-am', 'patch');
    await refused(sb, lib);
  });

  it('a linked worktree elsewhere, with a commit on its detached HEAD, shown', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'));
    const wt = join(tempDir('r10-wt-'), 'exp');
    git(lib, 'worktree', 'add', '-q', '--detach', wt);
    write(wt, 'lib.ts', 'export const lib = 3;\n');
    git(wt, 'commit', '-q', '-am', 'experiment');
    const commit = git(wt, 'rev-parse', 'HEAD').trim();
    expect(await refused(sb, lib)).toContain(
      `vendor/lib (its worktrees elsewhere stop working: ${wt})`,
    );
    expect(git(wt, 'cat-file', '-t', commit).trim()).toBe('commit');
  });

  /** A new nested repository, shown and confirmed; `change` runs once the abort is under way. */
  async function confirmedAbortWith(
    change: (repo: string) => void,
  ): Promise<{ code: number; repo: string }> {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    const repo = join(page, 'src/app/tool');
    git(page, 'init', '-q', '-b', 'main', 'src/app/tool');
    write(repo, '.gitignore', 'notes/\n');
    write(repo, 'main.ts', 'export const v = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'tool');
    write(repo, 'main.ts', 'export const v = 2;\n');
    utimesSync(join(repo, 'main.ts'), 1_700_000_000, 1_700_000_000);
    // The page branch is looked at by the listing, then by abort's own check: change it then.
    let looks = 0;
    hook.afterBranchLook = (branch) => {
      if (branch === 'mindly/billing/page' && ++looks === 2) change(repo);
    };
    let r: Awaited<ReturnType<typeof cli>>;
    try {
      r = await cli(sb, ['split', 'abort'], { answers: ['y'] });
    } finally {
      delete hook.afterBranchLook;
    }
    expect(looks).toBeGreaterThanOrEqual(2);
    return { code: r.code, repo };
  }

  it('an ignored file written in a confirmed nested repository after the yes', async () => {
    const { code, repo } = await confirmedAbortWith((r) => write(r, 'notes/design.md', 'new\n'));
    expect(code).toBe(1);
    expect(existsSync(join(repo, 'notes/design.md'))).toBe(true);
  });

  it('a same-size, same-time edit in a confirmed nested repository after the yes', async () => {
    const { code, repo } = await confirmedAbortWith((r) => {
      writeFileSync(join(r, 'main.ts'), 'export const v = 9;\n');
      utimesSync(join(r, 'main.ts'), 1_700_000_000, 1_700_000_000);
    });
    expect(code).toBe(1);
    expect(readFileSync(join(repo, 'main.ts'), 'utf8')).toBe('export const v = 9;\n');
  });
});
