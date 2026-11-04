#!/usr/bin/env node
import './quiet-warnings.js';

/**
 * Entry point of the `mindly` binary. The rest of the CLI is loaded with a dynamic import so the
 * warning filter above is installed before any module (including `node:sqlite`) is linked.
 * `hook` exits as soon as its answer is written: when the deadline passed, the abandoned handler
 * must not keep the agent waiting. `statusline` skips the command parser and the Mindly packages
 * entirely so Claude Code's status line starts as fast as Node can.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === 'statusline') {
    let line = 'mindly · offline';
    try {
      const { statusLineText } = await import('./statusline.js');
      line = await statusLineText({ stdin: process.stdin, env: process.env, cwd: process.cwd() });
    } catch {
      // statusLineText never throws; this covers a missing module or working directory.
    }
    process.stdout.write(`${line}\n`, () => process.exit(0));
    return;
  }
  const [{ processIo }, { run }] = await Promise.all([import('./io.js'), import('./run.js')]);
  const code = await run(argv, processIo());
  if (argv[0] === 'hook') {
    process.stdout.write('', () => process.exit(code));
    return;
  }
  process.exitCode = code;
}

void main();
