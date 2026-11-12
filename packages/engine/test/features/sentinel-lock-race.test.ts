import { spawn } from 'node:child_process';
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
/** Blocks for `ms`. */
const block = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const waitFor = (path: string): void => {
  const end = Date.now() + 10_000;
  while (!fs.existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    block(5);
  }
};
/** Stands in for another process: it does not share this one's memory of released locks. */
const asAnotherProcess = <T>(id: string, fn: () => T): T => {
  const released = ((globalThis as Record<symbol, Set<string> | undefined>)[
    Symbol.for('mindly.sentinel.released')
  ] ??= new Set<string>());
  const had = released.delete(id);
  try {
    return fn();
  } finally {
    if (had) released.add(id);
  }
};
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
    // A's note of its release stays: its own lock may still be aside with someone.
    expect(fs.readdirSync(join(file, '..')).filter((f) => !f.startsWith('lock.released-'))).toEqual(
      ['lock'],
    );
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
      expect(
        fs.readdirSync(join(file, '..')).filter((f) => !f.startsWith('lock.released-')),
      ).toEqual(['lock']);
      fs.unlinkSync(file);
    }
  });

  it('never leaves its lock behind when it lets go while a takeover has it aside', () => {
    const file = lockFile();
    const a = tryProcessLock(file)!;
    // An observer in another namespace saw the lock unchanged for the window; A was only slow,
    // and touches it while it is judged under the guard, so the takeover will put it back.
    let mono = 0;
    const observer = {
      namespace: () => 'pid:[4026532002]',
      host: () => 'host-1',
      monotonic: () => mono,
    };
    expect(tryProcessLock(file, observer)).toBeNull();
    mono += 6 * SENTINEL_LOCK_HEARTBEAT_MS + 1000;
    let reads = 0;
    let releasedAside = false;
    hook.fn = (op, path) => {
      // The takeover has the lock aside; at that moment A lets go.
      if (op === 'read' && path.startsWith(`${file}.stale-`) && !releasedAside) {
        releasedAside = true;
        hook.fn = null;
        a.release();
      }
    };
    let r: ReturnType<typeof tryProcessLock>;
    try {
      r = tryProcessLock(file, {
        ...observer,
        monotonic: () => {
          if (++reads === 2) {
            const t = new Date(Date.now() + 1000);
            fs.utimesSync(file, t, t);
          }
          return mono;
        },
      });
    } finally {
      hook.fn = null;
    }
    expect(releasedAside).toBe(true);
    // Not put back: A let go of it, so the takeover takes it. Nothing of A's lock is left.
    expect(r).not.toBeNull();
    expect(fs.readFileSync(file, 'utf8').split('\n')[0]).toBe(String(process.pid));
    r!.release();
    expect(fs.readdirSync(join(file, '..')).filter((f) => !f.startsWith('lock.seen-'))).toEqual([]);
  });

  it('never leaves its lock behind when it is moved aside between its look and its move', () => {
    const file = lockFile();
    const a = tryProcessLock(file)!;
    const id = fs.readFileSync(file, 'utf8').split('\n')[1] as string;
    // B, in another namespace (and here standing in for another process: it does not share
    // A's memory of released locks), saw the lock unchanged for the window.
    let mono = 0;
    const observer = {
      namespace: () => 'pid:[4026532002]',
      host: () => 'host-1',
      monotonic: () => mono,
    };
    expect(tryProcessLock(file, observer)).toBeNull();
    mono += 6 * SENTINEL_LOCK_HEARTBEAT_MS + 1000;
    let b: ReturnType<typeof tryProcessLock> = null;
    let putBack = false;
    hook.fn = (op, path) => {
      // A found the lock its own and is about to move it: B moves it aside first. A's last
      // heartbeat touched it while B judged it, so B would put it back.
      if (op !== 'rename' || path !== file) return;
      hook.fn = null;
      const released = (globalThis as Record<symbol, Set<string> | undefined>)[
        Symbol.for('mindly.sentinel.released')
      ];
      released?.delete(id);
      let reads = 0;
      b = tryProcessLock(file, {
        ...observer,
        link: (existing, to) => {
          if (existing.includes('.stale-')) putBack = true;
          fs.linkSync(existing, to);
        },
        monotonic: () => {
          if (++reads === 2) {
            const t = new Date(Date.now() + 1000);
            fs.utimesSync(file, t, t);
          }
          return mono;
        },
      });
      released?.add(id);
    };
    try {
      a.release();
    } finally {
      hook.fn = null;
    }
    // B found A's note of the release: it did not put A's lock back, and took the lock.
    expect(putBack).toBe(false);
    expect(b).not.toBeNull();
    expect(fs.readFileSync(file, 'utf8').split('\n')[1]).not.toBe(id);
    b!.release();
    expect(fs.readdirSync(join(file, '..')).filter((f) => !f.startsWith('lock.seen-'))).toEqual([]);
  });

  it('never takes a lock in the middle of a release, whatever its clock says', () => {
    for (const skew of [0, 3000, -3000, 60 * 60_000]) {
      const file = lockFile();
      let d: ReturnType<typeof tryProcessLock> = null;
      // H lets go. Should a third process D create a lock while H puts something back, it gets
      // it only if the lock is free.
      const h = tryProcessLock(file, {
        link: (existing, to) => {
          if (existing.includes('.release-') && d === null) d = tryProcessLock(file);
          fs.linkSync(existing, to);
        },
      })!;
      const hId = fs.readFileSync(file, 'utf8').split('\n')[1] as string;
      let c: ReturnType<typeof tryProcessLock> = null;
      hook.fn = (op, path) => {
        // H noted its release and found the lock its own; it is about to move it. C, another
        // process of this machine whose clock is off (an NFS server, a clock step), looks now.
        if (op !== 'rename' || path !== file) return;
        hook.fn = null;
        const released = (globalThis as Record<symbol, Set<string>>)[
          Symbol.for('mindly.sentinel.released')
        ]!;
        released.delete(hId);
        c = tryProcessLock(file, { now: () => Date.now() + skew });
        released.add(hId);
      };
      try {
        h.release();
      } finally {
        hook.fn = null;
      }
      expect(c).toBeNull();
      expect(fs.existsSync(file)).toBe(false);
      // Nothing left but what C noted of the lock it saw.
      expect(fs.readdirSync(join(file, '..')).filter((f) => !f.startsWith('lock.seen-'))).toEqual(
        [],
      );
    }
  });

  it('takes a lock that was let go of while it judged it, in the same call', () => {
    const file = lockFile();
    // A holder of this machine and namespace whose process is gone.
    fs.writeFileSync(
      file,
      [999999, 'abababababababababababab', '', 'pid:[1]', 'host-1'].join('\n'),
    );
    const here = { namespace: () => 'pid:[1]', host: () => 'host-1', alive: () => false };
    // Between the first create and the judgement, the lock is taken over and let go of by
    // someone else; the lock found then is again a dead holder's.
    let creates = 0;
    const lock = tryProcessLock(file, {
      ...here,
      link: (existing, to) => {
        if (existing.includes('.new-') && ++creates === 2) {
          fs.writeFileSync(
            to,
            [999998, 'cdcdcdcdcdcdcdcdcdcdcdcd', '', 'pid:[1]', 'host-1'].join('\n'),
          );
        }
        fs.linkSync(existing, to);
      },
    });
    expect(lock).not.toBeNull();
    expect(fs.readFileSync(file, 'utf8').split('\n')[0]).toBe(String(process.pid));
    lock!.release();
  });

  it('keeps a release note an acquirer in between would have removed', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const file = lockFile();
      const r = tryProcessLock(file, {
        namespace: () => 'pid:[4026532001]',
        host: () => 'host-1',
      })!;
      const rId = fs.readFileSync(file, 'utf8').split('\n')[1] as string;
      // T, in another namespace, saw R's lock unchanged for the window; R touches it while T
      // judges it, so T would put it back.
      let mono = 0;
      const observer = {
        namespace: () => 'pid:[4026532002]',
        host: () => 'host-1',
        monotonic: () => mono,
      };
      expect(tryProcessLock(file, observer)).toBeNull();
      mono += 6 * SENTINEL_LOCK_HEARTBEAT_MS + 1000;
      let reads = 0;
      let noteAfterN = false;
      hook.fn = (op, path) => {
        if (op !== 'read' || !path.startsWith(`${file}.stale-`)) return;
        hook.fn = null;
        // While T has R's lock aside: R lets go (a one-shot, it exits), and N takes the free
        // lock and lets go of it again.
        r.release();
        asAnotherProcess(rId, () => {
          const n = tryProcessLock(file, {
            namespace: () => 'pid:[4026532003]',
            host: () => 'host-1',
          })!;
          noteAfterN = fs.existsSync(`${file}.released-${rId}`);
          n.release();
        });
      };
      let t: ReturnType<typeof tryProcessLock>;
      try {
        t = asAnotherProcess(rId, () =>
          tryProcessLock(file, {
            ...observer,
            monotonic: () => {
              if (++reads === 2) {
                const d = new Date(Date.now() + 1000);
                fs.utimesSync(file, d, d);
              }
              return mono;
            },
          }),
        );
      } finally {
        hook.fn = null;
      }
      // R's note outlived N, so T found it: R's lock was not put back, and T took the lock.
      expect(noteAfterN).toBe(true);
      expect(t).not.toBeNull();
      expect(fs.readFileSync(file, 'utf8').split('\n')[1]).not.toBe(rId);
      t!.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never leaves a live holder that let go holding its lock', () => {
    const file = lockFile();
    const dir = join(file, '..');
    const src = new URL('../../src/features/sentinel-lock.ts', import.meta.url).pathname;
    // R: a daemon in its own process, of this machine and namespace. It takes the lock, lets
    // go of it when told, and lives on.
    const holder = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { tryProcessLock } from ${JSON.stringify(src)};
      const [file, dir] = process.argv.slice(-2);
      const lock = tryProcessLock(file);
      writeFileSync(dir + '/acquired', '');
      const poll = setInterval(() => {
        if (!existsSync(dir + '/go')) return;
        clearInterval(poll);
        lock.release();
        writeFileSync(dir + '/released', '');
      }, 5);
      setTimeout(() => {}, 60_000);
    `;
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        holder,
        file,
        dir,
      ],
      { stdio: 'inherit' },
    );
    try {
      waitFor(join(dir, 'acquired'));
      const rId = fs.readFileSync(file, 'utf8').split('\n')[1] as string;
      let mono = 0;
      const observer = {
        namespace: () => 'pid:[4026532002]',
        host: () => 'host-1',
        monotonic: () => mono,
      };
      expect(tryProcessLock(file, observer)).toBeNull();
      mono += 6 * SENTINEL_LOCK_HEARTBEAT_MS + 1000;
      let reads = 0;
      hook.fn = (op, path) => {
        if (op !== 'read' || !path.startsWith(`${file}.stale-`)) return;
        hook.fn = null;
        // T has R's lock aside and stalls. R lets go and finds the lock away; N takes the free
        // lock, holds it while R looks again (and sees N's lock), and lets go.
        fs.writeFileSync(join(dir, 'go'), '');
        waitFor(join(dir, 'released'));
        const n = tryProcessLock(file)!;
        expect(n).not.toBeNull();
        block(2500);
        n.release();
      };
      let t: ReturnType<typeof tryProcessLock>;
      try {
        t = tryProcessLock(file, {
          ...observer,
          monotonic: () => {
            if (++reads === 2) {
              const d = new Date(Date.now() + 1000);
              fs.utimesSync(file, d, d);
            }
            return mono;
          },
        });
      } finally {
        hook.fn = null;
      }
      // R's note was still there: T did not put R's lock back. R is alive, and holds nothing.
      expect(child.exitCode).toBeNull();
      expect(t).not.toBeNull();
      expect(fs.readFileSync(file, 'utf8').split('\n')[1]).not.toBe(rId);
      t!.release();
      const next = tryProcessLock(file)!;
      expect(next).not.toBeNull();
      next.release();
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);

  it('removes notes of releases once no takeover can need them', () => {
    const file = lockFile();
    // Releases that never found their lock again: one long ago, one just now (a takeover may
    // still have that lock aside), one dated in the future (a clock that stepped).
    const old = `${file}.released-abababababababababababab`;
    const fresh = `${file}.released-cdcdcdcdcdcdcdcdcdcdcdcd`;
    const future = `${file}.released-efefefefefefefefefefefef`;
    for (const f of [old, fresh, future]) fs.writeFileSync(f, '');
    const at = (f: string, ms: number): void => {
      const t = new Date(Date.now() - ms);
      fs.utimesSync(f, t, t);
    };
    at(old, 11 * 60_000);
    at(future, -11 * 60_000);
    const lock = tryProcessLock(file)!;
    expect(fs.readdirSync(join(file, '..')).sort()).toEqual(
      ['lock', 'lock.released-cdcdcdcdcdcdcdcdcdcdcdcd'].sort(),
    );
    lock.release();
  });

  it('looks for a lock it let go of while it was away, and removes it once back', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const file = lockFile();
      const a = tryProcessLock(file)!;
      const mine = fs.readFileSync(file, 'utf8');
      const id = mine.split('\n')[1] as string;
      // Away while A lets go (another process has it aside), back a second later.
      fs.renameSync(file, `${file}.away`);
      a.release();
      expect(fs.existsSync(`${file}.released-${id}`)).toBe(true);
      fs.renameSync(`${file}.away`, file);
      vi.advanceTimersByTime(1000);
      expect(fs.readdirSync(join(file, '..'))).toEqual([]);
    } finally {
      vi.useRealTimers();
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
