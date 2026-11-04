import type { Clock } from '@synapse/core';
import { Store } from '../src/index.js';

export class FakeClock implements Clock {
  constructor(public t = 1_750_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function setup() {
  const clock = new FakeClock();
  const store = Store.memory(clock);
  const project = store.projects.upsertByRoot('/repo', 'repo');
  const a = store.sessions.upsert({
    projectId: project.id,
    agentKind: 'claude-code',
    externalId: 'cc-1',
    worktree: '/repo',
    branch: 'main',
    transcriptPath: null,
  }).session;
  const b = store.sessions.upsert({
    projectId: project.id,
    agentKind: 'codex',
    externalId: 'cx-1',
    worktree: '/repo',
    branch: 'main',
    transcriptPath: null,
  }).session;
  return { clock, store, project, a, b };
}
