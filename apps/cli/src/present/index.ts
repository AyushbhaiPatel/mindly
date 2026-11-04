/*
 * Presentation helpers for human CLI output (docs/output-style.md): agent and session names,
 * plain words for internal values, relative times, markers with an ASCII fallback, colour only on
 * a TTY, wrapping at the terminal width. `--json` output never goes through these.
 */
export { agentName, humanizeText, sessionName } from './agents.js';
export * from './terminal.js';
export * from './time.js';
export * from './words.js';
