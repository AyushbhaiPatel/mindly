import { useEffect, useState, type FormEvent } from 'react';
import { PlainMarkdown } from '../components/markdown';
import {
  Confirm,
  Empty,
  ErrorNote,
  Help,
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
import {
  contextItemKindWords,
  contextSizeWords,
  humanizeAgentText,
  memoryKindWords,
  omitReasonWords,
  productName,
  relevanceWords,
  sessionName,
  sessionStatusWords,
  sourceWords,
  xraySentence,
} from '../vocab';
import { useAction, useApp, useResource } from '../state';
import type {
  ContextItem,
  ContextPacket,
  ProvenanceResult,
  Snapshot,
  SnapshotDiff,
} from '../types';

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
  const { client, project, sessions } = useApp();
  const sres = useResource(() => client.sessions(project.id, 50), [project.id], ['sessions']);
  const [sessionId, setSessionId] = useState<string>('');
  const current = sessionId ? sessions.get(sessionId) : undefined;
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
      help="xray"
      actions={
        sres.data && (
          <label className="field field-inline">
            <span>Agent</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {sres.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionName(s)} · {sessionStatusWords(s.status)}
                </option>
              ))}
            </select>
          </label>
        )
      }
    >
      <p className="help">
        Each time an agent starts, gets a prompt or is about to edit a file, Mindly sends it the
        memories, tasks and updates that matter right now. This shows exactly what it got, what was
        left out, and why. Newest first.
      </p>
      {sres.error ? (
        <ErrorNote error={sres.error} onRetry={sres.reload} />
      ) : (
        <Loaded res={pres}>
          {(packets) =>
            packets.length === 0 ? (
              <Empty>
                Mindly has not sent {current ? sessionName(current) : 'this agent'} any context yet.
                It does so when the agent starts, gets a prompt or is about to edit a file.
              </Empty>
            ) : (
              <ol className="packets">
                {packets.map((p) => (
                  <Packet key={p.id} p={p} agent={productName(current?.agentKind)} />
                ))}
              </ol>
            )
          }
        </Loaded>
      )}
    </Panel>
  );
}

function Packet({ p, agent }: { p: ContextPacket; agent: string }) {
  const [showOmitted, setShowOmitted] = useState(true);
  const pct =
    p.tokenBudget > 0 ? Math.min(100, Math.round((p.tokensUsed / p.tokenBudget) * 100)) : 0;
  const size = contextSizeWords(p.tokensUsed, p.tokenBudget);
  return (
    <li className="packet">
      <header className="packet-head">
        <p className="packet-sentence">{xraySentence(p, agent)}</p>
        <span className="grow" />
        <Time ms={p.createdAt} />
      </header>
      {p.query && (
        <p className="packet-query">
          <span className="muted">{p.trigger === 'pre_tool' ? 'About to: ' : 'Prompt: '}</span>“
          {p.query}”
        </p>
      )}
      <div className="budget" title={`${p.tokensUsed} of ${p.tokenBudget} tokens used`}>
        <span className="budget-name">
          context size <Help term="contextSize" />
        </span>
        <Meter value={pct} max={100} label={`Context size: ${size}, ${pct}% of the space used`} />
        <span className="budget-label">
          {size}, {pct}% of the space used
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
            {showOmitted ? 'Hide' : 'Show'} what was left out ({p.omitted.length})
          </button>
          {showOmitted && (
            <ItemTable title={`Left out (${p.omitted.length})`} items={p.omitted} kind="out" />
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
    return (
      <Empty>
        {kind === 'in'
          ? 'Nothing was relevant enough to send.'
          : 'Nothing was left out: everything relevant fit.'}
      </Empty>
    );
  const sorted = [...items].sort((a, b) => b.score - a.score);
  return (
    <div className="table-wrap">
      <table className={cx('table', 'table-compact', kind === 'out' && 'table-omitted')}>
        <caption className="table-caption">{title}</caption>
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col" className="num">
              Relevance
            </th>
            <th scope="col">{kind === 'in' ? 'Why it was sent' : 'Why it was left out'}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((i) => (
            <tr key={`${i.kind}:${i.ref}`}>
              <td>
                <span className="tag">{contextItemKindWords(i.kind)}</span>{' '}
                {humanizeAgentText(i.title)}
              </td>
              <td className="num">
                <span className="score" title={`Relevance score ${i.score.toFixed(2)} of 1`}>
                  <span
                    className="score-bar"
                    style={{ width: `${Math.round(Math.max(0, Math.min(1, i.score)) * 100)}%` }}
                  />
                  {relevanceWords(i.score)}
                </span>
              </td>
              <td className="muted" title={kind === 'out' ? i.reason : undefined}>
                {kind === 'out' ? omitReasonWords(i.reason) : humanizeAgentText(i.reason)}
              </td>
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
    <Panel title="Provenance" help="provenance">
      <p className="help">
        Type a file and line number to see which agent wrote it, when, and what it was asked to do.
      </p>
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
              <dd>{session ? sessionName(session) : productName(r.agentKind)}</dd>
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
                      <Tag>{memoryKindWords(m.kind)}</Tag>
                      <TrustBadge trust={m.trust} by={sourceWords(m.source, sessions)} />
                      <span>{m.title}</span>
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
            <Empty>
              No agent activity in this period. Once agents work here, this becomes a short written
              summary of what got done.
            </Empty>
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
    <Panel title="Snapshots" count={res.data?.length} noun="snapshot" help="snapshot">
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
            <Empty>
              No snapshots yet. Save one before a risky change; you can restore it later to a new
              branch.
            </Empty>
          ) : (
            <ul className="snapshots">
              {snaps.map((s) => (
                <li key={s.id} className="snapshot">
                  <div className="row-line">
                    <span className="grow snapshot-label">{s.label}</span>
                    {s.commit && (
                      <span className="muted small">
                        at commit <Mono title={s.commit}>{s.commit.slice(0, 8)}</Mono>
                      </span>
                    )}
                    <Time ms={s.createdAt} prefix="saved" />
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
        {label}: <span className="add">{c.added ?? 0} added</span>,{' '}
        <span className="chg">{c.changed ?? 0} changed</span>,{' '}
        <span className="del">{c.removed ?? 0} removed</span>
      </span>
    );
  return (
    <div className="stack">
      <p className="muted small">Changes since this snapshot</p>
      <div className="row-line">
        {counts('Memories', d.memories)}
        {counts('Tasks', d.tasks)}
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
