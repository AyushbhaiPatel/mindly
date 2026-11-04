import { join } from 'node:path';
import {
  createLogger,
  describeError,
  fileSink,
  homePaths,
  isMindlyError,
  mindlyHome,
  sanitizeLine,
} from '@mindly/core';
import { parseClaudeCodeStatusLine } from '@mindly/adapters';
import { openDatabaseReadOnly, readGlance, type Glance } from '@mindly/store';
import { readStdin, type CliIo } from './io.js';

/** Largest status line payload read from stdin. */
export const MAX_STATUSLINE_STDIN_BYTES = 256 * 1024;
/** How long to wait for stdin before answering for the working directory instead. */
export const STATUSLINE_STDIN_TIMEOUT_MS = 250;
/** What is printed when Mindly cannot answer (no database, unreadable state, anything else). */
export const NEUTRAL_LINE = 'mindly';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Formats the counts: `mindly · 3 rules · 1 update · 0 conflicts`. */
export function formatGlance(g: Glance): string {
  return [
    'mindly',
    plural(g.rules, 'rule'),
    plural(g.updates, 'update'),
    plural(g.conflicts, 'conflict'),
  ].join(' · ');
}

async function readPayload(io: CliIo): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), STATUSLINE_STDIN_TIMEOUT_MS);
  });
  const read = readStdin(io.stdin, MAX_STATUSLINE_STDIN_BYTES).then(
    (raw) => JSON.parse(raw) as unknown,
  );
  read.catch(() => undefined);
  try {
    return await Promise.race([read, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `mindly statusline`: Claude Code's status line command. Reads the session JSON on stdin and
 * prints one line with the rules in effect, updates waiting for this session and conflicts that
 * need the user, e.g. `mindly · 3 rules · 1 update · 0 conflicts`.
 *
 * Read-only and fail-soft: it never writes to the database, never needs the daemon, and always
 * exits 0 with a short line (`mindly`, or `mindly · not set up here` outside known projects) so
 * Claude Code never shows a blank or broken status line.
 */
export async function runStatusLine(io: CliIo): Promise<number> {
  let line = NEUTRAL_LINE;
  try {
    const input = parseClaudeCodeStatusLine(await readPayload(io));
    const db = openDatabaseReadOnly(homePaths(mindlyHome(io.env)).db);
    try {
      const glance = readGlance(db, {
        dir: input.dir ?? io.cwd,
        agentKind: 'claude-code',
        externalSessionId: input.sessionId === null ? null : sanitizeLine(input.sessionId, 200),
        now: Date.now(),
      });
      line = glance === null ? `${NEUTRAL_LINE} · not set up here` : formatGlance(glance);
    } finally {
      db.close();
    }
  } catch (err) {
    if (!isMindlyError(err, 'not_found')) logFailure(io.env, err);
  }
  io.stdout.write(`${line}\n`);
  return 0;
}

function logFailure(env: NodeJS.ProcessEnv, err: unknown): void {
  try {
    createLogger({
      sink: fileSink(join(homePaths(mindlyHome(env)).logs, 'mindly.log')),
      base: { component: 'statusline' },
    }).warn('status line fell back', { error: describeError(err) });
  } catch {
    // Logging is best effort.
  }
}
