import { describe, expect, it } from 'vitest';
import { USER } from '../src/index.js';
import { event, setup, shellTool, writeTool } from './helpers.js';

describe('hook flow', () => {
  it('captures a rule from one agent and delivers it to the other', async () => {
    const { root, synapse } = setup();
    await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await synapse.hooks.handle(event(root, 'codex', 'cx', 'session_start'));

    const res = await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', {
        prompt: 'No, use pnpm. From now on always use pnpm instead of npm.',
      }),
    );
    expect(res.userMessage).toMatch(/project rule/);

    const codex = await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'add a dependency' }),
    );
    expect(codex.context).toContain('New project rule');
    expect(codex.context).toContain('pnpm');

    const fresh = await synapse.hooks.handle(event(root, 'cursor', 'cu', 'session_start'));
    expect(fresh.context).toContain('Project rules (from the user)');
    expect(fresh.context).toMatch(/always use pnpm/i);
  });

  it('delivers each update once and acknowledges it on the next turn', async () => {
    const { root, synapse } = setup();
    await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await synapse.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'We always use tabs in Makefiles.' }),
    );
    const first = await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'hello' }),
    );
    expect(first.context).toContain('New project rule');
    const second = await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'hello again' }),
    );
    expect(second.context ?? '').not.toContain('New project rule');
    const pid = synapse.store.projects.list()[0]!.id;
    expect(synapse.store.deliveries.list(pid, { statuses: ['acked'] })).toHaveLength(1);
  });

  it('warns about overlapping edits and notifies the other agent', async () => {
    const { root, synapse } = setup();
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    const res = await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool(`${root}/src/auth.ts`, 'y') }),
    );
    expect(res.context).toContain('Coordination warning');
    expect(res.context).toContain('src/auth.ts');
    const pid = synapse.store.projects.list()[0]!.id;
    expect(synapse.store.conflicts.list(pid)[0]?.kind).toBe('intent_overlap');
    const cc = await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }),
    );
    expect(cc.context).toContain('started editing src/auth.ts');
  });

  it('denies writes only for user-enforced scoped rules', async () => {
    const { root, synapse } = setup();
    const ctx = await synapse.projects.resolve(root);
    synapse.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'src/generated is produced by codegen',
      scopePaths: ['src/generated/**'],
      source: USER,
      enforce: true,
    });
    const denied = await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/generated/api.ts', 'x') }),
    );
    expect(denied.decision).toBe('deny');
    const allowed = await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    expect(allowed.decision).toBeNull();
  });

  it('ignores writes outside the project and to denied paths', async () => {
    const { root, synapse } = setup();
    for (const p of ['/etc/passwd', '.env', '../outside.ts']) {
      await synapse.hooks.handle(
        event(root, 'codex', 'cx', 'post_tool', { tool: writeTool(p, 'SECRET=1') }),
      );
    }
    const pid = synapse.store.projects.list()[0]!.id;
    expect(synapse.store.events.query(pid, { types: ['file.changed'] })).toHaveLength(0);
  });

  it('records provenance for written lines', async () => {
    const { root, synapse } = setup();
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'add admin role' }),
    );
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', '  return { role: "admin" };'),
      }),
    );
    const pid = synapse.store.projects.list()[0]!.id;
    const changes = synapse.store.fileChanges.forPath(pid, 'src/auth.ts');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.promptEventId).not.toBeNull();
  });

  it('remembers failing commands and warns before they are repeated', async () => {
    const { root, synapse } = setup();
    await synapse.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: shellTool(
          'npm test -- --watch',
          true,
          'ERR! missing script: test TOKEN=abcdef123456',
        ),
      }),
    );
    const res = await synapse.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool('npm test') }),
    );
    expect(res.context).toContain('failed before');
    expect(res.context).not.toContain('abcdef123456');
  });

  it('never throws, even for a missing working directory', async () => {
    const { synapse } = setup();
    const res = await synapse.hooks.handle(
      event('/definitely/not/here', 'codex', 'cx', 'session_start'),
    );
    expect(res).toEqual({ context: null, decision: null, reason: null, userMessage: null });
  });

  it('hands off a task to the next session of another agent', async () => {
    const { root, synapse } = setup();
    await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const pid = synapse.store.projects.list()[0]!.id;
    const cc = synapse.store.sessions.list(pid)[0]!;
    synapse.store.handoffs.create({
      projectId: pid,
      fromSessionId: cc.id,
      toAgentKind: 'codex',
      taskId: null,
      reason: 'rate_limit',
      summary: 'Finish the auth refactor',
      packet: {
        goal: 'Finish the auth refactor',
        plan: [
          { text: 'update login', done: true },
          { text: 'update tests', done: false },
        ],
        filesChanged: ['src/auth.ts'],
        recentPrompts: [],
        decisions: [],
        blockers: [],
        nextSteps: ['update tests'],
        branch: 'main',
        headCommit: null,
      },
    });
    const res = await synapse.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(res.context).toContain('Handoff for you');
    expect(res.context).toContain('usage limit');
    expect(synapse.store.handoffs.list(pid)[0]?.status).toBe('claimed');
  });
});
