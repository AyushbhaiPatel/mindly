import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  Confirm,
  Drawer,
  Empty,
  Loaded,
  Mono,
  Panel,
  Status,
  Tag,
  Time,
  TrustBadge,
  cx,
} from '../components/ui';
import { absTime, agentName, splitList } from '../format';
import { useAction, useApp, useResource } from '../state';
import {
  MEMORY_KINDS,
  TRUST_LEVELS,
  type Memory,
  type MemoryDetail,
  type MemoryKind,
  type MemorySource,
  type Trust,
} from '../types';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function sourceLabel(
  src: MemorySource,
  sessions: ReturnType<typeof useApp>['sessions'],
): string {
  if (src.type === 'user') return 'you';
  if (src.type === 'system') return 'mindly';
  if (src.type === 'code') return 'code';
  const s = src.sessionId ? sessions.get(src.sessionId) : undefined;
  return s ? agentName(s) : (src.agentKind ?? 'agent');
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

  return (
    <div className="view">
      <Panel
        title="Memory"
        count={res.data?.length}
        actions={
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => setCreating(true)}
          >
            New memory
          </button>
        }
      >
        <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
          <label className="field field-grow">
            <span>Search</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Full-text: title, body, tags"
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind | '')}>
              <option value="">any</option>
              {MEMORY_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Trust</span>
            <select value={trust} onChange={(e) => setTrust(e.target.value as Trust | '')}>
              <option value="">any</option>
              {TRUST_LEVELS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Branch</span>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="all"
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'archived')}
            >
              <option value="active">active</option>
              <option value="archived">archived</option>
            </select>
          </label>
        </form>
        <Loaded res={res}>
          {(list) =>
            list.length === 0 ? (
              <Empty>
                {dq || kind || trust || db
                  ? 'No memories match these filters.'
                  : 'No memories yet. Agents propose them as they work, or add one with “New memory”.'}
              </Empty>
            ) : (
              <ul className="mem-list">
                {list.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={cx('mem-row', m.id === openId && 'is-open')}
                      onClick={() => setOpen(m.id)}
                    >
                      <span className="mem-badges">
                        <TrustBadge trust={m.trust} />
                        <Tag>{m.kind}</Tag>
                      </span>
                      <span className="mem-main">
                        <span className="mem-title">
                          {m.pinned && (
                            <span className="pin" title="Pinned">
                              pinned
                            </span>
                          )}
                          {m.title}
                          {m.enforce && <span className="enforced">enforced</span>}
                        </span>
                        <span className="mem-body">{m.body}</span>
                      </span>
                      <span className="mem-side">
                        <span className="muted">by {sourceLabel(m.source, sessions)}</span>
                        {m.scope.branch && <Mono>{m.scope.branch}</Mono>}
                        {m.scope.paths.slice(0, 2).map((p) => (
                          <Mono key={p}>{p}</Mono>
                        ))}
                        <Time ms={m.updatedAt} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
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

  const act = (key: string, fn: () => Promise<unknown>, msg: string) =>
    void run(key, fn, msg).then((ok) => ok && onChanged());

  if (editing) {
    return <MemoryForm existing={m} onDone={() => (setEditing(false), onChanged())} />;
  }

  return (
    <div className="stack-lg">
      <div className="detail-head">
        <div className="mem-badges">
          <TrustBadge trust={m.trust} />
          <Tag>{m.kind}</Tag>
          {m.status === 'archived' && <Status value="archived" />}
          {m.pinned && <Tag tone="accent">pinned</Tag>}
          {m.enforce && <Tag tone="warn">enforced</Tag>}
        </div>
        <h3 className="detail-title">{shown ? shown.title : m.title}</h3>
        <p className="muted small">
          v{m.version} · by {sourceLabel(m.source, sessions)} · updated <Time ms={m.updatedAt} />
          {m.lastVerifiedAt && (
            <>
              {' '}
              · verified <Time ms={m.lastVerifiedAt} />
            </>
          )}{' '}
          · <Mono>{m.id}</Mono>
        </p>
      </div>

      {shown && (
        <div className="time-travel" role="status">
          Viewing version {shown.version} from {absTime(shown.createdAt)} (trust {shown.trust}).{' '}
          <button type="button" className="link" onClick={() => setViewVersion(null)}>
            Back to current
          </button>
        </div>
      )}
      <div className="body-text">{shown ? shown.body : m.body}</div>

      <div className="btn-row">
        {m.trust !== 'approved' && m.trust !== 'verified' && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy}
            onClick={() => act('approve', () => client.approveMemory(m.id), 'Approved')}
          >
            Approve
          </button>
        )}
        {m.trust !== 'rejected' && (
          <button
            type="button"
            className="btn"
            disabled={!!busy}
            onClick={() => act('reject', () => client.rejectMemory(m.id), 'Rejected')}
          >
            Reject
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={!!busy}
          onClick={() =>
            act(
              'pin',
              () => client.updateMemory(m.id, { pinned: !m.pinned }),
              m.pinned ? 'Unpinned' : 'Pinned',
            )
          }
        >
          {m.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button type="button" className="btn" disabled={!!busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        {m.status !== 'archived' && (
          <button
            type="button"
            className="btn"
            disabled={!!busy}
            onClick={() => act('archive', () => client.archiveMemory(m.id), 'Archived')}
          >
            Archive
          </button>
        )}
        <button
          type="button"
          className="btn btn-danger"
          disabled={!!busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      </div>

      <dl className="kv">
        <dt>Scope</dt>
        <dd className="file-list">
          {m.scope.paths.length === 0 ? (
            <span className="muted">whole project</span>
          ) : (
            m.scope.paths.map((p) => <Mono key={p}>{p}</Mono>)
          )}
        </dd>
        <dt>Branch</dt>
        <dd>
          {m.scope.branch ? (
            <Mono>{m.scope.branch}</Mono>
          ) : (
            <span className="muted">all branches</span>
          )}
        </dd>
        <dt>Tags</dt>
        <dd className="file-list">
          {m.tags.length ? (
            m.tags.map((t) => <Tag key={t}>{t}</Tag>)
          ) : (
            <span className="muted">none</span>
          )}
        </dd>
      </dl>

      <section aria-label="Version history">
        <h4 className="sub">History</h4>
        <ol className="timeline">
          {versions.map((v) => (
            <li
              key={v.version}
              className={cx('tl-item', v.version === (viewVersion ?? m.version) && 'tl-current')}
            >
              <button
                type="button"
                className="tl-btn"
                onClick={() => setViewVersion(v.version === m.version ? null : v.version)}
                aria-pressed={v.version === (viewVersion ?? m.version)}
              >
                <span className="tl-ver">v{v.version}</span>
                <TrustBadge trust={v.trust} />
                <span className="tl-reason">{v.reason ?? 'changed'}</span>
                <span className="muted">by {sourceLabel(v.changedBy, sessions)}</span>
                <Time ms={v.createdAt} />
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Evidence">
        <h4 className="sub">Evidence</h4>
        {d.evidence.length === 0 ? (
          <Empty>No evidence linked. Without evidence this memory can’t self-heal.</Empty>
        ) : (
          <ul className="evidence">
            {d.evidence.map((e) => (
              <li key={e.id}>
                <span className={cx('tag', e.valid ? 'tone-good' : 'tone-bad')}>
                  {e.valid ? 'valid' : 'changed'}
                </span>
                <Tag>{e.type}</Tag>
                <Mono>{e.ref}</Mono>
                {e.checkedAt && (
                  <span className="muted small">
                    checked <Time ms={e.checkedAt} />
                  </span>
                )}
                {e.excerpt && <pre className="pre pre-inline">{e.excerpt}</pre>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Contracts">
        <h4 className="sub">Contracts</h4>
        {d.contracts.length === 0 ? (
          <Empty>No executable checks bound to this memory.</Empty>
        ) : (
          <ul className="evidence">
            {d.contracts.map((c) => (
              <li key={c.id}>
                <Status value={c.state} />
                <Tag>{c.kind.replace(/_/g, ' ')}</Tag>
                <Mono>{c.spec.path ?? c.spec.argv?.join(' ') ?? ''}</Mono>
                {c.spec.pattern && <Mono>/{c.spec.pattern}/</Mono>}
                {c.spec.symbol && <Mono>{c.spec.symbol}</Mono>}
                {c.spec.key && <Mono>{c.spec.key}</Mono>}
                {c.kind === 'command' && !c.approvedHash && <Tag tone="warn">needs approval</Tag>}
                {c.lastMessage && <span className="small">{c.lastMessage}</span>}
                <span className="muted small">
                  <Time ms={c.lastRunAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Where it was served">
        <h4 className="sub">Served in context</h4>
        {d.xray.length === 0 ? (
          <Empty>Not served to any agent yet.</Empty>
        ) : (
          <ul className="evidence">
            {d.xray.map((p) => {
              const inc = p.included.find((i) => i.ref === m.id);
              const om = p.omitted.find((i) => i.ref === m.id);
              const it = inc ?? om;
              return (
                <li key={p.id}>
                  <span className={cx('tag', inc ? 'tone-good' : 'tone-warn')}>
                    {inc ? 'included' : 'omitted'}
                  </span>
                  <span>{agentName(sessions.get(p.sessionId))}</span>
                  <Tag>{p.trigger.replace(/_/g, ' ')}</Tag>
                  {it && (
                    <span className="small">
                      score {it.score.toFixed(2)} · {it.reason}
                    </span>
                  )}
                  <Time ms={p.createdAt} />
                </li>
              );
            })}
          </ul>
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
          removed from the database. This can’t be undone. Archive it instead if you only want
          agents to stop seeing it.
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
              <option key={k}>{k}</option>
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
        <span>Scope globs</span>
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
          <label htmlFor={`${fid}-enf`}>Enforce this rule</label>
          <p id={`${fid}-enf-help`} className="help">
            When on, Mindly may block an agent’s file edit or command that clearly violates this
            rule (the agent sees why and can adjust). Leave off for guidance agents should weigh,
            not obey.
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
        <label htmlFor={`${fid}-pin`}>Pin (always include in context)</label>
      </div>
      <div className="btn-row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!!busy || !title.trim() || !body.trim()}
        >
          {existing ? 'Save changes' : 'Create memory'}
        </button>
        <button type="button" className="btn" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
