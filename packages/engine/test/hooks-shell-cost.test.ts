import type * as Fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Mindly, USER } from '../src/index.js';
import { event, FakeClock, fakeGit, shellTool } from './helpers.js';

/** Every directory listed while a hook runs. */
const listed = vi.hoisted(() => [] as string[]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const readdirSync = (...args: Parameters<typeof actual.readdirSync>) => {
    listed.push(String(args[0]));
    return actual.readdirSync(...args);
  };
  return { ...actual, readdirSync };
});

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-cost-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'syn-cost-out-')));
  mkdirSync(join(root, 'src', 'generated', 'deep'), { recursive: true });
  writeFileSync(join(root, 'src', 'generated', 'deep', 'api.ts'), 'export const a = 1;\n');
  writeFileSync(join(outside, 'a.log'), 'x\n');
  const lookups: string[] = [];
  const mindly = Mindly.open({
    inMemory: true,
    clock: new FakeClock(),
    ports: {
      git: {
        ...fakeGit,
        findRepoRoot: async (cwd) => {
          lookups.push(cwd);
          return cwd === root || cwd.startsWith(`${root}/`) ? root : null;
        },
        projectRoot: async (cwd) => {
          lookups.push(cwd);
          return cwd === root || cwd.startsWith(`${root}/`) ? root : null;
        },
      },
    },
  });
  const hook = (name: 'pre_tool' | 'post_tool', command: string) =>
    mindly.hooks.handle(event(root, 'codex', 'cx', name, { tool: shellTool(command) }));
  const under = (dir: string) => listed.filter((d) => d === dir || d.startsWith(`${dir}/`));
  return { root, outside, mindly, lookups, hook, under };
}

async function enforce(mindly: Mindly, root: string, scope: string) {
  const ctx = await mindly.projects.resolve(root);
  mindly.memory.remember({
    projectId: ctx.project.id,
    projectRoot: root,
    kind: 'rule',
    title: 'Never edit generated code',
    body: 'src/generated is produced by codegen',
    scopePaths: [scope],
    source: USER,
    enforce: true,
  });
}

describe('what a shell hook costs', () => {
  beforeEach(() => {
    listed.length = 0;
  });

  it('never lists a directory outside the project', async () => {
    const { root, outside, mindly, hook, under } = project();
    await enforce(mindly, root, '**/*.log');
    for (const command of [
      `rm ${outside}/*.log`,
      `rm -rf ${outside}`,
      `cd ${outside} && rm -rf *`,
      'rm -rf /tmp',
    ]) {
      const r = await hook('pre_tool', command);
      expect(r.decision, command).toBeNull();
    }
    expect(under(outside)).toEqual([]);
    expect(listed.filter((d) => d === '/tmp' || d === tmpdir())).toEqual([]);
  });

  it('lists nothing when no enforced rule can reach what the command writes', async () => {
    const { root, mindly, hook, under } = project();
    expect((await hook('pre_tool', 'rm -rf src/generated')).decision).toBeNull();
    await enforce(mindly, root, 'prisma/migrations/**');
    expect((await hook('pre_tool', 'rm -rf src/generated')).decision).toBeNull();
    expect((await hook('pre_tool', 'rm src/generated/*.ts')).decision).toBeNull();
    expect(under(root)).toEqual([]);
    // A rule that can reach it is settled by one listing of that directory, inside the project.
    await enforce(mindly, root, 'src/generated/**');
    expect((await hook('pre_tool', 'rm -rf src/generated')).decision).toBe('deny');
    expect(under(root).sort()).toEqual([
      join(root, 'src', 'generated'),
      join(root, 'src', 'generated', 'deep'),
    ]);
  });

  it('does not walk directories or look up other trees again after the command ran', async () => {
    const { root, outside, mindly, lookups, hook, under } = project();
    await enforce(mindly, root, 'src/generated/**');
    await hook('pre_tool', 'echo warm up');
    listed.length = 0;
    lookups.length = 0;
    for (const command of [
      'rm -rf src/generated',
      'rm src/generated/*.ts',
      `cp src/generated/deep/api.ts ${outside}/copy.ts && rm ${outside}/a.log`,
    ]) {
      await hook('post_tool', command);
    }
    expect(under(root)).toEqual([]);
    expect(under(outside)).toEqual([]);
    // Git is only asked about the session's own working directory.
    expect(lookups.filter((d) => d !== root)).toEqual([]);
  });

  it('stays fast on a command that names many files and directories', async () => {
    const { root, mindly, hook } = project();
    await enforce(mindly, root, 'src/generated/**');
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(root, 'pkg', `p${i}`), { recursive: true });
      for (let j = 0; j < 100; j++) writeFileSync(join(root, 'pkg', `p${i}`, `f${j}.ts`), '');
    }
    await hook('pre_tool', 'echo warm up');
    const command = `rm -rf pkg ${Array.from({ length: 50 }, (_, i) => `pkg/p${i % 40}/f${i}.ts`).join(' ')}`;
    const started = performance.now();
    expect((await hook('pre_tool', command)).decision).toBeNull();
    await hook('post_tool', command);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
