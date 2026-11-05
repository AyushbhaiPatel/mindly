import { ShadowMergeResult } from '../components/runs';
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
  Status,
  type Column,
} from '../components/ui';
import { useApp, useResource } from '../state';
import type { Split, SplitContractItem, SplitDetail, SplitPartDetail } from '../types';
import {
  COLUMNS,
  EMPTY,
  count,
  humanizeAgentText,
  productName,
  runStatusWords,
  splitPartStateWords,
  splitStatusWords,
} from '../vocab';
import { AgentName } from './Overview';

/** The project's current split: its parts, the shared contract and the latest merge check. */
export function SplitView() {
  const { client, project } = useApp();
  const list = useResource(() => client.splits(project.id), [project.id], ['splits']);
  const current = list.data?.[0] ?? null;
  return (
    <div className="view">
      <Loaded res={list}>
        {() => (current ? <SplitPanels split={current} /> : <Empty>{EMPTY.split}</Empty>)}
      </Loaded>
    </div>
  );
}

function SplitPanels({ split }: { split: Split }) {
  const { client } = useApp();
  const res = useResource(
    () => client.split(split.id),
    [split.id, split.updatedAt],
    ['splits', 'tasks', 'sessions', 'conflicts', 'runs'],
  );
  return (
    <Loaded res={res}>
      {(d) => (
        <>
          <PartsPanel d={d} />
          <ContractPanel contract={d.contract} />
          <MergeCheckPanel d={d} />
        </>
      )}
    </Loaded>
  );
}

function PartsPanel({ d }: { d: SplitDetail }) {
  const done = d.parts.filter((p) => p.state === 'done').length;
  const cols: Column<SplitPartDetail>[] = [
    {
      key: 'state',
      header: COLUMNS.status,
      cell: (p) => <Status value={p.state} label={splitPartStateWords(p.state)} />,
    },
    {
      key: 'part',
      header: COLUMNS.task,
      kind: 'main',
      title: (p) => p.part.title,
      cell: (p) => `${p.part.position + 1}. ${p.part.title}`,
    },
    {
      key: 'agent',
      header: COLUMNS.agent,
      kind: 'clip',
      cell: (p) => <AgentName kind={p.session?.agentKind ?? p.part.agentKind} />,
    },
    {
      key: 'owns',
      header: COLUMNS.files,
      kind: 'clip',
      cell: (p) => <Paths paths={p.part.owns} />,
    },
    {
      key: 'changed',
      header: COLUMNS.progress,
      kind: 'meta',
      cell: (p) =>
        p.filesChanged.length > 0 ? (
          count(p.filesChanged.length, 'file')
        ) : (
          <span className="muted">{'—'}</span>
        ),
    },
    {
      key: 'active',
      header: COLUMNS.active,
      kind: 'meta',
      cell: (p) =>
        p.lastActivityAt === null ? (
          <span className="muted">{'—'}</span>
        ) : (
          <Age ms={p.lastActivityAt} />
        ),
    },
  ];
  const s = d.split;
  return (
    <Panel
      title={humanizeAgentText(s.goal)}
      help="split"
      meta={
        <>
          <Status value={s.status} label={splitStatusWords(s.status)} />
          {s.status === 'active' && ` · ${done}/${d.parts.length} parts done`}
          {s.strict && ' · strict'}
        </>
      }
    >
      <DataTable
        label="Parts"
        columns={cols}
        rows={d.parts}
        rowKey={(p) => p.part.id}
        detail={(p) => (
          <Facts
            items={[
              ['Brief', p.part.brief && <p>{humanizeAgentText(p.part.brief)}</p>],
              ['Owns', <Paths paths={p.part.owns} max={Infinity} />],
              ['Reads', p.part.reads.length > 0 && <Paths paths={p.part.reads} max={Infinity} />],
              [
                'Depends on',
                p.part.dependsOn.length > 0 &&
                  p.part.dependsOn
                    .map((k) => d.parts.find((q) => q.part.key === k)?.part.title ?? k)
                    .join(', '),
              ],
              ['Branch', <Mono>{p.part.branch}</Mono>],
              ['Worktree', <Mono title={p.part.worktree}>{p.part.worktree}</Mono>],
              [
                'Changed',
                p.filesChanged.length > 0 ? (
                  <Paths paths={p.filesChanged} max={Infinity} />
                ) : (
                  <span className="muted">{EMPTY.splitFiles}</span>
                ),
              ],
              [
                'Conflicts',
                p.conflicts.length > 0 && (
                  <ul className="steps">
                    {p.conflicts.map((c) => (
                      <li key={c.id}>{humanizeAgentText(c.title)}</li>
                    ))}
                  </ul>
                ),
              ],
              ['Task', <CopyId id={p.task.id} label="task id" />],
            ]}
          />
        )}
      />
      <p className="line-meta">
        <span className="muted">base: </span>
        <Mono>{s.baseCommit.slice(0, 10)}</Mono>
        {s.baseBranch && (
          <>
            <span className="muted">{' on '}</span>
            <Mono>{s.baseBranch}</Mono>
          </>
        )}
        {s.integrationBranch && (
          <>
            <span className="muted">{' · merged into '}</span>
            <Mono>{s.integrationBranch}</Mono>
          </>
        )}
        <span className="muted">{' · planned by '}</span>
        {s.plannedBy === 'plan-file' ? 'you' : productName(s.plannedBy)}
        <span className="muted">{' · started '}</span>
        <Age ms={s.createdAt} />
      </p>
    </Panel>
  );
}

function ContractPanel({ contract }: { contract: SplitContractItem[] }) {
  const cols: Column<SplitContractItem>[] = [
    {
      key: 'name',
      header: COLUMNS.item,
      kind: 'main',
      title: (c) => c.name,
      cell: (c) => <code className="mono">{c.name}</code>,
    },
    { key: 'owner', header: COLUMNS.owner, kind: 'clip', cell: (c) => c.owner },
  ];
  return (
    <Panel title="Contract" meta={contract.length > 0 ? String(contract.length) : undefined}>
      {contract.length === 0 ? (
        <Empty>{EMPTY.splitContract}</Empty>
      ) : (
        <DataTable
          label="Contract"
          columns={cols}
          rows={contract}
          rowKey={(c) => c.memoryId ?? c.name}
          detail={(c) => (
            <Facts
              items={[
                ['Definition', <p>{humanizeAgentText(c.definition)}</p>],
                ['Memory', c.memoryId && <CopyId id={c.memoryId} label="memory id" />],
              ]}
            />
          )}
        />
      )}
    </Panel>
  );
}

function MergeCheckPanel({ d }: { d: SplitDetail }) {
  const run = d.mergeCheck;
  return (
    <Panel
      title="Merge check"
      help="mergeCheck"
      meta={run ? <Status value={run.status} label={runStatusWords(run.status)} /> : undefined}
    >
      {run ? (
        <>
          <ShadowMergeResult run={run} />
          <p className="line-meta">
            <span className="muted">checked </span>
            <Age ms={run.finishedAt ?? run.createdAt} />
          </p>
        </>
      ) : (
        <Empty>{EMPTY.mergeCheck}</Empty>
      )}
    </Panel>
  );
}
