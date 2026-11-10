// Git command lines checked both ways, for asking git what a git command writes: each runs in a
// scratch copy to see which covered files it really writes, then the pre-tool hook is asked.
//
// The cases marked `known` are still read wrongly and are expected to fail (`it.fails`); each
// one is work left on this branch:
// - rebase: the upstream's fork point (a bare rebase onto a rewound upstream), `--root <branch>`,
//   `--keep-base`, and the flags that imply `--force-rebase` (`--committer-date-is-author-date`,
//   `--reset-author-date`, `--signoff`, a clustered `-qf`), `--gpg-sign` taking no value;
// - refs moved by commands read as looking: `branch --set-upstream-to`, `tag -a`,
//   `remote add -f`, and the read-only `branch --contains` / `tag --points-at` / `push` that
//   should not stop a later command from being asked;
// - what git itself is changed into on the line: an exported `GIT_DIR`, `.git` written
//   in place, `.gitignore` rewritten.
import { describe, expect, it } from 'vitest';
import { file, guarded, pem, runInCopy } from './written.js';

type G = ReturnType<typeof guarded>;
type Verdict = 'deny' | 'warn' | 'allow';
const RULE = 'Certificates are issued by hand';

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

const cases: {
  name: string;
  prepare?: (g: G) => void;
  command: (g: G) => string;
  writes: string[];
  want: Verdict | Verdict[];
  known?: boolean;
}[] = [
  {
    name: 'branch --set-upstream-to= then a bare rebase',
    known: true,
    command: () => 'git branch --set-upstream-to=certs-change && git rebase',
    writes: ['certs/server.pem'],
    want: ['deny', 'warn'],
  },
  {
    name: 'branch --set-upstream-to= then a bare merge',
    known: true,
    command: () => 'git branch --set-upstream-to=certs-change && git merge',
    writes: ['certs/server.pem'],
    want: ['deny', 'warn'],
  },
  {
    name: 'annotated tag then checkout of it',
    known: true,
    command: () => 'git tag -a v1 -m release certs-change && git checkout -q v1',
    writes: ['certs/server.pem'],
    want: ['deny', 'warn'],
  },
  {
    name: 'remote add -f then merge of the fetched branch',
    known: true,
    command: (g) =>
      `git remote add -f other ${g.dir} >/dev/null && git merge -q --no-edit other/certs-change`,
    writes: ['certs/server.pem'],
    want: ['deny', 'warn'],
  },
  {
    name: 'rebase --root <branch> on that branch',
    known: true,
    command: () => 'git rebase -q --root main',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'rebase --keep-base writes nothing',
    known: true,
    prepare: (g) => {
      file(g.dir, 'certs/server.pem', 'k-main\n');
      g.git('commit', '-qam', 'main pem');
      g.git('checkout', '-q', 'feature');
    },
    command: () => 'git rebase -q --keep-base main',
    writes: [],
    want: 'allow',
  },
  {
    name: 'GIT_EDITOR=true merge touching no pem',
    command: () => 'GIT_EDITOR=true git merge -q feature',
    writes: [],
    want: 'allow',
  },
  {
    name: 'rebase -x writing a pem',
    prepare: (g) => g.git('checkout', '-q', 'feature'),
    command: () => "git rebase -q -x 'echo z > certs/server.pem' HEAD~1",
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'git diff --output into a pem',
    prepare: (g) => file(g.dir, 'src/a.ts', 'dirty\n'),
    command: () => 'git diff --output=certs/server.pem',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    // A second `cd` makes the line one not read fully: git is asked nothing about it.
    name: 'HEAD written from inside .git, then reset --hard',
    command: () =>
      "cd .git && echo 'ref: refs/heads/certs-change' > HEAD && cd .. && git reset -q --hard",
    writes: ['certs/server.pem'],
    want: ['deny', 'warn'],
  },
  {
    name: '.gitignore emptied, then stash -u',
    known: true,
    prepare: (g) => {
      file(g.dir, '.gitignore', 'certs/dev.pem\n');
      g.git('add', '.gitignore');
      g.git('commit', '-qm', 'ignore');
      file(g.dir, 'certs/dev.pem', 'dev\n');
    },
    command: () => ': > .gitignore && git stash -q -u',
    writes: ['certs/dev.pem'],
    want: ['deny', 'warn'],
  },
  {
    name: 'export GIT_DIR then checkout -- .',
    prepare: (g) => {
      g.git('clone', '-q', '-b', 'certs-change', g.dir, `${g.dir}-clone`);
    },
    command: (g) => `export GIT_DIR=${g.dir}-clone/.git && git checkout -- .`,
    writes: ['certs/server.pem'],
    want: ['deny', 'warn'],
  },
  {
    name: 'read-only branch --contains, then checkout (should still deny)',
    known: true,
    command: () => 'git branch --contains HEAD && git checkout -q certs-change',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'read-only tag --points-at, then checkout',
    known: true,
    command: () => 'git tag --points-at HEAD && git checkout -q certs-change',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'push then checkout',
    known: true,
    prepare: (g) => {
      g.git('init', '-q', '--bare', `${g.dir}-bare`);
      g.git('remote', 'add', 'origin', `${g.dir}-bare`);
    },
    command: () => 'git push -q origin main && git checkout -q certs-change',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'cherry-pick ^A B picks the whole range',
    prepare: (g) => {
      g.git('checkout', '-q', 'certs-change');
      file(g.dir, 'src/a.ts', 'after certs\n');
      g.git('commit', '-qam', 'after certs');
      g.git('checkout', '-q', 'feature');
    },
    command: () => 'git cherry-pick ^main certs-change',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'rebase --gpg-sign <upstream> (fast-forward, no signing)',
    known: true,
    command: () => 'git rebase -q --gpg-sign certs-change',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'merge --gpg-sign <branch> (fast-forward, no signing)',
    known: true,
    command: () => 'git merge -q --gpg-sign certs-change',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'bare rebase with a rewound upstream (fork point)',
    known: true,
    prepare: (g) => {
      g.git('branch', '-q', 'up');
      g.git('checkout', '-q', 'up');
      file(g.dir, 'certs/server.pem', 'k-up\n');
      g.git('commit', '-qam', 'up pem');
      g.git('checkout', '-q', 'main');
      g.git('merge', '-q', '--ff-only', 'up');
      g.git('branch', '-q', '-f', 'up', 'up~1');
      g.git('branch', '-q', '--set-upstream-to=up');
    },
    command: () => 'git rebase -q',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'cp -r a clone .git over ours, then reset --hard',
    prepare: (g) => {
      g.git('clone', '-q', '-b', 'certs-change', g.dir, `${g.dir}-clone2`);
    },
    command: (g) => `rm -rf .git && cp -r ${g.dir}-clone2/.git .git && git reset -q --hard`,
    writes: ['certs/server.pem'],
    want: ['deny', 'warn'],
  },
  {
    name: 'rebase --committer-date-is-author-date (implies --force-rebase) on an up-to-date branch',
    known: true,
    prepare: (g) => g.git('checkout', '-q', 'certs-change'),
    command: () => 'git rebase -q --committer-date-is-author-date main',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'rebase --reset-author-date on an up-to-date branch',
    known: true,
    prepare: (g) => g.git('checkout', '-q', 'certs-change'),
    command: () => 'git rebase -q --reset-author-date main',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'rebase -qf (clustered force) on an up-to-date branch',
    known: true,
    prepare: (g) => g.git('checkout', '-q', 'certs-change'),
    command: () => 'git rebase -qf main',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'rebase --signoff on an up-to-date branch',
    known: true,
    prepare: (g) => g.git('checkout', '-q', 'certs-change'),
    command: () => 'git rebase -q --signoff main',
    writes: ['certs/server.pem'],
    want: 'deny',
  },
  {
    name: 'tag -a -m (annotate) read as a listing; switch after it should deny',
    command: () => 'git tag -a v1 -m rel && git checkout -q certs-change',
    writes: ['certs/server.pem'],
    want: ['deny', 'warn'],
  },
];

describe('git commands and lines, asked of git', () => {
  for (const c of cases) {
    (c.known ? it.fails : it)(c.name, async () => {
      const g = setUp();
      try {
        c.prepare?.(g);
        const command = c.command(g);
        const done = runInCopy(g.dir, command, pem);
        expect(done.written, `what \`${command}\` writes; output: ${done.output}`).toEqual(
          c.writes,
        );
        const r = await g.shell(command);
        const v = verdictOf(r);
        const want = Array.isArray(c.want) ? c.want : [c.want];
        expect(want, `hook on \`${command}\` said ${v}: reason=${r.reason ?? ''}`).toContain(v);
      } finally {
        g.mindly.close();
      }
    });
  }
});
