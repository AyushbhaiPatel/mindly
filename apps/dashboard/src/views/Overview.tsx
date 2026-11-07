import { ChecksTable } from '../components/runs';
import {
  Age,
  CodeText,
  CopyId,
  DataTable,
  Dot,
  DotWord,
  Empty,
  Facts,
  Panel,
  Paths,
  SeverityMark,
  TextLink,
  statusTone,
  type Column,
  type MenuItem,
} from '../components/ui';
import { readShadowMerge } from '../format';
import { useAction, useApp } from '../state';
import { CONFLICT_ACTIONS, type Conflict, type Overview } from '../types';
import {
  COLUMNS,
  EMPTY,
  INTRO,
  conflictActionWords,
  conflictAgents,
  conflictStatusWords,
  conflictWhat,
  humanizeAgentText,
  productName,
  runStatusWords,
  shortId,
} from '../vocab';

/*
 * Pieces shared by several pages: the agent name with its colour dot, the conflicts table and
 * the merge-check panel. The Home page itself lives in Home.tsx.
 */

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

/** Open and recently closed conflicts of the project, with the actions on each. */
export function ConflictsPanel({ ov, onChange }: { ov: Overview; onChange(): void }) {
  return (
    <Panel
      title="Conflicts"
      intro={INTRO.conflicts}
      meta={ov.conflicts.length > 0 ? `${ov.conflicts.length} open` : undefined}
    >
      <ConflictTable conflicts={ov.conflicts} onChange={onChange} />
    </Panel>
  );
}

export function MergeCheckPanel({ ov, onQueued }: { ov: Overview; onQueued(): void }) {
  const { client, project, navigate } = useApp();
  const { busy, run } = useAction();
  const last = ov.lastShadowMerge;
  const running = last?.status === 'queued' || last?.status === 'running';
  const result = last ? readShadowMerge(last) : null;
  return (
    <Panel
      title="Merge check"
      intro={INTRO.mergeCheck}
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
