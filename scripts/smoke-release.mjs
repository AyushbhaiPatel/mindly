#!/usr/bin/env node
// Smoke-tests a packed `mindly-agents` tarball the way a user would install it.
//
// Usage: node scripts/smoke-release.mjs <path/to/mindly-agents-x.y.z.tgz>
//
// Everything runs in a fresh temp directory with a temp HOME and MINDLY_HOME, so the real
// ~/.mindly, ~/.claude and npm cache are never touched. `npm install` of the tarball needs network
// access for the third-party dependencies. Nothing is published.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const tarballArg = process.argv[2];
if (!tarballArg) {
  console.error('usage: node scripts/smoke-release.mjs <tarball>');
  process.exit(2);
}
const tarball = resolve(tarballArg);
if (!existsSync(tarball)) {
  console.error(`smoke: ${tarball} not found`);
  process.exit(2);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-smoke-')));
const dirs = {
  home: join(root, 'home'),
  mindlyHome: join(root, 'mindly-home'),
  app: join(root, 'app'),
  repo: join(root, 'repo'),
};
// MINDLY_HOME must be private (0700) or `mindly doctor` rightly fails its permissions check.
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });

const bin = join(dirs.app, 'node_modules', '.bin');
const pkgDir = join(dirs.app, 'node_modules', 'mindly-agents');
const env = {
  PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  MINDLY_HOME: dirs.mindlyHome,
  npm_config_cache: join(root, 'npm-cache'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  GIT_AUTHOR_NAME: 'smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  NO_COLOR: '1',
};

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail.replace(/\n/g, '\n      ')}` : ''}`,
  );
};
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? dirs.app,
    env,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
  });
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
};
const freePort = () =>
  new Promise((done, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => done(port));
    });
  });

try {
  console.log(`smoke: working in ${root}`);

  // 1. Install the tarball like a user would (local install).
  run('npm', ['init', '-y']);
  const install = run('npm', ['install', tarball], { timeout: 600_000 });
  check(
    install.code === 0 && existsSync(join(pkgDir, 'dist', 'main.js')),
    'npm install <tarball>',
    install.code === 0 ? '' : install.stderr,
  );

  // 2. --version through npx.
  const version = run('npx', ['--no-install', 'mindly', '--version']);
  const expected = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  check(
    version.code === 0 && version.stdout === expected,
    `npx mindly --version -> ${version.stdout}`,
    version.stderr,
  );

  // 3. doctor.
  const doctor = run('mindly', ['doctor']);
  check(
    doctor.code === 0,
    `mindly doctor (exit ${doctor.code})`,
    `${doctor.stdout}\n${doctor.stderr}`.trim(),
  );

  // 4. init in a temp git repo; the hook must point at the installed package.
  run('git', ['init', '-q', '-b', 'main'], { cwd: dirs.repo });
  writeFileSync(join(dirs.repo, 'README.md'), '# smoke\n');
  run('git', ['add', '.'], { cwd: dirs.repo });
  run('git', ['commit', '-q', '-m', 'init'], { cwd: dirs.repo });
  const port = await freePort();
  writeFileSync(join(dirs.mindlyHome, 'config.json'), `${JSON.stringify({ daemon: { port } })}\n`, {
    mode: 0o600,
  });
  const init = run('mindly', ['init', '--project', '--yes', '--agents', 'claude-code'], {
    cwd: dirs.repo,
  });
  check(
    init.code === 0,
    `mindly init --project --yes --agents claude-code (exit ${init.code})`,
    init.code === 0 ? '' : `${init.stdout}\n${init.stderr}`,
  );
  const settingsFile = join(dirs.repo, '.claude', 'settings.json');
  const settings = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '';
  const commands = [...settings.matchAll(/"command":\s*"([^"]+)"/g)].map((m) => m[1]);
  const first = commands[0] ?? '';
  const pointsInside =
    commands.length > 0 &&
    commands.every(
      (c) =>
        c.includes(realpathSync(dirs.app)) &&
        (c.includes(join('mindly-agents', 'dist', 'main.js')) ||
          c.includes(join('.bin', 'mindly'))),
    );
  check(
    pointsInside,
    `.claude/settings.json hooks point at the installed package (${commands.length} hooks)`,
    first,
  );
  const binPath = first.split(' ').find((part) => isAbsolute(part) && /mindly|main\.js/.test(part));
  check(Boolean(binPath && existsSync(binPath)), 'hook entry exists on disk', binPath ?? '(none)');

  // 4b. Without `mindly` on PATH, init falls back to `node <package>/dist/main.js`.
  const repo2 = join(root, 'repo2');
  mkdirSync(repo2);
  run('git', ['init', '-q', '-b', 'main'], { cwd: repo2 });
  const noPath = spawnSync(
    process.execPath,
    [join(pkgDir, 'dist', 'main.js'), 'init', '--project', '--yes', '--agents', 'claude-code'],
    { cwd: repo2, env: { ...env, PATH: process.env.PATH ?? '' }, encoding: 'utf8' },
  );
  const settings2File = join(repo2, '.claude', 'settings.json');
  const settings2 = existsSync(settings2File) ? readFileSync(settings2File, 'utf8') : '';
  const fallback = /"command":\s*"([^"]+)"/.exec(settings2)?.[1] ?? '';
  const fallbackMain = join(realpathSync(pkgDir), 'dist', 'main.js');
  check(
    noPath.status === 0 && fallback.includes(fallbackMain) && existsSync(fallbackMain),
    'init without mindly on PATH uses node <package>/dist/main.js',
    fallback,
  );

  // 5. A SessionStart hook payload; with one rule in memory the hook must inject it.
  const add = run('mindly', ['memory', 'add', '--kind', 'rule', '--title', 'Use pnpm, never npm'], {
    cwd: dirs.repo,
  });
  check(add.code === 0, `mindly memory add --kind rule (exit ${add.code})`, add.stderr);
  const payload = JSON.stringify({
    session_id: 'smoke-session',
    transcript_path: join(dirs.home, 'transcript.jsonl'),
    cwd: dirs.repo,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  const hook = run('mindly', ['hook', 'claude-code', 'SessionStart'], {
    cwd: dirs.repo,
    input: payload,
  });
  check(
    hook.code === 0 &&
      hook.stderr === '' &&
      hook.stdout.includes('additionalContext') &&
      hook.stdout.includes('Use pnpm, never npm'),
    `mindly hook claude-code SessionStart (exit ${hook.code}, stdout ${hook.stdout.length} bytes, stderr ${hook.stderr.length} bytes)`,
    `${hook.stdout.slice(0, 300)}${hook.stderr ? `\nstderr: ${hook.stderr}` : ''}`,
  );

  // 6. Daemon: start, health, dashboard, stop.
  const start = run('mindly', ['daemon', 'start'], { cwd: dirs.repo, timeout: 60_000 });
  check(
    start.code === 0,
    `mindly daemon start (exit ${start.code})`,
    `${start.stdout}\n${start.stderr}`.trim(),
  );
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await health.text();
    check(
      health.status === 200 && JSON.parse(body).ok === true,
      `GET /api/health -> ${health.status}`,
      body,
    );
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    check(
      page.status === 200 &&
        /text\/html/.test(page.headers.get('content-type') ?? '') &&
        html.includes('<div id="root">'),
      `GET / -> ${page.status} ${page.headers.get('content-type')}, ${html.length} bytes of dashboard HTML`,
    );
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    const js = asset ? await fetch(`http://127.0.0.1:${port}${asset}`) : null;
    check(js?.status === 200, `GET ${asset ?? '(no script tag)'} -> ${js?.status ?? 'n/a'}`);
  } catch (err) {
    check(false, 'daemon HTTP checks', String(err));
  }
  const stop = run('mindly', ['daemon', 'stop'], { cwd: dirs.repo, timeout: 60_000 });
  check(
    stop.code === 0,
    `mindly daemon stop (exit ${stop.code})`,
    `${stop.stdout}\n${stop.stderr}`.trim(),
  );
  const stopped = await fetch(`http://127.0.0.1:${port}/api/health`).then(
    () => false,
    () => true,
  );
  check(stopped, 'daemon no longer answers after stop');
} finally {
  // Make sure no daemon outlives the test, then clean up.
  spawn('mindly', ['daemon', 'stop'], { cwd: dirs.repo, env, stdio: 'ignore' }).on('exit', () => {
    if (!process.env.MINDLY_SMOKE_KEEP) rmSync(root, { recursive: true, force: true });
    console.log(failures === 0 ? 'smoke: all checks passed' : `smoke: ${failures} check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
  });
}
