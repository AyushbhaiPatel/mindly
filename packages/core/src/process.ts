import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/*
 * Who started whom. A hook process and an MCP server of one agent window are both started by
 * that window's client process, which is how a server finds the session that is its own when
 * several windows of one agent are open. A process is named by its PID together with the time it
 * started: the PID alone is reused by the system.
 */

/** One process: its PID and an opaque value that differs between two processes with that PID. */
export interface ProcessRef {
  pid: number;
  start: string;
  /** The program's name, when known (only used to recognise launchers such as `npx`). */
  name?: string;
}

/** How many ancestors are recorded for a process. */
export const MAX_ANCESTORS = 5;

interface ProcessInfo {
  ppid: number;
  start: string;
  name?: string;
}

/** Reads one process from `/proc` (Linux). Null when it is gone or `/proc` is not there. */
function fromProc(pid: number): ProcessInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) may hold spaces and parentheses: fields are counted after it.
    const fields = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(' ');
    const ppid = Number(fields[1]);
    const start = fields[19];
    if (!Number.isInteger(ppid) || !start || !/^\d+$/.test(start)) return null;
    const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    return { ppid, start, ...(name ? { name } : {}) };
  } catch {
    return null;
  }
}

// `lstart` in the C locale: weekday, month, day, time, year ("Tue Nov 10 03:00:36 2026").
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*?))?\s*\r?$/;

/**
 * Parses `ps -o pid=,ppid=,lstart=,comm=` output: one process per line, the command name last
 * (it may be missing, or hold spaces). Lines that are not of that form are skipped.
 */
export function parsePsTable(out: string): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
  for (const line of out.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const name = m[4]?.trim();
    table.set(Number(m[1]), {
      ppid: Number(m[2]),
      start: (m[3] as string).replace(/\s+/g, ' '),
      ...(name ? { name } : {}),
    });
  }
  return table;
}

/**
 * The lines of `out` that were printed whole. A `ps` that was killed or failed part-way may have
 * printed half a line, which can still look like a whole one with a wrong start time (output
 * arrives in blocks, so the cut can fall anywhere): its last line counts only when the run ended
 * normally and the output ends with a line break.
 */
export function completeLines(out: string, interrupted: boolean): string {
  if (!interrupted && out.endsWith('\n')) return out;
  return out.slice(0, out.lastIndexOf('\n') + 1);
}

const PS_PATHS = ['/bin/ps', '/usr/bin/ps'];

/**
 * The process table from one `ps` call (macOS, BSD), or an empty one when `ps` is missing or
 * prints nothing in time. A `ps` that is too slow is killed outright (it must not be able to
 * hold a hook up by ignoring SIGTERM), and what it printed before exiting with an error is
 * still read: lines that do not parse are skipped anyway.
 */
function psTable(): Map<number, ProcessInfo> {
  const ps = PS_PATHS.find((p) => existsSync(p));
  if (!ps) return new Map();
  try {
    const r = spawnSync(ps, ['-A', '-o', 'pid=,ppid=,lstart=,comm='], {
      encoding: 'utf8',
      timeout: 400,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A fixed locale, so the start time reads the same in every process that asks.
      env: { LC_ALL: 'C', PATH: '/bin:/usr/bin' },
    });
    const out = typeof r.stdout === 'string' ? r.stdout : '';
    return parsePsTable(completeLines(out, Boolean(r.error) || r.signal !== null));
  } catch {
    return new Map();
  }
}

/** Where process facts come from; tests give their own. */
export type ProcessLookup = (pid: number) => { ppid: number; start: string; name?: string } | null;

/** A lookup over one `ps` call, made when it is first asked. */
export function psProcessLookup(): ProcessLookup {
  let table: Map<number, ProcessInfo> | null = null;
  return (pid) => (table ??= psTable()).get(pid) ?? null;
}

/** The lookup for this machine: `/proc` where there is one, else one `ps` call, made lazily. */
export function systemProcessLookup(): ProcessLookup {
  if (process.platform === 'win32') return () => null;
  if (process.platform === 'linux' && existsSync('/proc/self/stat')) return fromProc;
  return psProcessLookup();
}

/**
 * The ancestors of `pid`, nearest first, without `pid` itself and without the init process: at
 * most `MAX_ANCESTORS`. Empty when nothing can be read; this never throws.
 */
export function ancestorChain(
  pid: number,
  lookup: ProcessLookup = systemProcessLookup(),
  max = MAX_ANCESTORS,
): ProcessRef[] {
  const chain: ProcessRef[] = [];
  try {
    let cur = lookup(pid)?.ppid;
    const seen = new Set<number>([pid]);
    while (cur !== undefined && cur > 1 && chain.length < max && !seen.has(cur)) {
      seen.add(cur);
      const info = lookup(cur);
      if (!info) break;
      chain.push({ pid: cur, start: info.start, ...(info.name ? { name: info.name } : {}) });
      cur = info.ppid;
    }
  } catch {
    // Not knowing is fine: the caller falls back to what it did without this.
  }
  return chain;
}

/**
 * True when the process `ref` names is still running: its PID is in use by a process that
 * started at the same time. With `start` unknown (null lookup) the PID alone decides.
 */
export function processRuns(
  ref: ProcessRef,
  lookup: ProcessLookup = systemProcessLookup(),
): boolean {
  if (!Number.isInteger(ref.pid) || ref.pid <= 0) return false;
  try {
    process.kill(ref.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (ref.start === '') return true;
  const now = lookup(ref.pid);
  return now === null || now.start === ref.start;
}

/** `pid` with its start time, or with an empty start when that cannot be read. */
export function processRef(pid: number, lookup: ProcessLookup = systemProcessLookup()): ProcessRef {
  return { pid, start: lookup(pid)?.start ?? '' };
}

/**
 * True when `name` is a program that only starts another one and waits for it: a package runner
 * (`npx`, `pnpm dlx`, `npm exec`, `yarn dlx`, `bunx`), a JavaScript runtime running a shim, or a
 * shell. Such a process between an MCP server and its client says nothing about which client it
 * is. Unknown names are not launchers.
 */
export function isLauncherName(name: string | undefined): boolean {
  if (!name) return false;
  const first = name.trim().split(/\s+/)[0] ?? '';
  const base = (first.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd)$/, '');
  return /^(node|nodejs|npm|npx|pnpm|pnpx|yarn|bun|bunx|deno|corepack|sh|bash|zsh|dash|cmd|pwsh|powershell)$/.test(
    base,
  );
}

/** Parses a stored chain; anything malformed yields an empty one. */
export function parseProcessChain(value: unknown): ProcessRef[] {
  if (!Array.isArray(value)) return [];
  const out: ProcessRef[] = [];
  for (const v of value.slice(0, MAX_ANCESTORS * 2)) {
    const r = v as Partial<ProcessRef> | null;
    if (r && typeof r.pid === 'number' && Number.isInteger(r.pid) && typeof r.start === 'string') {
      out.push({ pid: r.pid, start: r.start.slice(0, 64) });
    }
  }
  return out;
}

/** Prefix of the keys under which hook sessions' ancestors are kept. */
export const HOOK_ANCESTRY_PREFIX = 'hook:ancestry:';

/** Key under which the ancestors of a hook session's first hook process are kept. */
export function hookAncestryKey(agentKind: string, externalSessionId: string): string {
  return `${HOOK_ANCESTRY_PREFIX}${agentKind}:${externalSessionId}`;
}

/**
 * How long a recorded chain is kept without being written again. A session that is still in use
 * after that has its chain recorded again by its next hook; one that ended without saying so
 * (its window was closed) leaves nothing behind for longer than this.
 */
export const HOOK_ANCESTRY_TTL_MS = 7 * 24 * 60 * 60_000;

/** What is stored when the ancestors could not be read: try again after `retryAfter`. */
export interface AncestryRetry {
  retryAfter: number;
}

/** How long a hook waits before it tries to read the ancestors again after it could not. */
export const HOOK_ANCESTRY_RETRY_MS = 60_000;
