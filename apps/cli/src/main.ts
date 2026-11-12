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
  const [{ quietOnClosedPipe, whileRunning }, { failsOpen, loadSqliteWithFts5, nodeProblem }] =
    await Promise.all([import('./closed-pipe.js'), import('./node-check.js')]);
  // The MCP server ends its session when its client stops reading: it handles that itself.
  if (argv[0] !== 'mcp') quietOnClosedPipe();
  const problem = await nodeProblem(argv, {
    version: process.version,
    loadSqlite: loadSqliteWithFts5,
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
  if (argv[0] === 'mcp') quietUntilServerStarts();
  const [{ processIo }, { run }] = await Promise.all([import('./io.js'), import('./run.js')]);
  // Cut off by a closed pipe before it finishes, a command has not succeeded; hooks still fail open.
  whileRunning(failsOpen(argv) ? 0 : 1);
  const code = await run(argv, processIo());
  whileRunning(null);
  if (argv[0] === 'hook') {
    process.stdout.write('', () => process.exit(code));
    return;
  }
  process.exitCode = code;
}

/**
 * A client may stop its MCP server right after starting it. Until the server has loaded and
 * installed its own handlers there is nothing to clean up, so a signal ends the process with
 * exit code 0 where the default would report it as killed. The server removes these handlers
 * through the well-known symbol when it takes over.
 */
function quietUntilServerStarts(): void {
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const quit = (): void => process.exit(0);
  for (const s of signals) process.once(s, quit);
  (globalThis as Record<symbol, unknown>)[Symbol.for('mindly.mcp.earlySignals')] = (): void => {
    for (const s of signals) process.off(s, quit);
  };
}

void main();
