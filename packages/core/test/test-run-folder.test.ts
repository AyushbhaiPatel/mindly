import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import setup from '../../../vitest.global-setup.js';

describe('the temp folder of a test run', () => {
  it('is removed at the end of the run, read-only folders the tests left in it included', () => {
    const outer = process.env['TMPDIR'];
    const base = mkdtempSync(join(tmpdir(), 'run-folder-'));
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    const tmp = join(base, 'tmp');
    mkdirSync(tmp);
    process.env['TMPDIR'] = tmp;
    try {
      const teardown = setup();
      const run = process.env['TMPDIR'];
      expect(run.startsWith(join(tmp, 'mindly-test-'))).toBe(true);

      // What tests about unwritable files leave: a read-only folder holding a file, a folder that
      // cannot be listed, and a link to a folder that is not the run's.
      const certs = join(run, 'copy', 'certs');
      mkdirSync(certs, { recursive: true });
      writeFileSync(join(certs, 'server.pem'), 'x');
      const closed = join(run, 'closed', 'inner');
      mkdirSync(closed, { recursive: true });
      writeFileSync(join(closed, 'file'), 'x');
      symlinkSync(outside, join(run, 'link'));
      chmodSync(certs, 0o500);
      chmodSync(join(run, 'copy'), 0o500);
      chmodSync(closed, 0o000);

      teardown();
      expect(existsSync(run)).toBe(false);
      expect(process.env['TMPDIR']).toBe(tmp);
      // What a link points at is left alone.
      expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    } finally {
      if (outer === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = outer;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
