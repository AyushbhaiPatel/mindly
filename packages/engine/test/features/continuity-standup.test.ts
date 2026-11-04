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
    const { root, clock, synapse, sent } = env;
    synapse.use(standupModule);
    await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    clock.advance(1000);
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: `Please look at ${SECRET} today` }),
    );
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'const secretCode = 42;'),
      }),
    );
    await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'stop'));
    await synapse.hooks.handle(event(root, 'codex', 'cx', 'session_start'));

    const pid = synapse.store.projects.list()[0]!.id;
    const cx = synapse.store.sessions.findByExternal(pid, 'codex', 'cx')!;
    synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'Use Postgres',
      body: `because ${SECRET}`,
      source: USER,
    });
    synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'rule',
      title: 'Prefer named exports',
      body: 'b',
      source: { type: 'agent', sessionId: cx.id, agentKind: 'codex' },
    });
    synapse.store.conflicts.report({
      projectId: pid,
      kind: 'contract_broken',
      severity: 'critical',
      title: 'Login contract broken',
      detail: SECRET,
      sessionIds: [cx.id],
      paths: ['src/auth.ts'],
      fingerprint: 'fp1',
    });
    const blocked = synapse.tasks.create({ projectId: pid, title: 'Deploy pipeline' });
    synapse.tasks.update(blocked.id, { status: 'blocked' }, null);
    await failoverService(synapse).handoffs.create(cx, {
      toAgentKind: 'cursor',
      summary: `Continue ${SECRET}`,
    });

    const svc = standupService(synapse);
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

  it('computes the scheduled time in local time', () => {
    const now = new Date(2026, 10, 4, 10, 30).getTime();
    expect(standupDueAt('09:00', now)).toBe(new Date(2026, 10, 4, 9, 0).getTime());
    expect(standupDueAt('11:15', now)).toBe(new Date(2026, 10, 3, 11, 15).getTime());
    expect(standupDueAt('25:00', now)).toBeNull();
    const env = make();
    expect(standupService(env.synapse).dueAt(now)).toBeNull();
  });
});
