import { useEffect, useState, type FormEvent } from 'react';
import { PlainMarkdown } from '../components/markdown';
import {
  Confirm,
  Empty,
  ErrorNote,
  JsonBlock,
  Loaded,
  Loading,
  Meter,
  Mono,
  Panel,
  Segmented,
  Tabs,
  Tag,
  Time,
  TrustBadge,
  cx,
} from '../components/ui';
import { agentName } from '../format';
import { useAction, useApp, useResource } from '../state';
import type {
  ContextItem,
  ContextPacket,
  ProvenanceResult,
  Snapshot,
  SnapshotDiff,
} from '../types';
import { sourceLabel } from './Memory';

type Sub = 'xray' | 'provenance' | 'standup' | 'snapshots';

export function InsightView() {
  const [sub, setSub] = useState<Sub>('xray');
  return (
    <div className="view">
      <div className="subnav">
        <Tabs
          idPrefix="insight"
          label="Insight sections"
          value={sub}
          onChange={setSub}
          tabs={[
            { key: 'xray', label: 'Context X-Ray' },
            { key: 'provenance', label: 'Provenance' },
            { key: 'standup', label: 'Standup' },
            { key: 'snapshots', label: 'Snapshots' },
          ]}
        />
      </div>
      <div id="insight-panel" role="tabpanel" aria-labelledby={`insight-tab-${sub}`}>
        {sub === 'xray' && <XRay />}
        {sub === 'provenance' && <Provenance />}
        {sub === 'standup' && <Standup />}
        {sub === 'snapshots' && <Snapshots />}
      </div>
    </div>
  );
}

function XRay() {
  const { client, project } = useApp();
  const sres = useResource(() => client.sessions(project.id, 50), [project.id], ['sessions']);
  const [sessionId, setSessionId] = useState<string>('');
  useEffect(() => {
    if (!sessionId && sres.data?.[0]) setSessionId(sres.data[0].id);
  }, [sres.data, sessionId]);
  const pres = useResource(
    () => (sessionId ? client.xray(sessionId, 30) : Promise.resolve([] as ContextPacket[])),
    [sessionId],
    ['xray'],
  );
  return (
    <Panel
      title="Context X-Ray"
      actions={
        sres.data && (
          <label className="field field-inline">
            <span>Session</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {sres.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {agentName(s)} · {s.status}
                </option>
              ))}
            </select>
          </label>
        )
      }
    >
      <p className="help">Exactly what Mindly gave this agent, what it left out, and why.</p>
      {sres.error ? (
        <ErrorNote error={sres.error} onRetry={sres.reload} />
      ) : (
        <Loaded res={pres}>
          {(packets) =>
            packets.length === 0 ? (
              <Empty>No context packets recorded for this session.</Empty>
            ) : (
              <ol className="packets">
                {packets.map((p) => (
                  <Packet key={p.id} p={p} />
                ))}
              </ol>
            )
          }
        </Loaded>
      )}
    </Panel>
  );
}

function Packet({ p }: { p: ContextPacket }) {
  const [showOmitted, setShowOmitted] = useState(true);
  return (
    <li className="packet">
      <header className="packet-head">
        <Tag tone="accent">{p.trigger.replace(/_/g, ' ')}</Tag>
        {p.query && <span className="packet-query">“{p.query}”</span>}
        <span className="grow" />
        <Time ms={p.createdAt} />
      </header>
      <div className="budget">
        <Meter value={p.tokensUsed} max={p.tokenBudget} label="Token budget used" />
        <span className="budget-label mono">
          {p.tokensUsed} / {p.tokenBudget} tokens
        </span>
      </div>
      <div className="packet-cols">
        <ItemTable title={`Included (${p.included.length})`} items={p.included} kind="in" />
        <div>
          <button
            type="button"
            className="link small"
            aria-expanded={showOmitted}
            onClick={() => setShowOmitted((v) => !v)}
          >
            {showOmitted ? 'Hide' : 'Show'} omitted ({p.omitted.length})
          </button>
          {showOmitted && (
            <ItemTable title={`Omitted (${p.omitted.length})`} items={p.omitted} kind="out" />
          )}
        </div>
      </div>
    </li>
  );
}

function ItemTable({
  title,
  items,
  kind,
}: {
  title: string;
  items: ContextItem[];
  kind: 'in' | 'out';
}) {
  if (items.length === 0)
    return <Empty>{kind === 'in' ? 'Nothing included.' : 'Nothing omitted.'}</Empty>;
  const sorted = [...items].sort((a, b) => b.score - a.score);
  return (
    <div className="table-wrap">
      <table className={cx('table', 'table-compact', kind === 'out' && 'table-omitted')}>
        <caption className="table-caption">{title}</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="num">
              Score
            </th>
            <th scope="col" className="num">
              Tokens
            </th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((i) => (
            <tr key={`${i.kind}:${i.ref}`}>
              <td>
                <span className="tag">{i.kind}</span> {i.title}
              </td>
              <td className="num">
                <span className="score">
                  <span
                    className="score-bar"
                    style={{ width: `${Math.round(Math.max(0, Math.min(1, i.score)) * 100)}%` }}
                  />
                  {i.score.toFixed(2)}
                </span>
              </td>
              <td className="num">{i.tokens}</td>
              <td className="muted">{i.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Provenance() {
  const { client, project, sessions } = useApp();
  const [file, setFile] = useState('');
  const [line, setLine] = useState('1');
  const [state, setState] = useState<{
    loading: boolean;
    error: unknown;
    result: ProvenanceResult | null;
  }>({
    loading: false,
    error: null,
    result: null,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number.parseInt(line, 10);
    if (!file.trim() || !Number.isFinite(n) || n < 1) return;
    setState({ loading: true, error: null, result: null });
    client.provenance(project.id, file.trim(), n).then(
      (result) => setState({ loading: false, error: null, result }),
      (error: unknown) => setState({ loading: false, error, result: null }),
    );
  };
  const r = state.result;
  const known = new Set([
    'file',
    'line',
    'found',
    'sessionId',
    'agentKind',
    'createdAt',
    'tool',
    'promptSummary',
    'memories',
  ]);
  const extra = r ? Object.fromEntries(Object.entries(r).filter(([k]) => !known.has(k))) : {};
  const session = r?.sessionId ? sessions.get(r.sessionId) : undefined;
  return (
    <Panel title="Provenance">
      <p className="help">Which agent wrote a line, when, and in response to what.</p>
      <form className="filters" onSubmit={submit}>
        <label className="field field-grow">
          <span>File</span>
          <input
            value={file}
            onChange={(e) => setFile(e.target.value)}
            placeholder="src/auth/session.ts"
            required
            maxLength={500}
          />
        </label>
        <label className="field">
          <span>Line</span>
          <input
            type="number"
            min={1}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            required
            className="input-narrow"
          />
        </label>
        <div className="field field-end">
          <button type="submit" className="btn btn-primary" disabled={state.loading}>
            Look up
          </button>
        </div>
      </form>
      {state.loading && <Loading />}
      {state.error ? <ErrorNote error={state.error} /> : null}
      {r &&
        (r.found === false ? (
          <Empty>
            No agent edit recorded for <Mono>{`${r.file ?? file}:${r.line ?? line}`}</Mono>. It was
            probably written by a person or before Mindly was installed.
          </Empty>
        ) : (
          <div className="stack">
            <dl className="kv">
              <dt>Line</dt>
              <dd>
                <Mono>{`${r.file ?? file}:${r.line ?? line}`}</Mono>
              </dd>
              <dt>Agent</dt>
              <dd>{session ? agentName(session) : (r.agentKind ?? '—')}</dd>
              <dt>When</dt>
              <dd>
                <Time ms={r.createdAt ?? null} />
              </dd>
              {r.tool && (
                <>
                  <dt>Tool</dt>
                  <dd>
                    <Mono>{r.tool}</Mono>
                  </dd>
                </>
              )}
              <dt>Prompt</dt>
              <dd>
                {r.promptSummary ? (
                  <q>{r.promptSummary}</q>
                ) : (
                  <span className="muted">not recorded</span>
                )}
              </dd>
            </dl>
            {r.memories && r.memories.length > 0 && (
              <section aria-label="Related memories">
                <h4 className="sub">Related memories</h4>
                <ul className="evidence">
                  {r.memories.map((m) => (
                    <li key={m.id}>
                      <TrustBadge trust={m.trust} />
                      <Tag>{m.kind}</Tag>
                      <span>{m.title}</span>
                      <span className="muted small">by {sourceLabel(m.source, sessions)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {Object.keys(extra).length > 0 && (
              <details>
                <summary>Raw details</summary>
                <JsonBlock value={extra} />
              </details>
            )}
          </div>
        ))}
    </Panel>
  );
}

const DAY = 86_400_000;

function Standup() {
  const { client, project } = useApp();
  const [range, setRange] = useState<'1' | '3' | '7'>('1');
  const [since] = useState(() => Date.now());
  const res = useResource(
    () => client.standup(project.id, since - Number(range) * DAY),
    [project.id, range],
    [],
  );
  return (
    <Panel
      title="Standup"
      actions={
        <>
          <Segmented
            label="Period"
            value={range}
            onChange={setRange}
            options={[
              { key: '1', label: '24h' },
              { key: '3', label: '3 days' },
              { key: '7', label: 'week' },
            ]}
          />
          <button type="button" className="btn btn-small" onClick={res.reload}>
            Refresh
          </button>
        </>
      }
    >
      <Loaded res={res}>
        {(s) =>
          s.markdown.trim() ? (
            <PlainMarkdown source={s.markdown} />
          ) : (
            <Empty>Nothing happened in this period.</Empty>
          )
        }
      </Loaded>
    </Panel>
  );
}

function Snapshots() {
  const { client, project } = useApp();
  const res = useResource(() => client.snapshots(project.id), [project.id], ['snapshots']);
  const { busy, run } = useAction();
  const [label, setLabel] = useState('');
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [restore, setRestore] = useState<Snapshot | null>(null);
  const [branch, setBranch] = useState('');
  const [restored, setRestored] = useState<string | null>(null);

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    void run(
      'create',
      () => client.createSnapshot(project.id, label.trim()),
      'Snapshot created',
    ).then((ok) => {
      if (ok) {
        setLabel('');
        res.reload();
      }
    });
  };

  return (
    <Panel title="Snapshots" count={res.data?.length}>
      <p className="help">
        A snapshot captures code (tracked and untracked), memory and task state together. Restoring
        never touches your current branch.
      </p>
      <form className="filters" onSubmit={create}>
        <label className="field field-grow">
          <span>Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="before the big refactor"
            maxLength={120}
          />
        </label>
        <div className="field field-end">
          <button type="submit" className="btn btn-primary" disabled={!!busy || !label.trim()}>
            Create snapshot
          </button>
        </div>
      </form>
      {restored && (
        <p className="notice" role="status">
          Restored to new branch <Mono>{restored}</Mono>. Check it out with{' '}
          <Mono>{`git switch ${restored}`}</Mono>.
        </p>
      )}
      <Loaded res={res}>
        {(snaps) =>
          snaps.length === 0 ? (
            <Empty>No snapshots yet.</Empty>
          ) : (
            <ul className="snapshots">
              {snaps.map((s) => (
                <li key={s.id} className="snapshot">
                  <div className="row-line">
                    <span className="grow snapshot-label">{s.label}</span>
                    {s.commit && <Mono>{s.commit.slice(0, 10)}</Mono>}
                    <Time ms={s.createdAt} />
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-expanded={diffFor === s.id}
                      onClick={() => setDiffFor(diffFor === s.id ? null : s.id)}
                    >
                      {diffFor === s.id ? 'Hide diff' : 'Diff'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        setBranch('');
                        setRestore(s);
                      }}
                    >
                      Restore…
                    </button>
                  </div>
                  {s.gitRef && <p className="muted small mono">{s.gitRef}</p>}
                  {diffFor === s.id && <SnapshotDiffView id={s.id} />}
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <Confirm
        open={!!restore}
        title="Restore snapshot to a new branch?"
        confirmLabel="Restore to new branch"
        onCancel={() => setRestore(null)}
        onConfirm={() => {
          const s = restore;
          setRestore(null);
          if (!s) return;
          let b: string | undefined;
          void run('restore', async () => {
            const r = await client.restoreSnapshot(s.id, branch.trim() || undefined);
            b = typeof r.branch === 'string' ? r.branch : branch.trim() || 'new branch';
          }).then((ok) => ok && b && setRestored(b));
        }}
      >
        <p>
          “{restore?.label}” will be checked out into a new git branch. Your current branch and
          working tree are not changed.
        </p>
        <label className="field">
          <span>Branch name (optional)</span>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="mindly/restore-…"
            pattern="[0-9A-Za-z._\/\-]{0,100}"
          />
        </label>
      </Confirm>
    </Panel>
  );
}

function SnapshotDiffView({ id }: { id: string }) {
  const { client } = useApp();
  const res = useResource(() => client.snapshotDiff(id), [id]);
  return (
    <div className="snapshot-diff">
      <Loaded res={res}>{(d) => <DiffBody d={d} />}</Loaded>
    </div>
  );
}

function DiffBody({ d }: { d: SnapshotDiff }) {
  const known = new Set(['files', 'memories', 'tasks']);
  const extra = Object.fromEntries(Object.entries(d).filter(([k]) => !known.has(k)));
  const counts = (label: string, c?: { added?: number; changed?: number; removed?: number }) =>
    c && (
      <span className="small">
        {label}: <span className="add">+{c.added ?? 0}</span>{' '}
        <span className="chg">~{c.changed ?? 0}</span>{' '}
        <span className="del">−{c.removed ?? 0}</span>
      </span>
    );
  return (
    <div className="stack">
      <p className="muted small">Changes since this snapshot</p>
      <div className="row-line">
        {counts('memories', d.memories)}
        {counts('tasks', d.tasks)}
      </div>
      {d.files && d.files.length > 0 && (
        <ul className="diff-files">
          {d.files.map((f) => (
            <li key={f.path}>
              <span className="tag">{f.status ?? 'changed'}</span>
              <Mono>{f.path}</Mono>
              {f.added !== undefined && <span className="add">+{f.added}</span>}
              {f.removed !== undefined && <span className="del">−{f.removed}</span>}
            </li>
          ))}
        </ul>
      )}
      {Object.keys(extra).length > 0 && <JsonBlock value={extra} />}
    </div>
  );
}
