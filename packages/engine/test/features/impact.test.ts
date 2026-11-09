import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('keeps a separate baseline for each linked worktree', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    const changed = (base: string) => ({
      path: 'src/auth.ts',
      abs: `${base}/src/auth.ts`,
      addedText: '',
      removedText: '',
      wholeFile: false,
    });
    // Codex works in a linked worktree that still holds the original file.
    const tree = realpathSync(mkdtempSync(join(tmpdir(), 'syn-feat-wt-')));
    mkdirSync(join(tree, 'src'));
    writeFileSync(join(tree, 'src', 'auth.ts'), AUTH_V1);

    // Claude changes the signature in the main checkout.
    write(
      'src/auth.ts',
      AUTH_V1.replace('login(user: string)', 'login(user: string, otp: string)'),
    );
    await impactOf(mindly).onFilesChanged({
      projectId: pid,
      projectRoot: root,
      session: cc,
      files: [changed(root)],
    });
    const before = mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact').length;

    // Codex edits only the body of its own, unchanged copy: nothing changed in its tree.
    writeFileSync(join(tree, 'src', 'auth.ts'), AUTH_V1.replace('"admin"', '"owner"'));
    const reports = await impactOf(mindly).onFilesChanged({
      projectId: pid,
      projectRoot: root,
      session: cx,
      files: [changed(tree)],
    });
    expect(reports).toEqual([]);
    expect(mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact')).toHaveLength(
      before,
    );
    // Each checkout has its own stored surface.
    expect(mindly.store.kv.get(surfaceKey(pid, 'src/auth.ts'))).toMatchObject({
      login: 'function(user:string,otp:string){',
    });
    expect(mindly.store.kv.get(surfaceKey(pid, 'src/auth.ts', tree))).toMatchObject({
      login: 'function(user:string){',
    });
  });

  it('does not blame an agent for exports a commit changed in between', async () => {
    const { root, mindly, pid, repo, write } = await featureSetup();
    const NO_VERSION = AUTH_V1.replace('export const VERSION = 1;\n', '');
    const commits: Record<string, string> = { h1: AUTH_V1, h2: NO_VERSION };
    let head = 'h1';
    const git = mindly.kernel.ports.git;
    git.headCommit = async () => head;
    git.fileStateAtRef = async (_cwd, ref, path) =>
      path === 'src/auth.ts' && commits[ref] !== undefined
        ? { state: 'file', content: commits[ref] }
        : { state: 'no_ref' };
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    // Claude touches the file once, so its surface is stored.
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );

    // Someone removes VERSION by hand and commits it: no agent edit saw that.
    write('src/auth.ts', NO_VERSION);
    repo.head['src/auth.ts'] = NO_VERSION;
    head = 'h2';

    // Claude now edits only a body.
    write('src/auth.ts', NO_VERSION.replace('"admin"', '"owner"'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'owner') }),
    );
    expect(mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact')).toHaveLength(0);

    // A commit that leaves the exports alone keeps the stored surface: an uncommitted change made
    // before it is still compared against what the agents last saw.
    commits.h3 = NO_VERSION;
    head = 'h3';
    write(
      'src/auth.ts',
      NO_VERSION.replace('login(user: string)', 'login(user: string, otp: string)'),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'otp') }),
    );
    const impact = mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact');
    expect(impact).toHaveLength(1);
    expect(impact[0]!.detail).toContain('Changed signature: login');
  });

  it('closes the conflict and tells the others when a removed export is restored', async () => {
    const { root, mindly, pid, cx, write } = await featureSetup();
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    write('src/auth.ts', AUTH_V2);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'signIn') }),
    );
    const opened = mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact');
    expect(opened.map((c) => c.status)).toEqual(['open']);

    // An unrelated edit leaves the conflict open.
    write('src/auth.ts', AUTH_V2 + 'export function logout() {}\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'logout') }),
    );
    expect(mindly.store.conflicts.get(opened[0]!.id).status).toBe('open');

    // Putting `login` back as it was closes it.
    write('src/auth.ts', AUTH_V2 + AUTH_V1.split('\n').slice(0, 3).join('\n') + '\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'login') }),
    );
    expect(mindly.store.conflicts.get(opened[0]!.id).status).toBe('resolved');
    const told = mindly.store.deliveries
      .list(pid)
      .filter((d) => d.targetSessionId === cx.id && d.kind === 'impact')
      .map((d) => d.title);
    expect(told.some((t) => /restored the exports of src\/auth\.ts/.test(t))).toBe(true);
  });
});
