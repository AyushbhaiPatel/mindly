import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Mindly, USER } from '../src/index.js';
import { SEARCH_LIMITS } from '../src/hooks/search.js';
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
    for (const command of [
      'rm -rf packages/web',
      'rm -rf dist',
      'rm packages/web/src/*.ts',
      'rm -rf packages/*/src',
      'rm -rf **/dist',
    ]) {
      expect((await shell(command)).decision, command).toBeNull();
    }
    // A rule that names its directory also holds for files a command brings into it.
    for (const command of [
      'cp -R /tmp/migrations packages/db/prisma/',
      'tar xf a.tar -C packages/db/prisma/migrations',
      'find packages/db -type f -delete',
      'git checkout HEAD~1 packages',
      'git rm -r packages',
      'git clean -fdx packages/db',
      'sudo -u root rm packages/db/prisma/migrations/001.sql',
      'cd packages/db && cd - && rm packages/db/prisma/migrations/001.sql',
    ]) {
      const r = await shell(command);
      expect(r.decision, command).toBe('deny');
      expect(r.reason, command).toContain('Applied migrations are never edited');
    }
    // A line Mindly does not read fully (a substitution, code fed to a shell, a class of
    // characters) is never blocked: a warning names what the rule covers.
    for (const command of [
      'rm $(pwd)/packages/db/prisma/migrations/001.sql',
      "bash <<'EOF'\nrm packages/db/prisma/migrations/001.sql\nEOF",
      'rm packages/db/prisma/migrations/00[1].sql',
    ]) {
      const r = await shell(command);
      expect(r.decision, command).toBeNull();
      expect(r.context, command).toContain('could not read this command fully');
      expect(r.context, command).toContain('Applied migrations are never edited');
    }
    // Files of unknown names put around it may or may not land in it: worth a warning.
    for (const command of [
      'cp -r /tmp/prisma packages/db',
      'rsync -a /tmp/db/ packages/db/',
      'unzip -o a.zip -d packages/db',
      'tar xzf a.tgz',
      'mytool packages/db/prisma',
    ]) {
      const r = await shell(command);
      expect(r.decision, command).toBeNull();
      expect(r.context, command).toContain('Applied migrations are never edited');
    }

    // Dependency folders are only a rule's business when the rule names them.
    expect((await shell('rm -rf node_modules')).decision).toBeNull();
    rule('Vendored patches stay', 'node_modules/left-pad/**');
    expect((await shell('rm -rf node_modules')).decision).toBe('deny');
    // A program that may only read a folder is told about the rule, not blocked.
    const tool = await shell('mytool packages/db/');
    expect(tool.decision).toBeNull();
    expect(tool.context).toContain('Applied migrations are never edited');
  });

  it('decides a rule that can match at any depth by the files that exist, however many there are', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    for (const [title, scope] of [
      ['Certificates are issued by hand', '**/*.pem'],
      ['Env files are edited by hand', '**/.env'],
    ] as const) {
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
    }
    // Well over two thousand entries in every folder an everyday command sweeps away.
    const fill = (dir: string, n: number, ext: string) => {
      for (let i = 0; i < n; i++) {
        const d = join(root, dir, `m${i % 40}`);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, `f${i}.${ext}`), '');
      }
    };
    fill('dist', 2600, 'js');
    fill('build', 2100, 'js');
    fill('src', 2600, 'ts');
    fill('packages/web/dist', 2100, 'js');
    fill('packages/api/dist', 2100, 'js');
    for (let i = 0; i < 2100; i++) writeFileSync(join(root, `top${i}.txt`), '');
    writeFileSync(join(root, 'debug.log'), '');
    mkdirSync(join(root, 'certs'));
    writeFileSync(join(root, 'certs', 'server.pem'), '');
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    for (const command of [
      'rm -rf dist',
      'rm -rf dist build',
      'rm -rf ./dist/',
      'rm -rf packages/*/dist',
      'rm -rf dist/*',
      'rm -rf **/dist',
      'mv dist dist.old',
      'chmod -R u+w dist',
      'eslint --fix src',
      'prettier --write src',
      'prettier --write "src/**/*.ts"',
      'git checkout -- src',
      'git restore src/',
      'git clean -fdx dist',
      'cp -r src src-copy',
      'rm -f *.log',
      'rm -rf *.tsbuildinfo',
      'rm -rf coverage .next out',
      "find . -name '*.js' -delete",
      'find dist -type f -delete',
    ]) {
      const r = await shell(command);
      expect(r.decision, command).toBeNull();
      expect(r.context ?? '', command).not.toContain('enforced');
    }
    // The same commands are blocked as soon as a file the rule covers is really there.
    writeFileSync(join(root, 'dist', 'm7', 'leaf.pem'), '');
    writeFileSync(join(root, 'packages', 'api', 'dist', 'm3', '.env'), '');
    writeFileSync(join(root, 'old.pem'), '');
    for (const [command, file, title] of [
      ['rm -rf dist', 'dist/m7/leaf.pem', 'Certificates are issued by hand'],
      ['rm -rf dist build', 'dist/m7/leaf.pem', 'Certificates are issued by hand'],
      ['rm -rf dist/*', 'dist/m7/leaf.pem', 'Certificates are issued by hand'],
      ['mv dist dist.old', 'dist/m7/leaf.pem', 'Certificates are issued by hand'],
      ['rm -rf packages/*/dist', 'packages/api/dist/m3/.env', 'Env files are edited by hand'],
      ['rm -rf certs', 'certs/server.pem', 'Certificates are issued by hand'],
      ['git checkout -- .', '.pem', 'Certificates are issued by hand'],
      ['rm -rf .', '.pem', 'Certificates are issued by hand'],
      ['rm -f *.pem', 'old.pem', 'Certificates are issued by hand'],
      ["find . -name '*.pem' -delete", '.pem', 'Certificates are issued by hand'],
    ] as const) {
      const r = await shell(command);
      expect(r.decision, command).toBe('deny');
      expect(r.reason, command).toContain(title);
      expect(r.reason, command).toContain(file);
    }
    // A top-level wildcard is one level: it does not see what lies in folders.
    expect((await shell('rm -f *.log')).decision).toBeNull();
    expect((await shell('rm -f *.env')).decision).toBeNull();
    // A formatter only rewrites the kinds of file it knows: a covered file of another kind is
    // none of its business. A change of mode is a warning, not a block.
    for (const command of ['prettier --write .', 'eslint --fix .', 'black dist']) {
      const r = await shell(command);
      expect(r.decision, command).toBeNull();
      expect(r.context ?? '', command).not.toContain('Certificates are issued by hand');
    }
    const mode = await shell('chmod -R 755 .');
    expect(mode.decision).toBeNull();
    expect(mode.context).toContain('Certificates are issued by hand');
    for (const command of ['git checkout .', 'git restore .', 'rm -rf *']) {
      expect((await shell(command)).decision, command).toBe('deny');
    }
  });

  it('warns instead of blocking when the search for covered files cannot finish', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Certificates are issued by hand',
      body: 'Ask first.',
      scopePaths: ['**/*.pem'],
      source: USER,
      enforce: true,
    });
    mkdirSync(join(root, 'dist', 'deep'), { recursive: true });
    for (const name of ['a.js', 'b.js', 'c.js'])
      writeFileSync(join(root, 'dist', 'deep', name), '');
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    // A search budget too small for the folder: what it found is not the whole answer.
    const before = { ...SEARCH_LIMITS };
    SEARCH_LIMITS.entries = 1;
    SEARCH_LIMITS.firstPass = 1;
    try {
      const r = await shell('rm -rf dist');
      expect(r.decision).toBeNull();
      expect(r.context).toContain('could not search all of dist');
      expect(r.context).toContain('Certificates are issued by hand');
      // A possible write that could not be looked through says nothing.
      expect((await shell('mytool dist')).context ?? '').not.toContain('Certificates');
      // What the command names outright is still blocked, with or without a search.
      writeFileSync(join(root, 'dist', 'server.pem'), '');
      expect((await shell('rm dist/server.pem')).decision).toBe('deny');
      // A target whose search found a covered file is blocked, whatever another one did.
      mkdirSync(join(root, 'certs'));
      writeFileSync(join(root, 'certs', 'a.pem'), '');
      const both = await shell('rm -rf dist certs');
      expect(both.decision).toBe('deny');
      expect(both.reason).toContain('certs/a.pem');
    } finally {
      Object.assign(SEARCH_LIMITS, before);
    }
    expect((await shell('rm -rf dist')).decision).toBe('deny');
  });

  it('searches each target on its own, so a large folder never hides a small one', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Certificates are issued by hand',
      body: 'Ask first.',
      scopePaths: ['**/*.pem'],
      source: USER,
      enforce: true,
    });
    // A folder that sorts first and is larger than one search may look at.
    mkdirSync(join(root, 'build'));
    for (let i = 0; i < 3000; i++) writeFileSync(join(root, 'build', `f${i}.o`), '');
    mkdirSync(join(root, 'certs'));
    writeFileSync(join(root, 'certs', 'server.pem'), '');
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    const before = { ...SEARCH_LIMITS };
    SEARCH_LIMITS.entries = 1000;
    try {
      for (const command of [
        'rm -rf build certs',
        'rm -rf certs build',
        'rm -rf build && rm -rf certs',
        'rm -rf *',
        "find . -name '*.pem' -delete",
        'rm -f */*.pem',
      ]) {
        const r = await shell(command);
        expect(r.decision, command).toBe('deny');
        expect(r.reason, command).toContain('certs/server.pem');
      }
      const big = await shell('rm -rf build');
      expect(big.decision).toBeNull();
      expect(big.context).toContain('could not search all of build');
    } finally {
      Object.assign(SEARCH_LIMITS, before);
    }
  });

  it('walks the written folder itself when git does not answer, and still blocks', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-eng-')));
    mkdirSync(join(root, 'certs'));
    writeFileSync(join(root, 'certs', 'server.pem'), '');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'a.js'), '');
    const inRoot = async (cwd: string) =>
      cwd === root || cwd.startsWith(`${root}/`) ? root : null;
    // A git that never answers a listing, and one that fails outright.
    for (const listFiles of [
      () => new Promise<null>(() => undefined),
      async () => {
        throw new Error('git broke');
      },
    ]) {
      const mindly = Mindly.open({
        inMemory: true,
        clock: new FakeClock(),
        ports: { git: { ...fakeGit, findRepoRoot: inRoot, listFiles } },
      });
      const ctx = await mindly.projects.resolve(root);
      mindly.memory.remember({
        projectId: ctx.project.id,
        projectRoot: root,
        kind: 'rule',
        title: 'Certificates are issued by hand',
        body: 'Ask first.',
        scopePaths: ['**/*.pem'],
        source: USER,
        enforce: true,
      });
      const shell = (command: string) =>
        mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
      const started = performance.now();
      const r = await shell('rm -rf certs');
      expect(performance.now() - started).toBeLessThan(1500);
      expect(r.decision).toBe('deny');
      expect((await shell('rm certs/*.pem')).decision).toBe('deny');
      expect((await shell('rm -rf dist')).decision).toBeNull();
    }
  });

  it('keeps the letter case of a rule when the command ignores case', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Certificates are issued by hand',
      body: 'Ask first.',
      scopePaths: ['**/*.pem'],
      source: USER,
      enforce: true,
    });
    mkdirSync(join(root, 'certs'));
    writeFileSync(join(root, 'certs', 'OLD.PEM'), '');
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    expect((await shell("find . -iname '*.pem' -delete")).decision).toBeNull();
    writeFileSync(join(root, 'certs', 'new.pem'), '');
    expect((await shell("find . -iname '*.PEM' -delete")).decision).toBe('deny');
  });

  it('still places plain paths when the time for the rest has run out', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Certificates are issued by hand',
      body: 'Ask first.',
      scopePaths: ['**/*.pem'],
      source: USER,
      enforce: true,
    });
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    // A clock that has always run out: the heavy part is not placed, the plain path is.
    let t = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (t += 10_000));
    try {
      const command = `rm -rf ${Array.from({ length: 50 }, (_, i) => `dir${i}/*`).join(' ')} certs/a.pem`;
      const r = await shell(command);
      expect(r.decision).toBe('deny');
      expect(r.reason).toContain('certs/a.pem');
    } finally {
      clock.mockRestore();
    }
  });

  it('answers within its time, and says what it did not get to', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Certificates are issued by hand',
      body: 'Ask first.',
      scopePaths: ['**/*.pem'],
      source: USER,
      enforce: true,
    });
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    // A clock that has always run out: what is not searched is not cleared, and the agent is
    // told so.
    let t = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (t += 10_000));
    try {
      const r = await shell('rm -rf certs');
      expect(r.decision).toBeNull();
      expect(r.context).toContain('could not search all of certs');
    } finally {
      clock.mockRestore();
    }
    // Commands built to be slow end well inside the hook's deadline, with a warning.
    for (const command of [
      'cd a;'.repeat(40_000) + 'rm certs/a.pem',
      `rm ${'../'.repeat(60_000)}certs/a.pem`,
      `rm -rf ${'**/'.repeat(40)}*.pem`,
      `rm -rf ${'*a'.repeat(60)}*`,
      `${'echo x; '.repeat(25_000)}rm certs/a.pem`,
      `rm ${'{a,'.repeat(200)}b${'}'.repeat(200)}`,
    ]) {
      const started = performance.now();
      const r = await shell(command);
      expect(performance.now() - started, command.slice(0, 40)).toBeLessThan(1200);
      expect(r.decision, command.slice(0, 40)).toBeNull();
    }
    const cds = await shell('cd a;'.repeat(40_000) + 'rm certs/a.pem');
    expect(cds.context).toContain('did not read this whole command');
  });

  it('says so when a command is too long or too large to read to its end', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Certificates are issued by hand',
      body: 'Ask first.',
      scopePaths: ['**/*.pem'],
      source: USER,
      enforce: true,
    });
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    // Sixty other targets first, or twenty thousand characters: the write is still seen.
    const sixty = Array.from({ length: 60 }, (_, i) => `tmp/f${i}.txt`).join(' ');
    expect((await shell(`rm ${sixty} certs/server.pem`)).decision).toBe('deny');
    expect((await shell(`${'echo padding; '.repeat(2000)}rm certs/server.pem`)).decision).toBe(
      'deny',
    );
    // Beyond the limits the rest is not read, and the agent is told it was not checked.
    const many = Array.from({ length: 600 }, (_, i) => `tmp/f${i}.txt`).join(' ');
    const cut = await shell(`rm ${many} certs/server.pem`);
    expect(cut.decision).toBeNull();
    expect(cut.context).toContain('did not read this whole command');
    expect(cut.context).toContain('500 write targets');
    const long = await shell(`${'echo padding; '.repeat(20_000)}rm certs/server.pem`);
    expect(long.context).toContain('did not read this whole command');
    expect((await shell('rm tmp/a.txt')).context ?? '').not.toContain('did not read');
  });

  it('refuses a patch that was cut instead of checking only the part it was given', async () => {
    const { root, mindly } = setup();
    const tool = {
      ...writeTool('src/a.ts', 'x')!,
      name: 'apply_patch',
      editsCut: true,
    };
    const cut = await mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool }));
    expect(cut.decision).toBe('deny');
    expect(cut.reason).toContain('more files than are reported at once');
    const whole = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: { ...tool, editsCut: false } }),
    );
    expect(whole.decision).toBeNull();
    // More paths than are checked in one call are refused too, not dropped.
    const edits = Array.from({ length: 1001 }, (_, i) => ({
      path: `src/f${i}.ts`,
      addedText: 'x',
      removedText: '',
      wholeFile: true,
    }));
    const huge = await mindly.hooks.handle(
      event(root, 'codex', 'cx', 'pre_tool', { tool: { ...tool, editsCut: false, edits } }),
    );
    expect(huge.decision).toBe('deny');
  });

  it('names what git says a command changes from the top of the tree, at any count', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-eng-')));
    const listed = Array.from({ length: 100_000 }, (_, i) => `src/lib/d${i % 500}/f${i}.ts`);
    const roots: (string | undefined)[] = [];
    let answer = listed;
    const mindly = Mindly.open({
      inMemory: true,
      clock: new FakeClock(),
      ports: {
        git: {
          ...fakeGit,
          findRepoRoot: async (cwd) => (cwd === root || cwd.startsWith(`${root}/`) ? root : null),
          whatGitChanges: async (_cwd, query) => {
            roots.push(query.root);
            return Object.assign([...answer], { root });
          },
        },
      },
    });
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Certificates are issued by hand',
      body: 'Ask first.',
      scopePaths: ['**/*.pem'],
      source: USER,
      enforce: true,
    });
    const shell = (command: string) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool: shellTool(command) }));
    // A hundred thousand files are named without looking each one up.
    let started = performance.now();
    expect((await shell('git rm -r -q src')).decision).toBeNull();
    expect(performance.now() - started).toBeLessThan(3000);
    answer = [...listed, 'certs/server.pem'];
    started = performance.now();
    const r = await shell('git rm -r -q src');
    expect(performance.now() - started).toBeLessThan(3000);
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('certs/server.pem');
    // The top of the tree is known already: git is not asked for it again.
    expect(roots).toEqual([root, root]);
  });

  it('refuses a write to a path with control or bidi characters, never passing it over', async () => {
    const { root, mindly } = setup();
    const ctx = await mindly.projects.resolve(root);
    mindly.memory.remember({
      projectId: ctx.project.id,
      projectRoot: root,
      kind: 'rule',
      title: 'Certificates are issued by hand',
      body: 'Ask first.',
      scopePaths: ['**/*.pem'],
      source: USER,
      enforce: true,
    });
    const pre = (tool: NonNullable<ReturnType<typeof writeTool>>) =>
      mindly.hooks.handle(event(root, 'codex', 'cx', 'pre_tool', { tool }));
    // A name that reads as `server.pem` once a right-to-left override flips it, and one with a
    // control character in it.
    for (const name of ['certs/server\u202Emep.txt', 'certs/ser\u0007ver.pem']) {
      const edit = await pre(writeTool(name, 'x') as NonNullable<ReturnType<typeof writeTool>>);
      expect(edit.decision, JSON.stringify(name)).toBe('deny');
      expect(edit.reason, JSON.stringify(name)).toContain('control or bidi characters');
      const shell = await pre(
        shellTool(`rm -f '${name}'`) as NonNullable<ReturnType<typeof shellTool>>,
      );
      expect(shell.decision, JSON.stringify(name)).toBe('deny');
      expect(shell.reason, JSON.stringify(name)).toContain('control or bidi characters');
      // Reading it is not a write.
      const read = await pre(
        shellTool(`cat '${name}'`) as NonNullable<ReturnType<typeof shellTool>>,
      );
      expect(read.decision, JSON.stringify(name)).toBeNull();
    }
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
      ]) {
        expect((await shell(command)).decision, command).toBe('deny');
      }
      // A subshell is not read fully: a warning, not a block.
      const sub = await shell(`(cd /tmp && ls); rm src/generated/api.ts`);
      expect(sub.decision).toBeNull();
      expect(sub.context).toContain('could not read this command fully');
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
