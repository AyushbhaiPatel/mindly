import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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
      if (Date.now() - statSync(dir).mtimeMs > ABANDONED_MS) remove(dir);
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
    if (process.env['MINDLY_TEST_KEEP_TMP']) return;
    try {
      remove(run);
    } catch (err) {
      // A folder left behind is no reason to fail a run whose tests passed; a later run removes it.
      console.warn(`could not remove ${run}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/**
 * Removes a run folder. Tests about files that cannot be written leave read-only folders behind,
 * which cannot be emptied as they are: those are made writable first.
 */
function remove(dir: string): void {
  const options = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };
  try {
    rmSync(dir, options);
  } catch {
    makeWritable(dir);
    rmSync(dir, options);
  }
}

function makeWritable(dir: string): void {
  try {
    // A link is never followed: what it points at is not ours to change.
    if (!lstatSync(dir).isDirectory()) return;
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) makeWritable(join(dir, name));
  } catch {
    // gone meanwhile, or not ours to change: the removal reports what is left
  }
}
