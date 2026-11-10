import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultUserConfig, type UserConfig } from '@mindly/core';
import { Mindly, type GitPort, type NotifierPort, type NotifyResult } from '../../src/index.js';
import { FakeClock, fakeGit } from '../helpers.js';

export type Sent = Parameters<NotifierPort['send']>[0];
export type SentOptions = Parameters<NotifierPort['send']>[1];

/**
 * A Mindly with a recording notifier, adjustable config and git port. `answer` is what the
 * notifier reports for each send (nothing by default, as a port that cannot tell).
 */
export function make(
  opts: {
    config?: (c: UserConfig) => void;
    git?: Partial<GitPort>;
    answer?: (n: Sent) => NotifyResult[] | undefined;
  } = {},
): {
  root: string;
  clock: FakeClock;
  mindly: Mindly;
  sent: Sent[];
  sentOptions: SentOptions[];
} {
  const root = tmp('syn-cont-');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'auth.ts'), 'export function login() {}\n');
  const clock = new FakeClock();
  const sent: Sent[] = [];
  const sentOptions: SentOptions[] = [];
  const config = defaultUserConfig();
  opts.config?.(config);
  const mindly = Mindly.open({
    inMemory: true,
    clock,
    config,
    ports: {
      git: { ...fakeGit, headCommit: async () => 'abc1234def5678', ...opts.git },
      notifier: {
        send: async (n, options) => {
          sent.push(n);
          sentOptions.push(options);
          return opts.answer?.(n);
        },
      },
    },
  });
  return { root, clock, mindly, sent, sentOptions };
}

export function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
