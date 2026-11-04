import { normalizeLine, sha256 } from '@synapse/core';
import { describe, expect, it } from 'vitest';
import { excerptPresent, selfHealingOf } from '../../src/index.js';
import { event, writeTool } from '../helpers.js';
import { agentSource, AUTH_V1, featureSetup } from './fixtures.js';

describe('self-healing memory', () => {
  it('marks a memory stale when its evidence disappears and tells every live session', async () => {
    const { root, synapse, pid, cc, cx, write } = await featureSetup();
    const m = synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Login returns the admin role',
      body: 'login() always returns role admin',
      source: agentSource(cx),
      evidence: [{ path: 'src/auth.ts', excerpt: 'return { role: "admin" };' }],
    });
    expect(m.trust).toBe('verified');

    write('src/auth.ts', AUTH_V1.replace('return { role: "admin" };', 'return { role: "user" };'));
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'return { role: "user" };'),
      }),
    );

    expect(synapse.store.memories.get(m.id).trust).toBe('stale');
    expect(synapse.store.memories.evidenceFor(m.id)[0]!.valid).toBe(false);
    const stale = synapse.store.deliveries.list(pid).filter((d) => d.kind === 'stale_memory');
    expect(stale.map((d) => d.targetSessionId).sort()).toEqual([cc.id, cx.id].sort());

    const res = await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'what next' }),
    );
    expect(res.context).toContain(
      'Memory "Login returns the admin role" may be outdated because src/auth.ts changed',
    );

    // The excerpt comes back: evidence is valid again, trust stays stale for the user to restore.
    write('src/auth.ts', AUTH_V1);
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'return { role: "admin" };'),
      }),
    );
    expect(synapse.store.memories.evidenceFor(m.id)[0]!.valid).toBe(true);
    expect(synapse.store.memories.get(m.id).trust).toBe('stale');
    expect(synapse.store.events.query(pid, { types: ['memory.stale'] })).toHaveLength(1);
  });

  it('sweeps all evidence of a project, including deleted files', async () => {
    const { root, synapse, pid, write } = await featureSetup();
    const a = synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'Dashboard imports login',
      body: 'x',
      source: { type: 'user', sessionId: null, agentKind: null },
      evidence: [{ path: 'src/dashboard.ts', excerpt: "import { login } from './auth';" }],
    });
    const b = synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Auth module exists',
      body: 'y',
      source: { type: 'user', sessionId: null, agentKind: null },
      evidence: [{ path: 'src/auth.ts' }],
    });
    write('src/dashboard.ts', 'export const view = 1;\n');
    const result = selfHealingOf(synapse).sweep(pid);
    expect(result).toEqual({ checked: 2, invalid: 1, markedStale: 1, restored: 0 });
    expect(synapse.store.memories.get(a.id).trust).toBe('stale');
    expect(synapse.store.memories.get(b.id).trust).toBe('approved');
    // No live session other than the two fixtures: both are told.
    expect(
      synapse.store.deliveries.list(pid).filter((d) => d.kind === 'stale_memory'),
    ).toHaveLength(2);
  });

  it('matches redacted excerpts through the stored content hash', () => {
    const original = 'const key = "abc";\nconnect(key);';
    const hash = sha256(original.split('\n').map(normalizeLine).join('\n'));
    const content = `// header\n  const key = "abc";\nconnect(key);\n`;
    expect(excerptPresent(content, 'const key = "[REDACTED]";\nconnect(key);', hash)).toBe(true);
    expect(excerptPresent('other', 'const key = "[REDACTED]";\nconnect(key);', hash)).toBe(false);
    expect(excerptPresent('a\n   b   c\n', 'b c', null)).toBe(true);
  });
});
