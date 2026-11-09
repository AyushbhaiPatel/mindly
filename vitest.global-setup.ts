import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Every temp folder a test run makes (fake repositories, Mindly homes, scratch worktrees, the
 * CLI's and daemon's child processes) goes into one folder for the run, removed when the run
 * ends. `os.tmpdir()` reads `TMPDIR` on each call, and the test workers and the processes they
 * start inherit it, so no test has to clean up after itself to keep the machine clean.
 */

const PREFIX = 'mindly-test-';
/** A run folder older than this belongs to a run that was killed before its teardown. */
const ABANDONED_MS = 6 * 60 * 60_000;

export default function setup(): () => void {
  const base = tmpdir();
  for (const name of readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(base, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > ABANDONED_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // gone already, or not ours to remove
    }
  }
  const run = mkdtempSync(join(base, PREFIX));
  const previous = process.env['TMPDIR'];
  process.env['TMPDIR'] = run;
  return () => {
    if (previous === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previous;
    if (!process.env['MINDLY_TEST_KEEP_TMP']) rmSync(run, { recursive: true, force: true });
  };
}
