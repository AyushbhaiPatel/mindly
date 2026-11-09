import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mindly, USER } from '../src/index.js';
import { event, FakeClock, fakeGit, setup, shellTool, writeTool } from './helpers.js';

describe('hook flow', () => {
  it('captures a rule from one agent and delivers it to the other', async () => {
    const { root, mindly } = setup();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));

    const res = await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', {
        prompt: 'No, use pnpm. From now on always use pnpm instead of npm.',
      }),
    );
    expect(res.userMessage).toMatch(/project rule/);

    const codex = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'add a dependency' }),
    );
    expect(codex.context).toContain('New project rule');
    expect(codex.context).toContain('pnpm');

    const fresh = await mindly.hooks.handle(event(root, 'cursor', 'cu', 'session_start'));
    expect(fresh.context).toContain('Project rules (from the user)');
    expect(fresh.context).toMatch(/always use pnpm/i);
  });

  it('delivers each update once and acknowledges it on the next turn', async () => {
    const { root, mindly } = setup();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'We always use tabs in Makefiles.' }),
    );
    const first = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'hello' }),
    );
    expect(first.context).toContain('New project rule');
    const second = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'prompt', { prompt: 'hello again' }),
    );
    expect(second.context ?? '').not.toContain('New project rule');
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.deliveries.list(pid, { statuses: ['acked'] })).toHaveLength(1);
  });

  it('warns about overlapping edits and notifies the other agent', async () => {
    const { root, mindly } = setup();
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'pre_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    const res = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool(`${root}/src/auth.ts`, 'y') }),
    );
    expect(res.context).toContain('Coordination warning');
    expect(res.context).toContain('src/auth.ts');
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.conflicts.list(pid)[0]?.kind).toBe('intent_overlap');
    const cc = await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'continue' }),
    );
    expect(cc.context).toContain('started editing src/auth.ts');
  });

  it('denies writes only for user-enforced scoped rules', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'src/generated is produced by codegen',
      scopePaths: ['src/generated/**'],
      source: USER,
      enforce: true,
    });
    const denied = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/generated/api.ts', 'x') }),
    );
    expect(denied.decision).toBe('deny');
    const allowed = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/auth.ts', 'x') }),
    );
    expect(allowed.decision).toBeNull();
  });

  it('applies enforced rules to shell commands that write the file', async () => {
    const { root, mindly } = setup();
    mkdirSync(join(root, 'src', 'generated'));
    writeFileSync(join(root, 'src', 'generated', 'api.ts'), 'export const a = 1;\n');
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'src/generated is produced by codegen',
      scopePaths: ['src/generated/**'],
      source: USER,
      enforce: true,
    });
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    for (const command of [
      "sed -i 's/a/b/' src/generated/api.ts",
      'echo y > src/generated/api.ts',
      'echo y>src/generated/api.ts',
      'rm src/generated/api.ts',
      'rm -rf src/generated',
      'rm src/generated/*.ts',
      'cd src/generated && rm api.ts',
      'cp src/auth.ts src/generated',
      'mv src/generated/api.ts src/api.ts',
      'git checkout -- src/generated',
      `python -c "open('src/generated/api.ts','w').write('x')"`,
    ]) {
      const r = await shell(command);
      expect(r.decision, command).toBe('deny');
      expect(r.reason, command).toContain('Never edit generated code');
    }
    for (const command of [
      'cat src/generated/api.ts 2>/dev/null',
      'grep -rn export src/generated | sort',
      'npx vitest run src/generated/api.test.ts',
      'git diff -- src/generated/api.ts > /tmp/api.diff',
      'rm src/auth.ts',
      'npm test',
    ]) {
      const r = await shell(command);
      expect(r.decision, command).toBeNull();
      expect(r.context ?? '', command).not.toContain('Never edit generated code');
    }
    // A program Mindly does not know may only read the file: a warning, not a block.
    const unknown = await shell('node scripts/gen.js src/generated/api.ts');
    expect(unknown.decision).toBeNull();
    expect(unknown.context).toContain('src/generated/api.ts');
    expect(unknown.context).toContain('Never edit generated code');
    // The blocked shell write is the rule's save, like a blocked edit.
    const before = mindly.store.events.query(ctx.project.id, { types: ['tool.before'] });
    expect(before[0]?.payload).toMatchObject({ deniedBy: expect.any(String) });
  });

  it('enforces a rule scoped to deny-listed files without recording them', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    const pid = ctx.project.id;
    const env = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool('.env', 'A=1') }),
    );
    expect(env).toEqual({ context: null, decision: null, reason: null, userMessage: null });
    mindly.memory.remember({
      projectId: pid,
      projectRoot: root,
      kind: 'rule',
      title: 'Secrets are edited by hand only',
      body: 'Agents never write env files, keys or secrets.',
      scopePaths: ['.env*', 'secrets/**', '**/*.pem'],
      source: USER,
      enforce: true,
    });
    for (const path of ['.env', '.env.local', 'secrets/prod.yaml', 'certs/server.pem', '.envrc']) {
      const r = await mindly.hooks.handle(
        event(root, 'codex', 'cx', 'pre_tool', { tool: writeTool(path, 'A=1') }),
      );
      expect(r.decision, path).toBe('deny');
      expect(r.reason, path).toContain('Secrets are edited by hand only');
    }
    const shell = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool('echo A=1 >> .env') }),
    );
    expect(shell.decision).toBe('deny');
    // Deny-listed names are matched, never stored: not as an intent, an event path or a packet.
    const stored = JSON.stringify([
      mindly.store.events.query(pid, {}),
      mindly.store.intents.active(pid),
    ]);
    expect(stored).not.toContain('.env.local');
    expect(stored).not.toContain('secrets/prod.yaml');
    expect(stored).not.toContain('server.pem');
    await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'post_tool', { tool: writeTool('.env', 'A=1') }),
    );
    expect(mindly.store.events.query(pid, { types: ['file.changed'] })).toHaveLength(0);
  });

  it('checks every file of a large patch, not only the first fifty', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Applied migrations are never edited',
      body: 'Add a new migration instead.',
      scopePaths: ['prisma/migrations/**'],
      source: USER,
      enforce: true,
    });
    const edits = [
      ...Array.from({ length: 120 }, (_, i) => `src/new${i}.ts`),
      'prisma/migrations/001/migration.sql',
    ].map((path) => ({ path, addedText: 'x', removedText: '', wholeFile: true }));
    const r = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', {
        tool: { ...writeTool('x', 'x')!, name: 'apply_patch', edits },
      }),
    );
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('prisma/migrations/001/migration.sql');
    expect(r.reason).not.toContain('src/new0.ts');
  });

  it('still applies rules when the reported working directory is gone', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-eng-')));
    mkdirSync(join(root, 'src', 'generated'), { recursive: true });
    const inRoot = async (cwd: string) =>
      cwd === root || cwd.startsWith(`${root}/`) ? root : null;
    const mindly = Mindly.open({
      inMemory: true,
      clock: new FakeClock(),
      ports: { git: { ...fakeGit, findRepoRoot: inRoot } },
    });
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'src/generated is produced by codegen',
      scopePaths: ['src/generated/**'],
      source: USER,
      enforce: true,
    });
    const gone = join(root, 'removed-worktree');
    const denied = await mindly.hooks.handle(
      event(gone, 'codex', 'cx', 'pre_tool', {
        tool: writeTool(join(root, 'src/generated/api.ts'), 'x'),
      }),
    );
    expect(denied.decision).toBe('deny');
    // A relative path says nothing without a working directory: the hook stays out of the way.
    const relative = await mindly.hooks.handle(
      event(gone, 'codex', 'cx', 'pre_tool', { tool: writeTool('src/generated/api.ts', 'x') }),
    );
    expect(relative.decision).toBeNull();
  });

  it('judges a directory or wildcard by what it can reach, not by a listing that was cut short', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    const rule = (title: string, scope: string) =>
      mindly.memory.remember({
        projectId: ctx.project.id,
        projectRoot: root,
        kind: 'rule',
        title,
        body: 'Ask first.',
        scopePaths: [scope],
        source: USER,
        enforce: true,
      });
    rule('Applied migrations are never edited', 'packages/db/prisma/migrations/**');
    // A big package is listed before the protected file is reached.
    mkdirSync(join(root, 'packages', 'web', 'src'), { recursive: true });
    for (let i = 0; i < 2500; i++)
      writeFileSync(join(root, 'packages', 'web', 'src', `f${i}.ts`), '');
    mkdirSync(join(root, 'packages', 'db', 'prisma', 'migrations'), { recursive: true });
    writeFileSync(join(root, 'packages', 'db', 'prisma', 'migrations', '001.sql'), 'select 1;');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'main.js'), '');
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'cert.pem'), '');
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    for (const command of [
      'rm -rf packages',
      'rm -rf packages/*',
      'rm -rf packages/db/prisma',
      'git checkout -- packages',
      'cd packages && rm -rf db',
      'rm packages/*/prisma/migrations/*.sql',
      'rm -rf .',
    ]) {
      const r = await shell(command);
      expect(r.decision, command).toBe('deny');
      expect(r.reason, command).toContain('Applied migrations are never edited');
    }
    // What the rule cannot reach is not held up, however large it is.
    for (const command of ['rm -rf packages/web', 'rm -rf dist', 'rm packages/web/src/*.ts']) {
      expect((await shell(command)).decision, command).toBeNull();
    }

    rule('Certificates are issued by hand', '**/*.pem');
    // The rule can reach any folder: a complete listing settles it, a cut-off one does not.
    expect((await shell('rm -rf dist')).decision).toBeNull();
    expect((await shell('rm -rf not-there')).decision).toBeNull();
    const big = await shell('rm -rf packages/web');
    expect(big.decision).toBe('deny');
    expect(big.reason).toContain('Certificates are issued by hand');
    expect(big.reason).toContain('packages/web/**');
    // Dependency folders are only a rule's business when the rule names them.
    expect((await shell('rm -rf node_modules')).decision).toBeNull();
    rule('Vendored patches stay', 'node_modules/left-pad/**');
    expect((await shell('rm -rf node_modules')).decision).toBe('deny');
    // A program that may only read a folder is told about the rule, not blocked.
    const tool = await shell('mytool packages/db/');
    expect(tool.decision).toBeNull();
  });

  it('finds other working trees once and refuses what it cannot place', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-eng-')));
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'syn-eng-wt-')));
    const far = realpathSync(mkdtempSync(join(tmpdir(), 'syn-eng-far-')));
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(other, `d${i}`));
      mkdirSync(join(far, `d${i}`));
    }
    const asked: string[] = [];
    const treeOf = (cwd: string) =>
      [root, other].find((t) => cwd === t || cwd.startsWith(`${t}/`)) ?? null;
    const mindly = Mindly.open({
      inMemory: true,
      clock: new FakeClock(),
      ports: {
        git: {
          ...fakeGit,
          findRepoRoot: async (cwd) => {
            asked.push(cwd);
            return treeOf(cwd);
          },
          projectRoot: async (cwd) => (treeOf(cwd) ? root : null),
        },
      },
    });
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'src/generated is produced by codegen',
      scopePaths: ['src/generated/**'],
      source: USER,
      enforce: true,
    });
    const write = (paths: string[]) =>
      mindly.hooks.handle(
        event(root, 'codex', 'cx', 'pre_tool', {
          tool: {
            ...writeTool('x', 'x')!,
            edits: paths.map((path) => ({
              path,
              addedText: 'x',
              removedText: '',
              wholeFile: true,
            })),
          },
        }),
      );
    // Forty folders of one other working tree cost one lookup, and the last file is still checked.
    asked.length = 0;
    const inOther = await write([
      ...Array.from({ length: 40 }, (_, i) => join(other, `d${i}`, 'a.ts')),
      join(other, 'src/generated/api.ts'),
    ]);
    expect(inOther.decision).toBe('deny');
    expect(inOther.reason).toContain('src/generated/api.ts');
    expect(asked.filter((d) => d.startsWith(other))).toHaveLength(1);
    // A handful of places outside the project are looked up and found to be none of its business.
    const few = await write(Array.from({ length: 10 }, (_, i) => join(far, `d${i}`, 'a.ts')));
    expect(few.decision).toBeNull();
    // More places than are looked up at once: the call is refused, not waved through.
    const many = await write([
      ...Array.from({ length: 40 }, (_, i) => join(far, `d${i}`, 'a.ts')),
      join(other, 'src/generated/api.ts'),
    ]);
    expect(many.decision).toBe('deny');
    expect(many.reason).toContain('could not check');
    expect(many.reason).toContain('smaller steps');
  });

  it('applies rules to paths written through the home directory', async () => {
    const { root, mindly } = setup();
    mkdirSync(join(root, 'src', 'generated'));
    writeFileSync(join(root, 'src', 'generated', 'api.ts'), 'export const a = 1;\n');
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Never edit generated code',
      body: 'src/generated is produced by codegen',
      scopePaths: ['src/generated/**'],
      source: USER,
      enforce: true,
    });
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    const home = process.env['HOME'];
    const name = basename(root);
    try {
      process.env['HOME'] = dirname(root);
      for (const command of [
        `rm ~/${name}/src/generated/api.ts`,
        `cd ~/${name} && sed -i 's/a/b/' src/generated/api.ts`,
        `cd ~ && rm -rf ${name}/src`,
        `echo x > ~/${name}/src/generated/new.ts`,
        `(cd /tmp && ls); rm src/generated/api.ts`,
      ]) {
        expect((await shell(command)).decision, command).toBe('deny');
      }
      expect((await shell(`rm ~/${name}/src/auth.ts`)).decision).toBeNull();
      expect((await shell('rm ~/elsewhere/src/generated/api.ts')).decision).toBeNull();
      // Another user's home is taken to sit next to this one.
      process.env['HOME'] = join(dirname(root), 'someone');
      expect((await shell(`rm ~${name}/src/generated/api.ts`)).decision).toBe('deny');
      expect((await shell(`cd ~${name} && rm -rf src`)).decision).toBe('deny');
    } finally {
      if (home === undefined) delete process.env['HOME'];
      else process.env['HOME'] = home;
    }
  });

  it('ignores writes outside the project and to denied paths', async () => {
    const { root, mindly } = setup();
    for (const p of ['/etc/passwd', '.env', '../outside.ts']) {
      await mindly.hooks.handle(
        event(root, 'codex', 'cx', 'post_tool', { tool: writeTool(p, 'SECRET=1') }),
      );
    }
    const pid = mindly.store.projects.list()[0]!.id;
    expect(mindly.store.events.query(pid, { types: ['file.changed'] })).toHaveLength(0);
  });

  it('records provenance for written lines', async () => {
    const { root, mindly } = setup();
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'prompt', { prompt: 'add admin role' }),
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', '  return { role: "admin" };'),
      }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    const changes = mindly.store.fileChanges.forPath(pid, 'src/auth.ts');
    expect(changes).toHaveLength(1);
    expect(changes[0]?.promptEventId).not.toBeNull();
  });

  it('remembers failing commands and warns before they are repeated', async () => {
    const { root, mindly } = setup();
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: shellTool(
          'npm test -- --watch',
          true,
          'ERR! missing script: test TOKEN=abcdef123456',
        ),
      }),
    );
    const res = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool('npm test') }),
    );
    expect(res.context).toContain('failed before');
    expect(res.context).not.toContain('abcdef123456');
  });

  it('never throws, even for a missing working directory', async () => {
    const { mindly } = setup();
    const res = await mindly.hooks.handle(
      event('/definitely/not/here', 'codex', 'cx', 'session_start'),
    );
    expect(res).toEqual({ context: null, decision: null, reason: null, userMessage: null });
  });

  it('hands off a task to the next session of another agent', async () => {
    const { root, mindly } = setup();
    await mindly.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
    const pid = mindly.store.projects.list()[0]!.id;
    const cc = mindly.store.sessions.list(pid)[0]!;
    mindly.store.handoffs.create({
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
    const res = await mindly.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
    expect(res.context).toContain('Handoff for you');
    expect(res.context).toContain('usage limit');
    expect(mindly.store.handoffs.list(pid)[0]?.status).toBe('claimed');
  });
});

describe('provenance for partial-line edits', () => {
  it('maps a whole line back to an edit that changed only part of it', async () => {
    const { root, mindly } = setup();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      `${root}/src/auth.ts`,
      'export function login(user: string, pw: string) {\n  return 1;\n}\n',
    );
    await mindly.hooks.handle(
      event(root, 'claude-code', 'cc', 'post_tool', {
        tool: writeTool('src/auth.ts', 'login(user: string, pw: string)'),
      }),
    );
    const pid = mindly.store.projects.list()[0]!.id;
    const [hash] = fakeGitHash('export function login(user: string, pw: string) {');
    expect(mindly.store.fileChanges.findByHash(pid, 'src/auth.ts', hash!)).toHaveLength(1);
  });
});

function fakeGitHash(line: string): string[] {
  return fakeGit.hunkHashes(line);
}
