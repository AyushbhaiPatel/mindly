import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

/** Hermetic environment for the test's own git calls: no global/system config. */
const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'],
  HOME: process.env['HOME'],
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
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

/** Creates a fresh temp directory (realpath) removed after the test file. */
export function tempDir(prefix = 'syn-git-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Runs git for test setup (not through the library under test). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: TEST_GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Writes a file (creating parent directories) relative to `root`. */
export function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Stages everything and commits. Returns the new HEAD id. */
export function commitAll(root: string, message = 'commit'): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--no-verify', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}

/** Creates a repository with an initial commit containing `files`. */
export function makeRepo(files: Record<string, string> = { 'README.md': '# test\n' }): string {
  const root = tempDir('syn-repo-');
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  commitAll(root, 'initial');
  return root;
}
