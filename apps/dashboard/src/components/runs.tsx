import type { ReactNode } from 'react';
import {
  duration,
  readReplay,
  readReview,
  readShadowMerge,
  SEVERITY_ORDER,
  type CheckOutcome,
  type Finding,
  type ReplayRow,
} from '../format';
import type { Run } from '../types';
import { COLUMNS, EMPTY, productName, runStatusWords } from '../vocab';
import {
  DataTable,
  DotWord,
  Empty,
  JsonBlock,
  Mono,
  Paths,
  SeverityMark,
  Status,
  cx,
  type Column,
} from './ui';

/** Checks of a merge check: CHECK | RESULT | TIME; the output tail opens in the row. */
export function ChecksTable({ checks }: { checks: CheckOutcome[] }) {
  if (checks.length === 0) return <Empty>{EMPTY.checks}</Empty>;
  const cols: Column<CheckOutcome>[] = [
    { key: 'name', header: COLUMNS.check, cell: (c) => <Mono>{c.name}</Mono> },
    {
      key: 'result',
      header: COLUMNS.result,
      kind: 'main',
      cell: (c) => (
        <>
          <DotWord tone={c.ok ? 'good' : 'bad'}>{c.ok ? 'passed' : 'failed'}</DotWord>
          {!c.ok && c.exitCode !== null && (
            <span className="muted">
              {' '}
              {'·'} exit {c.exitCode}
            </span>
          )}
        </>
      ),
    },
    { key: 'time', header: COLUMNS.time, kind: 'meta', cell: (c) => duration(c.durationMs) },
  ];
  return (
    <DataTable
      label="Checks"
      columns={cols}
      rows={checks}
      rowKey={(c) => c.name}
      detail={(c) => (c.outputTail ? <pre className="pre">{c.outputTail}</pre> : null)}
    />
  );
}

export function ShadowMergeResult({ run }: { run: Run }) {
  const r = readShadowMerge(run);
  if (!run.result)
    return <Empty>{run.status === 'queued' ? EMPTY.runWaiting : EMPTY.runRunning}</Empty>;
  return (
    <div className="detail-stack">
      <ChecksTable checks={r.checks} />
      <p className="line-meta">
        <span className="muted">overlapping changes: </span>
        {r.conflictedPaths.length === 0 ? (
          <span className="muted">none</span>
        ) : (
          <Paths paths={r.conflictedPaths} max={Infinity} />
        )}
      </p>
    </div>
  );
}

export function ReviewResult({ run }: { run: Run }) {
  const r = readReview(run);
  if (!run.result) return <Empty>{EMPTY.runRunning}</Empty>;
  const findings = [...r.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const cols: Column<Finding>[] = [
    { key: 'sev', header: COLUMNS.severity, cell: (f) => <SeverityMark severity={f.severity} /> },
    {
      key: 'where',
      header: COLUMNS.fileLine,
      kind: 'clip',
      cell: (f) =>
        f.file ? (
          <Mono>
            {f.file}
            {f.line !== null ? `:${f.line}` : ''}
          </Mono>
        ) : (
          <span className="muted">{'—'}</span>
        ),
    },
    { key: 'msg', header: COLUMNS.finding, kind: 'plain', cell: (f) => f.message },
  ];
  return (
    <div className="detail-stack">
      {r.summary && <p className="detail-text">{r.summary}</p>}
      {findings.length === 0 ? (
        <Empty>{EMPTY.findings}</Empty>
      ) : (
        <DataTable
          label="Review findings"
          className="dt-wrap"
          columns={cols}
          rows={findings}
          rowKey={(f) => `${f.file}:${f.line}:${f.message}`}
        />
      )}
    </div>
  );
}

/** Replay: one column per agent, one row per measure; the best value is marked. */
export function ReplayResult({ run }: { run: Run }) {
  const rows = readReplay(run);
  if (!run.result) return <Empty>{EMPTY.runRunning}</Empty>;
  if (rows.length === 0) return <Empty>{EMPTY.replay}</Empty>;
  const hasCost = rows.some((r) => r.costUsd !== null);
  const best = (pick: (r: ReplayRow) => number | null, low = true) => {
    const vals = rows.map(pick).filter((v): v is number => v !== null);
    if (vals.length < 2) return null;
    return low ? Math.min(...vals) : Math.max(...vals);
  };
  const bestDur = best((r) => r.durationMs);
  const bestCost = best((r) => r.costUsd);
  const bestChecks = best((r) => r.checksPassed, false);
  const measures: {
    label: string;
    cell(r: ReplayRow): ReactNode;
    isBest?(r: ReplayRow): boolean;
  }[] = [
    {
      label: 'Result',
      cell: (r) => (r.status ? <Status value={r.status} label={runStatusWords(r.status)} /> : '—'),
    },
    {
      label: 'Checks passed',
      cell: (r) => `${r.checksPassed ?? '—'}/${r.checksTotal ?? '—'}`,
      isBest: (r) => r.checksPassed !== null && r.checksPassed === bestChecks,
    },
    { label: 'Files changed', cell: (r) => r.filesChanged ?? '—' },
    {
      label: 'Lines',
      cell: (r) => (
        <>
          <span className="add">+{r.added ?? 0}</span>{' '}
          <span className="del">
            {'−'}
            {r.removed ?? 0}
          </span>
        </>
      ),
    },
    {
      label: 'Duration',
      cell: (r) => duration(r.durationMs),
      isBest: (r) => r.durationMs !== null && r.durationMs === bestDur,
    },
    ...(hasCost
      ? [
          {
            label: 'Cost',
            cell: (r: ReplayRow) => (r.costUsd !== null ? `$${r.costUsd.toFixed(2)}` : '—'),
            isBest: (r: ReplayRow) => r.costUsd !== null && r.costUsd === bestCost,
          },
        ]
      : []),
  ];
  return (
    <table className="dt dt-compare" aria-label="Replay comparison">
      <thead>
        <tr>
          <th scope="col">
            <span className="visually-hidden">Measure</span>
          </th>
          {rows.map((r) => (
            <th key={r.agent} scope="col" className="c-meta">
              {productName(r.agent)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {measures.map((m) => (
          <tr key={m.label} className="dt-row">
            <th scope="row">{m.label}</th>
            {rows.map((r) => (
              <td
                key={r.agent}
                className={cx('c-meta', m.isBest?.(r) && 'best')}
                data-label={productName(r.agent)}
              >
                <span className="cell">
                  {m.cell(r)}
                  {m.isBest?.(r) && <span className="visually-hidden"> (best)</span>}
                </span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunResult({ run }: { run: Run }) {
  switch (run.kind) {
    case 'shadow_merge':
      return <ShadowMergeResult run={run} />;
    case 'review':
      return <ReviewResult run={run} />;
    case 'replay':
      return <ReplayResult run={run} />;
    default:
      return run.result ? <JsonBlock value={run.result} /> : <Empty>{EMPTY.runResult}</Empty>;
  }
}
