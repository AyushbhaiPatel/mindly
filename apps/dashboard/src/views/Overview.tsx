import { useState, type ReactNode } from 'react';
import { ActivityStream } from '../components/activity';
import { ChecksTable } from '../components/runs';
import { SavesPanel } from '../components/saves';
import {
  Age,
  CodeText,
  CopyId,
  DataTable,
  Dot,
  DotWord,
  Empty,
  Facts,
  Loaded,
  Mono,
  Panel,
  Paths,
  SeverityMark,
  StatRow,
  TextLink,
  statusTone,
  type Column,
  type MenuItem,
} from '../components/ui';
import { readShadowMerge } from '../format';
import { useAction, useApp, useResource } from '../state';
import {
  CONFLICT_ACTIONS,
  type Conflict,
  type Handoff,
  type Intent,
  type Memory,
  type Overview,
  type Session,
  type Task,
} from '../types';
import {
  COLUMNS,
  EMPTY,
  conflictActionWords,
  conflictAgents,
  conflictHeadline,
  conflictStatusWords,
  conflictWhat,
  humanizeAgentText,
  memorySummary,
  needActionWords,
  needKindWords,
  overviewStats,
  productName,
  progressWords,
  runStatusWords,
  sessionStatusWords,
  shortId,
  sourceWords,
  type NeedKind,
} from '../vocab';

export function OverviewView() {
  const { client, project, events } = useApp();
  const res = useResource(
    () => client.overview(project.id),
    [project.id],
    ['overview', 'sessions', 'intents', 'conflicts', 'runs'],
  );
  const waiting = useResource(
    () =>
      Promise.all([
        client.memories(project.id, { trust: 'proposed', status: 'active', limit: 20 }),
        client.handoffs(project.id),
      ]),
    [project.id],
    ['memories', 'handoffs'],
  );
  const saves = useResource(() => client.saves(project.id), [project.id], ['saves']);
  return (
    <Loaded res={res}>
      {(ov) => (
        <div className="overview view">
          <Stats ov={ov} saves={saves.data?.summary.total} />
          <NeedsYou
            ov={ov}
            memories={waiting.data?.[0] ?? []}
            handoffs={(waiting.data?.[1] ?? []).filter((h) => h.status === 'pending')}
            onChange={res.reload}
          />
          <Panel title="Agents" help="agents">
            <AgentsTable sessions={ov.sessions} tasks={ov.tasks} intents={ov.intents} />
          </Panel>
          <Panel
            title="Conflicts"
            help="conflict"
            meta={ov.conflicts.length > 0 ? `${ov.conflicts.length} open` : undefined}
          >
            <ConflictTable conflicts={ov.conflicts} onChange={res.reload} />
          </Panel>
          <SavesPanel res={saves.data} onChange={saves.reload} />
          <MergeCheckPanel ov={ov} onQueued={res.reload} />
          <MemoryLine ov={ov} />
          <ActivityPanel events={events} />
        </div>
      )}
    </Loaded>
  );
}

function needsTotal(ov: Overview): number {
  const n = ov.needsYou;
  return n.proposedRules + n.proposedMemories + n.openConflicts + n.pendingHandoffs;
}

function Stats({ ov, saves }: { ov: Overview; saves: number | undefined }) {
  const last = ov.lastShadowMerge;
  return (
    <StatRow
      stats={overviewStats({
        sessions: ov.sessions,
        needsYou: needsTotal(ov),
        ...(saves !== undefined ? { saves } : {}),
        lastMergeCheck: last
          ? { status: last.status, at: last.finishedAt ?? last.startedAt ?? last.createdAt }
          : null,
      })}
    />
  );
}

interface NeedItem {
  key: string;
  kind: NeedKind;
  tone: 'warn' | 'bad';
  text: ReactNode;
  action: ReactNode;
}

const quoted = (s: string) => `“${s}”`;

function NeedsYou({
  ov,
  memories,
  handoffs,
  onChange,
}: {
  ov: Overview;
  memories: Memory[];
  handoffs: Handoff[];
  onChange(): void;
}) {
  const { navigate, sessions, client } = useApp();
  const { busy, run } = useAction();
  const items: NeedItem[] = [];

  for (const c of ov.conflicts.filter((x) => x.status === 'open' && x.severity !== 'info')) {
    items.push({
      key: `c:${c.id}`,
      kind: 'conflict',
      tone: c.severity === 'critical' ? 'bad' : 'warn',
      text: <CodeText text={conflictHeadline(c, sessions)} />,
      action: (
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null}
          aria-label={`Resolve conflict ${shortId(c.id)}`}
          onClick={() =>
            void run(
              `${c.id}:resolved`,
              () => client.setConflictStatus(c.id, 'resolved'),
              'Conflict marked resolved',
            ).then((ok) => ok && onChange())
          }
        >
          {needActionWords('conflict')}
        </button>
      ),
    });
  }
  for (const m of memories) {
    const kind: NeedKind = m.kind === 'rule' ? 'rule' : 'memory';
    items.push({
      key: `m:${m.id}`,
      kind,
      tone: 'warn',
      text: (
        <>
          {quoted(m.title)}
          <span className="muted">
            {' '}
            {'—'} from {sourceWords(m.source, sessions)}
          </span>
        </>
      ),
      action: (
        <button
          type="button"
          className="btn-primary"
          aria-label={`Review ${kind}: ${m.title}`}
          onClick={() => navigate('memory', { trust: 'proposed', m: m.id })}
        >
          {needActionWords(kind)}
        </button>
      ),
    });
  }
  for (const h of handoffs) {
    items.push({
      key: `h:${h.id}`,
      kind: 'handoff',
      tone: 'warn',
      text: (
        <>
          {quoted(humanizeAgentText(h.packet.goal || h.summary))}
          <span className="muted">
            {' → '}
            {h.toAgentKind ? productName(h.toAgentKind) : 'any agent'}
          </span>
        </>
      ),
      action: (
        <TextLink go onClick={() => navigate('coordination', { focus: 'handoffs' })}>
          {needActionWords('handoff')}
        </TextLink>
      ),
    });
  }

  return (
    <Panel
      title="Needs you"
      help="needsYou"
      meta={items.length > 0 ? String(items.length) : undefined}
      className="needs"
    >
      {items.length === 0 ? (
        <Empty>{EMPTY.needsYou}</Empty>
      ) : (
        <ul className="needs-list">
          {items.map((i) => (
            <li key={i.key} className="need">
              <Dot tone={i.tone} />
              <span className="need-kind">{needKindWords(i.kind)}</span>
              <span className="need-text">{i.text}</span>
              <span className="need-action">{i.action}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The agent's stable colour dot (Claude Code violet, Codex blue, Cursor pink, others grey).
 * Decorative: the agent's name is always written next to it.
 */
export function AgentMark({ kind }: { kind: string }) {
  return <Dot agent={kind} />;
}

/** Agent name with its colour dot. */
export function AgentName({ kind }: { kind: string | null | undefined }) {
  return (
    <span className="dot-word">
      <Dot agent={kind ?? 'other'} />
      <span>{productName(kind)}</span>
    </span>
  );
}

interface AgentRow {
  s: Session;
  task: Task | undefined;
  files: string[];
}

function AgentsTable({
  sessions,
  tasks,
  intents,
}: {
  sessions: Session[];
  tasks: Task[];
  intents: Intent[];
}) {
  if (sessions.length === 0) return <Empty>{EMPTY.agents}</Empty>;
  const rows: AgentRow[] = sessions.map((s) => ({
    s,
    task: tasks.find((t) => t.id === s.currentTaskId),
    files: [
      ...new Set(intents.filter((i) => i.sessionId === s.id).flatMap((i) => i.targets.files)),
    ],
  }));
  const cols: Column<AgentRow>[] = [
    { key: 'agent', header: COLUMNS.agent, cell: (r) => <AgentName kind={r.s.agentKind} /> },
    {
      key: 'task',
      header: COLUMNS.task,
      kind: 'main',
      title: (r) => r.task?.title,
      cell: (r) =>
        r.task ? (
          <>
            {r.task.title}
            <span className="muted num">
              {' '}
              {progressWords(r.task.plan.filter((p) => p.done).length, r.task.plan.length)}
            </span>
          </>
        ) : (
          <span className="muted">{'—'}</span>
        ),
    },
    {
      key: 'editing',
      header: COLUMNS.editing,
      kind: 'clip',
      cell: (r) => <Paths paths={r.files} max={1} />,
    },
    {
      key: 'active',
      header: COLUMNS.active,
      kind: 'meta',
      cell: (r) =>
        r.s.status === 'active' ? (
          <Age ms={r.s.lastSeenAt} />
        ) : (
          <>
            {sessionStatusWords(r.s.status)} {'·'} <Age ms={r.s.lastSeenAt} />
          </>
        ),
    },
  ];
  return (
    <DataTable
      label="Agents"
      columns={cols}
      rows={rows}
      rowKey={(r) => r.s.id}
      detail={(r) => (
        <Facts
          items={[
            ['Status', sessionStatusWords(r.s.status)],
            ['Branch', r.s.branch ? <Mono>{r.s.branch}</Mono> : 'no branch'],
            ['Label', r.s.label],
            [
              'Plan',
              r.task && r.task.plan.length > 0 && (
                <ol className="steps">
                  {r.task.plan.map((p, i) => (
                    <li key={i} className={p.done ? 'step-done' : undefined}>
                      <span className="visually-hidden">{p.done ? 'done: ' : 'to do: '}</span>
                      {p.text}
                    </li>
                  ))}
                </ol>
              ),
            ],
            ['Editing', r.files.length > 0 && <Paths paths={r.files} max={Infinity} />],
            ['Session', <CopyId key="id" id={r.s.id} label="session id" />],
          ]}
        />
      )}
    />
  );
}

const SEV_RANK = { critical: 0, warning: 1, info: 2 } as const;

export function ConflictTable({
  conflicts,
  onChange,
}: {
  conflicts: Conflict[];
  onChange(): void;
}) {
  const { client, sessions } = useApp();
  const { busy, run } = useAction();
  if (conflicts.length === 0) return <Empty>{EMPTY.conflicts}</Empty>;
  const sorted = [...conflicts].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const cols: Column<Conflict>[] = [
    {
      key: 'sev',
      header: COLUMNS.severity,
      cell: (c) => (
        <>
          <SeverityMark severity={c.severity} />
          {c.status !== 'open' && (
            <span className="muted">
              {' '}
              {'·'} {conflictStatusWords(c.status)}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'what',
      header: COLUMNS.what,
      kind: 'main',
      title: (c) => conflictWhat(c, sessions).replace(/`/g, ''),
      cell: (c) => <CodeText text={conflictWhat(c, sessions)} />,
    },
    {
      key: 'agents',
      header: COLUMNS.agents,
      kind: 'clip',
      cell: (c) => conflictAgents(c, sessions),
    },
    { key: 'age', header: COLUMNS.age, kind: 'meta', cell: (c) => <Age ms={c.createdAt} /> },
  ];
  const menu = (c: Conflict): MenuItem[] =>
    [...CONFLICT_ACTIONS]
      .sort((a, b) => (a === 'resolved' ? -1 : b === 'resolved' ? 1 : 0))
      .filter((a) => !(a === 'acknowledged' && c.status === 'acknowledged'))
      .map((a) => ({
        label: conflictActionWords(a),
        danger: a === 'dismissed',
        disabled: busy !== null,
        onSelect: () =>
          void run(
            `${c.id}:${a}`,
            () => client.setConflictStatus(c.id, a),
            `Conflict marked ${conflictStatusWords(a)}`,
          ).then((ok) => ok && onChange()),
      }));
  return (
    <DataTable
      label="Conflicts"
      columns={cols}
      rows={sorted}
      rowKey={(c) => c.id}
      menu={menu}
      menuLabel={(c) => `Actions for conflict ${shortId(c.id)}`}
      detail={(c) => (
        <div className="detail-stack">
          <p className="detail-text">
            <CodeText text={humanizeAgentText(c.detail)} />
          </p>
          <Facts
            items={[
              ['Files', <Paths key="p" paths={c.paths} max={Infinity} />],
              ['Updated', <Age key="u" ms={c.updatedAt} />],
              ['Id', <CopyId key="id" id={c.id} label="conflict id" />],
            ]}
          />
        </div>
      )}
    />
  );
}

function MergeCheckPanel({ ov, onQueued }: { ov: Overview; onQueued(): void }) {
  const { client, project, navigate } = useApp();
  const { busy, run } = useAction();
  const last = ov.lastShadowMerge;
  const running = last?.status === 'queued' || last?.status === 'running';
  const result = last ? readShadowMerge(last) : null;
  return (
    <Panel
      title="Merge check"
      help="mergeCheck"
      meta={
        last ? (
          <>
            <DotWord tone={statusTone(last.status)}>{runStatusWords(last.status)}</DotWord>
            {' · '}
            <Age ms={last.finishedAt ?? last.startedAt ?? last.createdAt} />
          </>
        ) : undefined
      }
      actions={
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null || running}
          onClick={() =>
            void run('sm', () => client.shadowMerge(project.id), 'Merge check started').then(
              (ok) => ok && onQueued(),
            )
          }
        >
          {running ? 'Running…' : last ? 'Run again' : 'Run merge check'}
        </button>
      }
    >
      {!last || !result ? (
        <Empty>{EMPTY.mergeCheck}</Empty>
      ) : (
        <div className="detail-stack">
          {last.result ? (
            <ChecksTable checks={result.checks} />
          ) : (
            <Empty>{last.status === 'queued' ? EMPTY.runWaiting : EMPTY.runRunning}</Empty>
          )}
          <p className="line-meta">
            <span className="muted">overlapping changes: </span>
            {result.conflictedPaths.length === 0 ? (
              <span className="muted">none</span>
            ) : (
              <Paths paths={result.conflictedPaths} max={3} />
            )}
            <span className="grow" />
            <TextLink go onClick={() => navigate('runs', { run: last.id })}>
              Details
            </TextLink>
          </p>
        </div>
      )}
    </Panel>
  );
}

function MemoryLine({ ov }: { ov: Overview }) {
  const { navigate } = useApp();
  const parts = memorySummary(ov.memoryCounts);
  return (
    <Panel
      title="Memory"
      help="trust"
      actions={
        <TextLink go onClick={() => navigate('memory')}>
          Open memory
        </TextLink>
      }
    >
      {parts.length === 0 ? (
        <Empty>{EMPTY.memory}</Empty>
      ) : (
        <p className="summary-line">
          {parts.map((p, i) => (
            <span key={p.trust} className="summary-part">
              {i > 0 && (
                <span className="summary-sep" aria-hidden="true">
                  {'·'}
                </span>
              )}
              <button
                type="button"
                className="num-link"
                onClick={() => navigate('memory', { trust: p.trust })}
              >
                <span className="num-link-n">{p.n}</span> {p.text}
              </button>
            </span>
          ))}
        </p>
      )}
    </Panel>
  );
}

function ActivityPanel({ events }: { events: Parameters<typeof ActivityStream>[0]['events'] }) {
  const [all, setAll] = useState(false);
  return (
    <Panel
      title="Activity"
      actions={
        events.length > 8 ? (
          <TextLink onClick={() => setAll((v) => !v)} expanded={all}>
            {all ? 'Show fewer' : 'Show all'}
          </TextLink>
        ) : undefined
      }
    >
      <ActivityStream events={events} limit={all ? 60 : 8} />
    </Panel>
  );
}
