import { useEffect, useState } from 'react';
import {
  Age,
  CopyId,
  DataTable,
  Empty,
  Facts,
  Loaded,
  Mono,
  Panel,
  Paths,
  Segmented,
  Status,
  type Column,
} from '../components/ui';
import { useApp, useResource } from '../state';
import type { Delivery, Handoff, Intent, Task, TaskStatus } from '../types';
import {
  COLUMNS,
  EMPTY,
  deliveryKindWords,
  deliveryStatusWords,
  handoffReasonWords,
  handoffStatusWords,
  humanizeAgentText,
  productName,
  progressWords,
  taskStatusWords,
} from '../vocab';
import { AgentName, ConflictsPanel, MergeCheckPanel } from './Overview';

const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  blocked: 1,
  open: 2,
  done: 3,
  abandoned: 4,
};

export function CoordinationView() {
  const { params, client, project } = useApp();
  useEffect(() => {
    if (params.get('focus') === 'handoffs') document.getElementById('handoffs')?.scrollIntoView();
  }, [params]);
  const ov = useResource(
    () => client.overview(project.id),
    [project.id],
    ['overview', 'conflicts', 'runs', 'sessions'],
  );
  return (
    <div className="view">
      <TasksPanel />
      <IntentsPanel />
      {ov.data && <ConflictsPanel ov={ov.data} onChange={ov.reload} />}
      <DeliveriesPanel />
      <HandoffsPanel />
      {ov.data && <MergeCheckPanel ov={ov.data} onQueued={ov.reload} />}
    </div>
  );
}

function TasksPanel() {
  const { client, project, sessions } = useApp();
  const res = useResource(() => client.tasks(project.id), [project.id], ['tasks']);
  const cols: Column<Task>[] = [
    {
      key: 'status',
      header: COLUMNS.status,
      cell: (t) => <Status value={t.status} label={taskStatusWords(t.status)} />,
    },
    {
      key: 'task',
      header: COLUMNS.task,
      kind: 'main',
      title: (t) => t.title,
      cell: (t) => t.title,
    },
    {
      key: 'owner',
      header: COLUMNS.owner,
      kind: 'clip',
      cell: (t) => {
        const s = t.ownerSessionId ? sessions.get(t.ownerSessionId) : undefined;
        return s ? <AgentName kind={s.agentKind} /> : <span className="muted">{'—'}</span>;
      },
    },
    {
      key: 'progress',
      header: COLUMNS.progress,
      kind: 'meta',
      cell: (t) =>
        progressWords(t.plan.filter((p) => p.done).length, t.plan.length) || (
          <span className="muted">{'—'}</span>
        ),
    },
    {
      key: 'updated',
      header: COLUMNS.updated,
      kind: 'meta',
      cell: (t) => <Age ms={t.updatedAt} />,
    },
  ];
  return (
    <Panel title="Tasks" help="tasks" meta={res.data ? String(res.data.length) : undefined}>
      <Loaded res={res}>
        {(tasks) =>
          tasks.length === 0 ? (
            <Empty>{EMPTY.tasks}</Empty>
          ) : (
            <DataTable
              label="Tasks"
              columns={cols}
              rows={[...tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])}
              rowKey={(t) => t.id}
              detail={(t) => (
                <Facts
                  items={[
                    [
                      'Plan',
                      t.plan.length > 0 && (
                        <ol className="steps">
                          {t.plan.map((p, i) => (
                            <li key={i} className={p.done ? 'step-done' : undefined}>
                              <span className="visually-hidden">
                                {p.done ? 'done: ' : 'to do: '}
                              </span>
                              {p.text}
                            </li>
                          ))}
                        </ol>
                      ),
                    ],
                    ['Blocked by', t.blockers.length > 0 && t.blockers.join('; ')],
                    ['Id', <CopyId key="id" id={t.id} label="task id" />],
                  ]}
                />
              )}
            />
          )
        }
      </Loaded>
    </Panel>
  );
}

function IntentsPanel() {
  const { client, project, sessions } = useApp();
  const res = useResource(() => client.intents(project.id), [project.id], ['intents']);
  const cols: Column<Intent>[] = [
    {
      key: 'agent',
      header: COLUMNS.agent,
      cell: (i) => <AgentName kind={sessions.get(i.sessionId)?.agentKind} />,
    },
    {
      key: 'edit',
      header: COLUMNS.edit,
      kind: 'main',
      title: (i) => humanizeAgentText(i.summary),
      cell: (i) => humanizeAgentText(i.summary),
    },
    {
      key: 'files',
      header: COLUMNS.files,
      kind: 'clip',
      cell: (i) => <Paths paths={i.targets.files} max={1} />,
    },
    {
      key: 'expires',
      header: COLUMNS.expires,
      kind: 'meta',
      cell: (i) => <ExpiresIn ms={i.expiresAt} />,
    },
  ];
  return (
    <Panel
      title="Who is editing what"
      help="intent"
      meta={res.data ? String(res.data.length) : undefined}
    >
      <Loaded res={res}>
        {(intents) =>
          intents.length === 0 ? (
            <Empty>{EMPTY.intents}</Empty>
          ) : (
            <DataTable
              label="Edits in progress"
              columns={cols}
              rows={intents}
              rowKey={(i) => i.id}
              detail={(i) => (
                <Facts
                  items={[
                    ['Files', <Paths key="f" paths={i.targets.files} max={Infinity} />],
                    [
                      'Symbols',
                      i.targets.symbols.length > 0 &&
                        i.targets.symbols.map((s) => `${s}()`).join(', '),
                    ],
                    ['Id', <CopyId key="id" id={i.id} label="intent id" />],
                  ]}
                />
              )}
            />
          )
        }
      </Loaded>
    </Panel>
  );
}

/** "in 12m" for expiry times. */
function ExpiresIn({ ms }: { ms: number | null }) {
  if (!ms) return <span className="muted">{'—'}</span>;
  const m = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  return <span>{m < 60 ? `in ${m}m` : `in ${Math.round(m / 60)}h`}</span>;
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
  const who = (sid: string | null, kind: string | null) => {
    const s = sid ? sessions.get(sid) : undefined;
    return s ? productName(s.agentKind) : kind ? productName(kind) : 'Mindly';
  };
  const cols: Column<Delivery>[] = [
    {
      key: 'status',
      header: COLUMNS.status,
      cell: (d) => <Status value={d.status} label={deliveryStatusWords(d.status)} />,
    },
    {
      key: 'update',
      header: COLUMNS.update,
      kind: 'main',
      title: (d) => humanizeAgentText(d.title),
      cell: (d) => humanizeAgentText(d.title),
    },
    {
      key: 'route',
      header: COLUMNS.route,
      kind: 'clip',
      cell: (d) => `${who(d.sourceSessionId, null)} → ${who(d.targetSessionId, d.targetAgentKind)}`,
    },
    { key: 'when', header: COLUMNS.when, kind: 'meta', cell: (d) => <Age ms={d.createdAt} /> },
  ];
  return (
    <Panel
      title="Updates for agents"
      help="update"
      meta={shown ? String(shown.length) : undefined}
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
                ? EMPTY.deliveries
                : status === 'unseen'
                  ? EMPTY.deliveriesUnseen
                  : EMPTY.deliveriesSeen}
            </Empty>
          ) : (
            <DataTable
              label="Updates for agents"
              columns={cols}
              rows={shown}
              rowKey={(d) => d.id}
              detail={(d) => (
                <Facts
                  items={[
                    ['About', deliveryKindWords(d.kind)],
                    ['Note', d.body && humanizeAgentText(d.body)],
                    ['Id', <CopyId key="id" id={d.id} label="update id" />],
                  ]}
                />
              )}
            />
          )
        }
      </Loaded>
    </Panel>
  );
}

function HandoffsPanel() {
  const { client, project, sessions } = useApp();
  const res = useResource(() => client.handoffs(project.id), [project.id], ['handoffs']);
  const cols: Column<Handoff>[] = [
    {
      key: 'status',
      header: COLUMNS.status,
      cell: (h) => (
        <Status
          value={h.status}
          label={
            h.status === 'pending'
              ? 'waiting'
              : handoffStatusWords(
                  h,
                  h.claimedBySessionId
                    ? productName(sessions.get(h.claimedBySessionId)?.agentKind)
                    : undefined,
                )
          }
        />
      ),
    },
    {
      key: 'handoff',
      header: COLUMNS.handoff,
      kind: 'main',
      title: (h) => humanizeAgentText(h.summary),
      cell: (h) => humanizeAgentText(h.summary),
    },
    {
      key: 'route',
      header: COLUMNS.route,
      kind: 'clip',
      cell: (h) =>
        `${productName(sessions.get(h.fromSessionId)?.agentKind)} → ${
          h.toAgentKind ? productName(h.toAgentKind) : 'any agent'
        }`,
    },
    { key: 'when', header: COLUMNS.when, kind: 'meta', cell: (h) => <Age ms={h.createdAt} /> },
  ];
  return (
    <Panel
      title="Handoffs"
      help="handoff"
      id="handoffs"
      meta={res.data ? String(res.data.length) : undefined}
    >
      <Loaded res={res}>
        {(hs) =>
          hs.length === 0 ? (
            <Empty>{EMPTY.handoffs}</Empty>
          ) : (
            <DataTable
              label="Handoffs"
              columns={cols}
              rows={hs}
              rowKey={(h) => h.id}
              detail={(h) => {
                const p = h.packet;
                return (
                  <Facts
                    items={[
                      ['Goal', p.goal],
                      [
                        'Next steps',
                        p.nextSteps.length > 0 && (
                          <ol className="steps">
                            {p.nextSteps.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ol>
                        ),
                      ],
                      ['Decisions', p.decisions.length > 0 && p.decisions.join('; ')],
                      [
                        'Files',
                        p.filesChanged.length > 0 && (
                          <Paths paths={p.filesChanged} max={Infinity} />
                        ),
                      ],
                      ['Why', handoffReasonWords(h.reason)],
                      [
                        'Branch',
                        p.branch && (
                          <>
                            <Mono>{p.branch}</Mono>
                            {p.headCommit && (
                              <span className="muted">
                                {' '}
                                at <Mono title={p.headCommit}>{p.headCommit.slice(0, 8)}</Mono>
                              </span>
                            )}
                          </>
                        ),
                      ],
                      ['Id', <CopyId key="id" id={h.id} label="handoff id" />],
                    ]}
                  />
                );
              }}
            />
          )
        }
      </Loaded>
    </Panel>
  );
}
