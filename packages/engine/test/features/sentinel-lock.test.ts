import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { processAlive, SENTINEL_LOCK_MAX_AGE_MS, tryProcessLock } from '../../src/index.js';

const lockFile = (): string => join(mkdtempSync(join(tmpdir(), 'mindly-lock-')), 'lock');

describe('sentinel lock', () => {
  it('is held for as long as its process lives, however old', () => {
    const file = lockFile();
    const a = tryProcessLock(file)!;
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
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
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
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

  it('treats a lock still being written (no PID yet) as held', () => {
    const file = lockFile();
    writeFileSync(file, '');
    expect(tryProcessLock(file, { alive: () => false })).toBeNull();
  });

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
