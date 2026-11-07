/*
 * Text-only reading of shell commands an agent ran. Nothing here executes anything: commands are
 * compared and searched as strings, to tell whether a command could have written a file Mindly
 * is watching (saves) and whether two runs were the same command line.
 */

/** The command line with surrounding and repeated whitespace removed. */
export function normalizeCommandLine(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** Programs that only read files (when no output redirection is used). */
const READ_ONLY_PROGRAMS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'wc',
  'ls',
  'stat',
  'file',
  'diff',
  'bat',
  'nl',
  'jq',
  'echo',
  'printf',
  'test',
  'pwd',
]);

/** `git` subcommands that only read. */
const READ_ONLY_GIT = new Set(['diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the command text mentions `path` or its basename as a word. */
export function mentionsPath(command: string, path: string): boolean {
  if (path === '') return false;
  if (command.includes(path)) return true;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === '') return false;
  return new RegExp(`(^|[\\s'"=/<>:(\`])${escapeRe(base)}($|[\\s'"\`;|&)<>:,])`).test(command);
}

/** Whether every part of the command is a known read-only program without output redirection. */
export function isReadOnlyCommand(command: string): boolean {
  // `2>&1`, `>&2` only move streams; any other `>` writes a file.
  const streams = command.replace(/\d*>&\d+/g, ' ');
  if (streams.includes('>')) return false;
  // Command substitution can run anything.
  if (streams.includes('$(') || streams.includes('`')) return false;
  const segments = streams.split(/\|\||&&|[|;&\n]/);
  for (const segment of segments) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter((t) => t !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    const first = tokens[0];
    if (first === undefined) continue;
    const program = first.slice(first.lastIndexOf('/') + 1);
    if (program === 'git') {
      const sub = tokens.slice(1).find((t) => !t.startsWith('-'));
      if (sub === undefined || !READ_ONLY_GIT.has(sub)) return false;
      continue;
    }
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
  }
  return true;
}

/**
 * Whether a shell command may have written `path`: it mentions the path (or its basename) and is
 * not made only of read-only programs. Deliberately cautious: when in doubt it says yes, so a save
 * that depends on the file not being written is dropped rather than counted.
 */
export function shellMayWrite(command: string, path: string): boolean {
  return mentionsPath(command, path) && !isReadOnlyCommand(command);
}

/**
 * Whether a shell command may have written any file: it is not made only of read-only programs.
 * Cautious like `shellMayWrite`: when in doubt it says yes, so a checkpoint rescan follows.
 */
export function shellMayWriteFiles(command: string): boolean {
  return !isReadOnlyCommand(command);
}
