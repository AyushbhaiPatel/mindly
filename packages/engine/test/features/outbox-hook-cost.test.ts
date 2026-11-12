import type { execFileSync as ExecFileSync } from 'node:child_process';
import type * as Fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * Where there is no /proc (macOS, the BSDs), a sender's start time comes from `ps`. A hook must
 * not run it: `enqueue` runs inside the Stop hook's budget. Here /proc is made to look absent and
 * `ps` is recorded instead of run.
 */
const calls = vi.hoisted(() => ({ ps: 0, noProc: false }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return {
    ...fs,
    existsSync: (path: string) =>
      calls.noProc && String(path).startsWith('/proc/') ? false : fs.existsSync(path),
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const cp = await importOriginal<{ execFileSync: typeof ExecFileSync }>();
  return {
    ...cp,
    execFileSync: (...args: Parameters<typeof ExecFileSync>) => {
      if (args[0] === 'ps') {
        calls.ps++;
        return 'Tue Nov 10 09:00:00 2026\n';
      }
      return cp.execFileSync(...args);
    },
  };
});

const { notifyOutbox } = await import('../../src/index.js');
const { make } = await import('./continuity-helpers.js');

afterEach(() => {
  calls.ps = 0;
  calls.noProc = false;
});

describe('pager outbox without /proc', () => {
  it('lets a hook write a page without running ps; the sender still checks the start time', () => {
    const env = make();
    const outbox = notifyOutbox(env.mindly);
    calls.noProc = true;
    // A running sender (this process) with a recorded start time.
    env.mindly.store.kv.set('notify.outbox-sender', {
      owner: 'x',
      until: env.clock.t + 15_000,
      pid: process.pid,
      start: 'ps:Tue Nov 10 09:00:00 2026',
    });
    outbox.enqueue({ trigger: 'rate_limited', title: 't', body: 'b' });
    expect(calls.ps).toBe(0);
    // The pid is alive: the hook takes it for the sender and starts none.
    expect(outbox.needsSender()).toBe(false);

    // The full check, used by senders, asks ps and tells a different process apart.
    expect(outbox.senderAlive()).toBe(true);
    expect(calls.ps).toBe(1);
    env.mindly.store.kv.set('notify.outbox-sender', {
      owner: 'x',
      until: env.clock.t + 15_000,
      pid: process.pid,
      start: 'ps:Mon Nov  9 08:00:00 2026',
    });
    expect(outbox.senderAlive()).toBe(false);
  });
});
