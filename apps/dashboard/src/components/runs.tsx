import { duration, readReplay, readReview, readShadowMerge, SEVERITY_ORDER } from '../format';
import type { Run } from '../types';
import { Empty, Mono, SeverityBadge, Status, cx } from './ui';

export function ShadowMergeResult({ run, compact }: { run: Run; compact?: boolean }) {
  const r = readShadowMerge(run);
  if (!run.result)
    return (
      <Empty>{run.status === 'queued' ? 'Waiting to start…' : 'Merging and running checks…'}</Empty>
    );
  return (
    <div className="stack">
      <div className="kv-row">
        <span className="kv-label">Merge</span>
        {r.conflictedPaths.length === 0 ? (
          <span className="tag tone-good">clean</span>
        ) : (
          <span className="tag tone-bad">{r.conflictedPaths.length} conflicted</span>
        )}
        {r.conflictedPaths.map((p) => (
          <Mono key={p}>{p}</Mono>
        ))}
      </div>
      {r.checks.length > 0 && (
        <ul className="checks">
          {r.checks.map((c) => (
            <li key={c.name} className={cx('check', c.ok ? 'check-ok' : 'check-bad')}>
              <div className="check-head">
                <span className={cx('tag', c.ok ? 'tone-good' : 'tone-bad')}>
                  {c.ok ? 'pass' : 'fail'}
                </span>
                <Mono>{c.name}</Mono>
                {c.exitCode !== null && <span className="muted">exit {c.exitCode}</span>}
                <span className="muted">{duration(c.durationMs)}</span>
              </div>
              {c.outputTail && (!compact || !c.ok) && (
                <pre className="pre pre-tail">{c.outputTail}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReviewResult({ run }: { run: Run }) {
  const r = readReview(run);
  if (!run.result) return <Empty>Review in progress…</Empty>;
  const findings = [...r.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  return (
    <div className="stack">
      {r.summary && <p>{r.summary}</p>}
      {findings.length === 0 ? (
        <Empty>No findings.</Empty>
      ) : (
        <ul className="findings">
          {findings.map((f, i) => (
            <li key={i} className={`finding sev-row-${f.severity}`}>
              <SeverityBadge severity={f.severity} />
              {f.file && (
                <Mono>
                  {f.file}
                  {f.line !== null ? `:${f.line}` : ''}
                </Mono>
              )}
              <span className="finding-msg">{f.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReplayResult({ run }: { run: Run }) {
  const rows = readReplay(run);
  if (!run.result) return <Empty>Replaying in isolated worktrees…</Empty>;
  if (rows.length === 0) return <Empty>No agent results.</Empty>;
  const hasCost = rows.some((r) => r.costUsd !== null);
  const best = Math.min(...rows.map((r) => r.durationMs ?? Infinity));
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Result</th>
            <th scope="col" className="num">
              Files
            </th>
            <th scope="col" className="num">
              Lines
            </th>
            <th scope="col" className="num">
              Checks
            </th>
            <th scope="col" className="num">
              Duration
            </th>
            {hasCost && (
              <th scope="col" className="num">
                Cost
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agent}>
              <th scope="row">
                <Mono>{r.agent}</Mono>
              </th>
              <td>{r.status ? <Status value={r.status} /> : '—'}</td>
              <td className="num">{r.filesChanged ?? '—'}</td>
              <td className="num">
                <span className="add">+{r.added ?? 0}</span>{' '}
                <span className="del">−{r.removed ?? 0}</span>
              </td>
              <td className="num">
                {r.checksPassed ?? '—'}/{r.checksTotal ?? '—'}
              </td>
              <td className={cx('num', r.durationMs === best && rows.length > 1 && 'best')}>
                {duration(r.durationMs)}
              </td>
              {hasCost && (
                <td className="num">{r.costUsd !== null ? `$${r.costUsd.toFixed(2)}` : '—'}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
      return run.result ? (
        <pre className="pre">{JSON.stringify(run.result, null, 2)}</pre>
      ) : (
        <Empty>No result yet.</Empty>
      );
  }
}

export function RunStatus({ run }: { run: Run }) {
  return <Status value={run.status} />;
}
