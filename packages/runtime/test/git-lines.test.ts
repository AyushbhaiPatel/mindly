// Git command lines whose later commands depend on what earlier ones did. Each test runs the line
// in a scratch copy to see which covered files it really writes, then asks the pre-tool hook.
import { describe, expect, it } from 'vitest';
import { file, guarded, pem, runInCopy } from './written.js';

type G = ReturnType<typeof guarded>;

/** main: certs/server.pem (k1), src/a.ts. feature: a.ts changed. certs-change: the pem changed. */
const setUp = () => {
  const g = guarded({ 'Certificates are issued by hand': ['**/*.pem'] });
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

const check = async (
  g: G,
  command: string,
  want: { writes: string[]; decision: 'deny' | null },
) => {
  const ran = runInCopy(g.dir, command, pem);
  expect(ran.written, `what \`${command}\` really writes`).toEqual(want.writes);
  const r = await g.shell(command);
  expect(
    r.decision,
    `hook on \`${command}\`: reason=${r.reason ?? ''} warns=${(r.context ?? '').includes('Certificates')}`,
  ).toBe(want.decision);
};

describe('git command lines, checked against what they write', () => {
  it('a stash with nothing to save, then a pop, takes an older stash', async () => {
    const g = setUp();
    try {
      // An older stash holds a pem change; the working tree is clean now.
      file(g.dir, 'certs/server.pem', 'old-stash\n');
      g.git('stash', '-q');
      await check(g, 'git stash && git checkout feature && git stash pop', {
        writes: ['certs/server.pem'],
        decision: 'deny',
      });
    } finally {
      g.mindly.close();
    }
  });

  it('a stash of a clean path, then a pop, takes an older stash', async () => {
    const g = setUp();
    try {
      file(g.dir, 'certs/server.pem', 'old-stash\n');
      g.git('stash', '-q');
      file(g.dir, 'README.md', 'dirty\n');
      await check(g, 'git stash push -- src && git stash pop', {
        writes: ['certs/server.pem'],
        decision: 'deny',
      });
    } finally {
      g.mindly.close();
    }
  });

  it('a commit does not move where a later merge starts from', async () => {
    const g = setUp();
    try {
      file(g.dir, 'src/a.ts', 'wip\n');
      await check(g, 'git add -A && git commit -qm wip && git merge certs-change', {
        writes: ['certs/server.pem'],
        decision: 'deny',
      });
    } finally {
      g.mindly.close();
    }
  });

  it('a commit does not move the branch before (`git switch -`)', async () => {
    const g = setUp();
    try {
      g.git('checkout', '-q', 'feature');
      g.git('checkout', '-q', 'main');
      file(g.dir, 'src/a.ts', 'wip\n');
      await check(g, 'git commit -qam wip && git switch -', { writes: [], decision: null });
    } finally {
      g.mindly.close();
    }
  });

  it('an add of some paths takes only their untracked files', async () => {
    const g = setUp();
    try {
      file(g.dir, 'src/a.ts', 'wip\n');
      file(g.dir, 'certs/dev.pem', 'local dev cert, untracked\n');
      await check(g, 'git add src && git commit -qm wip && git checkout feature', {
        writes: [],
        decision: null,
      });
    } finally {
      g.mindly.close();
    }
  });

  it('`git add -u` takes no untracked file', async () => {
    const g = setUp();
    try {
      file(g.dir, 'src/a.ts', 'wip\n');
      file(g.dir, 'certs/dev.pem', 'local dev cert, untracked\n');
      await check(g, 'git add -u && git stash', { writes: [], decision: null });
    } finally {
      g.mindly.close();
    }
  });

  it('a fetch into a local branch moves it', async () => {
    const g = setUp();
    try {
      // origin's feature branch now changes the pem.
      const o = `${g.dir}-origin`;
      g.git('clone', '-q', g.dir, o);
      const og = (...a: string[]) => g.git('-C', o, ...a);
      og('checkout', '-q', 'feature');
      file(o, 'certs/server.pem', 'k9\n');
      og('commit', '-qam', 'origin pem');
      og('checkout', '-q', 'main');
      g.git('remote', 'add', 'origin', o);
      await check(g, 'git fetch -q origin feature:feature && git checkout feature', {
        writes: ['certs/server.pem'],
        decision: 'deny',
      });
    } finally {
      g.mindly.close();
    }
  });

  it('a picked range counts only its own side', async () => {
    const g = setUp();
    try {
      // main changes the pem after feature forked; release is cut before that.
      file(g.dir, 'certs/server.pem', 'k-main\n');
      g.git('commit', '-qam', 'main pem');
      g.git('checkout', '-q', '-b', 'release', 'HEAD~1');
      await check(g, 'git cherry-pick main..feature', { writes: [], decision: null });
    } finally {
      g.mindly.close();
    }
  });

  it('a rebase onto an upstream the branch is on writes nothing', async () => {
    const g = setUp();
    try {
      g.git('checkout', '-q', 'certs-change');
      await check(g, 'git rebase main', { writes: [], decision: null });
    } finally {
      g.mindly.close();
    }
  });

  it('a merge after a switch is asked from where the switch went', async () => {
    const g = setUp();
    try {
      await check(g, 'git switch feature && git merge --no-edit certs-change', {
        writes: ['certs/server.pem'],
        decision: 'deny',
      });
    } finally {
      g.mindly.close();
    }
  });

  it('a rebase without an upstream named goes to the upstream', async () => {
    const g = setUp();
    try {
      g.git('branch', '-q', '--set-upstream-to=certs-change');
      expect((await g.shell('git merge')).decision, 'git merge').toBe('deny');
      await check(g, 'git rebase', { writes: ['certs/server.pem'], decision: 'deny' });
    } finally {
      g.mindly.close();
    }
  });

  it('a branch only a remote has, after a fetch, is a warning at most', async () => {
    const g = setUp();
    try {
      g.git('remote', 'add', 'origin', g.dir);
      g.git('fetch', '-q', 'origin');
      g.git('branch', '-q', '-D', 'feature');
      // feature differs from main only in src/a.ts.
      await check(g, 'git fetch -q && git checkout feature', { writes: [], decision: null });
    } finally {
      g.mindly.close();
    }
  });

  it('`git merge -` merges the branch before', async () => {
    const g = setUp();
    try {
      g.git('checkout', '-q', 'certs-change');
      g.git('checkout', '-q', 'main');
      expect((await g.shell('git merge @{-1}')).decision, '@{-1}').toBe('deny');
      await check(g, 'git merge -', { writes: ['certs/server.pem'], decision: 'deny' });
    } finally {
      g.mindly.close();
    }
  });
});
