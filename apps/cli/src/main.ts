#!/usr/bin/env node
import './quiet-warnings.js';

/**
 * Entry point of the `mindly` binary. The rest of the CLI is loaded with a dynamic import so the
 * warning filter above is installed before any module (including `node:sqlite`) is linked.
 * `hook` exits as soon as its answer is written: when the deadline passed, the abandoned handler
 * must not keep the agent waiting. `statusline` runs every few seconds, so it skips the command
 * parser entirely and exits the same way (stdin may still be open when nothing was piped in).
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  quietOnClosedPipe();
  const { failsOpen, nodeProblem } = await import('./node-check.js');
  const problem = await nodeProblem(argv, {
    version: process.version,
    loadSqlite: () => import('node:sqlite'),
  });
  if (problem !== null) {
    if (failsOpen(argv)) {
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
    return;
  }
  if (argv.length === 1 && argv[0] === 'statusline') {
    const [{ processIo }, { runStatusLine }] = await Promise.all([
      import('./io.js'),
      import('./statusline.js'),
    ]);
    const code = await runStatusLine(processIo());
    process.stdout.write('', () => process.exit(code));
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

/**
 * A reader that goes away early (`mindly init | head -1`) closes the pipe; the next write then
 * fails with EPIPE. That is the reader's choice, not an error: stop quietly.
 */
function quietOnClosedPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(0);
      throw err;
    });
  }
}

void main();
