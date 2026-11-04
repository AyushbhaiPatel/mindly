import { useEffect, useState } from 'react';
import { Empty, Loaded, Mono, Panel, Segmented, Status, Tag, Time, cx } from '../components/ui';
import { useApp, useResource } from '../state';
import type { Handoff, Intent, Task, TaskStatus } from '../types';
import {
  deliveryKindWords,
  deliveryStatusWords,
  handoffReasonWords,
  handoffStatusWords,
  humanizeAgentText,
  productName,
  sessionName,
  taskStatusWords,
} from '../vocab';
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
    <Panel title="Tasks" count={res.data?.length} noun="task">
      <Loaded res={res}>
        {(tasks) =>
          tasks.length === 0 ? (
            <Empty>
              No tasks yet. When an agent plans its work, the task and its steps appear here so
              every agent can see who is doing what.
            </Empty>
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
                    aria-label={taskStatusWords(col)}
                  >
                    <h3 className="board-head">
                      {taskStatusWords(col)}
                      <span className="count">{items.length}</span>
                    </h3>
                    <ul className="board-items">
                      {items.map((t) => (
                        <TaskCard
                          key={t.id}
                          t={t}
                          owner={
                            t.ownerSessionId ? sessionName(sessions.get(t.ownerSessionId)) : null
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
      {t.status === 'abandoned' && (
        <Status value="abandoned" label={taskStatusWords('abandoned')} />
      )}
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
        <span className="muted">{owner ?? 'nobody has picked this up'}</span>
        <Time ms={t.updatedAt} prefix="updated" />
      </p>
    </li>
  );
}

function IntentsPanel() {
  const { client, project, sessions } = useApp();
  const res = useResource(() => client.intents(project.id), [project.id], ['intents']);
  return (
    <Panel title="Who is editing what" count={res.data?.length} noun="edit" help="intent">
      <Loaded res={res}>
        {(intents) => {
          if (intents.length === 0)
            return (
              <Empty>
                No agent is editing anything right now. Agents say which files they are about to
                change before they change them, and it shows up here.
              </Empty>
            );
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
                      {s ? sessionName(s) : 'An agent'} <span className="muted">is editing</span>
                    </h3>
                    <ul className="intents">
                      {list.map((i) => (
                        <li key={i.id}>
                          <p>{humanizeAgentText(i.summary)}</p>
                          <div className="file-list">
                            {i.targets.files.map((f) => (
                              <Mono key={f}>{f}</Mono>
                            ))}
                            {i.targets.symbols.map((sym) => (
                              <Tag key={sym}>{`${sym}()`}</Tag>
                            ))}
                          </div>
                          <p className="muted small">
                            <Time ms={i.expiresAt} prefix="plan expires" /> unless the agent renews
                            it
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
  const [status, setStatus] = useState<'all' | 'unseen' | 'seen'>('all');
  const res = useResource(() => client.deliveries(project.id), [project.id], ['deliveries']);
  const shown = res.data?.filter((d) =>
    status === 'all'
      ? true
      : status === 'unseen'
        ? d.status === 'pending'
        : d.status === 'delivered' || d.status === 'acked',
  );
  return (
    <Panel
      title="Updates for agents"
      count={shown?.length}
      noun="update"
      help="update"
      actions={
        <Segmented
          label="Show updates"
          value={status}
          onChange={setStatus}
          options={[
            { key: 'all', label: 'all' },
            { key: 'unseen', label: 'not seen yet' },
            { key: 'seen', label: 'seen' },
          ]}
        />
      }
    >
      <Loaded res={res}>
        {() =>
          !shown || shown.length === 0 ? (
            <Empty>
              {status === 'all'
                ? 'No updates yet. When one agent changes something another relies on, Mindly tells the other agent and it shows up here.'
                : status === 'unseen'
                  ? 'Every update has been seen by its agent.'
                  : 'No agent has seen an update yet.'}
            </Empty>
          ) : (
            <ul className="deliveries">
              {shown.map((d) => (
                <li key={d.id}>
                  <div className="row-line">
                    <Status value={d.status} label={deliveryStatusWords(d.status)} />
                    <Tag>{deliveryKindWords(d.kind)}</Tag>
                    <span className="grow">{humanizeAgentText(d.title)}</span>
                  </div>
                  <p className="muted small">
                    from{' '}
                    {d.sourceSessionId ? sessionName(sessions.get(d.sourceSessionId)) : 'Mindly'} to{' '}
                    {d.targetSessionId
                      ? sessionName(sessions.get(d.targetSessionId))
                      : `the next ${productName(d.targetAgentKind)} session`}{' '}
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
    <Panel title="Handoffs" count={res.data?.length} noun="handoff" help="handoff" id="handoffs">
      <Loaded res={res}>
        {(hs) =>
          hs.length === 0 ? (
            <Empty>
              No handoffs. When an agent stops in the middle of a task (for example because it hit
              its usage limit), its progress is packaged here for the next agent.
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
  const claimedBy = h.claimedBySessionId
    ? sessionName(sessions.get(h.claimedBySessionId))
    : undefined;
  return (
    <li className="handoff">
      <div className="row-line">
        <Status value={h.status} label={handoffStatusWords(h, claimedBy)} />
        <Tag tone={h.reason === 'manual' ? 'neutral' : 'warn'}>{handoffReasonWords(h.reason)}</Tag>
        <span className="grow handoff-title">{humanizeAgentText(h.summary)}</span>
        <Time ms={h.createdAt} />
      </div>
      <p className="muted small">
        from {sessionName(sessions.get(h.fromSessionId))} to{' '}
        {h.toAgentKind ? productName(h.toAgentKind) : 'any agent'}
        {p.branch && (
          <>
            {' '}
            · <Mono>{p.branch}</Mono>
          </>
        )}
        {p.headCommit && (
          <>
            {' '}
            at commit <Mono title={p.headCommit}>{p.headCommit.slice(0, 8)}</Mono>
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
          The next {h.toAgentKind ? productName(h.toAgentKind) : 'agent'} session started in this
          project picks this up automatically.
        </p>
      )}
    </li>
  );
}
