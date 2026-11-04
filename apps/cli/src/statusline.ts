import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { CliIo } from './io.js';

/*
 * mindly statusline: Claude Code's status line (https://code.claude.com/docs/en/statusline).
 * Claude Code runs it after every assistant message with the session JSON on stdin and shows the
 * first line of stdout. It must be fast, never hang and never fail, so this module imports only
 * Node built-ins (no @mindly/* packages, no zod, no commander) and reads the SQLite store
 * directly, read-only: the database is the source of truth and the daemon is optional.
 */

/** Claude Code's agent kind in the sessions and deliveries tables. */
const AGENT_KIND = 'claude-code';
/** Largest session JSON read from stdin (Claude Code sends a few KB). */
const MAX_STDIN_BYTES = 256 * 1024;

/** What the status line shows for one session. */
export interface StatusCounts {
  /** Approved or verified rules of the project, shared or scoped to the session's branch. */
  rules: number;
  /** Updates queued for this session that it has not received yet. */
  updates: number;
  /** Open conflicts in the project that need the user (more than FYI). */
  conflicts: number;
}

/** Result of a status line lookup. */
export type StatusLineResult =
  | { kind: 'counts'; counts: StatusCounts }
  /** No project in Mindly's store matches the session (Mindly has not seen this folder). */
  | { kind: 'no-project' }
  /** The store could not be read (not set up, unreadable, locked or anything else failing). */
  | { kind: 'offline' };

/** Time limits; tests shorten them. */
export interface StatusLineLimits {
  /** How long to wait for Claude Code's JSON on stdin. */
  stdinTimeoutMs: number;
  /** How long SQLite may wait for a lock before giving up. */
  busyTimeoutMs: number;
}

export const DEFAULT_LIMITS: StatusLineLimits = { stdinTimeoutMs: 250, busyTimeoutMs: 100 };

function plural(n: number, word: string): string {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/** Whether ANSI colour is allowed: on unless NO_COLOR is set or TERM is dumb. */
export function colorAllowed(env: NodeJS.ProcessEnv): boolean {
  const noColor = env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '';
  return !noColor && env['TERM'] !== 'dumb';
}

/**
 * Formats one status line, e.g. "mindly · 3 rules · 1 update · 0 conflicts". With colour, the
 * name is dim, pending updates cyan and conflicts that need the user red.
 */
export function formatStatusLine(result: StatusLineResult, color: boolean): string {
  const paint = (code: number, s: string): string =>
    color ? '\u001b[' + code + 'm' + s + '\u001b[0m' : s;
  const name = paint(2, 'mindly');
  if (result.kind === 'offline') return name + ' · ' + paint(2, 'offline');
  if (result.kind === 'no-project') return name + ' · ' + paint(2, 'no project');
  const { rules, updates, conflicts } = result.counts;
  return [
    name,
    plural(rules, 'rule'),
    updates > 0 ? paint(36, plural(updates, 'update')) : plural(updates, 'update'),
    conflicts > 0 ? paint(31, plural(conflicts, 'conflict')) : plural(conflicts, 'conflict'),
  ].join(' · ');
}

/** The parts of Claude Code's status line JSON that Mindly uses. */
export interface SessionInfo {
  sessionId: string | null;
  /** Candidate directories, most specific first: current dir, then the launch (project) dir. */
  dirs: string[];
}

/** Reads stdin to the end, or returns null after timeoutMs, past MAX_STDIN_BYTES or on error. */
async function readStdin(
  stdin: AsyncIterable<Buffer | string>,
  timeoutMs: number,
): Promise<string | null> {
  if ((stdin as { isTTY?: boolean }).isTTY === true) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), timeoutMs);
  });
  const read = (async (): Promise<string | null> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stdin) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buf.length;
      if (total > MAX_STDIN_BYTES) return null;
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  })().catch(() => null);
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function field(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
    ? value.trim()
    : null;
}

/**
 * Extracts the session id and directories from the status line JSON. Empty, invalid or partial
 * input is fine: the working directory of the process is always the last candidate.
 */
export function sessionInfo(raw: string | null, cwd: string): SessionInfo {
  let payload: unknown;
  try {
    payload = raw === null || raw.trim() === '' ? null : JSON.parse(raw);
  } catch {
    payload = null;
  }
  const workspace = field(payload, 'workspace');
  const dirs = [
    text(field(workspace, 'current_dir'), 4096),
    text(field(payload, 'cwd'), 4096),
    text(field(workspace, 'project_dir'), 4096),
    cwd,
  ].filter((d): d is string => d !== null && isAbsolute(d));
  return {
    sessionId: text(field(payload, 'session_id'), 512)?.slice(0, 200) ?? null,
    dirs: [...new Set(dirs)],
  };
}

/** Mindly's database path, following MINDLY_HOME like the rest of the CLI. */
function databasePath(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env['MINDLY_HOME'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return isAbsolute(fromEnv) ? join(resolve(fromEnv), 'mindly.db') : null;
  }
  return join(homedir(), '.mindly', 'mindly.db');
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function within(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

type Row = Record<string, unknown>;

/**
 * Counts for one session, read from the database at dbPath without writing anything. The
 * session is found by Claude Code's session id; before Mindly has registered it, the project is
 * the deepest known project root or session worktree containing one of info.dirs.
 */
export async function lookupStatus(
  dbPath: string,
  info: SessionInfo,
  busyTimeoutMs: number,
  now: number = Date.now(),
): Promise<StatusLineResult> {
  if (!existsSync(dbPath)) return { kind: 'offline' };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = ' + Math.max(0, Math.trunc(busyTimeoutMs)));
    db.exec('PRAGMA trusted_schema = OFF');
    const count = (sql: string, ...params: (string | number | null)[]): number =>
      Number((db.prepare(sql).get(...params) as Row | undefined)?.['n'] ?? 0);

    let projectId: string | null = null;
    let sessionId = '';
    let branch: string | null = null;
    if (info.sessionId !== null) {
      const session = db
        .prepare(
          'SELECT id, project_id, branch FROM sessions WHERE agent_kind = ? AND external_id = ? ORDER BY last_seen_at DESC LIMIT 1',
        )
        .get(AGENT_KIND, info.sessionId) as Row | undefined;
      if (session) {
        projectId = String(session['project_id']);
        sessionId = String(session['id']);
        branch = typeof session['branch'] === 'string' ? session['branch'] : null;
      }
    }
    if (projectId === null) {
      const roots = [
        ...(db.prepare('SELECT id AS project_id, root FROM projects').all() as Row[]),
        ...(db
          .prepare('SELECT DISTINCT project_id, worktree AS root FROM sessions')
          .all() as Row[]),
      ];
      for (const dir of info.dirs.map(realDir)) {
        let best: Row | null = null;
        for (const r of roots) {
          const root = String(r['root']);
          if (within(dir, root) && (best === null || root.length > String(best['root']).length)) {
            best = r;
          }
        }
        if (best !== null) {
          projectId = String(best['project_id']);
          break;
        }
      }
    }
    if (projectId === null) return { kind: 'no-project' };

    const rules = count(
      "SELECT COUNT(*) AS n FROM memories WHERE project_id = ? AND status = 'active' AND kind = 'rule' AND trust IN ('approved', 'verified') AND (scope_branch IS NULL OR scope_branch = ?)",
      projectId,
      branch,
    );
    const updates = count(
      "SELECT COUNT(*) AS n FROM deliveries WHERE project_id = ? AND status = 'pending' AND expires_at >= ? AND (target_session_id = ? OR (target_session_id IS NULL AND (target_agent_kind = ? OR target_agent_kind IS NULL))) AND (source_session_id IS NULL OR source_session_id != ?)",
      projectId,
      now,
      sessionId,
      AGENT_KIND,
      sessionId,
    );
    const conflicts = count(
      "SELECT COUNT(*) AS n FROM conflicts WHERE project_id = ? AND status = 'open' AND severity != 'info'",
      projectId,
    );
    return { kind: 'counts', counts: { rules, updates, conflicts } };
  } finally {
    db.close();
  }
}

/** Builds the status line text. Never throws: any failure becomes "mindly · offline". */
export async function statusLineText(
  io: Pick<CliIo, 'stdin' | 'env' | 'cwd'>,
  limits: StatusLineLimits = DEFAULT_LIMITS,
): Promise<string> {
  let color = false;
  try {
    color = colorAllowed(io.env);
    const info = sessionInfo(await readStdin(io.stdin, limits.stdinTimeoutMs), io.cwd);
    const dbPath = databasePath(io.env);
    const result =
      dbPath === null
        ? ({ kind: 'offline' } as const)
        : await lookupStatus(dbPath, info, limits.busyTimeoutMs);
    return formatStatusLine(result, color);
  } catch {
    return formatStatusLine({ kind: 'offline' }, color);
  }
}

/** mindly statusline: prints one line and always exits 0. */
export async function runStatusLine(
  io: Pick<CliIo, 'stdin' | 'stdout' | 'env' | 'cwd'>,
  limits: StatusLineLimits = DEFAULT_LIMITS,
): Promise<number> {
  io.stdout.write((await statusLineText(io, limits)) + '\n');
  return 0;
}
