import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { MindlyError, redactText, sanitizeLine } from '@mindly/core';

/** Default wall-clock limit for one git invocation. */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
/** Hard upper bound callers may request for one git invocation. */
export const MAX_GIT_TIMEOUT_MS = 10 * 60_000;
/** Default cap on captured stdout/stderr (each) for one git invocation. */
export const DEFAULT_GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `-c` overrides applied to every internal git invocation. They neutralise the configuration
 * knobs a hostile repository (or a tampered `.git/config`) could use to run code or reach the
 * network: hooks, fsmonitor, ssh/credential helpers, every transport protocol, submodule
 * recursion, signing programs and pagers.
 */
export const HARDENING_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.sshCommand=false',
  'core.pager=cat',
  'core.quotePath=false',
  'credential.helper=',
  'protocol.allow=never',
  'protocol.file.allow=never',
  'protocol.git.allow=never',
  'protocol.ssh.allow=never',
  'protocol.http.allow=never',
  'protocol.https.allow=never',
  'protocol.ext.allow=never',
  'submodule.recurse=false',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'color.ui=never',
  'advice.detachedHead=false',
];

/** Environment variables passed through from the parent process (everything else is dropped). */
const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USERPROFILE',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
] as const;

/** Fixed environment for internal git invocations. */
const FIXED_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  // Read-only commands such as `status` must not opportunistically rewrite the index.
  GIT_OPTIONAL_LOCKS: '0',
  // Never let git-lfs (or any smudge filter) download content during internal checkouts.
  GIT_LFS_SKIP_SMUDGE: '1',
  // Pathspecs we pass are always literal file names, never globs or magic.
  GIT_LITERAL_PATHSPECS: '1',
  GIT_ADVICE: '0',
  LC_ALL: 'C',
  LANG: 'C',
  LANGUAGE: 'C',
};

/** Builds the minimal, hardened environment used for every internal git invocation. */
export function hardenedGitEnv(
  extra: Readonly<Record<string, string>> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = base[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  Object.assign(env, FIXED_ENV);
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || value.includes('\0')) {
      throw new MindlyError('invalid_input', 'invalid environment variable for git');
    }
    env[key] = value;
  }
  return env;
}

/** Options for `runGit`. */
export interface RunGitOptions {
  /** Working directory; must be an existing absolute directory. */
  cwd: string;
  /** Extra environment variables (internal use: `GIT_INDEX_FILE`, author identity, …). */
  env?: Readonly<Record<string, string>>;
  /** Extra `-c key=value` overrides, appended after the hardening set. */
  config?: readonly string[];
  /** Wall-clock limit in milliseconds (default 30 s, max 10 min). */
  timeoutMs?: number;
  /** Maximum bytes captured from stdout and stderr each (default 64 MiB). */
  maxBuffer?: number;
  /** Data written to git's stdin. */
  input?: string;
  /** Exit codes that are returned instead of thrown (0 is always accepted). */
  okExitCodes?: readonly number[];
}

/** Captured output of a git invocation. */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function assertDirectory(cwd: string): void {
  if (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0') || !isAbsolute(cwd)) {
    throw new MindlyError('invalid_input', 'git cwd must be an absolute path');
  }
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    // treated as missing below
  }
  if (!isDir) throw new MindlyError('not_found', 'git cwd is not an existing directory');
}

function safeStderr(stderr: string): string {
  return sanitizeLine(redactText(stderr), 300);
}

/**
 * Runs `git` with an argument array (never a shell), a hardened environment and configuration,
 * a timeout and an output cap. Non-zero exit codes not listed in `okExitCodes` raise a
 * `MindlyError`; error messages name only the git subcommand, never argument values.
 */
export function runGit(args: readonly string[], options: RunGitOptions): Promise<GitResult> {
  try {
    assertDirectory(options.cwd);
  } catch (err) {
    return Promise.reject(err);
  }
  if (args.length === 0 || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    return Promise.reject(new MindlyError('invalid_input', 'invalid git arguments'));
  }
  const timeout = Math.min(
    Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS)),
    MAX_GIT_TIMEOUT_MS,
  );
  const maxBuffer = Math.max(1024, Math.floor(options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER));
  const configArgs: string[] = [];
  for (const kv of [...HARDENING_CONFIG, ...(options.config ?? [])]) {
    if (kv.includes('\0') || !kv.includes('=')) {
      return Promise.reject(new MindlyError('invalid_input', 'invalid git config override'));
    }
    configArgs.push('-c', kv);
  }
  const fullArgs = ['--no-pager', ...configArgs, ...args];
  const env = hardenedGitEnv(options.env ?? {});
  const subcommand = args.find((a) => !a.startsWith('-')) ?? 'git';
  const ok = new Set([0, ...(options.okExitCodes ?? [])]);

  return new Promise<GitResult>((resolve, reject) => {
    const child = execFile(
      'git',
      fullArgs,
      {
        cwd: options.cwd,
        env,
        timeout,
        maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        killSignal: 'SIGTERM',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const err = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (err.code === 'ENOENT') {
          reject(new MindlyError('unavailable', 'git executable not found on PATH'));
          return;
        }
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(
            new MindlyError('internal', `git ${subcommand} output exceeded the size limit`, {
              details: { subcommand, maxBuffer },
            }),
          );
          return;
        }
        if (err.killed || err.signal) {
          reject(
            new MindlyError('timeout', `git ${subcommand} timed out`, {
              details: { subcommand, timeoutMs: timeout },
            }),
          );
          return;
        }
        const exitCode = typeof err.code === 'number' ? err.code : -1;
        if (ok.has(exitCode)) {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        reject(
          new MindlyError('internal', `git ${subcommand} failed`, {
            details: { subcommand, exitCode, stderr: safeStderr(stderr) },
          }),
        );
      },
    );
    if (child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input ?? '');
    }
  });
}

/** Parsed `git version`. */
export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  /** Raw `git version` output, trimmed. */
  raw: string;
}

let versionPromise: Promise<GitVersion> | null = null;

/** Parses `git version 2.39.3 (Apple Git-145)` style output. */
export function parseGitVersion(raw: string): GitVersion {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!m) throw new MindlyError('unavailable', 'could not determine git version');
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3] ?? 0),
    raw: raw.trim(),
  };
}

/** Returns the installed git version (cached for the life of the process). */
export function gitVersion(): Promise<GitVersion> {
  versionPromise ??= runGit(['version'], { cwd: tmpdir(), timeoutMs: 10_000 }).then(
    (r) => parseGitVersion(r.stdout),
    (err: unknown) => {
      versionPromise = null;
      throw err;
    },
  );
  return versionPromise;
}

/** True when `v` is at least `major.minor`. */
export function versionAtLeast(v: GitVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/**
 * Discovers attribute-driven programs (filter, diff and merge drivers) defined in the repository's
 * own `local`/`worktree` config scope and returns `-c` overrides that disable them. Global config
 * is the user's own and is left alone; system config is never read.
 */
export async function driverOverrides(cwd: string): Promise<string[]> {
  const res = await runGit(
    [
      'config',
      '--null',
      '--show-scope',
      '--get-regexp',
      '^(filter|diff|merge)\\..+\\.(clean|smudge|process|command|textconv|driver)$',
    ],
    { cwd, okExitCodes: [1], timeoutMs: 10_000 },
  );
  const out: string[] = [];
  const fields = res.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i] ?? '';
    const entry = fields[i + 1] ?? '';
    if (scope !== 'local' && scope !== 'worktree') continue;
    const nl = entry.indexOf('\n');
    const key = (nl === -1 ? entry : entry.slice(0, nl)).trim();
    const m = /^(filter|diff|merge)\.(.+)\.(clean|smudge|process|command|textconv|driver)$/i.exec(
      key,
    );
    if (!m || /[\0\n=]/.test(key)) continue;
    const section = (m[1] ?? '').toLowerCase();
    const name = m[2] ?? '';
    out.push(`${key}=`);
    if (section === 'filter') out.push(`filter.${name}.required=false`);
  }
  return [...new Set(out)];
}
