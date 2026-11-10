import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SENTINEL_LOCK_HEARTBEAT_MS, tryProcessLock } from '../../src/index.js';

/*
 * The sentinel lock against another process acting at the worst moment: file operations of
 * the lock module call `hook` first, so a test can make "another process" act between two of
 * them.
 */

const hook: { fn: ((op: string, path: string) => void) | null } = { fn: null };

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  const wrap =
    <A extends unknown[], R>(op: string, f: (...a: A) => R) =>
    (...a: A): R => {
      hook.fn?.(op, String(a[0]));
      return f(...a);
    };
  return {
    ...real,
    copyFileSync: wrap('copy', real.copyFileSync),
    renameSync: wrap('rename', real.renameSync),
    unlinkSync: wrap('unlink', real.unlinkSync),
  };
});

const lockFile = (): string => join(fs.mkdtempSync(join(tmpdir(), 'mindly-lock-race-')), 'lock');
const lockOf = (pid: number, id: string): string =>
  [pid, id, 'boot-1:100', 'pid:[4026532001]', 'host-1'].join('\n');
const noLinks = (): never => {
  throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
};

describe('sentinel lock races', () => {
  it('never puts a lock back over one created while it was aside (no hard links)', () => {
    const file = lockFile();
    const original = lockOf(1, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    const third = lockOf(77, 'cccccccccccccccccccccccc');
    fs.writeFileSync(file, original);
    // An observer in another namespace has seen the lock unchanged for the window.
    let mono = 0;
    const opts = {
      namespace: () => 'pid:[4026532002]',
      host: () => 'host-1',
      alive: () => false,
      link: noLinks,
      monotonic: () => mono,
    };
    expect(tryProcessLock(file, opts)).toBeNull();
    mono += 6 * SENTINEL_LOCK_HEARTBEAT_MS + 1000;
    // Its holder was only slow: it touches the lock while it is judged under the guard (the
    // second read of the clock), so the takeover puts it back.
    let reads = 0;
    let created = false;
    hook.fn = (op, path) => {
      // Just before the lock moved aside is put back, a third process creates a new one (the
      // file is free at that moment) and holds it.
      if (created || !(op === 'rename' || op === 'copy') || !path.startsWith(`${file}.stale-`)) {
        return;
      }
      created = true;
      fs.writeFileSync(file, third, { flag: 'wx' });
    };
    try {
      const r = tryProcessLock(file, {
        ...opts,
        monotonic: () => {
          if (++reads === 2) {
            const t = new Date(Date.now() + 1000);
            fs.utimesSync(file, t, t);
          }
          return mono;
        },
      });
      expect(r).toBeNull();
    } finally {
      hook.fn = null;
    }
    expect(created).toBe(true);
    // The third process's lock stands; the slow holder finds out at its next heartbeat.
    expect(fs.readFileSync(file, 'utf8')).toBe(third);
  });

  it('never removes a lock that replaced its own while it lets go', () => {
    const file = lockFile();
    const lock = tryProcessLock(file)!;
    const third = lockOf(77, 'cccccccccccccccccccccccc');
    // Between reading its lock and removing it, the lock is taken over (moved aside) and a
    // third process creates a new one.
    let replaced = false;
    hook.fn = (op, path) => {
      if (replaced || op !== 'unlink' || !(path === file || path.startsWith(`${file}.`))) return;
      if (path.includes('.new-')) return;
      replaced = true;
      if (path === file) fs.renameSync(file, `${file}.gone`);
      fs.writeFileSync(file, third, { flag: 'wx' });
    };
    try {
      lock.release();
    } finally {
      hook.fn = null;
    }
    expect(replaced).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(third);
  });
});
