import { describe, expect, it } from 'vitest';
import { REDACTED } from '@mindly/core';
import {
  createFailoverModule,
  notifyOutbox,
  OUTBOX_MAX_AGE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_ENTRIES,
  processStartTime,
  withNotificationId,
  type NotifyResult,
} from '../../src/index.js';
import { event } from '../helpers.js';
import { make, type Sent } from './continuity-helpers.js';

const page: Sent = {
  trigger: 'rate_limited',
  title: 'claude-code hit its usage limit',
  body: 'handoff ready for codex',
  projectName: 'repo',
  priority: 'high',
  dedupeKey: 'rate_limited:h1',
};

const failed: NotifyResult[] = [
  { channel: 'webhook', status: 'failed', reason: 'webhook request failed' },
];
const sentOk: NotifyResult[] = [{ channel: 'webhook', status: 'sent' }];
const heldBack: NotifyResult[] = [
  { channel: 'webhook', status: 'skipped', reason: 'rate_limited' },
];

function outboxRows(env: ReturnType<typeof make>): { attempts: number; nextAt: number }[] {
  return env.mindly.store.kv
    .list<{ attempts: number; nextAt: number }>('notify.outbox:', 1000)
    .map((r) => r.value!);
}

describe('pager outbox', () => {
  it('keeps a notification until it has reached a channel', async () => {
    let down = true;
    const env = make({ answer: () => (down ? failed : sentOk) });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    expect(env.sent).toHaveLength(0);

    expect(await outbox.flush()).toEqual({ delivered: 0, waiting: 1, dropped: 0 });
    expect(env.sent).toHaveLength(1);

    // Not due again straight away: a dead endpoint is not asked on every tick.
    expect(outbox.hasDue()).toBe(false);
    expect(await outbox.flush()).toEqual({ delivered: 0, waiting: 1, dropped: 0 });
    expect(env.sent).toHaveLength(1);

    down = false;
    env.clock.advance(31_000);
    expect(outbox.hasDue()).toBe(true);
    expect(await outbox.flush()).toEqual({ delivered: 1, waiting: 0, dropped: 0 });
    expect(env.sent).toHaveLength(2);
    // Every attempt carries the same id, so a receiver can drop a repeat.
    expect(env.sent[0]!.id).toBeTruthy();
    expect(env.sent[1]!.id).toBe(env.sent[0]!.id);
    expect(outbox.nextDueAt()).toBeNull();
  });

  it('gives a notification up after a bounded number of attempts', async () => {
    const env = make({ answer: () => failed });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 3; i++) {
      await outbox.flush();
      env.clock.advance(31 * 60_000);
    }
    expect(env.sent).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(await outbox.flush()).toEqual({ delivered: 0, waiting: 0, dropped: 0 });
  });

  it('does not use up an attempt when the hourly budget held the notification back', async () => {
    let answer = heldBack;
    const env = make({ answer: () => answer });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 3; i++) {
      expect(await outbox.flush()).toEqual({ delivered: 0, waiting: 1, dropped: 0 });
      env.clock.advance(61_000);
    }
    expect(outboxRows(env)).toEqual([expect.objectContaining({ attempts: 0 })]);
    answer = sentOk;
    expect(await outbox.flush()).toEqual({ delivered: 1, waiting: 0, dropped: 0 });
  });

  it('drops a notification that is no longer news', async () => {
    const env = make({ answer: () => sentOk });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    env.clock.advance(OUTBOX_MAX_AGE_MS + 1);
    expect(await outbox.flush()).toEqual({ delivered: 0, waiting: 0, dropped: 1 });
    expect(env.sent).toHaveLength(0);
  });

  it('waits for an attempt as long as a channel may take, and counts one that timed out', async () => {
    let hang = true;
    const env = make({ answer: () => sentOk });
    env.mindly.kernel.ports.notifier = {
      send: (n) => {
        env.sent.push(n);
        return hang ? new Promise(() => undefined) : Promise.resolve(sentOk);
      },
    };
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    // No room for a whole attempt: nothing is started.
    expect(await outbox.flush({ budgetMs: 50, attemptMs: 100 })).toEqual({
      delivered: 0,
      waiting: 1,
      dropped: 0,
    });
    expect(env.sent).toHaveLength(0);

    expect(await outbox.flush({ budgetMs: 500, attemptMs: 100 })).toEqual({
      delivered: 0,
      waiting: 1,
      dropped: 0,
    });
    expect(env.sent).toHaveLength(1);
    expect(outboxRows(env)[0]!.attempts).toBe(1);

    hang = false;
    env.clock.advance(31_000);
    expect(await outbox.flush()).toEqual({ delivered: 1, waiting: 0, dropped: 0 });
  });

  it('lets one process send at a time, attempt by attempt', async () => {
    let release: () => void = () => undefined;
    const env = make();
    env.mindly.kernel.ports.notifier = {
      send: (n) => {
        env.sent.push(n);
        return new Promise((resolve) => {
          release = () => resolve(sentOk);
        });
      },
    };
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    outbox.enqueue({ ...page, dedupeKey: 'other' });
    const first = outbox.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A second flusher (the daemon, another sender) finds an attempt under way and leaves the
    // due entry for later.
    expect(await outbox.flush()).toEqual({ delivered: 0, waiting: 2, dropped: 0, busy: true });
    for (let i = 0; i < 2; i++) {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await first).toEqual({ delivered: 2, waiting: 0, dropped: 0 });
    expect(env.sent).toHaveLength(2);
    // The lease is given back after each attempt.
    outbox.enqueue({ ...page, dedupeKey: 'third' });
    env.mindly.kernel.ports.notifier = { send: async () => sentOk };
    expect((await outbox.flush()).delivered).toBe(1);
  });

  it('is not held up for long by a sender that died during an attempt', async () => {
    const env = make({ answer: () => sentOk });
    const outbox = notifyOutbox(env.mindly);
    // The lease a killed process left: twice the attempt time limit.
    env.mindly.store.kv.set('notify.outbox-lease', { owner: 'gone', until: env.clock.t + 16_000 });
    outbox.enqueue(page);
    expect(await outbox.flush()).toMatchObject({ delivered: 0, busy: true });
    env.clock.advance(16_001);
    expect(await outbox.flush()).toEqual({ delivered: 1, waiting: 0, dropped: 0 });
  });

  it('takes the entries in the order they are due, beyond the first few', async () => {
    const env = make({ answer: () => failed });
    const outbox = notifyOutbox(env.mindly);
    for (let i = 0; i < 30; i++) outbox.enqueue({ ...page, dedupeKey: `k${i}` });
    // Every entry gets its first attempt; after that none is due for a while.
    await outbox.flush({ attemptMs: 10, budgetMs: 10_000 });
    await outbox.flush({ attemptMs: 10, budgetMs: 10_000 });
    expect(env.sent).toHaveLength(30);
    expect(outbox.hasDue()).toBe(false);
  });

  it('says when it is full', async () => {
    const env = make({ answer: () => sentOk });
    const warned: string[] = [];
    const logger = env.mindly.kernel.logger;
    const warn = logger.warn.bind(logger);
    logger.warn = (message, fields) => {
      warned.push(message);
      warn(message, fields);
    };
    const outbox = notifyOutbox(env.mindly);
    for (let i = 0; i <= OUTBOX_MAX_ENTRIES; i++) outbox.enqueue({ ...page, dedupeKey: `k${i}` });
    expect(outboxRows(env)).toHaveLength(OUTBOX_MAX_ENTRIES);
    expect(warned).toContain('notification dropped: the outbox is full');
  });

  it('stores only cleaned, redacted text, redacted before it is shortened', async () => {
    const env = make({
      config: (c) => {
        c.redaction.extraPatterns = ['ACME-[0-9]{6}'];
      },
      answer: () => sentOk,
    });
    const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue({
      ...page,
      // A secret that the 200-character cut would split.
      title: `${'x'.repeat(180)} ${token}`,
      body: `line one\nline two ACME-123456 ${String.fromCharCode(0xad)}${token}`,
    });
    const stored = JSON.stringify(env.mindly.store.kv.list('notify.outbox:', 10));
    expect(stored).not.toContain('ghp_');
    expect(stored).not.toContain('A1b2C3');
    expect(stored).not.toMatch(/ACME-\d/);
    await outbox.flush();
    expect(env.sent[0]!.title).not.toContain('\n');
    expect(env.sent[0]!.title.length).toBeLessThanOrEqual(200);
    expect(env.sent[0]!.body).toContain(REDACTED);
  });
});

describe('the usage-limit page', () => {
  const limit = 'Claude usage limit reached. Your limit will reset at 3pm.';

  async function limitedTurn(env: ReturnType<typeof make>): Promise<void> {
    env.mindly.use(createFailoverModule());
    await env.mindly.hooks.handle(event(env.root, 'claude-code', 'cc', 'session_start'));
    await env.mindly.hooks.handle(
      event(env.root, 'claude-code', 'cc', 'prompt', { prompt: 'Add a discount field' }),
    );
    await env.mindly.hooks.handle(
      event(env.root, 'claude-code', 'cc', 'stop', { lastMessage: limit }),
    );
  }

  it('is written down by the hook, which sends nothing itself', async () => {
    const env = make({ answer: () => sentOk });
    expect(notifyOutbox(env.mindly).needsSender()).toBe(false);
    await limitedTurn(env);
    expect(env.sent).toHaveLength(0);
    expect(notifyOutbox(env.mindly).needsSender()).toBe(true);
    expect(await notifyOutbox(env.mindly).flush()).toEqual({
      delivered: 1,
      waiting: 0,
      dropped: 0,
    });
    expect(env.sent.map((n) => n.trigger)).toEqual(['rate_limited']);
  });

  it('survives a pager that fails outright', async () => {
    let down = true;
    const env = make({ answer: () => (down ? failed : sentOk) });
    await limitedTurn(env);
    await notifyOutbox(env.mindly).flush();
    expect(env.sent).toHaveLength(1);
    down = false;
    env.clock.advance(31_000);
    await notifyOutbox(env.mindly).flush();
    expect(env.sent).toHaveLength(2);
    expect(notifyOutbox(env.mindly).nextDueAt()).toBeNull();
  });
});

describe('the sender', () => {
  const quick = { sliceMs: 20, windowMs: 400, attemptMs: 2000 };

  it('sends a notification written while it is busy with another', async () => {
    const env = make();
    env.mindly.kernel.ports.notifier = {
      send: async (n) => {
        env.sent.push(n);
        await new Promise((resolve) => setTimeout(resolve, 150));
        return sentOk;
      },
    };
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    expect(outbox.needsSender()).toBe(true);
    const running = outbox.runSender(quick);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // A second page while the first is in flight: the running sender is seen and takes it.
    expect(outbox.senderAlive()).toBe(true);
    outbox.enqueue({ ...page, dedupeKey: 'second' });
    expect(await running).toEqual({ delivered: 2, dropped: 0 });
    expect(env.sent.map((n) => n.dedupeKey)).toEqual(['rate_limited:h1', 'second']);
    // It is gone, and says so.
    expect(outbox.senderAlive()).toBe(false);
  });

  it('does not count a sender whose process is gone', async () => {
    const env = make({ answer: () => sentOk });
    const outbox = notifyOutbox(env.mindly);
    const until = env.clock.t + 15_000;
    env.mindly.store.kv.set('notify.outbox-sender', { owner: 'x', until, pid: process.pid });
    expect(outbox.senderAlive()).toBe(true);
    // A pid that cannot belong to a running process.
    env.mindly.store.kv.set('notify.outbox-sender', { owner: 'x', until, pid: 2 ** 22 + 1 });
    expect(outbox.senderAlive()).toBe(false);
    outbox.enqueue(page);
    expect(outbox.needsSender()).toBe(true);
  });

  it('steps aside for a sender that is already running', async () => {
    const env = make({ answer: () => sentOk });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    const running = outbox.runSender(quick);
    const second = outbox.runSender(quick);
    expect(await second).toEqual({ delivered: 0, dropped: 0 });
    expect(await running).toEqual({ delivered: 1, dropped: 0 });
    expect(env.sent).toHaveLength(1);
  });

  // Windows has no start-time source: there the mark checks the pid only.
  it.skipIf(process.platform === 'win32')(
    'does not count a sender whose process id now belongs to another process',
    async () => {
      const env = make({ answer: () => sentOk });
      const outbox = notifyOutbox(env.mindly);
      const until = env.clock.t + 15_000;
      // The sender died and its pid went to an unrelated process (here: this one).
      env.mindly.store.kv.set('notify.outbox-sender', {
        owner: 'x',
        until,
        pid: process.pid,
        start: 'not-this-process',
      });
      expect(outbox.senderAlive()).toBe(false);
      outbox.enqueue(page);
      expect(outbox.needsSender()).toBe(true);
    },
  );

  it('tells processes apart by start time, from /proc or from ps', () => {
    const own = processStartTime(process.pid);
    expect(own).not.toBeNull();
    expect(processStartTime(process.pid)).toBe(own);
    expect(processStartTime(2 ** 22 + 1)).toBeNull();
    if (process.platform !== 'win32') {
      // The path used where there is no /proc (macOS, the BSDs).
      const viaPs = processStartTime(process.pid, 'ps');
      expect(viaPs).toMatch(/^ps:\S/);
      expect(processStartTime(process.pid, 'ps')).toBe(viaPs);
      expect(processStartTime(2 ** 22 + 1, 'ps')).toBeNull();
    }
  });

  it('waits while another process holds the outbox instead of leaving', async () => {
    const env = make({ answer: () => sentOk });
    const outbox = notifyOutbox(env.mindly);
    env.mindly.store.kv.set('notify.outbox-lease', { owner: 'other', until: env.clock.t + 16_000 });
    outbox.enqueue(page);
    const running = outbox.runSender(quick);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(env.sent).toHaveLength(0);
    env.mindly.store.kv.delete('notify.outbox-lease');
    expect(await running).toEqual({ delivered: 1, dropped: 0 });
    expect(env.sent).toHaveLength(1);
  });

  it('stays for a retry that falls within its window', async () => {
    let down = true;
    const env = make({ answer: () => (down ? failed : sentOk) });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    const running = outbox.runSender({ ...quick, windowMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(env.sent).toHaveLength(1);
    down = false;
    // The retry is due 30 s later on the store's clock.
    env.clock.advance(31_000);
    expect(await running).toEqual({ delivered: 1, dropped: 0 });
    expect(env.sent).toHaveLength(2);
  });
});

describe('notification id', () => {
  it('is kept when valid, new for each occurrence, and follows the key only when asked', () => {
    expect(withNotificationId({ ...page, id: 'abc_123' }).id).toBe('abc_123');
    // Two occurrences under one dedupe key are two alerts.
    expect(withNotificationId(page).id).not.toBe(withNotificationId(page).id);
    expect(withNotificationId({ ...page, id: 'not valid!' }).id).toMatch(/^[0-9a-f-]{36}$/);
    // An alert whose key names its occurrence (one standup a day) keeps one id across retries.
    const day = withNotificationId(page, 'key').id;
    expect(day).toBe(withNotificationId(page, 'key').id);
    expect(day).toMatch(/^k[0-9a-f]{32}$/);
  });

  it('is the one given to the first attempt when the outbox takes over', async () => {
    const env = make({ answer: () => sentOk });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue({ ...page, id: 'first-attempt-id' });
    await outbox.flush();
    expect(env.sent[0]!.id).toBe('first-attempt-id');
  });
});
