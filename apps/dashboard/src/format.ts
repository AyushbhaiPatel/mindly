import type { Run, Severity } from './types';

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/* ------------------------------------------------------------------------------------------ */
/* Run result parsing. The contract types `Run.result` as an open record; these readers pick   */
/* out known fields defensively so a daemon change never crashes the UI.                        */
/* ------------------------------------------------------------------------------------------ */

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface CheckOutcome {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number | null;
  outputTail: string;
}

export interface ShadowMergeView {
  conflictedPaths: string[];
  checks: CheckOutcome[];
  sessions: string[];
  mergedTree: string | null;
}

export function readShadowMerge(run: Run): ShadowMergeView {
  const r = rec(run.result);
  return {
    conflictedPaths: arr(r.conflictedPaths ?? r.conflicts).filter(
      (x): x is string => typeof x === 'string',
    ),
    checks: arr(r.checks).map((c) => {
      const o = rec(c);
      const exitCode = num(o.exitCode);
      return {
        name: text(o.name) ?? 'check',
        ok: typeof o.ok === 'boolean' ? o.ok : exitCode === 0,
        exitCode,
        durationMs: num(o.durationMs),
        outputTail: text(o.outputTail ?? o.output ?? o.stderr) ?? '',
      };
    }),
    sessions: arr(r.sessionIds ?? r.sessions).filter((x): x is string => typeof x === 'string'),
    mergedTree: text(r.mergedTree ?? r.tree),
  };
}

export interface Finding {
  severity: Severity;
  file: string | null;
  line: number | null;
  message: string;
}

export function readReview(run: Run): {
  summary: string | null;
  findings: Finding[];
  reviewer: string | null;
} {
  const r = rec(run.result);
  return {
    summary: text(r.summary),
    reviewer: text(r.reviewer ?? rec(run.input).reviewer),
    findings: arr(r.findings).map((f) => {
      const o = rec(f);
      const sev = text(o.severity);
      return {
        severity: sev === 'critical' || sev === 'warning' ? sev : 'info',
        file: text(o.file ?? o.path),
        line: num(o.line),
        message: text(o.message ?? o.text) ?? '',
      };
    }),
  };
}

export interface ReplayRow {
  agent: string;
  status: string | null;
  filesChanged: number | null;
  added: number | null;
  removed: number | null;
  checksPassed: number | null;
  checksTotal: number | null;
  durationMs: number | null;
  costUsd: number | null;
}

export function readReplay(run: Run): ReplayRow[] {
  const r = rec(run.result);
  return arr(r.agents ?? r.results).map((a) => {
    const o = rec(a);
    return {
      agent: text(o.agent ?? o.agentKind) ?? '?',
      status: text(o.status),
      filesChanged: num(o.filesChanged),
      added: num(o.addedLines ?? o.added),
      removed: num(o.removedLines ?? o.removed),
      checksPassed: num(o.checksPassed),
      checksTotal: num(o.checksTotal),
      durationMs: num(o.durationMs),
      costUsd: num(o.costUsd ?? o.cost),
    };
  });
}

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Splits a comma/newline separated text field into trimmed non-empty values. */
export function splitList(s: string): string[] {
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}
