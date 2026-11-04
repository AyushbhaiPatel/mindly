import { join } from 'node:path';
import { z } from 'zod';
import { shellJoin } from '../shared/command.js';
import { parseJsonConfig, readConfigText } from '../shared/config-files.js';
import { isRecord, MAX_PATH_CHARS } from '../shared/payload.js';

/*
 * Claude Code's status line: a `statusLine` entry in settings.json whose `command` receives the
 * session as JSON on stdin and prints the line to show. Mindly installs `<mindly> statusline`
 * there, but only where the user has no status line of their own.
 */

/** Seconds between refreshes while the session is idle (other agents keep changing Mindly state). */
export const STATUS_LINE_REFRESH_SEC = 10;

/** The `statusLine` settings value Mindly installs: `<command> statusline`. */
export function statusLineSetting(command: readonly string[]): Record<string, unknown> {
  return {
    type: 'command',
    command: shellJoin([...command, 'statusline']),
    refreshInterval: STATUS_LINE_REFRESH_SEC,
  };
}

/**
 * True when a `statusLine` settings value is one Mindly installed: a command whose last word is
 * `statusline` (bare or single-quoted) and that runs Mindly (`mindly` or the CLI's
 * `cli/dist/main.js`).
 */
export function isMindlyStatusLine(value: unknown): boolean {
  if (!isRecord(value) || typeof value['command'] !== 'string') return false;
  const m = /^(.*\S)\s+'?statusline'?$/s.exec(value['command'].trim());
  return m !== null && /mindly|[\\/]cli[\\/]dist[\\/]main\.js/i.test(m[1] as string);
}

/** The status line Claude Code would use, and whose it is. */
export interface ClaudeCodeStatusLine {
  /** `mindly` for Mindly's own, `other` for anything else, null when none is configured. */
  owner: 'mindly' | 'other' | null;
  /** The settings file that defines it. */
  file: string | null;
  /** Its command, when it has one. */
  command: string | null;
}

/**
 * Claude Code settings files that can define the status line for a scope, highest precedence
 * first: the project's `settings.local.json` and `settings.json`, then the user's settings.
 */
export function statusLineSettingsFiles(homeDir: string, projectRoot: string | null): string[] {
  const user = join(homeDir, '.claude', 'settings.json');
  if (projectRoot === null) return [user];
  return [
    join(projectRoot, '.claude', 'settings.local.json'),
    join(projectRoot, '.claude', 'settings.json'),
    user,
  ];
}

/**
 * Finds the status line Claude Code would use in `projectRoot` (user-wide when null). Missing or
 * unreadable files are skipped: this only informs, it never edits.
 */
export async function inspectClaudeCodeStatusLine(
  homeDir: string,
  projectRoot: string | null,
): Promise<ClaudeCodeStatusLine> {
  for (const file of statusLineSettingsFiles(homeDir, projectRoot)) {
    const found = await readStatusLine(file);
    if (found.owner !== null) return found;
  }
  return { owner: null, file: null, command: null };
}

/** The status line one settings file defines; a missing or unreadable file defines none. */
export async function readStatusLine(file: string): Promise<ClaudeCodeStatusLine> {
  let value: unknown;
  try {
    value = parseJsonConfig(file, await readConfigText(file))['statusLine'];
  } catch {
    value = undefined;
  }
  if (value === undefined || value === null) return { owner: null, file: null, command: null };
  const command = isRecord(value) && typeof value['command'] === 'string' ? value['command'] : null;
  return { owner: isMindlyStatusLine(value) ? 'mindly' : 'other', file, command };
}

/** What `mindly statusline` reads from Claude Code's status line JSON. */
export interface StatusLineInput {
  sessionId: string | null;
  /** Directory the session works in. */
  dir: string | null;
}

const text = (max: number) => z.string().trim().min(1).max(max).optional().catch(undefined);

const StatusLinePayloadSchema = z.looseObject({
  session_id: text(512),
  cwd: text(MAX_PATH_CHARS),
  workspace: z
    .looseObject({ current_dir: text(MAX_PATH_CHARS), project_dir: text(MAX_PATH_CHARS) })
    .optional()
    .catch(undefined),
});

/**
 * Reads the session id and working directory (`workspace.current_dir`, else `cwd`, else
 * `workspace.project_dir`) from a status line payload. Never throws; missing or malformed fields
 * come back null.
 */
export function parseClaudeCodeStatusLine(payload: unknown): StatusLineInput {
  const parsed = StatusLinePayloadSchema.safeParse(payload);
  if (!parsed.success) return { sessionId: null, dir: null };
  const p = parsed.data;
  return {
    sessionId: p.session_id ?? null,
    dir: p.workspace?.current_dir ?? p.cwd ?? p.workspace?.project_dir ?? null,
  };
}
