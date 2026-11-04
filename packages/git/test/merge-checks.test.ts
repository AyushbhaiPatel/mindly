import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMindlyError } from '@mindly/core';
import {
  captureWorktreeCommit,
  listWorktrees,
  materializeTree,
  parseMergeTreeOutput,
  runChecks,
  shadowMerge,
} from '../src/index.js';
import { git, makeRepo, tempDir, write } from './helpers.js';

/** Repo with two agent worktrees branching from main. */
function setup(): { root: string; a: string; b: string } {
  const root = makeRepo({
    'src/shared.ts': 'export const x = 1;\nexport const y = 2;\n',
    'README.md': 'base\n',
  });
  const dir = tempDir();
  const a = join(dir, 'agent-a');
  const b = join(dir, 'agent-b');
  git(root, 'worktree', 'add', '-q', '-b', 'agent-a', a);
  git(root, 'worktree', 'add', '-q', '-b', 'agent-b', b);
  return { root, a, b };
}

describe('shadowMerge', () => {
  it('merges non-overlapping work cleanly without touching branches', async () => {
    const { root, a, b } = setup();
    write(a, 'src/a.ts', 'export const a = 1;\n');
    write(b, 'src/b.ts', 'export const b = 1;\n');
    write(b, 'README.md', 'base\nmore from b\n');
    const refsBefore = git(root, 'for-each-ref');
    const ca = await captureWorktreeCommit(a);
    const cb = await captureWorktreeCommit(b);
    const result = await shadowMerge({
      repoRoot: root,
      sides: [
        { label: 'agent-a', commit: ca.commit },
        { label: 'agent-b', commit: cb.commit },
      ],
    });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.clean).toBe(true);
    expect(result.merged).toEqual(['agent-a', 'agent-b']);
    expect(result.steps).toEqual([
      expect.objectContaining({ label: 'agent-b', status: 'clean', conflicts: [] }),
    ]);
    const files = git(root, 'ls-tree', '-r', '--name-only', result.tree).trim().split('\n');
    expect(files.sort()).toEqual(['README.md', 'src/a.ts', 'src/b.ts', 'src/shared.ts']);
    expect(git(root, 'rev-parse', `${result.commit}^{tree}`).trim()).toBe(result.tree);
    expect(git(root, 'for-each-ref')).toBe(refsBefore);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('reports conflicts per step and leaves conflicting sides out of the final tree', async () => {
    const { root, a, b } = setup();
    const dir = tempDir();
    const c = join(dir, 'agent-c');
    git(root, 'worktree', 'add', '-q', '-b', 'agent-c', c);
    write(a, 'src/shared.ts', 'export const x = 100;\nexport const y = 2;\n');
    write(b, 'src/shared.ts', 'export const x = 200;\nexport const y = 2;\n');
    write(c, 'src/c.ts', 'export const c = 3;\n');
    const sides = await Promise.all(
      [
        ['agent-a', a],
        ['agent-b', b],
        ['agent-c', c],
      ].map(async ([label, wt]) => ({
        label: label as string,
        commit: (await captureWorktreeCommit(wt as string)).commit,
      })),
    );
    const result = await shadowMerge({ repoRoot: root, sides });
    if (!result.supported) throw new Error('git too old for this test');
    expect(result.clean).toBe(false);
    expect(result.steps.map((s) => [s.label, s.status])).toEqual([
      ['agent-b', 'conflicted'],
      ['agent-c', 'clean'],
    ]);
    expect(result.steps[0]?.conflicts).toEqual(['src/shared.ts']);
    expect(result.skipped).toEqual(['agent-b']);
    expect(result.merged).toEqual(['agent-a', 'agent-c']);
    expect(git(root, 'show', `${result.tree}:src/shared.ts`)).toContain('100');
    expect(git(root, 'show', `${result.tree}:src/c.ts`)).toContain('c = 3');
  });

  it('supports an explicit merge base and validates input', async () => {
    const { root, a, b } = setup();
    const base = git(root, 'rev-parse', 'HEAD').trim();
    write(a, 'one.txt', '1\n');
    write(b, 'two.txt', '2\n');
    const result = await shadowMerge({
      repoRoot: root,
      base,
      sides: [
        { label: 'a', commit: (await captureWorktreeCommit(a)).commit },
        { label: 'b', commit: (await captureWorktreeCommit(b)).commit },
      ],
    });
    expect(result.supported && result.clean).toBe(true);
    await expect(shadowMerge({ repoRoot: root, sides: [] })).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'invalid_input'),
    );
    await expect(
      shadowMerge({ repoRoot: root, sides: [{ label: 'x', commit: '--output=/tmp/x' }] }),
    ).rejects.toSatisfy((e: unknown) => isMindlyError(e, 'invalid_input'));
    await expect(
      shadowMerge({ repoRoot: root, sides: [{ label: 'x', commit: 'no-such-ref' }] }),
    ).rejects.toSatisfy((e: unknown) => isMindlyError(e, 'not_found'));
  });

  it('parses merge-tree output', () => {
    expect(parseMergeTreeOutput('abc\0a.ts\0b.ts\0a.ts\0\0info\0')).toEqual({
      tree: 'abc',
      conflicts: ['a.ts', 'b.ts'],
    });
    expect(parseMergeTreeOutput('abc\0')).toEqual({ tree: 'abc', conflicts: [] });
  });
});

describe('materializeTree', () => {
  it('checks out a tree into a temporary detached worktree and disposes it fully', async () => {
    const { root, a } = setup();
    write(a, 'src/a.ts', 'export const a = 1;\n');
    const captured = await captureWorktreeCommit(a);
    const before = (await listWorktrees(root)).length;
    const branchesBefore = git(root, 'branch', '--list');

    const mat = await materializeTree(root, captured.tree);
    expect(readFileSync(join(mat.path, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect((await listWorktrees(root)).length).toBe(before + 1);
    expect(git(mat.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD');
    expect(git(root, 'branch', '--list')).toBe(branchesBefore);

    await mat.dispose();
    await mat.dispose();
    expect(existsSync(mat.path)).toBe(false);
    expect((await listWorktrees(root)).length).toBe(before);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(mat.path);
  });

  it('accepts a commit and rejects unknown objects', async () => {
    const root = makeRepo({ 'a.txt': 'a\n' });
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const mat = await materializeTree(root, head);
    expect(mat.commit).toBe(head);
    await mat.dispose();
    await expect(materializeTree(root, 'deadbeef')).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'not_found'),
    );
  });
});

describe('runChecks', () => {
  const node = process.execPath;

  it('reports pass, fail, timeout and error with output tails', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'marker.txt'), 'here');
    const results = await runChecks(
      dir,
      [
        {
          name: 'pass',
          argv: [
            node,
            '-e',
            'console.log(require("fs").readFileSync("marker.txt","utf8"), process.env.CI)',
          ],
          timeoutSec: 20,
        },
        {
          name: 'fail',
          argv: [node, '-e', 'console.error("boom"); process.exit(3)'],
          timeoutSec: 20,
        },
        { name: 'slow', argv: [node, '-e', 'setTimeout(() => {}, 60000)'], timeoutSec: 0.5 },
        { name: 'missing', argv: ['/definitely/not/a/program'], timeoutSec: 5 },
      ],
      { killGraceMs: 200 },
    );
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['pass', 'pass'],
      ['fail', 'fail'],
      ['slow', 'timeout'],
      ['missing', 'error'],
    ]);
    expect(results[0]?.output).toContain('here 1');
    expect(results[1]?.exitCode).toBe(3);
    expect(results[1]?.output).toContain('boom');
    expect(results[2]?.durationMs).toBeLessThan(10_000);
  });

  it('caps captured output to the tail and does not leak the parent environment', async () => {
    const dir = tempDir();
    process.env['MINDLY_TEST_SECRET'] = 'leak-me';
    try {
      const [big, env] = await runChecks(
        dir,
        [
          {
            name: 'big',
            argv: [node, '-e', 'process.stdout.write("x".repeat(100000) + "END")'],
            timeoutSec: 20,
          },
          {
            name: 'env',
            argv: [node, '-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'],
            timeoutSec: 20,
          },
        ],
        { maxOutputBytes: 1024 },
      );
      expect(big?.output.length).toBeLessThanOrEqual(1024);
      expect(big?.output.endsWith('END')).toBe(true);
      expect(big?.truncated).toBe(true);
      expect(env?.output).not.toContain('MINDLY_TEST_SECRET');
      expect(env?.output).toContain('"CI"');
    } finally {
      delete process.env['MINDLY_TEST_SECRET'];
    }
  });

  it('validates its input and stops on failure when asked', async () => {
    const dir = tempDir();
    await expect(runChecks('relative', [])).rejects.toSatisfy((e: unknown) =>
      isMindlyError(e, 'invalid_input'),
    );
    await expect(runChecks(dir, [{ name: 'x', argv: [], timeoutSec: 1 }])).rejects.toSatisfy(
      (e: unknown) => isMindlyError(e, 'invalid_input'),
    );
    await expect(runChecks(dir, [{ name: 'x', argv: ['a\0b'], timeoutSec: 1 }])).rejects.toSatisfy(
      (e: unknown) => isMindlyError(e, 'invalid_input'),
    );
    const results = await runChecks(
      dir,
      [
        { name: 'fail', argv: [node, '-e', 'process.exit(1)'], timeoutSec: 20 },
        { name: 'never', argv: [node, '-e', ''], timeoutSec: 20 },
      ],
      { stopOnFailure: true },
    );
    expect(results.map((r) => r.name)).toEqual(['fail']);
  });

  it('does not interpret shell syntax', async () => {
    const dir = tempDir();
    const [r] = await runChecks(dir, [
      { name: 'echo', argv: ['echo', '$(touch pwned)', ';', 'touch', 'pwned2'], timeoutSec: 10 },
    ]);
    expect(r?.status).toBe('pass');
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    expect(existsSync(join(dir, 'pwned2'))).toBe(false);
  });
});
