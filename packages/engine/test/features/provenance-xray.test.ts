import { isSynapseError } from '@synapse/core';
import { describe, expect, it } from 'vitest';
import { provenanceOf, USER, xrayOf } from '../../src/index.js';
import { event, writeTool } from '../helpers.js';
import { AUTH_V1, featureSetup } from './fixtures.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return isSynapseError(err) ? err.code : 'other';
  }
  return 'none';
}

describe('code provenance', () => {
  it('maps a line back to the agent and prompt that wrote it', async () => {
    const { root, synapse, pid, cc, write } = await featureSetup();
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', {
        prompt: 'Add a guard so login rejects empty users',
      }),
    );
    const guard = '  if (!user) throw new Error("no user");';
    write('src/auth.ts', AUTH_V1.replace('{\n', `{\n${guard}\n`));
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', guard) }),
    );
    synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Login guards empty users',
      body: 'z',
      source: USER,
      evidence: [{ path: 'src/auth.ts', excerpt: 'throw new Error("no user")' }],
    });

    const why = provenanceOf(synapse).why(pid, root, 'src/auth.ts', 2);
    expect(why.text).toBe('if (!user) throw new Error("no user");');
    expect(why.changes).toHaveLength(1);
    expect(why.changes[0]).toMatchObject({
      sessionId: cc.id,
      agentKind: 'claude-code',
      tool: 'Edit',
      prompt: 'Add a guard so login rejects empty users',
    });
    expect(why.changes[0]!.label).toMatch(/^claude-code #/);
    expect(why.memories.map((m) => m.title)).toEqual(['Login guards empty users']);

    const unknown = provenanceOf(synapse).why(pid, root, 'src/auth.ts', 5);
    expect(unknown.changes).toEqual([]);
  });

  it('rejects unsafe or invalid input', async () => {
    const { root, synapse, pid } = await featureSetup();
    const p = provenanceOf(synapse);
    expect(codeOf(() => p.why(pid, root, '../outside.ts', 1))).toBe('path_outside_project');
    expect(codeOf(() => p.why(pid, root, '.env', 1))).toBe('forbidden');
    expect(codeOf(() => p.why(pid, root, 'src/auth.ts', 0))).toBe('invalid_input');
    expect(codeOf(() => p.why(pid, root, 'src/auth.ts', 999))).toBe('invalid_input');
    expect(codeOf(() => p.why(pid, root, 'src/nope.ts', 1))).toBe('not_found');
  });
});

describe('context x-ray', () => {
  it('shows omitted items and explains why a memory did not reach the session', async () => {
    const { root, synapse, pid, cx } = await featureSetup();
    const long = 'Postgres connection pooling details. '.repeat(12);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        synapse.memory.remember({
          projectId: pid,
          projectRoot: root,
          kind: 'fact',
          title: `Database fact number ${i}`,
          body: long,
          source: USER,
        }).id,
      );
    }
    const stale = synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Database legacy driver',
      body: 'old',
      source: USER,
    });
    synapse.memory.markStale(stale.id, 'test');
    const branchOnly = synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'fact',
      title: 'Database feature branch schema',
      body: 'branch only',
      source: USER,
      branch: 'feature-x',
    });

    await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'database pooling setup' }),
    );

    const xray = xrayOf(synapse);
    const view = xray.session(cx.id);
    const packet = view.packets.find((p) => p.trigger === 'prompt')!;
    expect(packet.included.length).toBeGreaterThan(0);
    expect(packet.omitted.length).toBeGreaterThan(0);
    expect(packet.omitted[0]!.reason).toContain('over token budget');

    const omittedId = packet.omitted[0]!.ref;
    const mem = xray.memory(pid, omittedId);
    expect(mem.omittedCount).toBe(1);
    expect(mem.appearances[0]).toMatchObject({ sessionId: cx.id, status: 'omitted' });

    const missing = xray.explainMissing(cx.id, 'database pooling setup');
    const reasons = new Map(missing.items.map((i) => [i.memoryId, i.reason]));
    expect(reasons.get(packet.included.find((i) => i.kind === 'memory')!.ref)).toBe(
      'already_served',
    );
    // Served items no longer compete for the budget, so the omitted one would fit now; the
    // recorded packet still shows why it was left out last time.
    const omittedItem = missing.items.find((i) => i.memoryId === omittedId)!;
    expect(omittedItem.reason).toBe('included');
    expect(omittedItem.lastSeen).toMatchObject({ status: 'omitted', packetId: packet.id });
    expect(omittedItem.lastSeen!.reason).toContain('over token budget');
    expect(missing.items.some((i) => i.reason === 'budget')).toBe(true);
    expect(reasons.get(stale.id)).toBe('trust_filter');
    expect(reasons.get(branchOnly.id)).toBe('branch_filter');
    expect(missing.tokenBudget).toBe(synapse.config.context.promptTokens);
  });

  it('rejects a memory from another project', async () => {
    const { root, synapse, pid } = await featureSetup();
    const m = synapse.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'note',
      title: 'n',
      body: 'b',
      source: USER,
    });
    expect(codeOf(() => xrayOf(synapse).memory('other-project', m.id))).toBe('not_found');
  });
});
