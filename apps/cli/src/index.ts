/**
 * `mindly`: the `mindly` command. `run(argv, io)` is the whole CLI as a function (used by
 * `main.ts` and by tests); `runHook` is the agent hook hot path.
 */
export { run } from './run.js';
export { MAX_HOOK_STDIN_BYTES, readStdin, runHook, type HookDeps } from './hook.js';
export { confirm, processIo, styleFor, type CliIo, type Style, type TextOut } from './io.js';
export { diffSummary, type DiffSummary } from './diff.js';
export { EXIT_ERROR, EXIT_OK, EXIT_USAGE, UsageError } from './util.js';
