#!/usr/bin/env node
import { processIo } from './io.js';
import { run } from './run.js';

/**
 * Entry point of the `mindly` binary. `hook` exits as soon as its answer is written: when the
 * deadline passed, the abandoned handler must not keep the agent waiting.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await run(argv, processIo());
  if (argv[0] === 'hook') {
    process.stdout.write('', () => process.exit(code));
    return;
  }
  process.exitCode = code;
}

void main();
