import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  Age,
  Confirm,
  CopyId,
  DataTable,
  DotWord,
  Drawer,
  Empty,
  Facts,
  Help,
  Loaded,
  Mono,
  Overflow,
  Panel,
  Paths,
  Segmented,
  Status,
  TextLink,
  TrustMark,
  type Column,
} from '../components/ui';
import { splitList } from '../format';
import { useAction, useApp, useResource } from '../state';
import {
  MEMORY_KINDS,
  TRUST_LEVELS,
  type ContextPacket,
  type Contract,
  type Memory,
  type MemoryDetail,
  type MemoryEvidence,
  type MemoryKind,
  type MemoryVersion,
  type Trust,
} from '../types';
import {
  COLUMNS,
  EMPTY,
  absTime,
  checkStateWords,
  memoryKindPlural,
  memoryKindWords,
  omitReasonWords,
  productName,
  relevanceWords,
  sourceWords,
  triggerWords,
  trustShort,
  words,
} from '../vocab';
import { AgentName } from './Overview';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function MemoryView() {
  const { client, project, params, navigate, sessions } = useApp();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<MemoryKind | ''>(
    (params.get('kind') as MemoryKind | null) ?? '',
  );
  const [trust, setTrust] = useState<Trust | ''>((params.get('trust') as Trust | null) ?? '');
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q, 250);
  const db = useDebounced(branch, 250);
  const openId = params.get('m');

  const res = useResource(
    () =>
      client.memories(project.id, {
        q: dq.trim(),
        kind,
        trust,
        branch: db.trim(),
        status,
        limit: 200,
      }),
    [project.id, dq, kind, trust, db, status],
    ['memories'],
  );

  const setOpen = (id: string | null) => {
    const p: Record<string, string> = {};
    if (kind) p.kind = kind;
    if (trust) p.trust = trust;
    if (id) p.m = id;
    navigate('memory', p);
  };

  const cols: Column<Memory>[] = [
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
    {
      key: 'updated',
      header: COLUMNS.updated,
      kind: 'meta',
      cell: (m) => <Age ms={m.updatedAt} />,
    },
  ];

  return (
    <div className="view">
      <Panel
        title="Memory"
        help="memory"
        meta={res.data ? String(res.data.length) : undefined}
        actions={<TextLink onClick={() => setCreating(true)}>New memory</TextLink>}
      >
        <div className="filters" role="search">
          <Segmented
            label="Trust"
            value={trust}
            onChange={setTrust}
            options={[
              { key: '', label: 'all' },
              ...(['proposed', 'approved', 'verified', 'stale', 'rejected'] as const).map((t) => ({
                key: t,
                label: trustShort(t),
              })),
            ]}
          />
          <Segmented
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { key: '', label: 'all kinds' },
              ...MEMORY_KINDS.map((k) => ({ key: k, label: memoryKindPlural(k) })),
            ]}
          />
          <div className="filter-line">
            <label className="line-field line-field-grow">
              <span className="visually-hidden">Search</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search title, body, tags"
                maxLength={200}
              />
            </label>
            <label className="line-field">
              <span className="visually-hidden">Branch</span>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="any branch"
                maxLength={200}
              />
            </label>
            <Segmented
              label="Show"
              value={status}
              onChange={setStatus}
              options={[
                { key: 'active', label: 'in use' },
                { key: 'archived', label: 'archived' },
              ]}
            />
          </div>
        </div>
        <Loaded res={res}>
          {(list) =>
            list.length === 0 ? (
              <Empty>
                {dq || kind || trust || db
                  ? EMPTY.memoryFiltered
                  : status === 'archived'
                    ? EMPTY.memoryArchived
                    : EMPTY.memory}
              </Empty>
            ) : (
              <DataTable
                label="Memories"
                columns={cols}
                rows={list}
                rowKey={(m) => m.id}
                onOpen={(m) => setOpen(m.id)}
                isCurrent={(m) => m.id === openId}
              />
            )
          }
        </Loaded>
      </Panel>
      <Drawer open={!!openId} onClose={() => setOpen(null)} title="Memory" wide>
        {openId && <MemoryDrawer id={openId} onGone={() => setOpen(null)} onChanged={res.reload} />}
      </Drawer>
      <Drawer open={creating} onClose={() => setCreating(false)} title="New memory">
        {creating && (
          <MemoryForm
            onDone={(m) => {
              setCreating(false);
              res.reload();
              if (m) setOpen(m.id);
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function MemoryDrawer({
  id,
  onGone,
  onChanged,
}: {
  id: string;
  onGone(): void;
  onChanged(): void;
}) {
  const { client } = useApp();
  const res = useResource(() => client.memory(id), [id], ['memories']);
  return (
    <Loaded res={res}>
      {(d) => (
        <MemoryDetailView
          d={d}
          onChanged={() => {
            res.reload();
            onChanged();
          }}
          onGone={() => {
            onChanged();
            onGone();
          }}
        />
      )}
    </Loaded>
  );
}

function MemoryDetailView({
  d,
  onChanged,
  onGone,
}: {
  d: MemoryDetail;
  onChanged(): void;
  onGone(): void;
}) {
  const { client, sessions } = useApp();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const m = d.memory;
  const versions = [...d.versions].sort((a, b) => b.version - a.version);
  const shown = viewVersion !== null ? versions.find((v) => v.version === viewVersion) : undefined;
  const waiting = m.trust !== 'approved' && m.trust !== 'verified' && m.trust !== 'rejected';

  const act = (key: string, fn: () => Promise<unknown>, msg: string) =>
    void run(key, fn, msg).then((ok) => ok && onChanged());

  if (editing) {
    return <MemoryForm existing={m} onDone={() => (setEditing(false), onChanged())} />;
  }

  const versionCols: Column<MemoryVersion>[] = [
    { key: 'v', header: COLUMNS.version, cell: (v) => `v${v.version}` },
    { key: 'trust', header: COLUMNS.trust, cell: (v) => <TrustMark trust={v.trust} /> },
    {
      key: 'change',
      header: COLUMNS.change,
      kind: 'main',
      title: (v) => v.reason ?? undefined,
      cell: (v) => v.reason ?? 'changed',
    },
    {
      key: 'by',
      header: COLUMNS.by,
      kind: 'clip',
      cell: (v) => sourceWords(v.changedBy, sessions),
    },
    { key: 'when', header: COLUMNS.when, kind: 'meta', cell: (v) => <Age ms={v.createdAt} /> },
  ];
  const evidenceCols: Column<MemoryEvidence>[] = [
    {
      key: 'state',
      header: COLUMNS.status,
      cell: (e) => (
        <DotWord tone={e.valid ? 'good' : 'bad'}>{e.valid ? 'matches' : 'code changed'}</DotWord>
      ),
    },
    { key: 'type', header: COLUMNS.type, cell: (e) => words(e.type) },
    {
      key: 'ref',
      header: COLUMNS.ref,
      kind: 'main',
      title: (e) => e.ref,
      cell: (e) => <Mono>{e.ref}</Mono>,
    },
    {
      key: 'checked',
      header: COLUMNS.checked,
      kind: 'meta',
      cell: (e) => <Age ms={e.checkedAt} />,
    },
  ];
  const checkCols: Column<Contract>[] = [
    {
      key: 'state',
      header: COLUMNS.status,
      cell: (c) => <Status value={c.state} label={checkStateWords(c.state)} />,
    },
    { key: 'kind', header: COLUMNS.kind, cell: (c) => words(c.kind) },
    {
      key: 'spec',
      header: COLUMNS.spec,
      kind: 'main',
      cell: (c) => (
        <Mono>
          {[
            c.spec.path ?? c.spec.argv?.join(' '),
            c.spec.pattern && `/${c.spec.pattern}/`,
            c.spec.symbol,
            c.spec.key,
          ]
            .filter(Boolean)
            .join(' ')}
        </Mono>
      ),
    },
    { key: 'last', header: COLUMNS.lastRun, kind: 'meta', cell: (c) => <Age ms={c.lastRunAt} /> },
  ];
  const xrayCols: Column<ContextPacket>[] = [
    {
      key: 'res',
      header: COLUMNS.result,
      cell: (p) =>
        p.included.some((i) => i.ref === m.id) ? (
          <DotWord tone="good">included</DotWord>
        ) : (
          <DotWord tone="warn">left out</DotWord>
        ),
    },
    {
      key: 'agent',
      header: COLUMNS.agent,
      cell: (p) => <AgentName kind={sessions.get(p.sessionId)?.agentKind} />,
    },
    {
      key: 'why',
      header: COLUMNS.why,
      kind: 'main',
      cell: (p) => {
        const inc = p.included.find((i) => i.ref === m.id);
        const it = inc ?? p.omitted.find((i) => i.ref === m.id);
        if (!it) return triggerWords(p.trigger);
        return (
          <span title={`Relevance score ${it.score.toFixed(2)}`}>
            {relevanceWords(it.score)} {'·'} {inc ? it.reason : omitReasonWords(it.reason)}
          </span>
        );
      },
    },
    { key: 'when', header: COLUMNS.when, kind: 'meta', cell: (p) => <Age ms={p.createdAt} /> },
  ];

  return (
    <div className="drawer-stack">
      <header className="detail-head">
        <h3 className="detail-title">{shown ? shown.title : m.title}</h3>
        <p className="detail-meta">
          <TrustMark trust={m.trust} />
          <span className="sep">{'·'}</span>
          {memoryKindWords(m.kind)}
          <span className="sep">{'·'}</span>
          from {sourceWords(m.source, sessions)}
          <span className="sep">{'·'}</span>v{m.version}
          <span className="sep">{'·'}</span>
          <Age ms={m.updatedAt} />
          {m.status === 'archived' && (
            <>
              <span className="sep">{'·'}</span>archived
            </>
          )}
          {m.pinned && (
            <>
              <span className="sep">{'·'}</span>always included
            </>
          )}
          {m.enforce && (
            <>
              <span className="sep">{'·'}</span>enforced
            </>
          )}
        </p>
      </header>

      {shown && (
        <p className="notice" role="status">
          Version {shown.version}, {absTime(shown.createdAt)}.{' '}
          <TextLink onClick={() => setViewVersion(null)}>Back to current</TextLink>
        </p>
      )}
      <div className="body-text">{shown ? shown.body : m.body}</div>

      <div className="action-row">
        {waiting && (
          <button
            type="button"
            className="btn-primary"
            disabled={!!busy}
            onClick={() => act('approve', () => client.approveMemory(m.id), 'Approved')}
          >
            Approve
          </button>
        )}
        {m.trust !== 'rejected' && (
          <TextLink
            disabled={!!busy}
            onClick={() => act('reject', () => client.rejectMemory(m.id), 'Rejected')}
          >
            Reject
          </TextLink>
        )}
        <TextLink disabled={!!busy} onClick={() => setEditing(true)}>
          Edit
        </TextLink>
        <Overflow
          label="More memory actions"
          items={[
            {
              label: m.pinned ? 'Stop always including' : 'Always include',
              disabled: !!busy,
              onSelect: () =>
                act(
                  'pin',
                  () => client.updateMemory(m.id, { pinned: !m.pinned }),
                  m.pinned ? 'No longer always included' : 'Always included',
                ),
            },
            ...(m.status !== 'archived'
              ? [
                  {
                    label: 'Archive',
                    disabled: !!busy,
                    onSelect: () => act('archive', () => client.archiveMemory(m.id), 'Archived'),
                  },
                ]
              : []),
            {
              label: 'Copy id',
              onSelect: () => void navigator.clipboard?.writeText(m.id).catch(() => undefined),
            },
            { label: 'Delete', danger: true, onSelect: () => setConfirmDelete(true) },
          ]}
        />
      </div>

      <Facts
        items={[
          [
            'Applies to',
            m.scope.paths.length === 0 ? (
              <span className="muted">whole project</span>
            ) : (
              <Paths paths={m.scope.paths} max={Infinity} />
            ),
          ],
          [
            'Branch',
            m.scope.branch ? <Mono>{m.scope.branch}</Mono> : <span className="muted">all</span>,
          ],
          ['Tags', m.tags.length > 0 && m.tags.join(', ')],
          ['Id', <CopyId key="id" id={m.id} label="memory id" />],
        ]}
      />

      <section aria-label="History" className="drawer-section">
        <h4 className="sub">History</h4>
        <DataTable
          label="Version history"
          columns={versionCols}
          rows={versions}
          rowKey={(v) => String(v.version)}
          isCurrent={(v) => v.version === (viewVersion ?? m.version)}
          onOpen={(v) => setViewVersion(v.version === m.version ? null : v.version)}
        />
      </section>

      <section aria-label="Evidence" className="drawer-section">
        <h4 className="sub">Evidence</h4>
        {d.evidence.length === 0 ? (
          <Empty>{EMPTY.evidence}</Empty>
        ) : (
          <DataTable
            label="Evidence"
            columns={evidenceCols}
            rows={d.evidence}
            rowKey={(e) => e.id}
            detail={(e) => (e.excerpt ? <pre className="pre">{e.excerpt}</pre> : null)}
          />
        )}
      </section>

      <section aria-label="Checks" className="drawer-section">
        <h4 className="sub">
          Checks <Help term="check" />
        </h4>
        {d.contracts.length === 0 ? (
          <Empty>{EMPTY.checks}</Empty>
        ) : (
          <DataTable
            label="Checks"
            columns={checkCols}
            rows={d.contracts}
            rowKey={(c) => c.id}
            detail={(c) =>
              c.lastMessage || (c.kind === 'command' && !c.approvedHash) ? (
                <Facts
                  items={[
                    ['Message', c.lastMessage],
                    [
                      'Approval',
                      c.kind === 'command' && !c.approvedHash && 'needs your approval to run',
                    ],
                  ]}
                />
              ) : null
            }
          />
        )}
      </section>

      <section aria-label="Given to agents" className="drawer-section">
        <h4 className="sub">
          Given to agents <Help term="xray" />
        </h4>
        {d.xray.length === 0 ? (
          <Empty>{EMPTY.givenTo}</Empty>
        ) : (
          <DataTable
            label="Given to agents"
            columns={xrayCols}
            rows={d.xray}
            rowKey={(p) => p.id}
          />
        )}
      </section>

      <Confirm
        open={confirmDelete}
        title="Delete this memory permanently?"
        confirmLabel="Delete permanently"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void run('delete', () => client.deleteMemory(m.id), 'Memory deleted').then(
            (ok) => ok && onGone(),
          );
        }}
      >
        <p>
          “{m.title}” and its {versions.length} version{versions.length === 1 ? '' : 's'} will be
          removed. This can’t be undone. Archive it instead to keep the history.
        </p>
      </Confirm>
    </div>
  );
}

function MemoryForm({ existing, onDone }: { existing?: Memory; onDone(m?: Memory): void }) {
  const { client, project } = useApp();
  const { busy, run } = useAction();
  const fid = useId();
  const [kind, setKind] = useState<MemoryKind>(existing?.kind ?? 'rule');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [tags, setTags] = useState(existing?.tags.join(', ') ?? '');
  const [paths, setPaths] = useState(existing?.scope.paths.join('\n') ?? '');
  const [enforce, setEnforce] = useState(existing?.enforce ?? false);
  const [pinned, setPinned] = useState(existing?.pinned ?? false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    let created: Memory | undefined;
    const fields = {
      title: title.trim(),
      body: body.trim(),
      tags: splitList(tags),
      scopePaths: splitList(paths),
      enforce: kind === 'rule' && enforce,
      pinned,
    };
    void run(
      'save',
      async () => {
        created = existing
          ? await client.updateMemory(existing.id, fields)
          : await client.createMemory(project.id, { kind, ...fields });
      },
      existing ? 'Changes saved' : 'Memory created',
    ).then((ok) => ok && onDone(created));
  };

  return (
    <form className="form" onSubmit={submit}>
      {!existing && (
        <label className="field">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {memoryKindWords(k)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Title</span>
        <input
          required
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Always use pnpm"
        />
      </label>
      <label className="field">
        <span>Body</span>
        <textarea
          required
          rows={6}
          value={body}
          maxLength={8000}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Tags</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tooling, ci" />
      </label>
      <label className="field">
        <span>Applies to files</span>
        <textarea
          rows={3}
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
          placeholder={'src/billing/**\none per line; empty = whole project'}
        />
      </label>
      {(existing?.kind ?? kind) === 'rule' && (
        <div className="check-field">
          <input
            id={`${fid}-enf`}
            type="checkbox"
            checked={enforce}
            onChange={(e) => setEnforce(e.target.checked)}
            aria-describedby={`${fid}-enf-help`}
          />
          <label htmlFor={`${fid}-enf`}>Enforce</label>
          <p id={`${fid}-enf-help`} className="help">
            Mindly may block an edit or command that clearly breaks this rule.
          </p>
        </div>
      )}
      <div className="check-field">
        <input
          id={`${fid}-pin`}
          type="checkbox"
          checked={pinned}
          onChange={(e) => setPinned(e.target.checked)}
        />
        <label htmlFor={`${fid}-pin`}>Always include</label>
      </div>
      <div className="action-row">
        <button
          type="submit"
          className="btn-primary"
          disabled={!!busy || !title.trim() || !body.trim()}
        >
          {existing ? 'Save changes' : 'Create memory'}
        </button>
        <TextLink onClick={() => onDone()}>Cancel</TextLink>
      </div>
    </form>
  );
}
