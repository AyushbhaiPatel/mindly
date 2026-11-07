import { useEffect, useState, type FormEvent } from 'react';
import { PlainMarkdown } from '../components/markdown';
import {
  Age,
  Confirm,
  DataTable,
  Empty,
  ErrorNote,
  Facts,
  Help,
  JsonBlock,
  Loaded,
  Loading,
  Meter,
  Mono,
  Panel,
  Paths,
  Segmented,
  Tabs,
  TextLink,
  Time,
  TrustMark,
  type Column,
} from '../components/ui';
import {
  COLUMNS,
  EMPTY,
  contextItemKindWords,
  contextSizeWords,
  humanizeAgentText,
  memoryKindWords,
  omitReasonWords,
  productName,
  relevanceWords,
  sessionStatusWords,
  sourceWords,
  xraySentence,
} from '../vocab';
import { useAction, useApp, useResource } from '../state';
import type {
  ContextItem,
  ContextPacket,
  Memory,
  ProvenanceResult,
  Snapshot,
  SnapshotDiff,
} from '../types';
import { AgentName } from './Overview';

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

export function XRay() {
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
          <label className="line-field">
            <span className="visually-hidden">Agent</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {sres.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {productName(s.agentKind)}
                  {s.label ? ` (${s.label})` : ''} {'·'} {sessionStatusWords(s.status)}
                </option>
              ))}
            </select>
          </label>
        )
      }
    >
      {sres.error ? (
        <ErrorNote error={sres.error} onRetry={sres.reload} />
      ) : (
        <Loaded res={pres}>
          {(packets) =>
            packets.length === 0 ? (
              <Empty>{EMPTY.xray}</Empty>
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
  const pct =
    p.tokenBudget > 0 ? Math.min(100, Math.round((p.tokensUsed / p.tokenBudget) * 100)) : 0;
  const size = contextSizeWords(p.tokensUsed, p.tokenBudget);
  return (
    <li className="packet">
      <header className="packet-head">
        <p className="packet-sentence">{xraySentence(p, agent)}</p>
        <span className="packet-time">
          <Age ms={p.createdAt} />
        </span>
      </header>
      <p className="line-meta packet-meta">
        {p.query && (
          <span className="packet-query" title={p.query}>
            {'“'}
            {p.query}
            {'”'}
          </span>
        )}
        <span className="budget" title={`${p.tokensUsed} of ${p.tokenBudget} tokens used`}>
          <span className="muted">context</span>
          <Meter value={pct} max={100} label={`Context size: ${size}, ${pct}% of the space used`} />
          <span className="muted">
            {size} {'·'} {pct}%
          </span>
          <Help term="contextSize" />
        </span>
      </p>
      <ItemTable title="Included" items={p.included} kind="in" />
      <ItemTable title="Left out" items={p.omitted} kind="out" />
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
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const cols: Column<ContextItem>[] = [
    {
      key: 'item',
      header: COLUMNS.item,
      kind: 'main',
      title: (i) => humanizeAgentText(i.title),
      cell: (i) => (
        <>
          {humanizeAgentText(i.title)}
          <span className="muted">
            {' '}
            {'·'} {contextItemKindWords(i.kind)}
          </span>
        </>
      ),
    },
    {
      key: 'rel',
      header: COLUMNS.relevance,
      cell: (i) => (
        <span title={`Relevance score ${i.score.toFixed(2)} of 1`}>{relevanceWords(i.score)}</span>
      ),
    },
    {
      key: 'why',
      header: COLUMNS.why,
      kind: 'clip',
      title: (i) => i.reason,
      cell: (i) => (kind === 'out' ? omitReasonWords(i.reason) : humanizeAgentText(i.reason)),
    },
  ];
  return (
    <section className="packet-table" aria-label={title}>
      <h4 className="sub">
        {title} <span className="count">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="muted small">{kind === 'in' ? EMPTY.included : EMPTY.omitted}</p>
      ) : (
        <DataTable
          label={title}
          className={kind === 'out' ? 'dt-omitted' : undefined}
          columns={cols}
          rows={sorted}
          rowKey={(i) => `${i.kind}:${i.ref}`}
        />
      )}
    </section>
  );
}

export function Provenance() {
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
  const memCols: Column<Memory>[] = [
    { key: 'trust', header: COLUMNS.trust, cell: (m) => <TrustMark trust={m.trust} /> },
    { key: 'kind', header: COLUMNS.kind, cell: (m) => memoryKindWords(m.kind) },
    {
      key: 'title',
      header: COLUMNS.title,
      kind: 'main',
      title: (m) => m.title,
      cell: (m) => m.title,
    },
    {
      key: 'from',
      header: COLUMNS.from,
      kind: 'clip',
      cell: (m) => sourceWords(m.source, sessions),
    },
  ];
  return (
    <Panel title="Provenance" help="provenance">
      <form className="filter-line" onSubmit={submit}>
        <label className="line-field line-field-grow">
          <span className="visually-hidden">File</span>
          <input
            value={file}
            onChange={(e) => setFile(e.target.value)}
            placeholder="src/auth/session.ts"
            required
            maxLength={500}
          />
        </label>
        <label className="line-field line-field-narrow">
          <span className="visually-hidden">Line</span>
          <input
            type="number"
            min={1}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            required
            placeholder="line"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={state.loading}>
          Look up
        </button>
      </form>
      {state.loading && <Loading />}
      {state.error ? <ErrorNote error={state.error} /> : null}
      {r &&
        (r.found === false ? (
          <Empty>{EMPTY.provenance}</Empty>
        ) : (
          <div className="detail-stack result-block">
            <Facts
              items={[
                ['Line', <Mono key="l">{`${r.file ?? file}:${r.line ?? line}`}</Mono>],
                [
                  'Agent',
                  session ? (
                    <AgentName key="a" kind={session.agentKind} />
                  ) : (
                    productName(r.agentKind)
                  ),
                ],
                ['Tool', r.tool && <Mono>{r.tool}</Mono>],
                ['When', <Time key="w" ms={r.createdAt ?? null} />],
                [
                  'Prompt',
                  r.promptSummary ? (
                    <q>{r.promptSummary}</q>
                  ) : (
                    <span className="muted">not recorded</span>
                  ),
                ],
              ]}
            />
            {r.memories && r.memories.length > 0 && (
              <section aria-label="Related memories">
                <h4 className="sub">Related memories</h4>
                <DataTable
                  label="Related memories"
                  columns={memCols}
                  rows={r.memories}
                  rowKey={(m) => m.id}
                />
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

export function Standup() {
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
      help="standup"
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
          <TextLink onClick={res.reload}>Refresh</TextLink>
        </>
      }
    >
      <Loaded res={res}>
        {(s) =>
          s.markdown.trim() ? <PlainMarkdown source={s.markdown} /> : <Empty>{EMPTY.standup}</Empty>
        }
      </Loaded>
    </Panel>
  );
}

export function Snapshots() {
  const { client, project } = useApp();
  const res = useResource(() => client.snapshots(project.id), [project.id], ['snapshots']);
  const { busy, run } = useAction();
  const [label, setLabel] = useState('');
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

  const cols: Column<Snapshot>[] = [
    {
      key: 'label',
      header: COLUMNS.label,
      kind: 'main',
      title: (s) => s.label,
      cell: (s) => s.label,
    },
    {
      key: 'commit',
      header: COLUMNS.commit,
      cell: (s) =>
        s.commit ? (
          <Mono title={s.commit}>{s.commit.slice(0, 8)}</Mono>
        ) : (
          <span className="muted">{'—'}</span>
        ),
    },
    { key: 'saved', header: COLUMNS.saved, kind: 'meta', cell: (s) => <Age ms={s.createdAt} /> },
  ];

  return (
    <Panel title="Snapshots" help="snapshot" meta={res.data ? String(res.data.length) : undefined}>
      <form className="filter-line" onSubmit={create}>
        <label className="line-field line-field-grow">
          <span className="visually-hidden">Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label, e.g. before the big refactor"
            maxLength={120}
          />
        </label>
        <button type="submit" className="btn-primary" disabled={!!busy || !label.trim()}>
          Save snapshot
        </button>
      </form>
      {restored && (
        <p className="notice" role="status">
          Restored to new branch <Mono>{restored}</Mono>. Switch with{' '}
          <Mono>{`git switch ${restored}`}</Mono>.
        </p>
      )}
      <Loaded res={res}>
        {(snaps) =>
          snaps.length === 0 ? (
            <Empty>{EMPTY.snapshots}</Empty>
          ) : (
            <DataTable
              label="Snapshots"
              columns={cols}
              rows={snaps}
              rowKey={(s) => s.id}
              detail={(s) => <SnapshotDiffView id={s.id} />}
              menu={(s) => [
                {
                  label: 'Restore to new branch…',
                  onSelect: () => {
                    setBranch('');
                    setRestore(s);
                  },
                },
              ]}
              menuLabel={(s) => `Actions for snapshot ${s.label}`}
            />
          )
        }
      </Loaded>
      <Confirm
        open={!!restore}
        title="Restore snapshot to a new branch?"
        confirmLabel="Restore"
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
          “{restore?.label}” is checked out into a new branch. Your current branch is not changed.
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
  return <Loaded res={res}>{(d) => <DiffBody d={d} />}</Loaded>;
}

function DiffBody({ d }: { d: SnapshotDiff }) {
  const known = new Set(['files', 'memories', 'tasks']);
  const extra = Object.fromEntries(Object.entries(d).filter(([k]) => !known.has(k)));
  const counts = (c?: { added?: number; changed?: number; removed?: number }) =>
    c && (
      <>
        <span className="add">+{c.added ?? 0}</span> <span className="chg">~{c.changed ?? 0}</span>{' '}
        <span className="del">
          {'−'}
          {c.removed ?? 0}
        </span>
      </>
    );
  const files = d.files ?? [];
  return (
    <div className="detail-stack">
      <Facts
        items={[
          ['Memories', counts(d.memories)],
          ['Tasks', counts(d.tasks)],
          ['Files', files.length > 0 && <Paths paths={files.map((f) => f.path)} max={Infinity} />],
        ]}
      />
      {Object.keys(extra).length > 0 && <JsonBlock value={extra} />}
    </div>
  );
}
