#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isMindlyError } from '@mindly/core';
import { startDaemon, type Daemon } from './daemon.js';

/**
 * Entry point for `node dist/main.js`: starts the daemon with the user's config and stops it
 * gracefully on SIGINT/SIGTERM. Prints only the URL (never the token).
 */
export async function main(): Promise<number> {
  let daemon: Daemon;
  try {
    daemon = await startDaemon();
  } catch (err) {
    process.stderr.write(
      `mindly daemon: ${isMindlyError(err) ? err.message : 'failed to start (see the log)'}\n`,
    );
    return 1;
  }
  process.stdout.write(`Mindly daemon listening on ${daemon.url}\n`);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      void daemon.stop().finally(resolve);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
