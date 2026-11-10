import { symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLine, sha256 } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { evidenceState, excerptPresent, selfHealingOf } from '../../src/index.js';
import { event, writeTool } from '../helpers.js';
import { agentSource, AUTH_V1, featureSetup } from './fixtures.js';

describe('self-healing memory', () => {
  it('marks a memory stale when its evidence disappears and tells every live session', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    const m = mindly.memory.remember({
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
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'return { role: "user" };'),
      }),
    );

    expect(mindly.store.memories.get(m.id).trust).toBe('stale');
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.valid).toBe(false);
    const stale = mindly.store.deliveries.list(pid).filter((d) => d.kind === 'stale_memory');
    expect(stale.map((d) => d.targetSessionId).sort()).toEqual([cc.id, cx.id].sort());

    const res = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'what next' }),
    );
    expect(res.context).toContain(
      'Memory "Login returns the admin role" may be outdated because src/auth.ts changed',
    );

    // The excerpt comes back: evidence is valid again, trust stays stale for the user to restore.
    write('src/auth.ts', AUTH_V1);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'return { role: "admin" };'),
      }),
    );
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.valid).toBe(true);
    expect(mindly.store.memories.get(m.id).trust).toBe('stale');
    expect(mindly.store.events.query(pid, { types: ['memory.stale'] })).toHaveLength(1);
  });

  it('sweeps all evidence of a project, including deleted files', async () => {
    const { root, mindly, pid, write } = await featureSetup();
    const a = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'decision',
      title: 'Dashboard imports login',
      body: 'x',
      source: { type: 'user', sessionId: null, agentKind: null },
      evidence: [{ path: 'src/dashboard.ts', excerpt: "import { login } from './auth';" }],
    });
    const b = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Auth module exists',
      body: 'y',
      source: { type: 'user', sessionId: null, agentKind: null },
      evidence: [{ path: 'src/auth.ts' }],
    });
    write('src/dashboard.ts', 'export const view = 1;\n');
    const result = selfHealingOf(mindly).sweep(pid);
    expect(result).toEqual({ checked: 2, invalid: 1, markedStale: 1, restored: 0 });
    expect(mindly.store.memories.get(a.id).trust).toBe('stale');
    expect(mindly.store.memories.get(b.id).trust).toBe('approved');
    // No live session other than the two fixtures: both are told.
    expect(mindly.store.deliveries.list(pid).filter((d) => d.kind === 'stale_memory')).toHaveLength(
      2,
    );
  });

  it('matches redacted excerpts through the stored content hash', () => {
    const original = 'const key = "abc";\nconnect(key);';
    const hash = sha256(original.split('\n').map(normalizeLine).join('\n'));
    const content = `// header\n  const key = "abc";\nconnect(key);\n`;
    expect(excerptPresent(content, 'const key = "[REDACTED]";\nconnect(key);', hash)).toBe(true);
    expect(excerptPresent('other', 'const key = "[REDACTED]";\nconnect(key);', hash)).toBe(false);
    expect(excerptPresent('a\n   b   c\n', 'b c', null)).toBe(true);
  });

  it('judges evidence the same way on a restatement as in a sweep', async () => {
    const { root, mindly, pid, write } = await featureSetup();
    write('src/kept.ts', 'export const KEPT_VALUE_FOR_TEST = 1;\n');
    write('src/changed.ts', 'export const CHANGED_VALUE_FOR_TEST = 1;\n');
    write('src/gone.ts', 'export const GONE_VALUE_FOR_TEST = 1;\n');
    write('.env', 'SECRET_VALUE_FOR_TEST=1\n');
    symlinkSync(tmpdir(), join(root, 'outside'));
    const rows = [
      { ref: 'src/kept.ts', excerpt: 'KEPT_VALUE_FOR_TEST = 1', contentHash: null },
      { ref: 'src/changed.ts', excerpt: 'CHANGED_VALUE_FOR_TEST = 1', contentHash: null },
      { ref: 'src/gone.ts', excerpt: 'GONE_VALUE_FOR_TEST = 1', contentHash: null },
      { ref: 'src/gone.ts', excerpt: null, contentHash: null },
      { ref: '.env', excerpt: 'SECRET_VALUE_FOR_TEST=1', contentHash: null },
      { ref: 'outside/x.ts', excerpt: null, contentHash: null },
    ];
    // Stored directly: the deny-listed and outside paths could never be given as evidence now.
    const m = mindly.store.memories.create({
      projectId: pid,
      kind: 'fact',
      title: 'Parity',
      body: '',
      trust: 'approved',
      source: { type: 'user', sessionId: null, agentKind: null },
    });
    for (const r of rows) {
      mindly.store.memories.addEvidence({ memoryId: m.id, projectId: pid, type: 'file', ...r });
    }
    write('src/changed.ts', 'export const CHANGED_VALUE_FOR_TEST = 2;\n');
    unlinkSync(join(root, 'src', 'gone.ts'));
    const deny = mindly.config.redaction.denyPaths;
    const before = mindly.store.memories.evidenceFor(m.id);
    const states = before.map((e) => evidenceState(root, deny, e));
    expect(states).toEqual(['valid', 'invalid', 'invalid', 'invalid', 'unknown', 'unknown']);
    selfHealingOf(mindly).sweep(pid);
    // The sweep marks exactly the rows a restatement would drop; the rest keep their validity.
    expect(mindly.store.memories.evidenceFor(m.id).map((e) => e.valid)).toEqual(
      states.map((s) => s !== 'invalid'),
    );
  });
});
