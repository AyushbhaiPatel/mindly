import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { impactOf, SURFACE_FORMAT, surfaceKey, type Mindly } from '../../src/index.js';
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

  // What a released version left behind: the surface alone, with no record of its format.
  const asStoredBefore = (mindly: Mindly, pid: string): void => {
    mindly.store.kv.delete(`surface-state:${pid}:src/auth.ts`);
  };
  const impactConflicts = (mindly: Mindly, pid: string) =>
    mindly.store.conflicts.list(pid).filter((c) => c.kind === 'impact');

  it('still sees an export removed after an upgrade', async () => {
    const { root, mindly, pid, write } = await featureSetup();
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    // Uncommitted: HEAD knows nothing about `logout`, only the stored surface does.
    write('src/auth.ts', AUTH_V1 + 'export function logout() {}\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'logout') }),
    );
    asStoredBefore(mindly, pid);

    write('src/auth.ts', AUTH_V1);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    const impact = impactConflicts(mindly, pid);
    expect(impact).toHaveLength(1);
    expect(impact[0]!.detail).toContain('Removed: logout');
  });

  it('does not report a change twice, or against another agent, after an upgrade', async () => {
    const { root, mindly, pid, cc, write } = await featureSetup();
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    const changed = AUTH_V1.replace('login(user: string)', 'login(user: string, otp: string)');
    write('src/auth.ts', changed);
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'otp') }),
    );
    expect(impactConflicts(mindly, pid)).toHaveLength(1);
    asStoredBefore(mindly, pid);

    // Codex edits a body only: the signature Claude changed is not Codex's change.
    write('src/auth.ts', changed.replace('"admin"', '"owner"'));
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/auth.ts', 'owner') }),
    );
    expect(impactConflicts(mindly, pid)).toHaveLength(1);
    const toClaude = mindly.store.deliveries
      .list(pid)
      .filter((d) => d.targetSessionId === cc.id && d.kind === 'impact');
    expect(toClaude).toHaveLength(0);
  });

  it('takes class signatures stored in an older format as unchanged, once', async () => {
    const { root, mindly, pid, repo, write } = await featureSetup();
    // Signatures as the git port writes them: `<kind>:<signature>`.
    mindly.kernel.ports.git.exportSurface = (source) =>
      new Map(
        [...source.matchAll(/^export (class|function) (\w+)(.*)$/gm)].map((m) => [
          m[2]!,
          `${m[1]}:${m[3]!.replace(/\s+/g, '')}`,
        ]),
      );
    const service = (base: string, body: string): string =>
      `export class Service extends ${base} {\n  run() { return ${body}; }\n}\n` +
      'export function login(user: string) {}\n';
    repo.head['src/auth.ts'] = service('Base', '1');
    write('src/auth.ts', service('Base', '1'));
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    // The earlier version hashed the class another way.
    mindly.store.kv.set(surfaceKey(pid, 'src/auth.ts'), {
      Service: 'class:#written-by-the-old-format',
      login: 'function:(user:string){}',
    });

    // A body-only edit of the class reports nothing and rewrites the surface.
    write('src/auth.ts', service('Base', '2'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', '2') }),
    );
    expect(impactConflicts(mindly, pid)).toHaveLength(0);
    expect(mindly.store.kv.get(surfaceKey(pid, 'src/auth.ts'))).toEqual({
      Service: 'class:extendsBase{',
      login: 'function:(user:string){}',
    });

    // From here on a class change is seen.
    write('src/auth.ts', service('Other', '2'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'Other') }),
    );
    const impact = impactConflicts(mindly, pid);
    expect(impact).toHaveLength(1);
    expect(impact[0]!.detail).toContain('Changed signature: Service');
  });

  it('cannot tell a class change made by the first edit after an upgrade, but sees the rest', async () => {
    const { root, mindly, pid, repo, write } = await featureSetup();
    mindly.kernel.ports.git.exportSurface = (source) =>
      new Map(
        [...source.matchAll(/^export (class|function) (\w+)(.*)$/gm)].map((m) => [
          m[2]!,
          `${m[1]}:${m[3]!.replace(/\s+/g, '')}`,
        ]),
      );
    const file = (base: string, params: string): string =>
      `export class Service extends ${base} {}\nexport function login(${params}) {}\n`;
    repo.head['src/auth.ts'] = file('Base', 'user: string');
    write('src/auth.ts', file('Base', 'user: string'));
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    mindly.store.kv.set(surfaceKey(pid, 'src/auth.ts'), {
      Service: 'class:#written-by-the-old-format',
      login: 'function:(user:string){}',
    });

    // The class and a function change in the same first edit: only the function can be compared.
    write('src/auth.ts', file('Other', 'user: string, otp: string'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'otp') }),
    );
    const impact = impactConflicts(mindly, pid);
    expect(impact).toHaveLength(1);
    expect(impact[0]!.detail).toContain('Changed signature: login');
    expect(impact[0]!.detail).not.toContain('Service');
  });

  it('stores the surface and its format together even when a later step fails', async () => {
    const { root, mindly, pid, write } = await featureSetup();
    mindly.kernel.ports.git.dependentsOf = async () => {
      throw new Error('boom');
    };
    write('src/auth.ts', 'export const VERSION = 3;\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'v3') }),
    );
    expect(mindly.store.kv.get(surfaceKey(pid, 'src/auth.ts'))).toEqual({ VERSION: 'const' });
    expect(mindly.store.kv.get(`surface-state:${pid}:src/auth.ts`)).toMatchObject({
      format: SURFACE_FORMAT,
    });
  });

  it('reports a change once when two edits of the file are analysed at the same time', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    write('src/auth.ts', AUTH_V1 + 'export function logout() {}\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'logout') }),
    );

    // Claude removes `logout`; Codex's body-only edit lands before Claude's hook has finished.
    write('src/auth.ts', AUTH_V1);
    const first = mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    write('src/auth.ts', AUTH_V1.replace('"admin"', '"owner"'));
    const second = mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/auth.ts', 'owner') }),
    );
    await Promise.all([first, second]);

    const impact = impactConflicts(mindly, pid);
    expect(impact).toHaveLength(1);
    expect(impact[0]!.title).toMatch(/^claude-code #[0-9a-f]{8} changed the exports/);
    const told = mindly.store.deliveries.list(pid).filter((d) => d.kind === 'impact');
    expect(told.map((d) => d.targetSessionId)).toEqual([cx.id]);
    expect(told.some((d) => d.targetSessionId === cc.id)).toBe(false);
  });

  it('reports a change once for analyses that overlap on every wait', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    const file = {
      path: 'src/auth.ts',
      abs: `${root}/src/auth.ts`,
      addedText: '',
      removedText: '',
      wholeFile: false,
    };
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    await impactOf(mindly).analyze(pid, root, cc, file);
    // Both analyses are held at the HEAD lookup until each has taken its first look at the store.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    mindly.kernel.ports.git.headCommit = async () => {
      waiting += 1;
      if (waiting === 2) release();
      await gate;
      return 'h1';
    };
    write('src/auth.ts', AUTH_V2);
    const reports = await Promise.all([
      impactOf(mindly).analyze(pid, root, cc, file),
      impactOf(mindly).analyze(pid, root, cx, file),
    ]);
    expect(waiting).toBe(2);
    expect(reports.filter((r) => r !== null)).toHaveLength(1);
    expect(impactConflicts(mindly, pid)).toHaveLength(1);
  });

  it('leaves a conflict open when its remembered signature cannot be compared any more', async () => {
    const { root, mindly, pid, repo, cc, cx, write } = await featureSetup();
    mindly.kernel.ports.git.exportSurface = (source) =>
      new Map(
        [...source.matchAll(/^export (class|function) (\w+)(.*)$/gm)].map((m) => [
          m[2]!,
          `${m[1]}:${m[3]!.replace(/\s+/g, '')}`,
        ]),
      );
    const file = (extra = ''): string => `export class Service extends Other {}\n${extra}`;
    repo.head['src/auth.ts'] = file();
    write('src/auth.ts', file());
    const { conflict } = mindly.store.conflicts.report({
      projectId: pid,
      kind: 'impact',
      severity: 'warning',
      title: 'codex changed the exports of src/auth.ts',
      detail: 'Changed signature: Service',
      sessionIds: [cc.id, cx.id].sort(),
      paths: ['src/auth.ts'],
      fingerprint: 'impact-test',
    });
    // Remembered in an older format: the class as it was before the change, hashed the old way.
    mindly.store.kv.set(surfaceKey(pid, 'src/auth.ts'), { Service: 'class:#old-after' });
    mindly.store.kv.set(`surface-state:${pid}:src/auth.ts`, {
      head: null,
      open: [{ conflictId: conflict.id, before: { Service: 'class:#old-before' } }],
    });

    write('src/auth.ts', file('export function added() {}\n'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'added') }),
    );
    expect(mindly.store.conflicts.get(conflict.id).status).toBe('open');
    const restored = mindly.store.deliveries
      .list(pid)
      .filter((d) => d.kind === 'impact' && /restored/.test(d.title));
    expect(restored).toHaveLength(0);
  });

  it('does not report a declaration the analysis could not read before as changed', async () => {
    const { root, mindly, pid, repo, write } = await featureSetup();
    mindly.kernel.ports.git.exportSurface = (source) =>
      new Map(
        [...source.matchAll(/^export (class|function) (\w+)(.*)$/gm)].map((m) => [
          m[2]!,
          `${m[1]}:${m[3]!.replace(/\s+/g, '')}`,
        ]),
      );
    const file = (body: string): string => `export function compare(a, b) { return ${body}; }\n`;
    repo.head['src/auth.ts'] = file('0');
    write('src/auth.ts', file('0'));
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    // The earlier version knew the name but not what it was.
    mindly.store.kv.set(surfaceKey(pid, 'src/auth.ts'), { compare: 'unknown:' });

    write('src/auth.ts', file('1'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', '1') }),
    );
    expect(impactConflicts(mindly, pid)).toHaveLength(0);
    expect(mindly.store.kv.get(surfaceKey(pid, 'src/auth.ts'))).toEqual({
      compare: 'function:(a,b){return1;}',
    });

    // In the current format the same kind change is a real one.
    mindly.store.kv.set(surfaceKey(pid, 'src/auth.ts'), { compare: 'unknown:' });
    write('src/auth.ts', file('2'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', '2') }),
    );
    expect(impactConflicts(mindly, pid)).toHaveLength(1);
  });

  const authFile = (root: string) => ({
    path: 'src/auth.ts',
    abs: `${root}/src/auth.ts`,
    addedText: '',
    removedText: '',
    wholeFile: false,
  });

  it('credits each agent with its own edit when a later edit is analysed first', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    write('src/auth.ts', AUTH_V1 + 'export function logout() {}\n');
    await impactOf(mindly).analyze(pid, root, cc, authFile(root));

    // Claude's analysis is held at the HEAD lookup; Codex's runs to the end in the meantime.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    mindly.kernel.ports.git.headCommit = async () => {
      calls += 1;
      if (calls === 1) await gate;
      return null;
    };
    write('src/auth.ts', AUTH_V1);
    const claude = impactOf(mindly).analyze(pid, root, cc, authFile(root));
    const withExtra = AUTH_V1 + 'export function extra() {}\n';
    write('src/auth.ts', withExtra);
    const codex = await impactOf(mindly).analyze(pid, root, cx, authFile(root));
    release();
    const claudeReport = await claude;

    expect(codex).toBeNull();
    expect(claudeReport?.diff.removed).toEqual(['logout']);
    const impact = impactConflicts(mindly, pid);
    expect(impact).toHaveLength(1);
    expect(impact[0]!.title).toMatch(/^claude-code #[0-9a-f]{8} changed the exports/);
    expect(impact[0]!.detail).toContain('Removed: logout');
    // The stored surface is the file as it is.
    expect(mindly.store.kv.get(surfaceKey(pid, 'src/auth.ts'))).toEqual(
      Object.fromEntries(mindly.kernel.ports.git.exportSurface(withExtra, 'src/auth.ts')!),
    );
  });

  it('never records a HEAD older than the one already recorded', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    const git = mindly.kernel.ports.git;
    const order = ['h0', 'h1'];
    git.isAncestor = async (_cwd, a, d) => order.indexOf(a) <= order.indexOf(d);
    let lookups = 0;
    git.fileStateAtRef = async () => {
      lookups += 1;
      return { state: 'no_ref' };
    };
    await impactOf(mindly).analyze(pid, root, cc, authFile(root));

    // Claude reads HEAD before a commit; Codex reads it after and records it first.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    git.headCommit = async () => {
      await gate;
      return 'h0';
    };
    write('src/auth.ts', AUTH_V1.replace('"admin"', '"a"'));
    const claude = impactOf(mindly).analyze(pid, root, cc, authFile(root));
    git.headCommit = async () => 'h1';
    write('src/auth.ts', AUTH_V1.replace('"admin"', '"b"'));
    await impactOf(mindly).analyze(pid, root, cx, authFile(root));
    release();
    await claude;
    expect(mindly.store.kv.get(`surface-state:${pid}:src/auth.ts`)).toMatchObject({ head: 'h1' });

    // The next analysis sees no HEAD move, so it does not look at the commits.
    lookups = 0;
    write('src/auth.ts', AUTH_V1.replace('"admin"', '"c"'));
    await impactOf(mindly).analyze(pid, root, cc, authFile(root));
    expect(lookups).toBe(0);
  });

  it('closes a conflict that cannot be shown restored once its removed exports are back', async () => {
    const { root, mindly, pid, repo, cc, cx, write } = await featureSetup();
    mindly.kernel.ports.git.exportSurface = (source) =>
      new Map(
        [...source.matchAll(/^export (class|function) (\w+)(.*)$/gm)].map((m) => [
          m[2]!,
          `${m[1]}:${m[3]!.replace(/\s+/g, '')}`,
        ]),
      );
    repo.head['src/auth.ts'] = 'export class Service {}\n';
    write('src/auth.ts', 'export class Service {}\n');
    const { conflict } = mindly.store.conflicts.report({
      projectId: pid,
      kind: 'impact',
      severity: 'critical',
      title: 'codex changed the exports of src/auth.ts',
      detail: 'Removed: logout. Changed signature: Service',
      sessionIds: [cc.id, cx.id].sort(),
      paths: ['src/auth.ts'],
      fingerprint: 'impact-test',
    });
    mindly.store.kv.set(surfaceKey(pid, 'src/auth.ts'), { Service: 'class:#old' });
    mindly.store.kv.set(`surface-state:${pid}:src/auth.ts`, {
      head: null,
      open: [
        {
          conflictId: conflict.id,
          before: { Service: 'class:#older', logout: 'function:(){}' },
          removed: ['logout'],
        },
      ],
    });

    write('src/auth.ts', 'export class Service {}\nexport function logout() {}\n');
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', 'logout') }),
    );
    expect(mindly.store.conflicts.get(conflict.id).status).toBe('resolved');
    const titles = mindly.store.deliveries
      .list(pid)
      .filter((d) => d.targetSessionId === cx.id && d.kind === 'impact')
      .map((d) => d.title);
    expect(titles).toEqual(['src/auth.ts exports logout again']);
  });

  it('closes a conflict that cannot be shown restored after a week without changes', async () => {
    const { root, clock, mindly, pid, repo, cc, cx, write } = await featureSetup();
    mindly.kernel.ports.git.exportSurface = (source) =>
      new Map(
        [...source.matchAll(/^export (class|function) (\w+)(.*)$/gm)].map((m) => [
          m[2]!,
          `${m[1]}:${m[3]!.replace(/\s+/g, '')}`,
        ]),
      );
    repo.head['src/auth.ts'] = 'export class Service {}\n';
    write('src/auth.ts', 'export class Service {}\n');
    const { conflict } = mindly.store.conflicts.report({
      projectId: pid,
      kind: 'impact',
      severity: 'warning',
      title: 'codex changed the exports of src/auth.ts',
      detail: 'Changed signature: Service',
      sessionIds: [cc.id, cx.id].sort(),
      paths: ['src/auth.ts'],
      fingerprint: 'impact-test',
    });
    const seed = (): void => {
      mindly.store.kv.set(surfaceKey(pid, 'src/auth.ts'), { Service: 'class:#old' });
      mindly.store.kv.set(`surface-state:${pid}:src/auth.ts`, {
        head: null,
        open: [{ conflictId: conflict.id, before: { Service: 'class:#older' } }],
      });
    };
    const edit = async (tag: string): Promise<void> => {
      write('src/auth.ts', `export class Service {}\n// ${tag}\n`);
      await mindly.hooks.handle(
        event(root, 'claude-code', 'cc', 'post_tool', { tool: writeTool('src/auth.ts', tag) }),
      );
    };

    seed();
    clock.advance(6 * 24 * 60 * 60_000);
    await edit('six days');
    expect(mindly.store.conflicts.get(conflict.id).status).toBe('open');

    seed();
    clock.advance(2 * 24 * 60 * 60_000);
    await edit('eight days');
    expect(mindly.store.conflicts.get(conflict.id).status).toBe('resolved');
    const told = mindly.store.deliveries.list(pid).filter((d) => d.kind === 'impact');
    expect(told).toHaveLength(0);
  });

  it('applies only what a pull changed while another edit is being analysed', async () => {
    const { root, mindly, pid, cc, cx, write } = await featureSetup();
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
    );
    const git = mindly.kernel.ports.git;
    const PULLED = AUTH_V1 + 'export function logout() {}\n';
    const commits: Record<string, string> = { h0: AUTH_V1, h1: PULLED };
    git.fileStateAtRef = async (_cwd, ref, path) =>
      path === 'src/auth.ts' && commits[ref] !== undefined
        ? { state: 'file', content: commits[ref] }
        : { state: 'no_ref' };
    git.isAncestor = async (_cwd, a, d) => a === d || (a === 'h0' && d === 'h1');
    git.headCommit = async () => 'h0';
    await impactOf(mindly).analyze(pid, root, cc, authFile(root));

    // A pull brings `logout`; Claude then stops exporting `login` and its analysis is held at HEAD.
    write('src/auth.ts', PULLED);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    git.headCommit = async () => {
      await gate;
      return 'h1';
    };
    write('src/auth.ts', PULLED.replace('export function login', 'function login'));
    const claude = impactOf(mindly).analyze(pid, root, cc, authFile(root));
    // Codex adds an export and its analysis runs to the end.
    git.headCommit = async () => 'h1';
    write(
      'src/auth.ts',
      PULLED.replace('export function login', 'function login') + 'export function extra() {}\n',
    );
    const codex = await impactOf(mindly).analyze(pid, root, cx, authFile(root));
    release();
    const claudeReport = await claude;

    expect(codex).toBeNull();
    expect(claudeReport?.diff.removed).toEqual(['login']);
    const impact = impactConflicts(mindly, pid);
    expect(impact).toHaveLength(1);
    expect(impact[0]!.title).toMatch(/^claude-code #[0-9a-f]{8} changed the exports/);
    expect(mindly.store.kv.get(`surface-state:${pid}:src/auth.ts`)).toMatchObject({ head: 'h1' });
  });

  describe('after a git operation moved HEAD', () => {
    const PULLED = AUTH_V1 + 'export function logout() {}\n';
    const OTP = 'login(user: string, otp: string)';
    const withCommits = (mindly: Mindly, commits: Record<string, string>) => {
      const git = mindly.kernel.ports.git;
      git.fileStateAtRef = async (_cwd, ref, path) =>
        path === 'src/auth.ts' && commits[ref] !== undefined
          ? { state: 'file', content: commits[ref] }
          : { state: 'no_ref' };
      git.isAncestor = async (_cwd, a, d) => a === d || (a === 'h0' && d === 'h1');
      git.headCommit = async () => 'h0';
      return git;
    };

    it('does not blame the next agent for a change a stash set aside', async () => {
      const { root, mindly, pid, cc, cx, write } = await featureSetup();
      await mindly.hooks.handle(
        event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
      );
      const git = withCommits(mindly, { h0: AUTH_V1, h1: PULLED });
      // Claude changes `login` (uncommitted), which is reported.
      write('src/auth.ts', AUTH_V1.replace('login(user: string)', OTP));
      await impactOf(mindly).analyze(pid, root, cc, authFile(root));
      expect(impactConflicts(mindly, pid)).toHaveLength(1);

      // `git stash && git pull`: the change is set aside and the pull adds `logout`.
      git.headCommit = async () => 'h1';
      write('src/auth.ts', PULLED + 'export function extra() {}\n');
      const report = await impactOf(mindly).analyze(pid, root, cx, authFile(root));
      expect(report).toBeNull();
      expect(impactConflicts(mindly, pid).filter((c) => c.title.startsWith('codex'))).toEqual([]);
    });

    it('does not blame the next agent when a checkout leaves the exports as committed', async () => {
      const { root, mindly, pid, cc, cx, write } = await featureSetup();
      // The file differs between the commits, though not in its exports.
      const git = withCommits(mindly, { h0: AUTH_V1, h1: AUTH_V1.replace('"admin"', '"root"') });
      write('src/auth.ts', AUTH_V1.replace('login(user: string)', OTP));
      await impactOf(mindly).analyze(pid, root, cc, authFile(root));

      // `git checkout -f other` puts the committed `login` back.
      git.headCommit = async () => 'h1';
      write('src/auth.ts', AUTH_V1.replace('"admin"', '"root"') + 'export function extra() {}\n');
      expect(await impactOf(mindly).analyze(pid, root, cx, authFile(root))).toBeNull();
    });

    // What a commit of another file (the file is the same at both HEADs) or a commit of this one
    // does to the comparison of the next edit, for each kind of uncommitted change.
    const LOGOUT = 'export function logout() {}\n';
    const cases: {
      name: string;
      commits: Record<string, string>;
      uncommitted: string;
      next: string;
      expected: { added: string[]; removed: string[]; changed: string[] } | null;
    }[] = [
      {
        name: 'unrelated commit, uncommitted export removed again',
        commits: { h0: AUTH_V1, h1: AUTH_V1 },
        uncommitted: AUTH_V1 + LOGOUT,
        next: AUTH_V1,
        expected: { added: [], removed: ['logout'], changed: [] },
      },
      {
        name: 'unrelated commit, uncommitted signature change undone',
        commits: { h0: AUTH_V1, h1: AUTH_V1 },
        uncommitted: AUTH_V1.replace('login(user: string)', OTP),
        next: AUTH_V1,
        expected: { added: [], removed: [], changed: ['login'] },
      },
      {
        name: 'unrelated commit, uncommitted removal kept',
        commits: { h0: AUTH_V1, h1: AUTH_V1 },
        uncommitted: AUTH_V1.replace('export const VERSION = 1;\n', ''),
        next: AUTH_V1.replace('export const VERSION = 1;\n', '') + LOGOUT,
        expected: null,
      },
      {
        name: 'commit of this file, uncommitted export removed again',
        commits: { h0: AUTH_V1, h1: PULLED.replace(LOGOUT, 'export function other() {}\n') },
        uncommitted: AUTH_V1 + LOGOUT,
        next: AUTH_V1 + 'export function other() {}\n',
        // `other` came with the commit: not an agent's change.
        expected: { added: [], removed: ['logout'], changed: [] },
      },
      {
        name: 'commit of this file, uncommitted signature change kept, body edited',
        commits: { h0: AUTH_V1, h1: PULLED },
        uncommitted: AUTH_V1.replace('login(user: string)', OTP),
        next: PULLED.replace('login(user: string)', OTP).replace('"admin"', '"root"'),
        expected: null,
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const { root, mindly, pid, cc, cx, write } = await featureSetup();
        await mindly.hooks.handle(
          event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
        );
        const git = withCommits(mindly, c.commits);
        write('src/auth.ts', c.uncommitted);
        await impactOf(mindly).analyze(pid, root, cx, authFile(root));
        git.headCommit = async () => 'h1';
        write('src/auth.ts', c.next);
        const report = await impactOf(mindly).analyze(pid, root, cc, authFile(root));
        expect(report?.diff ?? null).toEqual(c.expected);
      });
    }

    it('still compares an uncommitted change that survived the pull', async () => {
      const { root, mindly, pid, cc, cx, write } = await featureSetup();
      await mindly.hooks.handle(
        event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('src/dashboard.ts', 'y') }),
      );
      const git = withCommits(mindly, { h0: AUTH_V1, h1: PULLED });
      write('src/auth.ts', AUTH_V1.replace('login(user: string)', OTP));
      await impactOf(mindly).analyze(pid, root, cc, authFile(root));

      // A plain pull keeps Claude's change; Codex then removes VERSION.
      git.headCommit = async () => 'h1';
      const pulled = PULLED.replace('login(user: string)', OTP);
      write('src/auth.ts', pulled.replace('export const VERSION = 1;\n', ''));
      const report = await impactOf(mindly).analyze(pid, root, cx, authFile(root));
      expect(report?.diff).toEqual({ added: [], removed: ['VERSION'], changed: [] });
    });
  });
});
