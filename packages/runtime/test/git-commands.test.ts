// Single git commands, checked both ways: each runs in a scratch copy to see which covered files
// it really writes, then the pre-tool hook is asked. A command that writes a covered file is
// blocked when it names it, and warned about otherwise; one that writes none is let through, at
// most with a warning when it may change the whole tree.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GIT_ENV, file, guarded, pem, runInCopy } from './written.js';

const RULE = 'Certificates are issued by hand';
type Verdict = 'deny' | 'warn' | 'allow';

/** v1: pem k1. v2: pem k2. HEAD (main): a.ts changed. Tag STABLE = v1. */
const setUp = (prep = '') => {
  const g = guarded({ [RULE]: ['**/*.pem'] });
  file(g.dir, 'certs/server.pem', 'k1\n');
  file(g.dir, 'src/a.ts', 'x\n');
  g.git('add', '-A');
  g.git('commit', '-q', '-m', 'base');
  g.git('tag', 'v1');
  g.git('tag', 'STABLE');
  file(g.dir, 'certs/server.pem', 'k2\n');
  g.git('commit', '-qam', 'k2');
  g.git('tag', 'v2');
  file(g.dir, 'src/a.ts', 'y\n');
  g.git('commit', '-qam', 'a');
  if (prep) execFileSync('bash', ['-c', prep], { cwd: g.dir, env: GIT_ENV });
  return g;
};

const verdictOf = (r: { decision: string | null; context: string | null }): Verdict =>
  r.decision === 'deny' ? 'deny' : (r.context ?? '').includes(RULE) ? 'warn' : 'allow';

const OLD_BRANCH =
  'git checkout -q -b old v1 && echo b > src/b.ts && git add -A && git commit -qm b';
const LOCAL_PEM = 'echo local > certs/server.pem';
const BISECT =
  'echo b > src/b.ts && git add -A && git commit -qm b && echo c > src/c.ts && git add -A && git commit -qm c && echo k3 > certs/server.pem && git commit -qam k3';

const cases: {
  name: string;
  prep?: string;
  command: string;
  want: Verdict;
  /** What it writes there, when not the covered file; null when that depends on the copy. */
  writes?: string[] | null;
}[] = [
  // Flags that only change what is printed do not make a command look only.
  {
    name: 'merge --stat',
    prep: OLD_BRANCH,
    command: 'git merge --stat --no-edit main',
    want: 'warn',
  },
  {
    name: 'merge --summary',
    prep: OLD_BRANCH,
    command: 'git merge --summary --no-edit main',
    want: 'warn',
  },
  {
    name: 'pull --stat',
    prep: OLD_BRANCH,
    command: 'git pull --stat --no-rebase --no-edit . main',
    want: 'warn',
  },
  { name: 'rebase --stat', prep: OLD_BRANCH, command: 'git rebase --stat main', want: 'warn' },
  {
    name: 'apply --stat --apply',
    prep: 'git diff v2 v1 > p.diff',
    command: 'git apply --stat --apply p.diff',
    want: 'warn',
  },
  // Values of options are never paths, nor flags.
  { name: 'stash push -um', prep: LOCAL_PEM, command: 'git stash push -um wip', want: 'warn' },
  { name: 'stash push -km', prep: LOCAL_PEM, command: 'git stash push -km "wip"', want: 'warn' },
  { name: 'restore -sSTABLE', command: 'git restore -sSTABLE certs/server.pem', want: 'deny' },
  {
    name: 'restore --sou v1 (abbreviated)',
    command: 'git restore --sou v1 certs/server.pem',
    want: 'deny',
  },
  // Files a command writes its output to.
  { name: 'config -f', command: 'git config -f certs/server.pem a.b c', want: 'deny' },
  { name: 'archive -o', command: 'git archive -o certs/server.pem HEAD', want: 'deny' },
  {
    name: 'merge-file into the file it names',
    prep: 'git show v1:certs/server.pem > base.txt && git show v2:certs/server.pem > other.txt',
    command: 'git merge-file certs/server.pem base.txt other.txt',
    want: 'deny',
  },
  {
    name: 'checkout-index of a named file',
    prep: LOCAL_PEM,
    command: 'git checkout-index -f certs/server.pem',
    want: 'deny',
  },
  // Subcommands not known to only look may change the whole tree.
  { name: 'bisect start', prep: BISECT, command: 'git bisect start HEAD v2', want: 'warn' },
  {
    name: 'bisect good',
    prep: BISECT,
    command: 'git bisect start && git bisect bad && git bisect good v2',
    want: 'warn',
  },
  // (In a copy, git may leave files it sees as changed: what it writes there varies.)
  {
    name: 'sparse-checkout set',
    command: 'git sparse-checkout set src',
    want: 'warn',
    writes: null,
  },
  { name: 'checkout-index -a', prep: LOCAL_PEM, command: 'git checkout-index -f -a', want: 'warn' },
  { name: 'read-tree -u', command: 'git read-tree -u --reset v1', want: 'warn' },
  {
    name: 'worktree add',
    command: 'git worktree add wt v1',
    want: 'warn',
    writes: ['wt/certs/server.pem'],
  },
  {
    name: 'an alias',
    prep: 'git config alias.back "checkout v1 -- ."',
    command: 'git back',
    want: 'warn',
  },
  // Patch mode without a path works on the whole tree.
  { name: 'checkout -p', prep: LOCAL_PEM, command: 'yes | git checkout -p', want: 'warn' },
  { name: 'restore -p', prep: LOCAL_PEM, command: 'yes | git restore -p', want: 'warn' },
  // Case does not count with icase pathspecs.
  {
    name: ':(icase) with another case',
    prep: LOCAL_PEM,
    command: "git checkout -- ':(icase)CERTS/SERVER.PEM'",
    want: 'deny',
  },
  {
    name: '--icase-pathspecs with another case',
    prep: LOCAL_PEM,
    command: 'git --icase-pathspecs checkout -- CERTS/SERVER.PEM',
    want: 'deny',
  },
  // Global options that take a value do not shift the subcommand.
  {
    name: '--attr-source before the subcommand',
    command: 'git --attr-source HEAD restore -s v1 certs/server.pem',
    want: 'deny',
  },
];

/** Commands that write no covered file: never blocked. */
const quiet: { name: string; prep?: string; command: string; want: Verdict }[] = [
  { name: 'log', command: 'git log --stat -3', want: 'allow' },
  { name: 'diff', prep: LOCAL_PEM, command: 'git diff --stat', want: 'allow' },
  { name: 'show of a covered file', command: 'git show v1:certs/server.pem', want: 'allow' },
  { name: 'status', prep: LOCAL_PEM, command: 'git status --short', want: 'allow' },
  { name: 'grep', command: 'git grep k2', want: 'allow' },
  { name: 'blame', command: 'git blame certs/server.pem', want: 'allow' },
  { name: 'ls-files', command: 'git ls-files', want: 'allow' },
  { name: 'cat-file', command: 'git cat-file -p HEAD', want: 'allow' },
  { name: 'describe', command: 'git describe --tags', want: 'allow' },
  { name: 'config --get', command: 'git config --get user.name || true', want: 'allow' },
  { name: 'config --list', command: 'git config --list', want: 'allow' },
  { name: 'config -f of another file', command: 'git config -f tool.ini a.b c', want: 'allow' },
  { name: 'stash list', command: 'git stash list', want: 'allow' },
  { name: 'branch listing', command: 'git branch -a', want: 'allow' },
  { name: 'tag listing', command: 'git tag -l', want: 'allow' },
  { name: 'remote -v', command: 'git remote -v', want: 'allow' },
  { name: 'bisect log', prep: 'git bisect start', command: 'git bisect log', want: 'allow' },
  { name: 'add', prep: LOCAL_PEM, command: 'git add -A', want: 'allow' },
  { name: 'commit', prep: LOCAL_PEM, command: 'git commit -qam wip', want: 'allow' },
  {
    name: 'stash push of another path',
    prep: LOCAL_PEM,
    command: 'git stash push -m x -- src',
    want: 'allow',
  },
  { name: 'restore of another path', command: 'git restore -s v1 src/a.ts', want: 'allow' },
  {
    name: 'apply --check',
    prep: 'git diff v2 v1 > p.diff',
    command: 'git apply --check p.diff',
    want: 'allow',
  },
  {
    name: 'apply --stat',
    prep: 'git diff v2 v1 > p.diff',
    command: 'git apply --stat p.diff',
    want: 'allow',
  },
  { name: 'rm -n', command: 'git rm -n certs/server.pem', want: 'allow' },
  { name: 'clean -n', command: 'git clean -n', want: 'allow' },
  {
    name: 'diff --output of another file',
    command: 'git diff --output=out.diff v1',
    want: 'allow',
  },
  { name: 'checkout of a branch: a warning', command: 'git checkout -q v1', want: 'warn' },
];

describe('single git commands, checked against what they write', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const g = setUp(c.prep);
      try {
        const done = runInCopy(g.dir, c.command, pem);
        if (c.writes !== null) {
          expect(done.written, `what \`${c.command}\` writes; ${done.output}`).toEqual(
            c.writes ?? ['certs/server.pem'],
          );
        }
        const r = await g.shell(c.command);
        expect(verdictOf(r), `hook on \`${c.command}\`: ${r.reason ?? ''}`).toBe(c.want);
      } finally {
        g.mindly.close();
      }
    });
  }
  for (const c of quiet) {
    it(`never blocks: ${c.name}`, async () => {
      const g = setUp(c.prep);
      try {
        const done = runInCopy(g.dir, c.command, pem);
        if (c.want === 'allow') expect(done.written, c.command).toEqual([]);
        const r = await g.shell(c.command);
        expect(verdictOf(r), `hook on \`${c.command}\`: ${r.reason ?? ''}`).toBe(c.want);
      } finally {
        g.mindly.close();
      }
    });
  }

  it('reads paths in a working tree named apart, and says when it is another one', async () => {
    const g = setUp();
    try {
      const r = await g.shell(`git --work-tree=${g.dir} checkout -- certs/server.pem`);
      expect(r.decision).toBe('deny');
      const elsewhere = await g.shell('git --work-tree=/tmp/other checkout -- certs/server.pem');
      expect(elsewhere.decision).toBeNull();
      expect(elsewhere.context).toContain('another working tree');
    } finally {
      g.mindly.close();
    }
  });
});
