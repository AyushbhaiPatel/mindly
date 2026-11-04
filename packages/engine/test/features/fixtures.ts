import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemorySource, Session } from '@synapse/core';
import { installDefaultModules, Synapse, type GitPort } from '../../src/index.js';
import { event, FakeClock, fakeGit } from '../helpers.js';

export const AUTH_V1 = [
  'export function login(user: string) {',
  '  return { role: "admin" };',
  '}',
  'export const VERSION = 1;',
  '',
].join('\n');

const EXPORT_RE =
  /^export\s+(?:async\s+)?(function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)(.*)$/;

/** Tiny regex-based export surface: `name -> kind + normalised rest of the declaration line`. */
export function regexExportSurface(source: string, path: string): Map<string, string> | null {
  if (!/\.(?:[cm]?[jt]sx?|py)$/.test(path)) return null;
  const out = new Map<string, string>();
  for (const line of source.split('\n')) {
    const m = EXPORT_RE.exec(line.trim());
    if (!m) continue;
    const [, kind, name, rest] = m;
    // Constants: the value is not part of the signature.
    const sig =
      kind === 'const' || kind === 'let' ? kind : `${kind}${(rest ?? '').replace(/\s+/g, '')}`;
    out.set(name as string, sig ?? '');
  }
  return out;
}

export interface FakeRepo {
  /** File contents at HEAD, by project-relative path. */
  head: Record<string, string>;
  /** Importers of each file. */
  dependents: Record<string, string[]>;
}

export function richGit(repo: FakeRepo): GitPort {
  return {
    ...fakeGit,
    fileAtRef: async (_cwd, ref, path) => (ref === 'HEAD' ? (repo.head[path] ?? null) : null),
    exportSurface: regexExportSurface,
    diffExportSurface: (before, after) => ({
      added: [...after.keys()].filter((k) => !before.has(k)),
      removed: [...before.keys()].filter((k) => !after.has(k)),
      changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
    }),
    dependentsOf: async (_root, file) => repo.dependents[file] ?? [],
  };
}

/** A temp project with two live sessions (Claude Code `cc` and Codex `cx`) and all features. */
export async function featureSetup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-feat-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'auth.ts'), AUTH_V1);
  writeFileSync(
    join(root, 'src', 'dashboard.ts'),
    "import { login } from './auth';\nexport const view = login('x');\n",
  );
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}\n');
  const repo: FakeRepo = {
    head: { 'src/auth.ts': AUTH_V1 },
    dependents: { 'src/auth.ts': ['src/dashboard.ts'] },
  };
  const clock = new FakeClock();
  const synapse = Synapse.open({ inMemory: true, clock, ports: { git: richGit(repo) } });
  installDefaultModules(synapse);
  await synapse.hooks.handle(event(root, 'claude-code', 'cc', 'session_start'));
  await synapse.hooks.handle(event(root, 'codex', 'cx', 'session_start'));
  const pid = synapse.store.projects.list()[0]!.id;
  const cc = synapse.store.sessions.findByExternal(pid, 'claude-code', 'cc')!;
  const cx = synapse.store.sessions.findByExternal(pid, 'codex', 'cx')!;
  const write = (rel: string, content: string) => writeFileSync(join(root, rel), content);
  return { root, clock, synapse, repo, pid, cc, cx, write };
}

export function agentSource(s: Session): MemorySource {
  return { type: 'agent', sessionId: s.id, agentKind: s.agentKind };
}
