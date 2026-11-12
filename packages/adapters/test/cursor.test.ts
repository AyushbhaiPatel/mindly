import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorAdapter as a } from '../src/index.js';
import { fixture, must, out, result } from './helpers.js';

const f = (name: string) => fixture('cursor', name);
const ID = '6b1f0c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('cursor parse', () => {
  it('parses sessionStart using conversation_id and the first workspace root', () => {
    expect(a.parse('sessionStart', f('sessionStart'))).toMatchObject({
      agentKind: 'cursor',
      event: 'session_start',
      externalSessionId: ID,
      cwd: '/Users/dev/shop',
      transcriptPath: null,
    });
  });

  it('parses beforeSubmitPrompt', () => {
    expect(a.parse('beforeSubmitPrompt', f('beforeSubmitPrompt'))?.prompt).toBe(
      'Add a discount field to the checkout API',
    );
  });

  it('parses preToolUse writes', () => {
    const tool = a.parse('preToolUse', f('preToolUse'))?.tool;
    expect(tool).toMatchObject({ name: 'Write', writes: true });
    expect(tool?.edits[0]).toMatchObject({
      path: '/Users/dev/shop/src/new.ts',
      addedText: 'export const y = 2;\n',
      wholeFile: true,
    });
  });

  it('parses shell events', () => {
    expect(a.parse('beforeShellExecution', f('beforeShellExecution'))).toMatchObject({
      event: 'pre_tool',
      tool: { shell: true, command: 'npm run migrate' },
    });
    expect(a.parse('afterShellExecution', f('afterShellExecution'))?.tool).toMatchObject({
      shell: true,
      command: 'npm test',
      outputExcerpt: '3 passing',
      failed: false,
    });
  });

  it('parses afterFileEdit edits', () => {
    const ev = a.parse('afterFileEdit', f('afterFileEdit'));
    expect(ev?.event).toBe('post_tool');
    expect(ev?.tool?.writes).toBe(true);
    expect(ev?.tool?.edits).toEqual([
      {
        path: '/Users/dev/shop/src/checkout.ts',
        addedText: 'total: number;\n  discount: number;',
        removedText: 'total: number;',
        wholeFile: false,
      },
      {
        path: '/Users/dev/shop/src/checkout.ts',
        addedText: 'v2',
        removedText: 'v1',
        wholeFile: false,
      },
    ]);
  });

  it('parses failures, stop and sessionEnd', () => {
    expect(a.parse('postToolUseFailure', f('postToolUseFailure'))?.tool).toMatchObject({
      failed: true,
      shell: true,
      outputExcerpt: 'Build failed: Cannot find module ./discount',
    });
    expect(a.parse('stop', f('stop'))?.event).toBe('stop');
    expect(a.parse('sessionEnd', f('sessionEnd'))?.event).toBe('session_end');
  });

  it('picks the workspace root that holds the file, then the one that holds cwd', () => {
    const fx = f('preToolUse') as Record<string, unknown>;
    const roots = ['/Users/dev/docs', '/Users/dev/shop', '/Users/dev/shop/packages/web'];
    // The fixture writes /Users/dev/shop/src/new.ts with cwd /Users/dev/shop.
    expect(a.parse('preToolUse', { ...fx, workspace_roots: roots })?.cwd).toBe('/Users/dev/shop');
    const nested = {
      ...fx,
      workspace_roots: roots,
      tool_input: { file_path: '/Users/dev/shop/packages/web/a.ts', contents: 'x' },
    };
    expect(a.parse('preToolUse', nested)?.cwd).toBe('/Users/dev/shop/packages/web');
    // A sibling whose name merely starts like a root is not inside it.
    const sibling = {
      ...fx,
      workspace_roots: ['/Users/dev/sh', '/Users/dev/docs'],
      cwd: '/Users/dev/docs',
    };
    expect(a.parse('preToolUse', sibling)?.cwd).toBe('/Users/dev/docs');
    // Shell events carry no file: the reported working directory decides.
    const shell = f('beforeShellExecution') as Record<string, unknown>;
    expect(
      a.parse('beforeShellExecution', { ...shell, workspace_roots: roots, cwd: '/Users/dev/shop' })
        ?.cwd,
    ).toBe('/Users/dev/shop');
    // The root only picks the project: a command run from a folder inside it keeps that folder,
    // because its relative paths start there.
    const inside = {
      ...shell,
      workspace_roots: roots,
      cwd: '/Users/dev/shop/prisma',
      command: 'rm -rf migrations',
    };
    expect(a.parse('beforeShellExecution', inside)).toMatchObject({
      cwd: '/Users/dev/shop/prisma',
      tool: { command: 'rm -rf migrations' },
    });
    expect(
      a.parse('beforeShellExecution', {
        ...shell,
        workspace_roots: ['/Users/dev/shop'],
        cwd: '/Users/dev/shop/prisma/migrations/001',
      })?.cwd,
    ).toBe('/Users/dev/shop/prisma/migrations/001');
    // A file in another root than the working directory: the file's root, not a folder of it.
    expect(
      a.parse('preToolUse', {
        ...fx,
        workspace_roots: roots,
        cwd: '/Users/dev/docs/guides',
        tool_input: { file_path: '/Users/dev/shop/src/new.ts', contents: 'x' },
      })?.cwd,
    ).toBe('/Users/dev/shop');
    // Nothing points at another root: the first one, as with a single root.
    expect(
      a.parse('beforeShellExecution', { ...shell, workspace_roots: roots, cwd: '/somewhere/else' })
        ?.cwd,
    ).toBe('/Users/dev/docs');
  });

  it('keeps the working directory it reports whenever it exists, comparing real paths', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-cursor-')));
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
    mkdirSync(join(repo, 'prisma'), { recursive: true });
    mkdirSync(join(base, 'scratch'));
    symlinkSync(repo, join(base, 'link'));
    const shell = f('beforeShellExecution') as Record<string, unknown>;
    const at = (roots: string[], cwd: string) =>
      a.parse('beforeShellExecution', { ...shell, workspace_roots: roots, cwd })?.cwd;
    // A root deeper than where the command runs: the command's own directory counts.
    expect(at([join(repo, 'packages', 'api')], repo)).toBe(repo);
    expect(at([join(repo, 'packages', 'api')], join(repo, 'prisma'))).toBe(join(repo, 'prisma'));
    // A scratch directory outside every root is where the command runs.
    expect(at([repo], join(base, 'scratch'))).toBe(join(base, 'scratch'));
    // A root given through a link holds the real directory.
    expect(at([join(base, 'link')], join(repo, 'prisma'))).toBe(join(repo, 'prisma'));
    // A write to a file in a root while the directory is elsewhere is read from that root.
    const write = f('preToolUse') as Record<string, unknown>;
    expect(
      a.parse('preToolUse', {
        ...write,
        workspace_roots: [repo],
        cwd: join(base, 'scratch'),
        tool_input: { file_path: join(repo, 'prisma', 'a.sql'), contents: 'x' },
      })?.cwd,
    ).toBe(repo);
  });

  it('returns null without an id or workspace root', () => {
    const fx = f('stop');
    expect(a.parse('stop', { ...fx, conversation_id: undefined })).toBeNull();
    expect(a.parse('stop', { ...fx, workspace_roots: [] })).toBeNull();
    expect(a.parse('stop', { ...fx, workspace_roots: 'nope' })).toBeNull();
    expect(a.parse('beforeReadFile', fx)).toBeNull();
  });
});

describe('cursor render', () => {
  it('renders sessionStart additional_context', () => {
    const ev = must(a.parse('sessionStart', f('sessionStart')));
    expect(out(a.render(ev, result({ context: 'ctx' })).stdout)).toEqual({
      additional_context: 'ctx',
    });
    expect(a.render(ev, result({})).stdout).toBe('');
  });

  it('renders preToolUse deny with permission and messages', () => {
    const ev = must(a.parse('preToolUse', f('preToolUse')));
    const r = a.render(ev, result({ decision: 'deny', reason: 'rule says no' }));
    expect(r.exitCode).toBe(0);
    expect(out(r.stdout)).toEqual({
      permission: 'deny',
      user_message: 'rule says no',
      agent_message: 'rule says no',
    });
    expect(a.render(ev, result({ decision: 'allow' })).stdout).toBe('');
  });

  it('stays silent where Cursor has no output fields', () => {
    for (const name of ['beforeSubmitPrompt', 'afterFileEdit', 'stop', 'sessionEnd']) {
      const ev = must(a.parse(name, f(name)));
      expect(a.render(ev, result({ context: 'c' })).stdout).toBe('');
    }
  });

  it('renders post-tool failure context', () => {
    const ev = must(a.parse('postToolUseFailure', f('postToolUseFailure')));
    expect(out(a.render(ev, result({ context: 'seen' })).stdout)).toEqual({
      additional_context: 'seen',
    });
  });
});
