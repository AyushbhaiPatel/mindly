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
    readFileSync: wrap('read', real.readFileSync),
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

  it('leaves the lock of the holder that took it over alone when it lets go', () => {
    const file = lockFile();
    const a = tryProcessLock(file)!;
    // B took A's lock over (moved it aside, created its own); A's heartbeat has not noticed.
    fs.renameSync(file, `${file}.taken`);
    fs.unlinkSync(`${file}.taken`);
    const b = tryProcessLock(file)!;
    expect(b).not.toBeNull();
    const ino = fs.statSync(file).ino;
    let moved = 0;
    let bHeld: boolean;
    let c: ReturnType<typeof tryProcessLock>;
    hook.fn = (op, path) => {
      if (op === 'rename' && path === file) moved++;
    };
    try {
      a.release();
      bHeld = b.held();
      c = tryProcessLock(file);
    } finally {
      hook.fn = null;
    }
    // A never moved B's lock: B still holds it, nobody else can take it.
    expect(moved).toBe(0);
    expect(fs.statSync(file).ino).toBe(ino);
    expect(bHeld).toBe(true);
    expect(c).toBeNull();
    // B lets go: the lock is free, not brought back by anyone.
    b.release();
    expect(fs.existsSync(file)).toBe(false);
    tryProcessLock(file)!.release();
  });

  it('puts back a lock that replaced its own between its look and its move', () => {
    const file = lockFile();
    const a = tryProcessLock(file)!;
    const theirs = lockOf(77, 'bbbbbbbbbbbbbbbbbbbbbbbb');
    // Right after A looked at its lock and found it its own, B takes it over.
    hook.fn = (op, path) => {
      if (op !== 'rename' || path !== file || !path) return;
      hook.fn = null;
      fs.renameSync(file, `${file}.taken`);
      fs.unlinkSync(`${file}.taken`);
      fs.writeFileSync(file, theirs, { flag: 'wx' });
    };
    try {
      a.release();
    } finally {
      hook.fn = null;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(theirs);
    expect(fs.readdirSync(join(file, '..'))).toEqual(['lock']);
  });

  it('never deletes a newer lock when it cannot put one back', () => {
    const file = lockFile();
    const theirs = lockOf(77, 'bbbbbbbbbbbbbbbbbbbbbbbb');
    const newer = lockOf(88, 'cccccccccccccccccccccccc');
    for (const links of [true, false]) {
      // Without hard links the put-back is an exclusive copy.
      const link = (existing: string, path: string): void => {
        if (existing.includes('.release-')) {
          // In the instant before the put-back, C creates a lock.
          fs.writeFileSync(path, newer, { flag: 'wx' });
          if (!links) noLinks();
        }
        fs.linkSync(existing, path);
      };
      const a = tryProcessLock(file, { link })!;
      hook.fn = (op, path) => {
        if (op !== 'rename' || path !== file) return;
        hook.fn = null;
        fs.unlinkSync(file);
        fs.writeFileSync(file, theirs, { flag: 'wx' });
      };
      try {
        a.release();
      } finally {
        hook.fn = null;
      }
      // C's lock stands; B's, moved aside, is gone (B finds out at its next heartbeat).
      expect(fs.readFileSync(file, 'utf8')).toBe(newer);
      expect(fs.readdirSync(join(file, '..'))).toEqual(['lock']);
      fs.unlinkSync(file);
    }
  });

  it('does not count a lock that is away for a moment as lost', () => {
    const file = lockFile();
    const lock = tryProcessLock(file)!;
    // Another process has it renamed aside to look at it: two reads fail, then it is back.
    let fails = 2;
    hook.fn = (op, path) => {
      if (op === 'read' && path === file && fails > 0) {
        fails--;
        throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      }
    };
    try {
      expect(lock.held()).toBe(true);
    } finally {
      hook.fn = null;
    }
    expect(lock.signal.aborted).toBe(false);
    // One that stays away is not ours as far as anyone can tell, but not taken over either.
    fs.renameSync(file, `${file}.away`);
    expect(lock.held()).toBe(false);
    expect(lock.signal.aborted).toBe(false);
    fs.renameSync(`${file}.away`, file);
    expect(lock.held()).toBe(true);
    lock.release();
  });
});
