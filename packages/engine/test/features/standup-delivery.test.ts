import { describe, expect, it } from 'vitest';
import { standupDueAt, standupModule, standupService } from '../../src/index.js';
import { event } from '../helpers.js';
import { make } from './continuity-helpers.js';

describe('standup delivery', () => {
  it('does not depend on the trigger list: setting the time asks for it', async () => {
    const env = make({
      config: (c) => {
        c.standup.time = '09:00';
      },
    });
    env.mindly.use(standupModule);
    await env.mindly.hooks.handle(event(env.root, 'claude-code', 'cc', 'session_start'));
    const pid = env.mindly.store.projects.list()[0]!.id;
    expect(env.mindly.config.notify.triggers).not.toContain('standup');
    expect(await standupService(env.mindly).notify(pid)).toBe(true);
    expect(env.sent.map((n) => n.trigger)).toEqual(['standup']);
    expect(env.sentOptions[0]).toEqual({ ignoreTriggers: true });
  });

  it('says so when the summary reached no channel', async () => {
    let down = true;
    const env = make({
      config: (c) => {
        c.standup.time = '09:00';
      },
      answer: () =>
        down
          ? [{ channel: 'webhook', status: 'failed', reason: 'webhook request failed' }]
          : [{ channel: 'webhook', status: 'sent' }],
    });
    env.mindly.use(standupModule);
    await env.mindly.hooks.handle(event(env.root, 'claude-code', 'cc', 'session_start'));
    const pid = env.mindly.store.projects.list()[0]!.id;
    const svc = standupService(env.mindly);
    expect(await svc.notify(pid)).toBe(false);
    down = false;
    expect(await svc.notify(pid)).toBe(true);
    expect(env.sent).toHaveLength(2);
  });

  it('fires once a day when the time falls in the hour skipped by daylight saving', () => {
    const tz = process.env['TZ'];
    process.env['TZ'] = 'America/New_York';
    try {
      // 2026-03-08: clocks go from 02:00 to 03:00, so 02:30 does not exist that day.
      const minute = 60_000;
      let last = 0;
      const fired: string[] = [];
      const start = Date.UTC(2026, 2, 7, 0, 0);
      for (let now = start; now < start + 3 * 24 * 60 * minute; now += minute) {
        const due = standupDueAt('02:30', now)!;
        if (last < due) {
          fired.push(new Date(now).toISOString());
          last = now;
        }
      }
      expect(fired).toEqual([
        // The loop starts with nothing delivered, so the first minute fires for the day before.
        '2026-03-07T00:00:00.000Z',
        '2026-03-07T07:30:00.000Z', // Sat 02:30 EST
        '2026-03-08T07:30:00.000Z', // Sun 03:30 EDT: the skipped time lands an hour later
        '2026-03-09T06:30:00.000Z', // Mon 02:30 EDT
      ]);
    } finally {
      if (tz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = tz;
    }
  });

  it('fires once a day when clocks go back', () => {
    const tz = process.env['TZ'];
    process.env['TZ'] = 'America/New_York';
    try {
      // 2026-11-01: 01:30 happens twice.
      const minute = 60_000;
      let last = 0;
      let fired = 0;
      const start = Date.UTC(2026, 9, 31, 12, 0);
      for (let now = start; now < start + 2 * 24 * 60 * minute; now += minute) {
        const due = standupDueAt('01:30', now)!;
        if (last < due) {
          fired++;
          last = now;
        }
      }
      // The first minute (for the day before), then Nov 1 and Nov 2.
      expect(fired).toBe(3);
    } finally {
      if (tz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = tz;
    }
  });
});
