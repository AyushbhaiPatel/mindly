import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliIo } from '../src/index.js';
import { run } from '../src/index.js';

/** A temp dir resolved through symlinks (macOS /var -> /private/var). */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
}

export function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** A git repository with one commit. */
export function repo(): string {
  const dir = tempDir('mindly-cli-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'README.md', '# demo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** Isolated environment: temp MINDLY_HOME, temp HOME and an empty PATH apart from git's. */
export interface Sandbox {
  home: string;
  mindlyHome: string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

export function sandbox(): Sandbox {
  const home = tempDir('mindly-cli-home-');
  const mindlyHome = join(tempDir('mindly-cli-mh-'), 'mindly');
  // PATH holds only git: agent binaries installed on this machine (claude, codex, cursor) stay
  // invisible to detection.
  const bin = tempDir('mindly-cli-bin-');
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    MINDLY_HOME: mindlyHome,
    PATH: bin,
    NO_COLOR: '1',
  };
  return { home, mindlyHome, repo: repo(), env };
}

/** Result of one in-process CLI run. */
export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Builds a test `CliIo`. */
export function testIo(
  sb: Sandbox,
  opts: { cwd?: string; stdin?: string; answers?: string[] } = {},
): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const answers = opts.answers ? [...opts.answers] : null;
  const stdin = opts.stdin ?? '';
  return {
    out,
    err,
    stdout: { write: (s: string) => void out.push(s), isTTY: false },
    stderr: { write: (s: string) => void err.push(s), isTTY: false },
    stdin: (async function* () {
      if (stdin) yield Buffer.from(stdin, 'utf8');
    })(),
    env: sb.env,
    cwd: opts.cwd ?? sb.repo,
    prompt: answers ? async () => answers.shift() ?? '' : null,
  };
}

/** Runs the CLI in-process. */
export async function cli(
  sb: Sandbox,
  argv: string[],
  opts: { cwd?: string; stdin?: string; answers?: string[] } = {},
): Promise<Result> {
  const io = testIo(sb, opts);
  const code = await run(argv, io);
  return { code, stdout: io.out.join(''), stderr: io.err.join('') };
}

/** Loads `test/fixtures/<name>.json`. */
export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'),
  ) as Record<string, unknown>;
}
