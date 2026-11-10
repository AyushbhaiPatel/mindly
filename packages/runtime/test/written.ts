// Helpers for tests that check a git command line both ways: what the pre-tool hook says about
// it, and which covered files it really writes when run in a scratch copy of the repository.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { openMindly } from '../src/index.js';

/**
 * The environment git runs in: the test's own, less what would change what git does (an editor,
 * a password prompt, settings given through `GIT_CONFIG_*`), so commands behave the same anywhere.
 */
export const GIT_ENV = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/^(GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_ASKPASS|GIT_CONFIG_.*|EDITOR|VISUAL)$/.test(k),
    ),
  ),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function guarded(scopes: Record<string, string[]>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-written-')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
      cwd: dir,
      stdio: 'pipe',
      env: GIT_ENV,
    }).toString();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'r\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const home = mkdtempSync(join(tmpdir(), 'mindly-home-'));
  const mindly = openMindly({ home, disableNotify: true });
  const ready = (async () => {
    const project = await mindly.projects.resolve(dir);
    for (const [title, scopePaths] of Object.entries(scopes)) {
      mindly.memory.remember({
        projectId: project.project.id,
        projectRoot: dir,
        kind: 'rule',
        title,
        body: 'Ask first.',
        scopePaths,
        source: { type: 'user', sessionId: null, agentKind: null },
        enforce: true,
      });
    }
  })();
  // A test that stops before asking closes the store under it: that is not an error of its own.
  ready.catch(() => undefined);
  const shell = async (command: string, cwd = dir) => {
    await ready;
    return mindly.hooks.handle({
      agentKind: 'codex',
      event: 'pre_tool',
      externalSessionId: 'git',
      cwd,
      transcriptPath: null,
      startSource: null,
      prompt: null,
      lastMessage: null,
      tool: {
        name: 'Bash',
        writes: false,
        shell: true,
        edits: [],
        command,
        failed: false,
        outputExcerpt: null,
      },
    });
  };
  return { dir, mindly, shell, git };
}

/** Every file under `dir` (outside .git) matching `test`, with content hash and mtime. */
function snapshot(dir: string, test: (rel: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = relative(dir, p);
        if (!test(rel)) continue;
        const st = statSync(p);
        const h = createHash('sha1').update(readFileSync(p)).digest('hex');
        out.set(rel, `${h}:${st.mtimeMs}:${st.ino}`);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Runs `command` in a scratch copy of `dir` and returns the covered files it created, changed,
 * rewrote or removed.
 */
export function runInCopy(
  dir: string,
  command: string,
  covered: (rel: string) => boolean,
  sub = '',
): { written: string[]; output: string } {
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'mindly-written-copy-')));
  execFileSync('cp', ['-a', `${dir}/.`, copy]);
  // Let mtimes move apart from the copy's.
  execFileSync('sleep', ['0.05']);
  const before = snapshot(copy, covered);
  let output: string;
  try {
    output = execFileSync('bash', ['-c', `${command} 2>&1`], {
      cwd: join(copy, sub),
      env: GIT_ENV,
    }).toString();
  } catch (e) {
    output = `(exit ${(e as { status: number }).status}) ${String((e as { stdout?: Buffer }).stdout ?? '')}`;
  }
  const after = snapshot(copy, covered);
  const written: string[] = [];
  for (const [k, v] of before) if (after.get(k) !== v) written.push(k);
  for (const k of after.keys()) if (!before.has(k)) written.push(k);
  return { written: written.sort(), output };
}

export const pem = (rel: string) => rel.endsWith('.pem');

export function file(dir: string, rel: string, text: string) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

export { existsSync };
