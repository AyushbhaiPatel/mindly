import { useEffect, useId, useState, type FormEvent } from 'react';
import { RunResult } from '../components/runs';
import {
  Age,
  CopyId,
  DataTable,
  Drawer,
  Empty,
  Facts,
  Loaded,
  Mono,
  Panel,
  Segmented,
  Status,
  TextLink,
  type Column,
} from '../components/ui';
import { duration, splitList } from '../format';
import {
  COLUMNS,
  EMPTY,
  humanizeAgentText,
  productName,
  runKindWords,
  runStatusWords,
  sessionName,
  sessionStatusWords,
} from '../vocab';
import { useAction, useApp, useResource } from '../state';
import type { Run, RunKind } from '../types';

const KNOWN_AGENTS = ['claude-code', 'codex', 'cursor'];

export function RunsView() {
  const { client, project, params, navigate } = useApp();
  const [kind, setKind] = useState<RunKind | 'all'>('all');
  const [dialog, setDialog] = useState<'review' | 'replay' | null>(null);
  const { busy, run } = useAction();
  const res = useResource(
    () => client.runs(project.id, kind === 'all' ? undefined : kind, 50),
    [project.id, kind],
    ['runs'],
  );
  const selectedId = params.get('run') ?? res.data?.[0]?.id ?? null;
  const selected = res.data?.find((r) => r.id === selectedId) ?? null;
  const cols: Column<Run>[] = [
    { key: 'kind', header: COLUMNS.kind, cell: (r) => runKindWords(r.kind) },
    {
      key: 'result',
      header: COLUMNS.result,
      cell: (r) => <Status value={r.status} label={runStatusWords(r.status)} />,
    },
    {
      key: 'what',
      header: COLUMNS.what,
      kind: 'main',
      title: (r) => humanizeAgentText(r.title),
      cell: (r) => humanizeAgentText(r.title),
    },
    { key: 'when', header: COLUMNS.when, kind: 'meta', cell: (r) => <Age ms={r.createdAt} /> },
  ];

  return (
    <div className="view">
      <Panel
        title="Runs"
        help="runs"
        actions={
          <>
            <TextLink onClick={() => setDialog('review')}>Start review</TextLink>
            <TextLink onClick={() => setDialog('replay')}>Start replay</TextLink>
            <button
              type="button"
              className="btn-primary"
              disabled={!!busy}
              onClick={() =>
                void run('sm', () => client.shadowMerge(project.id), 'Merge check started').then(
                  (ok) => ok && res.reload(),
                )
              }
            >
              Run merge check
            </button>
          </>
        }
      >
        <div className="filters">
          <Segmented
            label="Run kind"
            value={kind}
            onChange={setKind}
            options={[
              { key: 'all', label: 'all' },
              { key: 'shadow_merge', label: 'merge checks' },
              { key: 'review', label: 'reviews' },
              { key: 'replay', label: 'replays' },
            ]}
          />
        </div>
        <Loaded res={res}>
          {(runs) =>
            runs.length === 0 ? (
              <Empty>{EMPTY.runs}</Empty>
            ) : (
              <DataTable
                label="Runs"
                columns={cols}
                rows={runs}
                rowKey={(r) => r.id}
                onOpen={(r) => navigate('runs', { run: r.id })}
                isCurrent={(r) => r.id === selectedId}
              />
            )
          }
        </Loaded>
      </Panel>
      {selected && <RunDetail run={selected} />}
      <Drawer
        open={dialog === 'review'}
        onClose={() => setDialog(null)}
        title="Start a cross-agent review"
      >
        {dialog === 'review' && <ReviewForm onDone={() => (setDialog(null), res.reload())} />}
      </Drawer>
      <Drawer
        open={dialog === 'replay'}
        onClose={() => setDialog(null)}
        title="Start an A/B replay"
      >
        {dialog === 'replay' && <ReplayForm onDone={() => (setDialog(null), res.reload())} />}
      </Drawer>
    </div>
  );
}

function RunDetail({ run }: { run: Run }) {
  const { sessions } = useApp();
  const input = run.input;
  const sid = typeof input.sessionId === 'string' ? input.sessionId : null;
  const prompt = typeof input.prompt === 'string' ? input.prompt : null;
  const base = typeof input.baseCommit === 'string' ? input.baseCommit : null;
  return (
    <Panel
      title={humanizeAgentText(run.title)}
      className="run-detail"
      meta={<Status value={run.status} label={runStatusWords(run.status)} />}
    >
      <div className="detail-stack">
        <Facts
          items={[
            ['Kind', runKindWords(run.kind)],
            ['Started', <Age key="s" ms={run.startedAt ?? run.createdAt} />],
            [
              'Took',
              run.startedAt && run.finishedAt ? duration(run.finishedAt - run.startedAt) : null,
            ],
            ['Reviewed', sid && sessionName(sessions.get(sid))],
            ['Prompt', prompt && <q>{prompt}</q>],
            ['Base', base && <Mono>{base}</Mono>],
            ['Id', <CopyId key="id" id={run.id} label="run id" />],
          ]}
        />
        <RunResult run={run} />
      </div>
    </Panel>
  );
}

function ReviewForm({ onDone }: { onDone(): void }) {
  const { client, project } = useApp();
  const { busy, run } = useAction();
  const sres = useResource(() => client.sessions(project.id, 50), [project.id], ['sessions']);
  const [sessionId, setSessionId] = useState('');
  const [reviewer, setReviewer] = useState('codex');
  const id = useId();
  useEffect(() => {
    if (!sessionId && sres.data?.[0]) setSessionId(sres.data[0].id);
  }, [sres.data, sessionId]);
  const author = sres.data?.find((s) => s.id === sessionId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!sessionId || !reviewer) return;
    void run('review', () => client.review(project.id, sessionId, reviewer), 'Review queued').then(
      (ok) => ok && onDone(),
    );
  };
  return (
    <form className="form" onSubmit={submit}>
      <Loaded res={sres}>
        {(ss) => (
          <label className="field">
            <span>Session to review</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} required>
              {ss.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionName(s)} · {s.branch ?? 'no branch'} · {sessionStatusWords(s.status)}
                </option>
              ))}
            </select>
          </label>
        )}
      </Loaded>
      <label className="field">
        <span>Reviewer agent (for example codex)</span>
        <input
          list={`${id}-agents`}
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
          required
          pattern="[a-z][a-z0-9\-]{1,31}"
        />
        <datalist id={`${id}-agents`}>
          {KNOWN_AGENTS.map((a) => (
            <option key={a} value={a}>
              {productName(a)}
            </option>
          ))}
        </datalist>
      </label>
      {author && author.agentKind === reviewer && (
        <p className="help warn-text">
          Pick a different agent than the author for an independent review.
        </p>
      )}
      <p className="help">
        This launches the reviewer agent on this machine and may use its paid API quota.
      </p>
      <div className="action-row">
        <button type="submit" className="btn-primary" disabled={!!busy || !sessionId}>
          Start review
        </button>
        <button type="button" className="tlink" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReplayForm({ onDone }: { onDone(): void }) {
  const { client, project } = useApp();
  const { busy, run } = useAction();
  const fid = useId();
  const [prompt, setPrompt] = useState('');
  const [base, setBase] = useState('');
  const [agents, setAgents] = useState<string[]>(['claude-code', 'codex']);
  const [extra, setExtra] = useState('');
  const all = [...new Set([...agents, ...splitList(extra)])];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || all.length === 0) return;
    void run(
      'replay',
      () =>
        client.replay(project.id, {
          prompt: prompt.trim(),
          agents: all,
          ...(base.trim() ? { baseCommit: base.trim() } : {}),
        }),
      'Replay queued',
    ).then((ok) => ok && onDone());
  };
  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Prompt</span>
        <textarea
          required
          rows={4}
          maxLength={4000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Add cursor pagination to GET /invoices"
        />
      </label>
      <label className="field">
        <span>Base commit (optional)</span>
        <input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="HEAD"
          pattern="[0-9A-Za-z._\/\-]{0,100}"
        />
      </label>
      <fieldset className="fieldset">
        <legend>Agents</legend>
        {KNOWN_AGENTS.map((a) => (
          <div key={a} className="check-field">
            <input
              id={`${fid}-${a}`}
              type="checkbox"
              checked={agents.includes(a)}
              onChange={(e) =>
                setAgents((xs) => (e.target.checked ? [...xs, a] : xs.filter((x) => x !== a)))
              }
            />
            <label htmlFor={`${fid}-${a}`}>{productName(a)}</label>
          </div>
        ))}
        <label className="field">
          <span>Other agents (ids such as gemini-cli)</span>
          <input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="comma separated"
          />
        </label>
      </fieldset>
      <p className="help">
        This launches {all.length} agent run{all.length === 1 ? '' : 's'} on this machine and may
        use paid API quota.
      </p>
      <div className="action-row">
        <button
          type="submit"
          className="btn-primary"
          disabled={!!busy || !prompt.trim() || all.length === 0}
        >
          Start replay
        </button>
        <button type="button" className="tlink" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
