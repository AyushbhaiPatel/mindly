import { normalizeLine, sha256 } from '@mindly/core';
import { describe, expect, it } from 'vitest';
import { excerptPresent, excerptState, selfHealingOf } from '../../src/index.js';
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
    // A secret that opens the excerpt: the original starts where a value can start.
    const open = '[REDACTED]", retries: 3';
    const tail = sha256(normalizeLine('abcdef123456", retries: 3'));
    expect(excerptPresent(line, open, tail)).toBe(true);
    expect(excerptPresent(line.replace('retries: 3', 'retries: 4'), open, tail)).toBe(false);
  });
  it('marks a memory stale when a redacted value at the end of its evidence is replaced', async () => {
    const { root, mindly, pid, cc, write } = await featureSetup();
    const secret = ['sk', 'live', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
    write('src/client.yaml', `client:\n  token: ${secret}\n  retries: 3\n`);
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The client token is set inline',
      body: 'src/client.yaml holds the token itself',
      source: agentSource(cc),
      evidence: [{ path: 'src/client.yaml', excerpt: `token: ${secret}` }],
    });
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.excerpt).toBe('token: [REDACTED]');
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 0, markedStale: 0 });

    write('src/client.yaml', 'client:\n  token: ${VAULT_TOKEN}\n  retries: 3\n');
    expect(selfHealingOf(mindly).sweep(pid)).toMatchObject({ invalid: 1, markedStale: 1 });
    expect(mindly.store.memories.get(m.id).trust).toBe('stale');
  });

  it('lets the stored hash decide when a redaction opens or closes the excerpt', () => {
    const hashOf = (t: string) => sha256(t.split('\n').map(normalizeLine).join('\n'));
    // Closing redaction inside a line: the value ends at a separator.
    const line = 'connect({ token: "abcdef123456", retries: 3 });';
    const closing = hashOf('token: "abcdef123456');
    expect(excerptPresent(line, 'token: "[REDACTED]', closing)).toBe(true);
    expect(
      excerptPresent(line.replace('abcdef123456', 'zzzzzz999999'), 'token: "[REDACTED]', closing),
    ).toBe(false);

    // Nothing but a redaction: one value of the file, or nothing.
    const only = hashOf('abcdef123456');
    expect(excerptPresent(line, '[REDACTED]', only)).toBe(true);
    expect(excerptPresent('', '[REDACTED]', only)).toBe(false);
    expect(excerptPresent('export const unrelated = 1;\n', '[REDACTED]', only)).toBe(false);

    // A secret line followed by a plain one, with the secret line removed.
    const two = hashOf('abcdef123456\nmaxRetries = 3');
    const opened = '[REDACTED]\nmaxRetries = 3';
    expect(excerptPresent('x = 1\nabcdef123456\nmaxRetries = 3\n', opened, two)).toBe(true);
    expect(excerptPresent('x = 1\nmaxRetries = 3\n', opened, two)).toBe(false);
    expect(excerptPresent('maxRetries = 3\n', opened, two)).toBe(false);

    // The parts still exist, thousands of lines apart: that is not the excerpt.
    const far = hashOf('abcdef123456\nalpha = 1\nomega = 2');
    const filler = Array.from({ length: 5000 }, (_, i) => `line${i} = ${i}`).join('\n');
    expect(
      excerptPresent(
        `abcdef123456\nalpha = 1\n${filler}\nomega = 2\n`,
        '[REDACTED]\nalpha = 1\nomega = 2',
        far,
      ),
    ).toBe(false);
  });

  it('finds the line behind many lookalikes, and never calls it gone for lack of budget', async () => {
    const stored = 'token: "[REDACTED]", retries: 3';
    const hash = sha256(normalizeLine('token: "abcdef123456", retries: 3'));
    const lookalikes = Array.from(
      { length: 300 },
      (_, i) => `a${i}({ token: "v${i}", retries: 9 });`,
    );
    const real = 'connect({ token: "abcdef123456", retries: 3 });';
    expect(excerptState([...lookalikes, real].join('\n'), stored, hash)).toBe('present');
    expect(excerptState(lookalikes.join('\n'), stored, hash)).toBe('absent');

    // One line of 600 lookalike pairs: more candidates than one check may hash.
    const dense = 'k="v";'.repeat(600);
    const denseHash = sha256('k="abcdef123456";');
    expect(excerptState(dense, 'k="[REDACTED]";', denseHash)).toBe('unknown');

    const { root, mindly, pid, cc, write } = await featureSetup();
    write('src/dense.ts', 'const x = { k="abcdef123456"; };\n');
    const m = mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'The dense file sets k',
      body: 'k is set inline',
      source: agentSource(cc),
      evidence: [{ path: 'src/dense.ts', excerpt: 'k="abcdef123456";' }],
    });
    mindly.store.db
      .prepare('UPDATE memory_evidence SET excerpt = ? WHERE memory_id = ?')
      .run('k="[REDACTED]";', m.id);
    write('src/dense.ts', `${dense}\n`);
    expect(selfHealingOf(mindly).sweep(pid)).toEqual({
      checked: 0,
      invalid: 0,
      markedStale: 0,
      restored: 0,
    });
    expect(mindly.store.memories.evidenceFor(m.id)[0]!.valid).toBe(true);
    expect(mindly.store.memories.get(m.id).trust).not.toBe('stale');
  });
});
