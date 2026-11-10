import { describe, expect, it } from 'vitest';
import {
  failoverService,
  standupDueAt,
  standupModule,
  standupService,
  USER,
} from '../../src/index.js';
import { event, writeTool } from '../helpers.js';
import { make } from './continuity-helpers.js';

const SECRET = 'PURPLE-OCTOPUS-PROMPT';

describe('morning standup', () => {
  it('builds a digest with activity and items that need the user', async () => {
    const env = make({
      config: (c) => {
        c.standup.time = '09:00';
      },
    });
    const { root, clock, mindly, sent } = env;
    mindly.use(standupModule);
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    clock.advance(1000);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: `Please look at ${SECRET} today` }),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'const secretCode = 42;'),
      }),
    );
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'stop'));
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));

    const pid = mindly.store.projects.list()[0]!.id;
    const cx = mindly.store.sessions.findByExternal(pid, 'codex', 'cx')!;
    mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'Use Postgres',
      body: `because ${SECRET}`,
      source: USER,
    });
    mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'rule',
      title: 'Prefer named exports',
      body: 'b',
      source: { type: 'agent', sessionId: cx.id, agentKind: 'codex' },
    });
    mindly.store.conflicts.report({
      projectId: pid,
      kind: 'contract_broken',
      severity: 'critical',
      title: 'Login contract broken',
      detail: SECRET,
      sessionIds: [cx.id],
      paths: ['src/auth.ts'],
      fingerprint: 'fp1',
    });
    const blocked = mindly.tasks.create({ projectId: pid, title: 'Deploy pipeline' });
    mindly.tasks.update(blocked.id, { status: 'blocked' }, null);
    await failoverService(mindly).handoffs.create(cx, {
      toAgentKind: 'cursor',
      summary: `Continue ${SECRET}`,
    });

    const svc = standupService(mindly);
    const d = svc.build(pid);
    const cc = d.agents.find((a) => a.agentKind === 'claude-code')!;
    expect(cc).toMatchObject({ sessions: 1, turns: 1, filesChanged: 1, topFiles: ['src/auth.ts'] });
    expect(d.agents.find((a) => a.agentKind === 'codex')?.sessions).toBe(1);
    expect(d.memories.decisions.map((m) => m.title)).toEqual(['Use Postgres']);
    expect(d.conflicts).toEqual({ opened: 1, resolved: 0, open: 1 });
    expect(d.blockedTasks.map((t) => t.title)).toEqual(['Deploy pipeline']);
    expect(d.handoffs).toHaveLength(1);
    expect(d.needsYou.proposedRules.map((m) => m.title)).toEqual(['Prefer named exports']);
    expect(d.needsYou.criticalConflicts.map((c) => c.title)).toEqual(['Login contract broken']);
    expect(d.needsYou.unclaimedHandoffs[0]).toMatchObject({
      fromAgentKind: 'codex',
      toAgentKind: 'cursor',
      reason: 'manual',
    });

    const text = svc.render(d);
    expect(text).toContain('## Needs you');
    expect(text).toContain('Prefer named exports');
    expect(text).toContain('codex -> cursor (manual)');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('secretCode');
    expect(text.split('\n').length).toBeLessThanOrEqual(25);

    expect(await svc.notify(pid, d)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.trigger).toBe('standup');
    // Setting the time asks for the standup: it does not depend on `notify.triggers`.
    expect(env.sentOptions[0]).toEqual({ ignoreTriggers: true });
    expect(JSON.stringify(sent)).not.toContain(SECRET);

    // Delivery moves the window forward.
    expect(svc.isDue(pid)).toBe(true);
    clock.advance(1000);
    svc.markDelivered(pid);
    expect(svc.isDue(pid)).toBe(false);
    const next = svc.build(pid);
    expect(next.agents).toEqual([]);
    expect(next.memories.decisions).toEqual([]);
    expect(next.needsYou.proposedRules).toHaveLength(1);
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

  it('computes the scheduled time in local time', () => {
    const now = new Date(2026, 10, 4, 10, 30).getTime();
    expect(standupDueAt('09:00', now)).toBe(new Date(2026, 10, 4, 9, 0).getTime());
    expect(standupDueAt('11:15', now)).toBe(new Date(2026, 10, 3, 11, 15).getTime());
    expect(standupDueAt('25:00', now)).toBeNull();
    const env = make();
    expect(standupService(env.mindly).dueAt(now)).toBeNull();
  });
});
