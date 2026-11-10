import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  pidNamespace,
  processAlive,
  processIdentity,
  SENTINEL_LOCK_HEARTBEAT_MS,
  SENTINEL_LOCK_MAX_AGE_MS,
  tryProcessLock,
} from '../../src/index.js';

const lockFile = (): string => join(mkdtempSync(join(tmpdir(), 'mindly-lock-')), 'lock');
/** The PID a lock file records (its first line). */
const pidIn = (file: string): string => readFileSync(file, 'utf8').split('\n')[0] ?? '';
/** A lock file as a holder writes it: PID, id, process start, PID namespace. */
const lockOf = (pid: number, identity: string, namespace: string): string =>
  [pid, 'feedfeedfeedfeedfeedfeed', identity, namespace].join('\n');
/** Sets a file's time to `ms` ago (negative: in the future). */
const age = (file: string, ms: number): void => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('sentinel lock', () => {
  it('is held for as long as its process lives, however old', () => {
    const file = lockFile();
    const a = tryProcessLock(file)!;
    expect(pidIn(file)).toBe(String(process.pid));
    // The checkpoint lock would take this over after 30 s; this one does not.
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, hourAgo, hourAgo);
    expect(tryProcessLock(file)).toBeNull();
    a.release();
    a.release();
    expect(existsSync(file)).toBe(false);
    tryProcessLock(file)!.release();
  });

  it('is taken over when its process is gone, or after the maximum age', () => {
    const file = lockFile();
    writeFileSync(file, '999999');
    const dead = tryProcessLock(file, { alive: () => false })!;
    expect(dead).not.toBeNull();
    expect(pidIn(file)).toBe(String(process.pid));
    dead.release();

    writeFileSync(file, '424242');
    expect(tryProcessLock(file, { alive: () => true })).toBeNull();
    const later = Date.now() + SENTINEL_LOCK_MAX_AGE_MS + 1;
    const old = tryProcessLock(file, { alive: () => true, now: () => later })!;
    expect(old).not.toBeNull();
    old.release();
  });

  it('never takes over a lock another process took over first', () => {
    const file = lockFile();
    writeFileSync(file, '999999');
    // While this call decides the old lock is stale, another process takes it over (a new file).
    const r = tryProcessLock(file, {
      alive: (pid) => {
        if (pid === 999999) {
          unlinkSync(file);
          writeFileSync(file, '424242');
        }
        return false;
      },
    });
    expect(r).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('424242');
    expect(readdirSync(dirname(file))).toEqual(['lock']);
  });

  it('treats a lock without a holder as held for a moment only', () => {
    const file = lockFile();
    writeFileSync(file, '');
    expect(tryProcessLock(file, { alive: () => false })).toBeNull();
    // Left by a process that died while writing it: not held for a day.
    const minutesAgo = new Date(Date.now() - 5 * 60_000);
    utimesSync(file, minutesAgo, minutesAgo);
    tryProcessLock(file, { alive: () => false })!.release();
    expect(existsSync(file)).toBe(false);
  });

  it('never shows another process a lock without its holder', () => {
    const file = lockFile();
    const lock = tryProcessLock(file)!;
    // Written whole, then linked into place: no temp file is left next to it.
    expect(readdirSync(dirname(file))).toEqual(['lock']);
    expect(readFileSync(file, 'utf8').split('\n')).toEqual([
      String(process.pid),
      expect.stringMatching(/^[0-9a-f]{24}$/),
      processIdentity(process.pid) ?? '',
      pidNamespace() ?? '',
    ]);
    lock.release();
  });

  it('is not held by a lock that names its own PID from an earlier life', () => {
    const file = lockFile();
    const ns = { namespace: () => 'pid:[1]' };
    // A daemon killed in a pass and started again with the same PID (a container): the lock
    // names this very PID in this namespace, but a process that started at another time.
    writeFileSync(file, lockOf(process.pid, 'boot-1:100', 'pid:[1]'));
    const again = tryProcessLock(file, { ...ns, identity: () => 'boot-1:900' })!;
    expect(again).not.toBeNull();
    // A lock this process does hold is held, also against itself.
    expect(tryProcessLock(file, ns)).toBeNull();
    again.release();
    expect(existsSync(file)).toBe(false);
  });

  it('does not take a lock naming its own PID for its own when it cannot tell', () => {
    const file = lockFile();
    // The same PID, start time and namespace, but an id this process does not know: another
    // thread of this process may hold it. Held while it is touched, like any lock that the
    // PID says nothing about.
    writeFileSync(file, lockOf(process.pid, 'boot-1:100', 'pid:[1]'));
    const same = { namespace: () => 'pid:[1]', identity: () => 'boot-1:100' };
    expect(tryProcessLock(file, same)).toBeNull();
    // Where the system does not tell when a process started, neither.
    expect(tryProcessLock(file, { ...same, identity: () => null })).toBeNull();
    age(file, 10 * SENTINEL_LOCK_HEARTBEAT_MS);
    tryProcessLock(file, same)!.release();

    // A lock an older version wrote records only a PID: held while that PID lives.
    writeFileSync(file, String(process.pid));
    expect(tryProcessLock(file)).toBeNull();
  });

  it('is not held once its PID belongs to another process', () => {
    const file = lockFile();
    const ns = { namespace: () => 'pid:[1]' };
    writeFileSync(file, lockOf(424242, 'boot-1:100', 'pid:[1]'));
    // Same process still: held, however long ago it was touched.
    age(file, 60 * 60_000);
    expect(
      tryProcessLock(file, { ...ns, alive: () => true, identity: () => 'boot-1:100' }),
    ).toBeNull();
    // Where the system cannot tell, a live PID keeps the lock.
    expect(tryProcessLock(file, { ...ns, alive: () => true, identity: () => null })).toBeNull();
    // The PID is alive, but it is a process started later (or after a reboot).
    const taken = tryProcessLock(file, {
      ...ns,
      alive: () => true,
      identity: (pid) => (pid === 424242 ? 'boot-2:7' : processIdentity(pid)),
    })!;
    expect(taken).not.toBeNull();
    expect(pidIn(file)).toBe(String(process.pid));
    taken.release();
  });

  it('does not judge a PID of another PID namespace', () => {
    const file = lockFile();
    // Two containers sharing a home both run as PID 1: the lock names this very PID, and it is
    // another process, alive, in the other container.
    writeFileSync(file, lockOf(process.pid, 'boot-1:100', 'pid:[4026532001]'));
    const here = { namespace: () => 'pid:[4026532002]' };
    expect(tryProcessLock(file, { ...here, identity: () => 'boot-1:900' })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(lockOf(process.pid, 'boot-1:100', 'pid:[4026532001]'));

    // A holder in a container, looked at from the host: its PID is no process here, or the
    // PID of some other process.
    writeFileSync(file, lockOf(1, 'boot-1:100', 'pid:[4026532001]'));
    expect(tryProcessLock(file, { ...here, alive: () => false })).toBeNull();
    expect(
      tryProcessLock(file, { ...here, alive: () => true, identity: () => 'boot-1:5' }),
    ).toBeNull();

    // A namespace that cannot be read, on either side, says as little.
    expect(tryProcessLock(file, { namespace: () => null, alive: () => false })).toBeNull();
    writeFileSync(file, lockOf(1, 'boot-1:100', ''));
    expect(tryProcessLock(file, { ...here, alive: () => false })).toBeNull();
    expect(pidIn(file)).toBe('1');
  });

  it('takes a lock of another namespace over once its holder stopped touching it', () => {
    const file = lockFile();
    const here = { namespace: () => 'pid:[4026532002]', alive: () => false };
    writeFileSync(file, lockOf(1, 'boot-1:100', 'pid:[4026532001]'));
    // A few beats late: still held.
    age(file, 3 * SENTINEL_LOCK_HEARTBEAT_MS);
    expect(tryProcessLock(file, here)).toBeNull();
    // Its holder crashed: nothing touched it for a minute and more.
    age(file, 6 * SENTINEL_LOCK_HEARTBEAT_MS + 5000);
    const taken = tryProcessLock(file, here)!;
    expect(taken).not.toBeNull();
    expect(pidIn(file)).toBe(String(process.pid));
    taken.release();

    // Dated in the future (the clock was set back): as abandoned as one long in the past.
    writeFileSync(file, lockOf(1, 'boot-1:100', 'pid:[4026532001]'));
    age(file, -10 * 60_000);
    tryProcessLock(file, here)!.release();
    expect(existsSync(file)).toBe(false);
  });

  it('touches its lock while it holds it, and stops when it lets go', async () => {
    const file = lockFile();
    const lock = tryProcessLock(file, { heartbeatMs: 20 })!;
    age(file, 60 * 60_000);
    const before = statSync(file).mtimeMs;
    await sleep(120);
    expect(statSync(file).mtimeMs).toBeGreaterThan(before + 30 * 60_000);
    // Seen from another namespace it is held for as long as that goes on: without the touch,
    // an hour-old lock would count as abandoned there.
    expect(tryProcessLock(file, { namespace: () => 'pid:[9]', alive: () => false })).toBeNull();
    lock.release();
    expect(existsSync(file)).toBe(false);

    // A lock that was taken over is no longer touched by the process that lost it.
    const lost = tryProcessLock(file, { heartbeatMs: 20 })!;
    writeFileSync(file, '424242');
    age(file, 60 * 60_000);
    const frozen = statSync(file).mtimeMs;
    await sleep(120);
    expect(statSync(file).mtimeMs).toBe(frozen);
    lost.release();
    expect(readFileSync(file, 'utf8')).toBe('424242');
  });

  it('puts a lock back when its holder touched it during the takeover', () => {
    const file = lockFile();
    const content = lockOf(1, 'boot-1:100', 'pid:[4026532001]');
    writeFileSync(file, content);
    age(file, 10 * SENTINEL_LOCK_HEARTBEAT_MS);
    // The holder was only slow: its heartbeat lands after this process judged the lock
    // abandoned, before it is moved away. `now` is asked once per judgement.
    let asked = 0;
    const r = tryProcessLock(file, {
      namespace: () => 'pid:[4026532002]',
      now: () => {
        if (++asked === 2) age(file, 0);
        return Date.now();
      },
    });
    expect(r).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(readdirSync(dirname(file))).toEqual(['lock']);
  });

  it('knows its PID namespace where there is one', () => {
    const ns = pidNamespace();
    expect(pidNamespace()).toBe(ns);
    if (process.platform === 'linux') expect(ns).toMatch(/^pid:\[\d+\]$/);
    else expect(ns).toBe('host');
  });

  it('removes the temp files a killed process left next to the lock', () => {
    const file = lockFile();
    const dir = dirname(file);
    // Killed while creating a lock, and while taking one over, some time ago.
    writeFileSync(`${file}.new-4242-aaaaaaaaaaaa`, 'x');
    writeFileSync(`${file}.stale-4242-bbbbbbbbbbbb`, 'x');
    age(`${file}.new-4242-aaaaaaaaaaaa`, 5 * 60_000);
    age(`${file}.stale-4242-bbbbbbbbbbbb`, 5 * 60_000);
    // One of a process at work right now, and files that are not this lock's.
    writeFileSync(`${file}.new-4243-cccccccccccc`, 'x');
    writeFileSync(join(dir, 'other.new-1-dddddddddddd'), 'x');
    writeFileSync(join(dir, 'notes'), 'x');
    age(join(dir, 'other.new-1-dddddddddddd'), 5 * 60_000);
    age(join(dir, 'notes'), 5 * 60_000);
    const lock = tryProcessLock(file)!;
    expect(readdirSync(dir).sort()).toEqual(
      ['lock', 'lock.new-4243-cccccccccccc', 'notes', 'other.new-1-dddddddddddd'].sort(),
    );
    lock.release();
  });

  it('tells a process from a later one with the same PID where the system says', () => {
    const mine = processIdentity(process.pid);
    expect(processIdentity(process.pid)).toBe(mine);
    expect(processIdentity(0)).toBeNull();
    expect(processIdentity(2 ** 22 + 12345)).toBeNull();
    if (process.platform === 'linux') expect(mine).toMatch(/^[0-9a-f-]+:\d+$/);
  });

  it('works the same on a file system without hard links', () => {
    const file = lockFile();
    const link = (): never => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    const a = tryProcessLock(file, { link })!;
    expect(a).not.toBeNull();
    expect(pidIn(file)).toBe(String(process.pid));
    // Held: a second attempt is refused, not an error.
    expect(tryProcessLock(file, { link })).toBeNull();
    a.release();
    expect(existsSync(file)).toBe(false);

    // A lock whose holder is gone is taken over there too, not left busy for good.
    writeFileSync(file, '999999');
    const dead = tryProcessLock(file, { link, alive: () => false })!;
    expect(dead).not.toBeNull();
    expect(pidIn(file)).toBe(String(process.pid));
    expect(readdirSync(dirname(file))).toEqual(['lock']);
    dead.release();

    // A live holder's lock is still held.
    writeFileSync(file, '424242');
    expect(tryProcessLock(file, { link, alive: () => true })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('424242');
  });

  it('leaves a takeover to the process already doing it', () => {
    const file = lockFile();
    writeFileSync(file, '999999');
    // Another process is taking the stale lock over right now.
    writeFileSync(`${file}.takeover`, '');
    expect(tryProcessLock(file, { alive: () => false })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('999999');
    // A guard left by a process that died in the middle is cleared, and the next attempt works.
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${file}.takeover`, old, old);
    expect(tryProcessLock(file, { alive: () => false })).toBeNull();
    const lock = tryProcessLock(file, { alive: () => false })!;
    expect(lock).not.toBeNull();
    expect(readdirSync(dirname(file))).toEqual(['lock']);
    lock.release();

    // A guard dated in the future (the clock was set back) is left over too: it does not
    // block takeovers until the clock catches up.
    writeFileSync(file, '999999');
    writeFileSync(`${file}.takeover`, '');
    age(`${file}.takeover`, -60 * 60_000);
    expect(tryProcessLock(file, { alive: () => false })).toBeNull();
    tryProcessLock(file, { alive: () => false })!.release();
    expect(readdirSync(dirname(file))).toEqual([]);
  });

  it('is never held by two processes at once when stale locks are taken over', async () => {
    const dir = dirname(lockFile());
    const file = join(dir, 'lock');
    const marker = join(dir, 'held');
    const src = new URL('../../src/features/sentinel-lock.ts', import.meta.url).pathname;
    // Each worker takes the lock in a loop; while it holds it, a marker directory proves it is
    // alone. Every few rounds a worker "crashes": it leaves the lock behind, naming a dead PID.
    const worker = `
      import { mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
      import { tryProcessLock } from ${JSON.stringify(src)};
      const [file, marker] = process.argv.slice(-2);
      let got = 0, both = 0;
      const end = Date.now() + 1500;
      while (Date.now() < end) {
        const lock = tryProcessLock(file);
        if (!lock) continue;
        got++;
        try { mkdirSync(marker); } catch { both++; continue; }
        rmdirSync(marker);
        if (got % 7 === 0) writeFileSync(file, '999999');
        else lock.release();
      }
      process.stdout.write(JSON.stringify({ got, both }));
    `;
    const run = (): Promise<{ got: number; both: number }> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--experimental-strip-types', '--input-type=module', '-e', worker, file, marker],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('error', reject);
        child.on('close', () => {
          try {
            resolve(JSON.parse(out) as { got: number; both: number });
          } catch (err) {
            reject(err as Error);
          }
        });
      });
    const results = await Promise.all([run(), run(), run(), run()]);
    expect(results.reduce((n, r) => n + r.both, 0)).toBe(0);
    expect(results.reduce((n, r) => n + r.got, 0)).toBeGreaterThan(20);
    // Whatever is left is a lock nobody holds: it can be taken.
    mkdirSync(marker);
    rmdirSync(marker);
    tryProcessLock(file)!.release();
  }, 20_000);

  it('never removes a lock another process took over', () => {
    const file = lockFile();
    const mine = tryProcessLock(file)!;
    writeFileSync(file, '424242');
    mine.release();
    expect(readFileSync(file, 'utf8')).toBe('424242');
  });

  it('knows whether a process lives', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-5)).toBe(false);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });
});
