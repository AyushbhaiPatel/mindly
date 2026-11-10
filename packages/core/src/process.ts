import { execFileSync } from 'node:child_process';
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
}

/** How many ancestors are recorded for a process. */
export const MAX_ANCESTORS = 5;

interface ProcessInfo {
  ppid: number;
  start: string;
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
    return { ppid, start };
  } catch {
    return null;
  }
}

/** Parses `ps -o pid=,ppid=,lstart=` output: one process per line. */
export function parsePsTable(out: string): Map<number, ProcessInfo> {
  const table = new Map<number, ProcessInfo>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    table.set(Number(m[1]), { ppid: Number(m[2]), start: (m[3] as string).replace(/\s+/g, ' ') });
  }
  return table;
}

const PS_PATHS = ['/bin/ps', '/usr/bin/ps'];

/** The process table from one `ps` call (macOS, BSD). Empty when `ps` cannot be run in time. */
function psTable(): Map<number, ProcessInfo> {
  const ps = PS_PATHS.find((p) => existsSync(p));
  if (!ps) return new Map();
  try {
    const out = execFileSync(ps, ['-A', '-o', 'pid=,ppid=,lstart='], {
      encoding: 'utf8',
      timeout: 400,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A fixed locale, so the start time reads the same in every process that asks.
      env: { LC_ALL: 'C', PATH: '/bin:/usr/bin' },
    });
    return parsePsTable(out);
  } catch {
    return new Map();
  }
}

/** Where process facts come from; tests give their own. */
export type ProcessLookup = (pid: number) => { ppid: number; start: string } | null;

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
      chain.push({ pid: cur, start: info.start });
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

/** Key under which the ancestors of a hook session's first hook process are kept. */
export function hookAncestryKey(agentKind: string, externalSessionId: string): string {
  return `hook:ancestry:${agentKind}:${externalSessionId}`;
}
