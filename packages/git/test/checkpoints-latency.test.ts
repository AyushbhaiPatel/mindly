import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCheckpoint, checkpointRefName } from '../src/index.js';
import { commitAll, git, tempDir } from './helpers.js';

const FOLDERS = 100;
const FILES_PER_FOLDER = 50;
const EDITS = 50;

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

describe('checkpoint latency', () => {
  it('keeps per-edit checkpoints fast on a repository of 5,000 tracked files', async () => {
    const root = tempDir('syn-latency-');
    git(root, 'init', '-q');
    const files: string[] = [];
    for (let d = 0; d < FOLDERS; d++) {
      const folder = `src/mod${String(d).padStart(3, '0')}`;
      mkdirSync(join(root, folder), { recursive: true });
      for (let f = 0; f < FILES_PER_FOLDER; f++) {
        const rel = `${folder}/file${f}.ts`;
        writeFileSync(join(root, rel), `export const v${d}x${f} = ${f};\n`);
        files.push(rel);
      }
    }
    commitAll(root, 'bulk');
    expect(git(root, 'ls-files').trim().split('\n')).toHaveLength(FOLDERS * FILES_PER_FOLDER);

    const indexFile = join(tempDir(), 'index');
    const base = await captureCheckpoint({
      worktree: root,
      indexFile,
      parent: null,
      paths: null,
      always: true,
      ref: checkpointRefName(root, 1),
      message: 'baseline',
    });
    const chain = [base.commit as string];
    const durations: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      const rel = files[(i * 997) % files.length] as string;
      writeFileSync(join(root, rel), `export const edited = ${i};\n`);
      const startedAt = performance.now();
      const r = await captureCheckpoint({
        worktree: root,
        indexFile,
        parent: { commit: chain[chain.length - 1] as string },
        paths: [rel],
        always: true,
        ref: checkpointRefName(root, i + 2),
        message: `edit ${i}`,
      });
      durations.push(performance.now() - startedAt);
      expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(r.changedPaths).toEqual([rel]);
      chain.push(r.commit as string);
    }

    // A full rescan of the same tree, for scale: a loaded runner slows both the same way.
    const fullDurations: number[] = [];
    for (let i = 0; i < 3; i++) {
      const startedAt = performance.now();
      await captureCheckpoint({
        worktree: root,
        indexFile,
        parent: { commit: chain[chain.length - 1] as string },
        paths: null,
        always: true,
        ref: checkpointRefName(root, EDITS + 2 + i),
        message: `rescan ${i}`,
      });
      fullDurations.push(performance.now() - startedAt);
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const median = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const fullMedian = percentile(
      [...fullDurations].sort((a, b) => a - b),
      50,
    );
    console.log(
      `checkpoint latency: median ${median.toFixed(1)}ms p95 ${p95.toFixed(1)}ms (${EDITS} edits, ${files.length} files; full rescan ${fullMedian.toFixed(1)}ms)`,
    );

    expect(git(root, 'rev-list', '--first-parent', chain[chain.length - 1] as string).trim()).toBe(
      [...chain].reverse().join('\n'),
    );
    const last = chain[chain.length - 1] as string;
    expect(git(root, 'rev-parse', checkpointRefName(root, EDITS + 1)).trim()).toBe(last);
    expect(git(root, 'rev-parse', 'HEAD^{tree}')).not.toBe(
      git(root, 'rev-parse', `${last}^{tree}`),
    );
    // Normally well under 100 ms; on a loaded machine an edit checkpoint still stays within a
    // few full rescans.
    expect(p95).toBeLessThan(Math.max(300, 3 * fullMedian));
  }, 120_000);
});
