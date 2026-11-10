// Git commands and command lines, checked both ways: each runs in a scratch copy to see which
// covered files it really writes, then the pre-tool hook is asked about it.
//
// A single git command is judged exactly: git is asked what it writes. On a line where an earlier
// command may have changed what git would answer (a commit, a stash, a fetch, a switch, a script),
// a later git command blocks on the paths it names, and what it does to the whole tree is a
// possible write: a warning naming the rule, never a block, never silence.
import { describe, expect, it } from 'vitest';
import { file, guarded, pem, runInCopy } from './written.js';

type G = ReturnType<typeof guarded>;
type Verdict = 'deny' | 'warn' | 'allow';

const RULE = 'Certificates are issued by hand';

/** main: certs/server.pem (k1), src/a.ts. feature: a.ts changed. certs-change: the pem changed. */
const setUp = () => {
  const g = guarded({ [RULE]: ['**/*.pem'] });
  file(g.dir, 'certs/server.pem', 'k1\n');
  file(g.dir, 'src/a.ts', 'x\n');
  g.git('add', '-A');
  g.git('commit', '-q', '-m', 'base');
  g.git('checkout', '-q', '-b', 'feature');
  file(g.dir, 'src/a.ts', 'y\n');
  g.git('commit', '-qam', 'feature');
  g.git('checkout', '-q', 'main');
  g.git('checkout', '-q', '-b', 'certs-change');
  file(g.dir, 'certs/server.pem', 'k2\n');
  g.git('commit', '-qam', 'certs');
  g.git('checkout', '-q', 'main');
  return g;
};

const verdictOf = (r: { decision: string | null; context: string | null }): Verdict =>
  r.decision === 'deny' ? 'deny' : (r.context ?? '').includes(RULE) ? 'warn' : 'allow';

/** Runs the line in a copy (`ran` may differ, for a path that differs there), then asks. */
const check = async (g: G, command: string, writes: string[], want: Verdict, ran = command) => {
  const done = runInCopy(g.dir, ran, pem);
  expect(done.written, `what \`${ran}\` really writes; output: ${done.output}`).toEqual(writes);
  const r = await g.shell(command);
  expect(verdictOf(r), `hook on \`${command}\`: reason=${r.reason ?? ''}`).toBe(want);
};

/** Two stashes, one holding a pem change and one a README change; a clean working tree. */
const twoStashes = (g: G, pemOlder: boolean) => {
  const pemStash = () => {
    file(g.dir, 'certs/server.pem', 'stashed\n');
    g.git('stash', '-q');
  };
  const readmeStash = () => {
    file(g.dir, 'README.md', 'stashed readme\n');
    g.git('stash', '-q');
  };
  if (pemOlder) {
    pemStash();
    readmeStash();
  } else {
    readmeStash();
    pemStash();
  }
};

/** origin is the repository itself, fetched; `feature` exists only there. */
const remoteOnlyFeature = (g: G) => {
  g.git('remote', 'add', 'origin', g.dir);
  g.git('fetch', '-q', 'origin');
  g.git('branch', '-q', '-D', 'feature');
};

const cases: {
  name: string;
  prepare?: (g: G) => void;
  command: string;
  writes: string[];
  verdict: Verdict;
  ran?: (g: G) => string;
}[] = [
  // Single commands: exact.
  {
    name: 'a picked range counts only its own side',
    prepare: (g) => {
      file(g.dir, 'certs/server.pem', 'k-main\n');
      g.git('commit', '-qam', 'main pem');
      g.git('checkout', '-q', '-b', 'release', 'HEAD~1');
    },
    command: 'git cherry-pick main..feature',
    writes: [],
    verdict: 'allow',
  },
  {
    name: 'a symmetric pick takes both sides',
    prepare: (g) => {
      file(g.dir, 'certs/server.pem', 'k-main\n');
      g.git('commit', '-qam', 'main pem');
      g.git('checkout', '-q', '-b', 'release', 'HEAD~1');
    },
    command: 'git cherry-pick main...feature',
    writes: ['certs/server.pem'],
    verdict: 'deny',
  },
  {
    name: '`..B` picks from HEAD',
    prepare: (g) => {
      g.git('checkout', '-q', 'certs-change');
      file(g.dir, 'src/a.ts', 'after certs\n');
      g.git('commit', '-qam', 'after certs');
      g.git('checkout', '-q', 'main');
    },
    command: 'git cherry-pick ..certs-change',
    writes: ['certs/server.pem'],
    verdict: 'deny',
  },
  {
    name: 'a rebase onto an upstream the branch is on writes nothing',
    prepare: (g) => g.git('checkout', '-q', 'certs-change'),
    command: 'git rebase main',
    writes: [],
    verdict: 'allow',
  },
  {
    name: "a rebase replays the branch's own changes",
    prepare: (g) => {
      file(g.dir, 'src/a.ts', 'main moved\n');
      g.git('commit', '-qam', 'main moved');
      g.git('checkout', '-q', 'certs-change');
    },
    command: 'git rebase main',
    writes: ['certs/server.pem'],
    verdict: 'deny',
  },
  {
    name: 'a rebase of a named branch checks it out first',
    command: 'git rebase main certs-change',
    writes: ['certs/server.pem'],
    verdict: 'deny',
  },
  {
    name: 'a rebase onto an older commit drops what came after it',
    prepare: (g) => {
      g.git('checkout', '-q', 'certs-change');
      file(g.dir, 'src/a.ts', 'after certs\n');
      g.git('commit', '-qam', 'after certs');
    },
    command: 'git rebase --onto HEAD~2 HEAD~1',
    writes: ['certs/server.pem'],
    verdict: 'deny',
  },
  {
    name: 'a rebase without an upstream named goes to the upstream',
    prepare: (g) => g.git('branch', '-q', '--set-upstream-to=certs-change'),
    command: 'git rebase',
    writes: ['certs/server.pem'],
    verdict: 'deny',
  },
  {
    name: '`git merge -` merges the branch before',
    prepare: (g) => {
      g.git('checkout', '-q', 'certs-change');
      g.git('checkout', '-q', 'main');
    },
    command: 'git merge -',
    writes: ['certs/server.pem'],
    verdict: 'deny',
  },
  {
    name: 'a merge of a fetched branch that touches nothing covered',
    prepare: (g) => {
      g.git('remote', 'add', 'origin', g.dir);
      g.git('fetch', '-q', 'origin');
    },
    command: 'git merge --no-edit origin/feature',
    writes: [],
    verdict: 'allow',
  },
  {
    name: 'an amend alone writes nothing',
    prepare: (g) => file(g.dir, 'certs/server.pem', 'local\n'),
    command: 'git commit -qa --amend --no-edit',
    writes: [],
    verdict: 'allow',
  },
  // Lines: after a command that may change what git would answer, a warning.
  {
    name: 'a stash with nothing to save, then a pop',
    prepare: (g) => {
      file(g.dir, 'certs/server.pem', 'old-stash\n');
      g.git('stash', '-q');
    },
    command: 'git stash && git checkout feature && git stash pop',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a stash of a clean path, then a pop',
    prepare: (g) => {
      file(g.dir, 'certs/server.pem', 'old-stash\n');
      g.git('stash', '-q');
      file(g.dir, 'README.md', 'dirty\n');
    },
    command: 'git stash push -- src && git stash pop',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a pop of a deeper stash, then a pop',
    prepare: (g) => twoStashes(g, false),
    command: 'git stash pop stash@{1} && git stash pop',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a drop of a deeper stash, then a pop',
    prepare: (g) => twoStashes(g, false),
    command: 'git stash drop stash@{1} && git stash pop',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a stash branch, then a pop',
    prepare: (g) => twoStashes(g, true),
    command: 'git stash branch tmp && git stash pop',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a drop from a folder of the same repository, then a pop',
    prepare: (g) => twoStashes(g, true),
    command: 'git -C src stash drop && git stash pop',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a commit, then a merge',
    prepare: (g) => file(g.dir, 'src/a.ts', 'wip\n'),
    command: 'git add -A && git commit -qm wip && git merge certs-change',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a commit, then a switch back',
    prepare: (g) => {
      g.git('checkout', '-q', 'feature');
      g.git('checkout', '-q', 'main');
      file(g.dir, 'src/a.ts', 'wip\n');
    },
    command: 'git commit -qam wip && git switch -',
    writes: [],
    verdict: 'warn',
  },
  {
    name: 'an amend, then a switch',
    prepare: (g) => file(g.dir, 'certs/server.pem', 'local\n'),
    command: 'git commit -qa --amend --no-edit && git checkout feature',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'an add of some paths, a commit, a switch',
    prepare: (g) => {
      file(g.dir, 'src/a.ts', 'wip\n');
      file(g.dir, 'certs/dev.pem', 'untracked\n');
    },
    command: 'git add src && git commit -qm wip && git checkout feature',
    writes: [],
    verdict: 'warn',
  },
  {
    name: 'an add of tracked files, then a stash',
    prepare: (g) => {
      file(g.dir, 'src/a.ts', 'wip\n');
      file(g.dir, 'certs/dev.pem', 'untracked\n');
    },
    command: 'git add -u && git stash',
    writes: [],
    verdict: 'warn',
  },
  {
    name: 'a fetch into a local branch, then a checkout of it',
    prepare: (g) => {
      const o = `${g.dir}-origin`;
      g.git('clone', '-q', g.dir, o);
      g.git('-C', o, 'checkout', '-q', 'feature');
      file(o, 'certs/server.pem', 'k9\n');
      g.git('-C', o, 'commit', '-qam', 'origin pem');
      g.git('-C', o, 'checkout', '-q', 'main');
      g.git('remote', 'add', 'origin', o);
    },
    command: 'git fetch -q origin feature:feature && git checkout feature',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a fetch, then a checkout of a branch only the remote has',
    prepare: remoteOnlyFeature,
    command: 'git fetch -q && git checkout feature',
    writes: [],
    verdict: 'warn',
  },
  {
    name: 'a switch to a branch only the remote has, then a merge',
    prepare: remoteOnlyFeature,
    command: 'git switch feature && git merge --no-edit certs-change',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a switch, then a merge',
    command: 'git switch feature && git merge --no-edit certs-change',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
  {
    name: 'a new branch, a commit, back, a merge',
    prepare: (g) => file(g.dir, 'src/a.ts', 'fix\n'),
    command: 'git checkout -b fix && git commit -qam fix && git checkout main && git merge fix',
    writes: [],
    verdict: 'warn',
  },
  {
    name: 'a fetch, then a merge',
    prepare: (g) => {
      g.git('remote', 'add', 'origin', g.dir);
      g.git('fetch', '-q', 'origin');
    },
    command: 'git fetch -q origin && git merge --no-edit origin/feature',
    writes: [],
    verdict: 'warn',
  },
  {
    name: 'a fetch, then a rebase',
    prepare: (g) => {
      g.git('remote', 'add', 'origin', g.dir);
      g.git('fetch', '-q', 'origin');
    },
    command: 'git fetch -q origin && git rebase origin/feature',
    writes: [],
    verdict: 'warn',
  },
  {
    name: 'a one-word checkout, then a merge',
    prepare: (g) => {
      file(g.dir, 'certs/server.pem', 'k2\n');
      g.git('commit', '-qam', 'pem k2');
      g.git('checkout', '-q', '-b', 'x');
      file(g.dir, 'src/b.ts', 'b\n');
      g.git('add', '-A');
      g.git('commit', '-qm', 'x');
      g.git('checkout', '-q', 'main');
      file(g.dir, 'certs/server.pem', 'k1\n');
      g.git('commit', '-qam', 'pem back');
    },
    command: 'git checkout feature && git merge --no-edit x',
    writes: ['certs/server.pem'],
    verdict: 'warn',
  },
];

describe('git commands and lines, checked against what they write', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const g = setUp();
      try {
        c.prepare?.(g);
        await check(g, c.command, c.writes, c.verdict);
      } finally {
        g.mindly.close();
      }
    });
  }

  it('a drop through the absolute path of the same repository, then a pop', async () => {
    const g = setUp();
    try {
      twoStashes(g, true);
      // The copy lives elsewhere: `-C .` there is the same repository as `-C <dir>` here.
      await check(
        g,
        `git -C ${g.dir} stash drop && git stash pop`,
        ['certs/server.pem'],
        'warn',
        'git -C . stash drop && git stash pop',
      );
    } finally {
      g.mindly.close();
    }
  });

  it('paths named after such a command are still blocked', async () => {
    const g = setUp();
    try {
      file(g.dir, 'certs/server.pem', 'local\n');
      await check(
        g,
        'git commit -qam wip && git checkout HEAD~1 -- certs/server.pem',
        ['certs/server.pem'],
        'deny',
      );
    } finally {
      g.mindly.close();
    }
  });
});
