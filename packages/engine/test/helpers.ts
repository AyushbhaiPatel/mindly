import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Clock, HookEventName, NormalizedHookEvent } from '@synapse/core';
import { nullGit, Synapse, type GitPort } from '../src/index.js';

export class FakeClock implements Clock {
  constructor(public t = 1_750_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const fakeGit: GitPort = {
  ...nullGit,
  currentBranch: async () => 'main',
  hunkHashes: (text) =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 4)
      .map((l) => createHash('sha256').update(l).digest('hex')),
};

export function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'syn-eng-')));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'auth.ts'),
    'export function login(user: string) {\n  return { role: "admin" };\n}\n',
  );
  const clock = new FakeClock();
  const synapse = Synapse.open({ inMemory: true, clock, ports: { git: fakeGit } });
  return { root, clock, synapse };
}

export function event(
  root: string,
  agentKind: string,
  sessionId: string,
  name: HookEventName,
  extra: Partial<NormalizedHookEvent> = {},
): NormalizedHookEvent {
  return {
    agentKind,
    event: name,
    externalSessionId: sessionId,
    cwd: root,
    transcriptPath: null,
    startSource: null,
    prompt: null,
    tool: null,
    lastMessage: null,
    ...extra,
  };
}

export function writeTool(path: string, added: string): NormalizedHookEvent['tool'] {
  return {
    name: 'Edit',
    writes: true,
    shell: false,
    edits: [{ path, addedText: added, removedText: '', wholeFile: false }],
    command: null,
    failed: false,
    outputExcerpt: null,
  };
}

export function shellTool(
  command: string,
  failed = false,
  output: string | null = null,
): NormalizedHookEvent['tool'] {
  return {
    name: 'Bash',
    writes: false,
    shell: true,
    edits: [],
    command,
    failed,
    outputExcerpt: output,
  };
}
