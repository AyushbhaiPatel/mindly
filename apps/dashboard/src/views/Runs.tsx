import { useEffect, useId, useState, type FormEvent } from 'react';
import { RunResult } from '../components/runs';
import { Drawer, Empty, Loaded, Mono, Panel, Segmented, Status, Time, cx } from '../components/ui';
import { agentName, duration, runKindLabel, splitList } from '../format';
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

  return (
    <div className="view">
      <Panel
        title="Runs"
        count={res.data?.length}
        actions={
          <>
            <Segmented
              label="Run kind"
              value={kind}
              onChange={setKind}
              options={[
                { key: 'all', label: 'all' },
                { key: 'shadow_merge', label: 'shadow merge' },
                { key: 'review', label: 'review' },
                { key: 'replay', label: 'replay' },
              ]}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={!!busy}
              onClick={() =>
                void run('sm', () => client.shadowMerge(project.id), 'Shadow merge queued').then(
                  (ok) => ok && res.reload(),
                )
              }
            >
              Shadow merge
            </button>
            <button type="button" className="btn btn-small" onClick={() => setDialog('review')}>
              Start review
            </button>
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => setDialog('replay')}
            >
              Start replay
            </button>
          </>
        }
      >
        <Loaded res={res}>
          {(runs) =>
            runs.length === 0 ? (
              <Empty>
                No runs yet. Shadow merges run in the background; reviews and replays start from
                here.
              </Empty>
            ) : (
              <div className="split">
                <ul className="run-list" aria-label="Runs">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className={cx('run-row', r.id === selectedId && 'is-open')}
                        aria-current={r.id === selectedId}
                        onClick={() => navigate('runs', { run: r.id })}
                      >
                        <span className="run-row-top">
                          <Status value={r.status} />
                          <span className="tag">{runKindLabel(r.kind)}</span>
                          <Time ms={r.createdAt} />
                        </span>
                        <span className="run-title">{r.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="run-detail">
                  {selected ? <RunDetail run={selected} /> : <Empty>Select a run.</Empty>}
                </div>
              </div>
            )
          }
        </Loaded>
      </Panel>
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
    <article className="stack" aria-label={run.title}>
      <header>
        <h3 className="detail-title">{run.title}</h3>
        <p className="muted small">
          {runKindLabel(run.kind)} · <Status value={run.status} /> · queued{' '}
          <Time ms={run.createdAt} />
          {run.startedAt && run.finishedAt && (
            <> · took {duration(run.finishedAt - run.startedAt)}</>
          )}{' '}
          · <Mono>{run.id}</Mono>
        </p>
        {sid && <p className="small">Reviewed session: {agentName(sessions.get(sid))}</p>}
        {prompt && (
          <p className="small">
            Prompt: <q>{prompt}</q>
            {base && (
              <>
                {' '}
                at <Mono>{base}</Mono>
              </>
            )}
          </p>
        )}
      </header>
      <RunResult run={run} />
    </article>
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
      <p className="help">
        A different agent reads the session’s diff headlessly and reports findings by severity.
      </p>
      <Loaded res={sres}>
        {(ss) => (
          <label className="field">
            <span>Session to review</span>
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} required>
              {ss.map((s) => (
                <option key={s.id} value={s.id}>
                  {agentName(s)} · {s.branch ?? 'detached'} · {s.status}
                </option>
              ))}
            </select>
          </label>
        )}
      </Loaded>
      <label className="field">
        <span>Reviewer agent</span>
        <input
          list={`${id}-agents`}
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
          required
          pattern="[a-z][a-z0-9\-]{1,31}"
        />
        <datalist id={`${id}-agents`}>
          {KNOWN_AGENTS.map((a) => (
            <option key={a} value={a} />
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
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={!!busy || !sessionId}>
          Start review
        </button>
        <button type="button" className="btn" onClick={onDone}>
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
      <p className="help">
        Each agent gets the same prompt in its own isolated worktree at the same commit; results are
        compared side by side.
      </p>
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
            <label htmlFor={`${fid}-${a}`}>{a}</label>
          </div>
        ))}
        <label className="field">
          <span>Other agent kinds</span>
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
      <div className="btn-row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!!busy || !prompt.trim() || all.length === 0}
        >
          Start replay
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
