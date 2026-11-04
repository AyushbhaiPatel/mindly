import { useEffect, useState } from 'react';
import { Empty, Loaded, Mono, Panel, Segmented, Status, Tag, Time, cx } from '../components/ui';
import { agentName } from '../format';
import { useApp, useResource } from '../state';
import type { DeliveryStatus, Handoff, Intent, Task, TaskStatus } from '../types';
import { AgentMark } from './Overview';

const COLUMNS: TaskStatus[] = ['open', 'in_progress', 'blocked', 'done'];

export function CoordinationView() {
  const { params } = useApp();
  useEffect(() => {
    if (params.get('focus') === 'handoffs') document.getElementById('handoffs')?.scrollIntoView();
  }, [params]);
  return (
    <div className="view">
      <TaskBoard />
      <div className="grid-2">
        <IntentsPanel />
        <DeliveriesPanel />
      </div>
      <HandoffsPanel />
    </div>
  );
}

function TaskBoard() {
  const { client, project, sessions } = useApp();
  const res = useResource(() => client.tasks(project.id), [project.id], ['tasks']);
  return (
    <Panel title="Tasks" count={res.data?.length}>
      <Loaded res={res}>
        {(tasks) =>
          tasks.length === 0 ? (
            <Empty>No tasks yet. Agents create them through the Synapse MCP tools.</Empty>
          ) : (
            <div className="board">
              {COLUMNS.map((col) => {
                const items = tasks.filter(
                  (t) => t.status === col || (col === 'done' && t.status === 'abandoned'),
                );
                return (
                  <section
                    key={col}
                    className={cx('board-col', `col-${col}`)}
                    aria-label={col.replace('_', ' ')}
                  >
                    <h3 className="board-head">
                      {col.replace('_', ' ')}
                      <span className="count">{items.length}</span>
                    </h3>
                    <ul className="board-items">
                      {items.map((t) => (
                        <TaskCard
                          key={t.id}
                          t={t}
                          owner={
                            t.ownerSessionId ? agentName(sessions.get(t.ownerSessionId)) : null
                          }
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )
        }
      </Loaded>
    </Panel>
  );
}

function TaskCard({ t, owner }: { t: Task; owner: string | null }) {
  const done = t.plan.filter((p) => p.done).length;
  return (
    <li className="task">
      <p className="task-title">{t.title}</p>
      {t.status === 'abandoned' && <Status value="abandoned" />}
      {t.plan.length > 0 && (
        <ol className="plan" aria-label={`Plan, ${done} of ${t.plan.length} done`}>
          {t.plan.map((p, i) => (
            <li key={i} className={p.done ? 'plan-done' : ''}>
              <span aria-hidden="true">{p.done ? '✓' : '○'}</span>{' '}
              <span className="visually-hidden">{p.done ? 'done: ' : 'todo: '}</span>
              {p.text}
            </li>
          ))}
        </ol>
      )}
      {t.blockers.length > 0 && (
        <ul className="blockers">
          {t.blockers.map((b, i) => (
            <li key={i}>Blocked: {b}</li>
          ))}
        </ul>
      )}
      <p className="task-foot">
        <span className="muted">{owner ?? 'unowned'}</span>
        <Time ms={t.updatedAt} />
      </p>
    </li>
  );
}

function IntentsPanel() {
  const { client, project, sessions } = useApp();
  const res = useResource(() => client.intents(project.id), [project.id], ['intents']);
  return (
    <Panel title="Active intents" count={res.data?.length}>
      <Loaded res={res}>
        {(intents) => {
          if (intents.length === 0) return <Empty>No agent has declared upcoming edits.</Empty>;
          const groups = new Map<string, Intent[]>();
          for (const i of intents) groups.set(i.sessionId, [...(groups.get(i.sessionId) ?? []), i]);
          return (
            <ul className="intent-groups">
              {[...groups].map(([sid, list]) => {
                const s = sessions.get(sid);
                return (
                  <li key={sid}>
                    <h3 className="intent-session">
                      {s && <AgentMark kind={s.agentKind} />}
                      {agentName(s)}
                    </h3>
                    <ul className="intents">
                      {list.map((i) => (
                        <li key={i.id}>
                          <p>{i.summary}</p>
                          <div className="file-list">
                            {i.targets.files.map((f) => (
                              <Mono key={f}>{f}</Mono>
                            ))}
                            {i.targets.symbols.map((sym) => (
                              <Tag key={sym}>{sym}</Tag>
                            ))}
                          </div>
                          <p className="muted small">
                            expires <Time ms={i.expiresAt} />
                          </p>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </Loaded>
    </Panel>
  );
}

function DeliveriesPanel() {
  const { client, project, sessions } = useApp();
  const [status, setStatus] = useState<DeliveryStatus | 'all'>('all');
  const res = useResource(
    () => client.deliveries(project.id, status === 'all' ? undefined : status),
    [project.id, status],
    ['deliveries'],
  );
  return (
    <Panel
      title="Deliveries"
      count={res.data?.length}
      actions={
        <Segmented
          label="Delivery status"
          value={status}
          onChange={setStatus}
          options={[
            { key: 'all', label: 'all' },
            { key: 'pending', label: 'pending' },
            { key: 'delivered', label: 'delivered' },
            { key: 'acked', label: 'acked' },
          ]}
        />
      }
    >
      <Loaded res={res}>
        {(ds) =>
          ds.length === 0 ? (
            <Empty>
              No messages between agents{status !== 'all' ? ` with status ${status}` : ''}.
            </Empty>
          ) : (
            <ul className="deliveries">
              {ds.map((d) => (
                <li key={d.id}>
                  <div className="row-line">
                    <Status value={d.status} />
                    <Tag>{d.kind.replace('_', ' ')}</Tag>
                    <span className="grow">{d.title}</span>
                  </div>
                  <p className="muted small">
                    {d.sourceSessionId ? agentName(sessions.get(d.sourceSessionId)) : 'synapse'} →{' '}
                    {d.targetSessionId
                      ? agentName(sessions.get(d.targetSessionId))
                      : `next ${d.targetAgentKind ?? 'agent'}`}{' '}
                    · <Time ms={d.createdAt} />
                  </p>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </Panel>
  );
}

function HandoffsPanel() {
  const { client, project } = useApp();
  const res = useResource(() => client.handoffs(project.id), [project.id], ['handoffs']);
  return (
    <Panel title="Handoffs" count={res.data?.length} id="handoffs">
      <Loaded res={res}>
        {(hs) =>
          hs.length === 0 ? (
            <Empty>
              No handoffs. When an agent stops mid-task, its packaged state appears here.
            </Empty>
          ) : (
            <ul className="handoffs">
              {hs.map((h) => (
                <HandoffCard key={h.id} h={h} />
              ))}
            </ul>
          )
        }
      </Loaded>
    </Panel>
  );
}

function HandoffCard({ h }: { h: Handoff }) {
  const { sessions } = useApp();
  const p = h.packet;
  const reason = { manual: 'manual', rate_limit: 'rate limit', crash: 'crash' }[h.reason];
  return (
    <li className="handoff">
      <div className="row-line">
        <Status value={h.status} />
        <Tag tone={h.reason === 'manual' ? 'neutral' : 'warn'}>{reason}</Tag>
        <span className="grow handoff-title">{h.summary}</span>
        <Time ms={h.createdAt} />
      </div>
      <p className="muted small">
        from {agentName(sessions.get(h.fromSessionId))} → {h.toAgentKind ?? 'any agent'}
        {h.claimedBySessionId && <> · claimed by {agentName(sessions.get(h.claimedBySessionId))}</>}
        {p.branch && (
          <>
            {' '}
            · <Mono>{p.branch}</Mono>
          </>
        )}
        {p.headCommit && (
          <>
            {' '}
            @ <Mono>{p.headCommit}</Mono>
          </>
        )}
      </p>
      <div className="handoff-grid">
        <div>
          <h4 className="sub">Goal</h4>
          <p>{p.goal}</p>
        </div>
        {p.nextSteps.length > 0 && (
          <div>
            <h4 className="sub">Next steps</h4>
            <ul className="bullets">
              {p.nextSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {p.filesChanged.length > 0 && (
          <div>
            <h4 className="sub">Files changed</h4>
            <div className="file-list">
              {p.filesChanged.map((f) => (
                <Mono key={f}>{f}</Mono>
              ))}
            </div>
          </div>
        )}
        {p.decisions.length > 0 && (
          <div>
            <h4 className="sub">Decisions</h4>
            <ul className="bullets">
              {p.decisions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {h.status === 'pending' && (
        <p className="help">
          The next {h.toAgentKind ?? 'agent'} session in this project receives this handoff when it
          starts.
        </p>
      )}
    </li>
  );
}
