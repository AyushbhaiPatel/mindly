import { describe, expect, it } from 'vitest';
import {
  notifyOutbox,
  OUTBOX_MAX_AGE_MS,
  OUTBOX_MAX_ATTEMPTS,
  type NotifyResult,
} from '../../src/index.js';
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
    expect(env.sent[1]).toEqual(page);

    // Gone once delivered.
    env.clock.advance(60 * 60_000);
    expect(await outbox.flush()).toEqual({ delivered: 0, waiting: 0, dropped: 0 });
    expect(env.sent).toHaveLength(2);
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

  it('drops a notification that is no longer news', async () => {
    const env = make({ answer: () => sentOk });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    env.clock.advance(OUTBOX_MAX_AGE_MS + 1);
    expect(await outbox.flush()).toEqual({ delivered: 0, waiting: 0, dropped: 1 });
    expect(env.sent).toHaveLength(0);
  });

  it('counts an attempt that was cut short, and makes it again later', async () => {
    let hang = true;
    const env = make({ answer: () => sentOk });
    // A pager that does not answer within the time the caller has.
    env.mindly.kernel.ports.notifier = {
      send: (n) => {
        env.sent.push(n);
        return hang ? new Promise(() => undefined) : Promise.resolve(sentOk);
      },
    };
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    const started = Date.now();
    expect(await outbox.flush({ budgetMs: 80 })).toEqual({ delivered: 0, waiting: 1, dropped: 0 });
    expect(Date.now() - started).toBeLessThan(1000);

    hang = false;
    env.clock.advance(31_000);
    expect(await outbox.flush()).toEqual({ delivered: 1, waiting: 0, dropped: 0 });
    expect(env.sent).toHaveLength(2);
  });

  it('is not sent twice by two flushes at once', async () => {
    const env = make({ answer: () => sentOk });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue(page);
    const both = await Promise.all([outbox.flush(), outbox.flush()]);
    expect(env.sent).toHaveLength(1);
    expect(both.map((r) => r.delivered).sort()).toEqual([0, 1]);
  });

  it('stores a cleaned copy and needs nothing sent when the trigger is off', async () => {
    const env = make({
      answer: () => [{ channel: 'webhook', status: 'skipped', reason: 'trigger_disabled' }],
    });
    const outbox = notifyOutbox(env.mindly);
    outbox.enqueue({ ...page, title: `line one\nline two ${'x'.repeat(500)}` });
    expect(await outbox.flush()).toEqual({ delivered: 1, waiting: 0, dropped: 0 });
    expect(env.sent[0]!.title).not.toContain('\n');
    expect(env.sent[0]!.title.length).toBeLessThanOrEqual(200);
  });
});
