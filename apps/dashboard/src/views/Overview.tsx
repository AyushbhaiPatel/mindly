import type { ReactNode } from 'react';
import { ActivityStream } from '../components/activity';
import { ShadowMergeResult } from '../components/runs';
import {
  CodeText,
  Empty,
  Help,
  Loaded,
  Mono,
  Panel,
  SeverityBadge,
  ShortId,
  Status,
  Time,
  TrustBadge,
  cx,
} from '../components/ui';
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
import {
  conflictActionWords,
  conflictHeadline,
  conflictStatusWords,
  count,
  humanizeAgentText,
  isAllQuiet,
  productName,
  runStatusWords,
  sessionName,
  sessionStatusWords,
  shortId,
  summaryLine,
} from '../vocab';

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
          <SummaryBar ov={ov} />
          <NeedsYou ov={ov} onChange={res.reload} />
          <div className="grid-main">
            <div className="col">
              <Panel title="Agents" count={ov.sessions.length} noun="agent">
                <AgentCards sessions={ov.sessions} tasks={ov.tasks} intents={ov.intents} />
              </Panel>
              <Panel
                title="Open conflicts"
                count={ov.conflicts.length}
                noun="conflict"
                help="conflict"
              >
                <ConflictList conflicts={ov.conflicts} onChange={res.reload} />
              </Panel>
            </div>
            <div className="col">
              <ShadowMergePanel ov={ov} onQueued={res.reload} />
              <MemoryCounts ov={ov} />
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

function needsTotal(ov: Overview): number {
  const n = ov.needsYou;
  return n.proposedRules + n.proposedMemories + n.criticalConflicts + n.pendingHandoffs;
}

function SummaryBar({ ov }: { ov: Overview }) {
  const last = ov.lastShadowMerge;
  const input = {
    sessions: ov.sessions,
    needsYou: needsTotal(ov),
    lastMergeCheck: last
      ? { status: last.status, at: last.finishedAt ?? last.startedAt ?? last.createdAt }
      : null,
  };
  const quiet = isAllQuiet(input);
  return (
    <p className={cx('summary-bar', input.needsYou > 0 && 'summary-attn')} role="status">
      <span className="summary-project">{ov.project.name}</span>
      <span aria-hidden="true" className="summary-sep">
        {'·'}
      </span>
      <span>
        {quiet ? 'All quiet. No agents are running and nothing needs you.' : summaryLine(input)}
      </span>
    </p>
  );
}

interface NeedItem {
  key: string;
  tone: 'warn' | 'bad';
  text: ReactNode;
  actions: ReactNode;
}

function NeedsYou({ ov, onChange }: { ov: Overview; onChange(): void }) {
  const { navigate, sessions, client } = useApp();
  const { busy, run } = useAction();
  const n = ov.needsYou;
  const items: NeedItem[] = [];

  const urgent = ov.conflicts.filter((c) => c.severity === 'critical' && c.status === 'open');
  for (const c of urgent) {
    items.push({
      key: `c:${c.id}`,
      tone: 'bad',
      text: (
        <>
          <strong>Urgent conflict:</strong> <CodeText text={conflictHeadline(c, sessions)} />.
          Decide which change wins, then mark it resolved.
        </>
      ),
      actions: (
        <>
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={busy !== null}
            onClick={() =>
              void run(
                `${c.id}:resolved`,
                () => client.setConflictStatus(c.id, 'resolved'),
                'Conflict marked resolved',
              ).then((ok) => ok && onChange())
            }
          >
            Mark resolved
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => document.getElementById(`conflict-${c.id}`)?.focus()}
          >
            See details
          </button>
        </>
      ),
    });
  }
  // The overview counts urgent conflicts too; cover any the list above did not include.
  const missingUrgent = n.criticalConflicts - urgent.length;
  if (missingUrgent > 0) {
    items.push({
      key: 'crit',
      tone: 'bad',
      text: (
        <>
          <strong>{count(missingUrgent, 'urgent conflict')}</strong> between agents{' '}
          {missingUrgent === 1 ? 'needs' : 'need'} a decision.
        </>
      ),
      actions: (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => document.getElementById('conflicts-list')?.focus()}
        >
          See conflicts
        </button>
      ),
    });
  }
  if (n.proposedRules > 0) {
    items.push({
      key: 'rules',
      tone: 'warn',
      text: (
        <>
          <strong>{count(n.proposedRules, 'suggested rule')}</strong>{' '}
          {n.proposedRules === 1 ? 'is' : 'are'} waiting for you. Approved rules apply to every
          agent.
        </>
      ),
      actions: (
        <button
          type="button"
          className="btn btn-small btn-primary"
          onClick={() => navigate('memory', { kind: 'rule', trust: 'proposed' })}
        >
          Review {n.proposedRules === 1 ? 'rule' : 'rules'}
        </button>
      ),
    });
  }
  if (n.proposedMemories > 0) {
    items.push({
      key: 'mem',
      tone: 'warn',
      text: (
        <>
          <strong>{count(n.proposedMemories, 'suggested memory', 'suggested memories')}</strong>{' '}
          {n.proposedMemories === 1 ? 'is' : 'are'} waiting for you. Until you approve them, agents
          treat them as hints only.
        </>
      ),
      actions: (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => navigate('memory', { trust: 'proposed' })}
        >
          Review {n.proposedMemories === 1 ? 'memory' : 'memories'}
        </button>
      ),
    });
  }
  if (n.pendingHandoffs > 0) {
    items.push({
      key: 'hand',
      tone: 'warn',
      text: (
        <>
          <strong>{count(n.pendingHandoffs, 'handoff')}</strong>{' '}
          {n.pendingHandoffs === 1 ? 'is' : 'are'} waiting to be picked up. Start the agent it is
          meant for in this project and it continues where the last one stopped.
        </>
      ),
      actions: (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => navigate('coordination', { focus: 'handoffs' })}
        >
          See {n.pendingHandoffs === 1 ? 'handoff' : 'handoffs'}
        </button>
      ),
    });
  }

  return (
    <section
      className={cx('needs', items.length === 0 && 'needs-clear')}
      aria-labelledby="needs-title"
    >
      <h2 className="needs-title" id="needs-title">
        Needs you
      </h2>
      {items.length === 0 ? (
        <p className="needs-none">
          Nothing needs you right now. Suggested memories, urgent conflicts and handoffs will show
          up here.
        </p>
      ) : (
        <ul className="needs-items">
          {items.map((i) => (
            <li key={i.key} className={cx('needs-item', `needs-${i.tone}`)}>
              <span className="needs-mark" aria-hidden="true">
                {i.tone === 'bad' ? '✗' : '!'}
              </span>
              <p className="needs-text">{i.text}</p>
              <div className="needs-actions">{i.actions}</div>
            </li>
          ))}
        </ul>
      )}
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
        No agents have been active in the last 30 minutes. Start Claude Code, Codex or Cursor in
        this repository and it appears here within a few seconds.
      </Empty>
    );
  let helpShown = false;
  return (
    <ul className="agents">
      {sessions.map((s) => {
        const task = tasks.find((t) => t.id === s.currentTaskId);
        const files = [
          ...new Set(intents.filter((i) => i.sessionId === s.id).flatMap((i) => i.targets.files)),
        ];
        const done = task?.plan.filter((p) => p.done).length ?? 0;
        const showHelp = files.length > 0 && !helpShown;
        if (showHelp) helpShown = true;
        return (
          <li key={s.id} className={cx('agent', `agent-status-${s.status}`)}>
            <div className="agent-head">
              <AgentMark kind={s.agentKind} />
              <div className="agent-id">
                <span className="agent-kind">
                  {productName(s.agentKind)}
                  <span className="agent-sep" aria-hidden="true">
                    {' · '}
                  </span>
                  <ShortId id={s.id} label="session id" />
                </span>
                {s.label && <span className="agent-label">{s.label}</span>}
              </div>
              <Status value={s.status} label={sessionStatusWords(s.status)} />
            </div>
            <ul className="agent-lines">
              <li>
                {task ? (
                  <>
                    <span className="muted">working on</span> {task.title}
                    {task.plan.length > 0 && (
                      <span className="muted">
                        {' '}
                        ({done} of {count(task.plan.length, 'step')} done)
                      </span>
                    )}
                  </>
                ) : (
                  <span className="muted">no task recorded</span>
                )}
              </li>
              <li className="file-list">
                {files.length === 0 ? (
                  <span className="muted">not editing anything right now</span>
                ) : (
                  <>
                    <span className="muted">editing</span>
                    {files.map((f) => (
                      <Mono key={f}>{f}</Mono>
                    ))}
                    {showHelp && <Help term="intent" />}
                  </>
                )}
              </li>
              <li>
                <span className="muted">on branch</span> <Mono>{s.branch ?? 'no branch'}</Mono>
              </li>
              <li>
                <span className="muted">
                  <Time ms={s.lastSeenAt} prefix="last active" />
                </span>
              </li>
            </ul>
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
    return (
      <Empty>
        No open conflicts. If two agents edit the same code or one breaks something another relies
        on, it shows up here.
      </Empty>
    );
  const sorted = [...conflicts].sort(
    (a, b) =>
      ({ critical: 0, warning: 1, info: 2 })[a.severity] -
      { critical: 0, warning: 1, info: 2 }[b.severity],
  );
  return (
    <ul className="conflicts" id="conflicts-list" tabIndex={-1}>
      {sorted.map((c) => (
        <li
          key={c.id}
          id={`conflict-${c.id}`}
          tabIndex={-1}
          className={cx('conflict', `sev-row-${c.severity}`)}
        >
          <div className="conflict-head">
            <SeverityBadge severity={c.severity} />
            <span className="conflict-title">
              <CodeText text={conflictHeadline(c, sessions)} />
            </span>
            {c.status !== 'open' && (
              <Status value={c.status} label={conflictStatusWords(c.status)} />
            )}
          </div>
          <p className="conflict-detail">
            <CodeText text={humanizeAgentText(c.detail)} />
          </p>
          <div className="conflict-meta">
            {c.paths.map((p) => (
              <Mono key={p}>{p}</Mono>
            ))}
            {c.sessionIds.length > 0 && (
              <span className="muted">
                involves {c.sessionIds.map((id) => sessionName(sessions.get(id))).join(', ')}
              </span>
            )}
            <span className="muted">
              <Time ms={c.updatedAt} prefix="updated" />
            </span>
            <ShortId id={c.id} label="conflict id" />
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
                aria-label={`${conflictActionWords(a)}: conflict ${shortId(c.id)}`}
                onClick={() =>
                  void run(
                    `${c.id}:${a}`,
                    () => client.setConflictStatus(c.id, a),
                    `Conflict marked ${conflictStatusWords(a)}`,
                  ).then((ok) => ok && onChange())
                }
              >
                {busy === `${c.id}:${a}` ? '…' : conflictActionWords(a)}
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
      title="Merge check"
      help="mergeCheck"
      actions={
        <>
          {last && <Status value={last.status} label={runStatusWords(last.status)} />}
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={busy !== null || running}
            onClick={() =>
              void run('sm', () => client.shadowMerge(project.id), 'Merge check started').then(
                (ok) => ok && onQueued(),
              )
            }
          >
            {running ? 'Running…' : 'Run merge check'}
          </button>
        </>
      }
    >
      {last ? (
        <>
          <p className="muted small">
            <CodeText text={humanizeAgentText(last.title)} /> {'·'}{' '}
            <Time ms={last.finishedAt ?? last.startedAt ?? last.createdAt} />{' '}
            <button
              type="button"
              className="link"
              onClick={() => navigate('runs', { run: last.id })}
            >
              full details
            </button>
          </p>
          <ShadowMergeResult run={last} compact />
        </>
      ) : (
        <Empty>
          No merge check yet. Run one to combine every agent&rsquo;s work in a scratch copy and run
          the project&rsquo;s checks. Your branches are not touched.
        </Empty>
      )}
    </Panel>
  );
}

function MemoryCounts({ ov }: { ov: Overview }) {
  const { navigate } = useApp();
  const total = TRUST_LEVELS.reduce((a, t) => a + (ov.memoryCounts[t] ?? 0), 0);
  return (
    <Panel title="Memory" count={total} noun="memory" plural="memories" help="trust">
      {total === 0 ? (
        <Empty>
          No memories yet. Agents suggest rules, decisions and known pitfalls as they work; you
          approve them in Memory.
        </Empty>
      ) : (
        <ul className="trust-counts">
          {TRUST_LEVELS.filter((t) => (ov.memoryCounts[t] ?? 0) > 0).map((t) => (
            <li key={t}>
              <button
                type="button"
                className="trust-count-btn"
                onClick={() => navigate('memory', { trust: t })}
              >
                <span className="trust-count">{ov.memoryCounts[t] ?? 0}</span>
                <TrustBadge trust={t} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
