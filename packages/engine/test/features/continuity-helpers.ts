import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultUserConfig, type UserConfig } from '@synapse/core';
import { Synapse, type GitPort, type NotifierPort } from '../../src/index.js';
import { FakeClock, fakeGit } from '../helpers.js';

export type Sent = Parameters<NotifierPort['send']>[0];

/** A Synapse with a recording notifier, adjustable config and git port. */
export function make(opts: { config?: (c: UserConfig) => void; git?: Partial<GitPort> } = {}): {
  root: string;
  clock: FakeClock;
  synapse: Synapse;
  sent: Sent[];
} {
  const root = tmp('syn-cont-');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function login() {}\n');
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const config = defaultUserConfig();
  opts.config?.(config);
  const synapse = Synapse.open({
    inMemory: true,
    clock,
    config,
    ports: {
      git: { ...fakeGit, headCommit: async () => 'abc1234def5678', ...opts.git },
      notifier: {
        send: async (n) => {
          sent.push(n);
        },
      },
    },
  });
  return { root, clock, synapse, sent };
}

export function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
