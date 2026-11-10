import { normalizeLine, sha256 } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { excerptPresent, selfHealingOf } from '../../src/index.js';
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

  it('keeps a redacted excerpt that is part of a longer line valid while the file is unchanged', async () => {
    const { root, mindly, pid, cc, write } = await featureSetup();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    const file = `export const client = connect({ region: "eu", token: "${secret}", retries: 3 });\n`;
    write('src/client.ts', file);
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The client retries three times',
      body: 'connect() is called with retries: 3',
      source: agentSource(cc),
      evidence: [{ path: 'src/client.ts', excerpt: `token: "${secret}", retries: 3` }],
    });
    const stored = mindly.store.memories.evidenceFor(m.id)[0]!;
    expect(stored.excerpt).toContain('[REDACTED]');
    expect(stored.excerpt).not.toContain(secret);

    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 0, markedStale: 0 });
    expect(mindly.store.memories.get(m.id).trust).not.toBe('stale');
    expect(mindly.store.deliveries.list(pid).filter((d) => d.kind === 'stale_memory')).toEqual([]);

    // The text around the secret is gone: the evidence no longer holds.
    write('src/client.ts', file.replace('retries: 3', 'retries: 5'));
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 1, markedStale: 1 });
  });

  it('matches a redacted fragment by what surrounds the secret', () => {
    const line = 'const c = connect({ token: "abcdef123456", retries: 3 });';
    const stored = 'token: "[REDACTED]", retries: 3';
    const hash = sha256(normalizeLine('token: "abcdef123456", retries: 3'));
    expect(excerptPresent(`// x\n${line}\n`, stored, hash)).toBe(true);
    // Another value in the same place is not the text the evidence was taken from.
    expect(excerptPresent(line.replace('abcdef123456', 'zzzzzz999999'), stored, hash)).toBe(false);
    expect(excerptPresent(line.replace('retries: 3', 'retries: 4'), stored, hash)).toBe(false);
    // A secret that opens the excerpt leaves no start to hash from: the rest decides.
    const open = '[REDACTED]", retries: 3';
    const tail = sha256(normalizeLine('abcdef123456", retries: 3'));
    expect(excerptPresent(line, open, tail)).toBe(true);
    expect(excerptPresent(line.replace('retries: 3', 'retries: 4'), open, tail)).toBe(false);
  });
});
