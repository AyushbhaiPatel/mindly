import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll } from 'vitest';

const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'],
  HOME: process.env['HOME'],
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.invalid',
  LC_ALL: 'C',
};

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp directory (realpath), removed after the test file. */
export function tempDir(prefix = 'syn-runners-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Runs git for test setup. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: TEST_GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Writes a file relative to `root`. */
export function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Repository with an initial commit. Returns its root. */
export function makeRepo(files: Record<string, string> = { 'README.md': '# test\n' }): string {
  const root = tempDir('syn-runners-repo-');
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--no-verify', '-m', 'initial');
  return root;
}

/** What a fake agent recorded about its invocation. */
export interface FakeLog {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  cwd: string;
}

/** A directory of fake agent executables plus where they log. */
export interface FakeBin {
  dir: string;
  logDir: string;
  /** Environment whose PATH starts with the fake bin dir; includes a secret and an auth key. */
  env: NodeJS.ProcessEnv;
  /** Reads the last log written by `name`, or null. */
  log(name: string): FakeLog | null;
}

/** Creates an empty fake bin directory. */
export function makeFakeBin(): FakeBin {
  const dir = tempDir('syn-fake-bin-');
  const logDir = tempDir('syn-fake-log-');
  return {
    dir,
    logDir,
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`,
      SECRET_X: 'super-secret-value',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      OPENAI_API_KEY: 'test-openai-key',
    },
    log(name) {
      const p = join(logDir, `${name}.json`);
      return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as FakeLog) : null;
    },
  };
}

/**
 * Installs a fake agent `name` (a CommonJS Node script with a shebang). It reads stdin, logs
 * argv/env/stdin/cwd, then runs `body` with `input` (stdin text), `argv`, `fs`, `cp` and `path`
 * in scope.
 */
export function installFake(bin: FakeBin, name: string, body: string): void {
  const logPath = join(bin.logDir, `${name}.json`);
  const script = `#!/usr/bin/env node
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const argv = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, env: process.env, stdin: input, cwd: process.cwd() }));
  ${body}
});
`;
  const p = join(bin.dir, name);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** Body printing a Claude Code `--output-format json` result whose `result` is `text`. */
export function claudeResultBody(text: string, extra = ''): string {
  return `${extra}
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
  result: ${JSON.stringify(text)}, total_cost_usd: 0.0123, session_id: 'sess-1', num_turns: 2,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }));`;
}

/** Body emulating `codex exec --json --output-last-message <file>` with final message `text`. */
export function codexResultBody(text: string, extra = ''): string {
  return `${extra}
const i = argv.indexOf('--output-last-message');
if (i !== -1) fs.writeFileSync(argv[i + 1], ${JSON.stringify(text)});
const ev = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
ev({ type: 'thread.started', thread_id: 'thread-1' });
ev({ type: 'turn.started' });
ev({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: ${JSON.stringify(text)} } });
ev({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 7 } });`;
}

/**
 * PATH containing only the fake bin dir and a dir with a `node` symlink, so real agent installs
 * on the developer's PATH cannot be picked up.
 */
export function isolatedPath(bin: FakeBin): string {
  const nodeDir = tempDir('syn-node-bin-');
  symlinkSync(process.execPath, join(nodeDir, 'node'));
  return `${bin.dir}${delimiter}${nodeDir}`;
}

/** True when a process with `pid` exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed process nobody has reaped yet (a zombie) still answers signal 0.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true;
  }
}
