import { describe, expect, it } from 'vitest';
import { impactOf, surfaceKey } from '../../src/index.js';
import { event, writeTool } from '../helpers.js';
import { AUTH_V1, featureSetup } from './fixtures.js';

const AUTH_V2 = [
  'export function signIn(user: string) {',
  '  return { role: "admin" };',
  '}',
  'export const VERSION = 2;',
  '',
].join('\n');

describe('impact radar', () => {
  it('tells Codex when Claude removes an export its file depends on', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    // Codex is about to edit the dashboard, which imports src/auth.ts.
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/dashboard.ts', 'x') }),
    );

    write('src/auth.ts', AUTH_V2);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'export function signIn(user: string) {'),
      }),
    );

    const conflicts = mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.severity).toBe('critical');
    expect(conflicts[0]!.sessionIds.sort()).toEqual([cc.id, cx.id].sort());

    const res = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'continue with the dashboard' }),
    );
    expect(res.context).toMatch(/claude-code #[0-9a-f]{8} changed the exports of src\/auth\.ts/);
    expect(res.context).toContain('Removed: login');
    expect(res.context).toContain('Added: signIn');
    expect(res.context).toContain('Your files that import it: src/dashboard.ts');
    // The surface is stored for the next comparison.
    expect(mindly.store.kv.get(surfaceKey(pid, 'src/auth.ts'))).toEqual({
      signIn: 'function(user:string){',
      VERSION: 'const',
    });
    // Claude itself is not told about its own change.
    const ccDeliveries = mindly.store.deliveries
      .list(pid)
      .filter((d) => d.targetSessionId === cc.id && d.kind === 'impact');
    expect(ccDeliveries).toHaveLength(0);
  });

  it('flags changed signatures as a warning and ignores additive changes', async () => {
    const { root, mindly, pid, write } = await featureSetup();
    // Codex recently edited the dashboard (file_changes), no explicit intent needed.
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );

    write('src/auth.ts', AUTH_V1 + 'export function logout() {}\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'logout') }),
    );
    expect(mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact')).toHaveLength(0);

    write(
      'src/auth.ts',
      AUTH_V1.replace('login(user: string)', 'login(user: string, otp: string)') +
        'export function logout() {}\n',
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'otp') }),
    );
    const impact = mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact');
    expect(impact).toHaveLength(1);
    expect(impact[0]!.severity).toBe('warning');
    expect(impact[0]!.detail).toContain('Changed signature: login');
  });

  it('seeds the surface on first sight when HEAD is unavailable', async () => {
    const { root, mindly, pid, repo, cc } = await featureSetup();
    delete repo.head['src/auth.ts'];
    const reports = await impactOf(mindly).onFilesChanged({
      projectId: pid,
      projectRoot: root,
      session: cc,
      files: [
        {
          path: 'src/auth.ts',
          abs: `${root}/src/auth.ts`,
          addedText: '',
          removedText: '',
          wholeFile: false,
        },
      ],
    });
    expect(reports).toEqual([]);
    expect(mindly.store.kv.get(surfaceKey(pid, 'src/auth.ts'))).toHaveProperty('login');
  });

  it('swallows port failures without affecting the hook', async () => {
    const { root, mindly, pid, write } = await featureSetup();
    mindly.kernel.ports.git.dependentsOf = async () => {
      throw new Error('boom');
    };
    write('src/auth.ts', 'export const VERSION = 3;\n');
    const res = await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'v3') }),
    );
    expect(res.decision).toBeNull();
    expect(mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact')).toHaveLength(0);
  });
});
