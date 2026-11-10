/*
 * `mindly split abort` against real git: what it must never delete without `--yes --discard`,
 * and what must not stop it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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

describe('split abort moves nested repositories out whole, and never deletes one', () => {
  /** Where the abort keeps `path` of a part's worktree: `.git/mindly/kept/<split id>/<part>/`. */
  function keptAt(sb: Sandbox, key: string, path: string): string {
    const kept = join(sb.repo, '.git', 'mindly', 'kept');
    const [id] = readdirSync(kept);
    return join(kept, id as string, key, path);
  }

  /** `mindly split abort` with `args`; `during` runs once the abort is under way. */
  async function abortWith(
    sb: Sandbox,
    args: string[],
    during?: () => void,
    look = 2,
  ): Promise<Awaited<ReturnType<typeof cli>>> {
    let looks = 0;
    hook.afterBranchLook = (branch) => {
      if (branch === 'mindly/billing/page' && ++looks === look) during?.();
    };
    try {
      const r = await cli(
        sb,
        ['split', 'abort', ...args],
        args.includes('--yes') ? {} : { answers: ['y'] },
      );
      expect(looks).toBeGreaterThanOrEqual(look);
      return r;
    } finally {
      delete hook.afterBranchLook;
    }
  }

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

  /** A repository at `<dir>` with one commit of `files`. */
  function repoAt(dir: string, files: Record<string, string> = { 'a.ts': 'a\n' }): void {
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'only copy');
  }

  it('a submodule with uncommitted edits', async () => {
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
    write(page, 'src/app/vendor/new.ts', 'export const fresh = 1;\n');
    const r = await cli(sb, ['split', 'abort', '--yes', '--keep-branches']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('src/app/vendor ->');
    expect(r.stdout).toContain('To bring one back, move its folder');
    const kept = keptAt(sb, 'page', 'src/app/vendor');
    expect(readFileSync(join(kept, 'lib.ts'), 'utf8')).toContain('hours of work');
    expect(git(kept, 'status', '--porcelain')).toBe(' M lib.ts\n?? new.ts\n');
    expect(existsSync(page)).toBe(false);
  });

  it('a repository committed into the part, with no .gitmodules, and work in it', async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    const nested = join(page, 'src/app/vendor');
    repoAt(nested, { 'lib.ts': 'export const lib = 1;\n' });
    git(page, 'add', 'src/app/vendor');
    git(page, 'commit', '-q', '-m', 'add vendor');
    write(nested, 'wip.ts', 'export const wip = 1;\n');
    expect((await cli(sb, ['split', 'abort', '--yes', '--keep-branches'])).code).toBe(0);
    expect(readFileSync(join(keptAt(sb, 'page', 'src/app/vendor'), 'wip.ts'), 'utf8')).toBe(
      'export const wip = 1;\n',
    );
  });

  it('a repository made in a folder the part tracks, with a commit only it has', async () => {
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
    // git looks past it: the part looks clean.
    expect(git(page, 'status', '--porcelain')).toBe('');
    expect((await cli(sb, ['split', 'abort', '--yes', '--keep-branches'])).code).toBe(0);
    const kept = keptAt(sb, 'page', 'src/app');
    expect(git(kept, 'log', '--format=%s', 'experiment').split('\n')[0]).toBe('experiment');
    expect(existsSync(page)).toBe(false);
  });

  it('repositories in ignored folders, wherever they are, and one inside another', async () => {
    const sb = await splitSandbox((s) =>
      write(s.repo, '.gitignore', 'tools/\nnode_modules/\nlib/\n'),
    );
    const page = partDir(sb, 'page');
    write(page, 'tools/CACHEDIR.TAG', '');
    for (const rel of [
      'tools/patched-dep',
      'node_modules/dep',
      'lib/python3.12/site-packages/pkg',
    ]) {
      repoAt(join(page, rel));
    }
    repoAt(join(page, 'tools/patched-dep/deps/inner'));
    expect((await cli(sb, ['split', 'abort', '--yes', '--keep-branches'])).code).toBe(0);
    for (const rel of [
      'tools/patched-dep',
      'node_modules/dep',
      'lib/python3.12/site-packages/pkg',
    ]) {
      expect(git(keptAt(sb, 'page', rel), 'log', '--format=%s')).toBe('only copy\n');
    }
    expect(git(keptAt(sb, 'page', 'tools/patched-dep/deps/inner'), 'log', '--format=%s')).toBe(
      'only copy\n',
    );
  });

  it('a clean dependency checkout is moved too, and --discard deletes it', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', '/deps\n'));
    const upstream = tempDir('r10-dep-');
    repoAt(upstream, { 'mix.exs': 'x\n' });
    git(sb.repo, 'clone', '-q', upstream, join(partDir(sb, 'page'), 'deps/jason'));
    const r = await cli(sb, ['split', 'abort', '--yes', '--discard']);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.repo, '.git', 'mindly', 'kept'))).toBe(false);
    expect(existsSync(partDir(sb, 'page'))).toBe(false);
  });

  it('what no local check can prove is elsewhere: a local tag, a hand-made remote ref, an ignored .env, a skip-worktree edit', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'), (up) => write(up, '.gitignore', '.env\n'));
    write(lib, 'lib.ts', 'export const lib = 2;\n');
    git(lib, 'commit', '-q', '-am', 'patch');
    git(lib, 'tag', 'my-patch');
    git(lib, 'update-ref', 'refs/remotes/origin/wip', 'HEAD');
    write(lib, '.env', 'STRIPE_KEY=sk_live_only_copy\n');
    git(lib, 'update-index', '--skip-worktree', 'lib.ts');
    write(lib, 'lib.ts', 'export const lib = 42;\n');
    expect((await cli(sb, ['split', 'abort', '--yes', '--keep-branches'])).code).toBe(0);
    const kept = keptAt(sb, 'page', 'vendor/lib');
    expect(git(kept, 'tag')).toBe('my-patch\n');
    expect(git(kept, 'rev-parse', 'origin/wip').trim()).toBe(
      git(kept, 'rev-parse', 'my-patch').trim(),
    );
    expect(readFileSync(join(kept, '.env'), 'utf8')).toContain('sk_live_only_copy');
    expect(readFileSync(join(kept, 'lib.ts'), 'utf8')).toBe('export const lib = 42;\n');
  });

  it('a linked worktree elsewhere keeps working, with its detached commit', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const lib = cloneVendor(partDir(sb, 'page'));
    const wt = join(tempDir('r10-wt-'), 'exp');
    git(lib, 'worktree', 'add', '-q', '--detach', wt);
    write(wt, 'lib.ts', 'export const lib = 3;\n');
    git(wt, 'commit', '-q', '-am', 'experiment');
    const commit = git(wt, 'rev-parse', 'HEAD').trim();
    expect((await cli(sb, ['split', 'abort', '--yes', '--keep-branches'])).code).toBe(0);
    expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(commit);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  /** A repository at `<page>/vendor/lib` with a submodule at `deps/sub`. */
  function vendorWithSubmodule(page: string): string {
    const sub = tempDir('r10-sub-');
    repoAt(sub, { 'x.ts': 'x\n' });
    const lib = join(page, 'vendor/lib');
    repoAt(lib, { 'lib.ts': 'export const lib = 1;\n', '.gitignore': 'notes/\n' });
    git(lib, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'deps/sub');
    git(lib, 'commit', '-q', '-m', 'sub');
    return lib;
  }

  it('work done in a nested repository after the yes, in all its forms', async () => {
    const sb = await splitSandbox(ignoreVendor);
    const page = partDir(sb, 'page');
    const lib = vendorWithSubmodule(page);
    write(lib, 'main.ts', 'export const v = 2;\n');
    const r = await abortWith(sb, [], () => {
      // In its submodule: an edit and a stash; a hook; an ignored file; a same-size edit.
      write(lib, 'deps/sub/notes.md', 'a day of design notes\n');
      write(lib, 'deps/sub/x.ts', 'stashed work\n');
      git(join(lib, 'deps/sub'), 'stash', '-q', '--', 'x.ts');
      write(lib, '.git/hooks/pre-push', '#!/bin/sh\n# release checks\n');
      write(lib, 'notes/design.md', 'new\n');
      writeFileSync(join(lib, 'main.ts'), 'export const v = 9;\n');
    });
    expect(r.code).toBe(0);
    const kept = keptAt(sb, 'page', 'vendor/lib');
    expect(readFileSync(join(kept, 'deps/sub/notes.md'), 'utf8')).toBe('a day of design notes\n');
    expect(git(join(kept, 'deps/sub'), 'stash', 'list')).not.toBe('');
    expect(existsSync(join(kept, '.git/hooks/pre-push'))).toBe(true);
    expect(readFileSync(join(kept, 'notes/design.md'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(kept, 'main.ts'), 'utf8')).toBe('export const v = 9;\n');
  });

  it('a repository made after the yes is moved too', async () => {
    const sb = await splitSandbox();
    const page = partDir(sb, 'page');
    write(page, 'src/app/billing.ts', 'export const billing = 1;\n');
    const r = await abortWith(sb, [], () => repoAt(join(page, 'src/app/late')), 3);
    expect(r.code).toBe(0);
    expect(git(keptAt(sb, 'page', 'src/app/late'), 'log', '--format=%s')).toBe('only copy\n');
  });

  it('takes about as long as before with dependency checkouts full of files', async () => {
    const sb = await splitSandbox((s) => write(s.repo, '.gitignore', 'deps/\n'));
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
    let t = Date.now();
    expect((await cli(sb, ['split', 'status'])).code).toBe(0);
    const status = Date.now() - t;
    t = Date.now();
    expect((await cli(sb, ['split', 'abort', '--keep-branches'], { answers: ['y'] })).code).toBe(0);
    const abort = Date.now() - t;
    // Nothing in them is read: no more than a few git listings of their folders.
    expect(status).toBeLessThan(2_000);
    expect(abort).toBeLessThan(5_000);
  }, 300_000);
});
