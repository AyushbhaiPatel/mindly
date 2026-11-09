import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  processAlive,
  processIdentity,
  SENTINEL_LOCK_MAX_AGE_MS,
  tryProcessLock,
} from '../../src/index.js';

const lockFile = (): string => join(mkdtempSync(join(tmpdir(), 'mindly-lock-')), 'lock');
/** The PID a lock file records (its first line). */
const pidIn = (file: string): string => readFileSync(file, 'utf8').split('\n')[0] ?? '';

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
    expect(readFileSync(file, 'utf8').split('\n')).toHaveLength(3);
    lock.release();
  });

  it('is not held by a lock that names its own PID from an earlier life', () => {
    const file = lockFile();
    // A daemon killed in a pass and started again with the same PID (a container): the lock
    // names this very process, which never took it.
    writeFileSync(file, String(process.pid));
    tryProcessLock(file)!.release();
    writeFileSync(file, `${process.pid}\n${'ab'.repeat(12)}\n`);
    const again = tryProcessLock(file)!;
    expect(again).not.toBeNull();
    // A lock this process does hold is held, also against itself.
    expect(tryProcessLock(file)).toBeNull();
    again.release();
    expect(existsSync(file)).toBe(false);
  });

  it('is not held once its PID belongs to another process', () => {
    const file = lockFile();
    writeFileSync(file, '424242\nfeedfeedfeedfeedfeedfeed\nboot-1:100');
    // Same process still: held.
    expect(tryProcessLock(file, { alive: () => true, identity: () => 'boot-1:100' })).toBeNull();
    // Where the system cannot tell, a live PID keeps the lock.
    expect(tryProcessLock(file, { alive: () => true, identity: () => null })).toBeNull();
    // The PID is alive, but it is a process started later (or after a reboot).
    const taken = tryProcessLock(file, {
      alive: () => true,
      identity: (pid) => (pid === 424242 ? 'boot-2:7' : processIdentity(pid)),
    })!;
    expect(taken).not.toBeNull();
    expect(pidIn(file)).toBe(String(process.pid));
    taken.release();
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
        if (got % 7 === 0) writeFileSync(file, '999999\\nfeedfeedfeedfeedfeedfeed\\n');
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
