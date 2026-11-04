import { ActivityStream } from '../components/activity';
import { ShadowMergeResult } from '../components/runs';
import {
  Empty,
  Loaded,
  Mono,
  Panel,
  SeverityBadge,
  Status,
  Time,
  TrustBadge,
  cx,
} from '../components/ui';
import { agentName } from '../format';
import { useAction, useApp, useResource } from '../state';
import {
  CONFLICT_ACTIONS,
  TRUST_LEVELS,
  type Conflict,
  type Intent,
  type Overview,
  type Session,
  type Task,
} from '../types';

export function OverviewView() {
  const { client, project, events } = useApp();
  const res = useResource(
    () => client.overview(project.id),
    [project.id],
    ['overview', 'sessions', 'intents', 'conflicts', 'runs'],
  );
  return (
    <Loaded res={res}>
      {(ov) => (
        <div className="overview">
          <NeedsYou ov={ov} />
          <div className="grid-main">
            <div className="col">
              <Panel title="Agents" count={ov.sessions.length}>
                <AgentCards sessions={ov.sessions} tasks={ov.tasks} intents={ov.intents} />
              </Panel>
              <Panel title="Open conflicts" count={ov.conflicts.length}>
                <ConflictList conflicts={ov.conflicts} onChange={res.reload} />
              </Panel>
            </div>
            <div className="col">
              <ShadowMergePanel ov={ov} onQueued={res.reload} />
              <Panel title="Memory by trust">
                <ul className="trust-counts">
                  {TRUST_LEVELS.map((t) => (
                    <li key={t}>
                      <TrustBadge trust={t} />
                      <span className="trust-count">{ov.memoryCounts[t] ?? 0}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel title="Activity" className="panel-activity">
                <ActivityStream events={events} />
              </Panel>
            </div>
          </div>
        </div>
      )}
    </Loaded>
  );
}

function NeedsYou({ ov }: { ov: Overview }) {
  const { navigate } = useApp();
  const n = ov.needsYou;
  const items: { key: string; count: number; label: string; tone: string; go(): void }[] = [
    {
      key: 'rules',
      count: n.proposedRules,
      label: n.proposedRules === 1 ? 'proposed rule to review' : 'proposed rules to review',
      tone: 'warn',
      go: () => navigate('memory', { kind: 'rule', trust: 'proposed' }),
    },
    {
      key: 'mem',
      count: n.proposedMemories,
      label: n.proposedMemories === 1 ? 'proposed memory' : 'proposed memories',
      tone: 'warn',
      go: () => navigate('memory', { trust: 'proposed' }),
    },
    {
      key: 'crit',
      count: n.criticalConflicts,
      label: n.criticalConflicts === 1 ? 'critical conflict' : 'critical conflicts',
      tone: 'bad',
      go: () => document.getElementById('conflicts-list')?.focus(),
    },
    {
      key: 'hand',
      count: n.pendingHandoffs,
      label: n.pendingHandoffs === 1 ? 'unclaimed handoff' : 'unclaimed handoffs',
      tone: 'warn',
      go: () => navigate('coordination', { focus: 'handoffs' }),
    },
  ];
  const total = items.reduce((a, b) => a + b.count, 0);
  return (
    <section className={cx('needs', total === 0 && 'needs-clear')} aria-label="Needs you">
      <h2 className="needs-title">{total === 0 ? 'Nothing needs you' : 'Needs you'}</h2>
      <ul className="needs-items">
        {items.map((i) => (
          <li key={i.key}>
            <button
              type="button"
              className={cx('needs-item', i.count > 0 && `needs-${i.tone}`)}
              onClick={i.go}
              disabled={i.count === 0}
            >
              <span className="needs-count">{i.count}</span>
              <span className="needs-label">{i.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const AGENT_MARK: Record<string, string> = {
  'claude-code': 'CC',
  codex: 'CX',
  cursor: 'CU',
};

export function AgentMark({ kind }: { kind: string }) {
  return (
    <span className={cx('agent-mark', `agent-${kind}`)} aria-hidden="true">
      {AGENT_MARK[kind] ?? kind.slice(0, 2).toUpperCase()}
    </span>
  );
}

function AgentCards({
  sessions,
  tasks,
  intents,
}: {
  sessions: Session[];
  tasks: Task[];
  intents: Intent[];
}) {
  if (sessions.length === 0)
    return (
      <Empty>
        No agents active in the last 30 minutes. Start Claude Code, Codex or Cursor in this repo.
      </Empty>
    );
  return (
    <ul className="agents">
      {sessions.map((s) => {
        const task = tasks.find((t) => t.id === s.currentTaskId);
        const files = [
          ...new Set(intents.filter((i) => i.sessionId === s.id).flatMap((i) => i.targets.files)),
        ];
        const done = task?.plan.filter((p) => p.done).length ?? 0;
        return (
          <li key={s.id} className={cx('agent', `agent-status-${s.status}`)}>
            <div className="agent-head">
              <AgentMark kind={s.agentKind} />
              <div className="agent-id">
                <span className="agent-kind">{s.agentKind}</span>
                {s.label && <span className="agent-label">{s.label}</span>}
              </div>
              <Status value={s.status} />
            </div>
            <dl className="agent-meta">
              <div>
                <dt>Task</dt>
                <dd>
                  {task ? (
                    <>
                      {task.title}
                      {task.plan.length > 0 && (
                        <span className="muted">
                          {' '}
                          · {done}/{task.plan.length}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="muted">none</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Editing</dt>
                <dd className="file-list">
                  {files.length === 0 ? (
                    <span className="muted">nothing declared</span>
                  ) : (
                    files.map((f) => <Mono key={f}>{f}</Mono>)
                  )}
                </dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>
                  <Mono>{s.branch ?? 'detached'}</Mono>
                </dd>
              </div>
              <div>
                <dt>Seen</dt>
                <dd>
                  <Time ms={s.lastSeenAt} />
                </dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

export function ConflictList({ conflicts, onChange }: { conflicts: Conflict[]; onChange(): void }) {
  const { client, sessions } = useApp();
  const { busy, run } = useAction();
  if (conflicts.length === 0)
    return <Empty>No open conflicts. Agents are staying out of each other’s way.</Empty>;
  const sorted = [...conflicts].sort(
    (a, b) =>
      ({ critical: 0, warning: 1, info: 2 })[a.severity] -
      { critical: 0, warning: 1, info: 2 }[b.severity],
  );
  const labels = {
    acknowledged: 'Acknowledge',
    resolved: 'Resolve',
    dismissed: 'Dismiss',
  } as const;
  const done = {
    acknowledged: 'Acknowledged',
    resolved: 'Resolved',
    dismissed: 'Dismissed',
  } as const;
  return (
    <ul className="conflicts" id="conflicts-list" tabIndex={-1}>
      {sorted.map((c) => (
        <li key={c.id} className={cx('conflict', `sev-row-${c.severity}`)}>
          <div className="conflict-head">
            <SeverityBadge severity={c.severity} />
            <span className="conflict-title">{c.title}</span>
            {c.status !== 'open' && <Status value={c.status} />}
          </div>
          <p className="conflict-detail">{c.detail}</p>
          <div className="conflict-meta">
            <span className="tag">{c.kind.replace(/_/g, ' ')}</span>
            {c.paths.map((p) => (
              <Mono key={p}>{p}</Mono>
            ))}
            {c.sessionIds.map((id) => (
              <span key={id} className="muted">
                {agentName(sessions.get(id))}
              </span>
            ))}
            <Time ms={c.updatedAt} />
          </div>
          <div className="btn-row">
            {CONFLICT_ACTIONS.filter(
              (a) => !(a === 'acknowledged' && c.status === 'acknowledged'),
            ).map((a) => (
              <button
                key={a}
                type="button"
                className={cx('btn btn-small', a === 'resolved' && 'btn-primary')}
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    `${c.id}:${a}`,
                    () => client.setConflictStatus(c.id, a),
                    `${done[a]}: ${c.title}`,
                  ).then((ok) => ok && onChange())
                }
              >
                {busy === `${c.id}:${a}` ? '…' : labels[a]}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ShadowMergePanel({ ov, onQueued }: { ov: Overview; onQueued(): void }) {
  const { client, project, navigate } = useApp();
  const { busy, run } = useAction();
  const last = ov.lastShadowMerge;
  const running = last?.status === 'queued' || last?.status === 'running';
  return (
    <Panel
      title="Shadow merge"
      actions={
        <>
          {last && <Status value={last.status} />}
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={busy !== null || running}
            onClick={() =>
              void run('sm', () => client.shadowMerge(project.id), 'Shadow merge queued').then(
                (ok) => ok && onQueued(),
              )
            }
          >
            {running ? 'Running…' : 'Run now'}
          </button>
        </>
      }
    >
      {last ? (
        <>
          <p className="muted small">
            {last.title} · <Time ms={last.finishedAt ?? last.startedAt ?? last.createdAt} />{' '}
            <button
              type="button"
              className="link"
              onClick={() => navigate('runs', { run: last.id })}
            >
              details
            </button>
          </p>
          <ShadowMergeResult run={last} compact />
        </>
      ) : (
        <Empty>
          No shadow merge yet. Run one to merge every agent’s work and run the project’s checks.
        </Empty>
      )}
    </Panel>
  );
}
