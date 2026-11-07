import { useState, type ReactNode } from 'react';
import { ActivityStream } from '../components/activity';
import { SavesPanel } from '../components/saves';
import {
  Age,
  CodeText,
  Dot,
  Empty,
  Loaded,
  Mono,
  Panel,
  TextLink,
  cx,
  useNow,
} from '../components/ui';
import { useAction, useApp, useResource, type Resource } from '../state';
import type {
  Handoff,
  Intent,
  Memory,
  MemoryKind,
  MindlyEvent,
  Overview,
  Session,
  Task,
} from '../types';
import {
  INTRO,
  agentDoingWords,
  conflictHeadline,
  count,
  homeSentence,
  humanizeAgentText,
  memoryKindPlural,
  needGroupWhy,
  needGroupWords,
  productName,
  sessionStatusWords,
  shortId,
  sourceWords,
} from '../vocab';

/**
 * Home: one sentence that says how the project is doing, the agents at work, the decisions only
 * the user can make, what Mindly prevented, and the latest activity. Every section says in plain
 * words what it shows; nothing needs the docs.
 */
export function HomeView() {
  const { client, project, events, eventsLoaded } = useApp();
  const res = useResource(
    () => client.overview(project.id),
    [project.id],
    ['overview', 'sessions', 'intents', 'conflicts', 'runs', 'splits', 'tasks'],
  );
  const waiting = useResource(
    () =>
      Promise.all([
        // Only for samples and which kinds are waiting; the counts come from `ov.needsYou`.
        client.memories(project.id, { trust: 'proposed', status: 'active', limit: 200 }),
        client.handoffs(project.id),
      ]),
    [project.id],
    ['memories', 'handoffs'],
  );
  const saves = useResource(() => client.saves(project.id), [project.id], ['saves']);
  return (
    <Loaded res={res}>
      {(ov) => {
        const quiet = isFirstRun(
          ov,
          eventsLoaded && !events.some((e) => e.projectId === project.id),
        );
        return (
          <div className="home view">
            <Pulse ov={ov} decisions={decisionCount(ov)} saves={saves.data?.summary.total} />
            {quiet && <GettingStarted />}
            <AgentsNow
              sessions={ov.sessions}
              tasks={ov.tasks}
              intents={ov.intents}
              events={events}
            />
            <Decisions ov={ov} waiting={waiting} onChange={res.reload} />
            <SavesPanel
              res={saves.data}
              onChange={saves.reload}
              title="Where Mindly helped"
              intro={INTRO.helped}
            />
            <RecentActivity events={events} />
          </div>
        );
      }}
    </Loaded>
  );
}

/** What waits for the user, as the server counts it (not capped by the samples Home fetches). */
function decisionCount(ov: Overview): number {
  const n = ov.needsYou;
  return (
    n.openConflicts +
    n.proposedRules +
    n.proposedMemories +
    n.pendingHandoffs +
    n.blockedParts +
    n.failedMergeChecks
  );
}

/**
 * True when nothing was ever recorded for this project. `lastSeq` is the highest event number
 * across all projects, so 0 means nothing happened anywhere. Otherwise the overview only describes
 * the current state (agents of the last 30 minutes, open work, active memories), so a project that
 * worked yesterday looks empty too: it also takes `noEvents`, true only once the project's event
 * backlog has loaded and holds nothing. While that list loads, or when it fails, this says no.
 */
function isFirstRun(ov: Overview, noEvents: boolean): boolean {
  if (ov.lastSeq === 0) return true;
  return (
    noEvents &&
    ov.sessions.length === 0 &&
    ov.tasks.length === 0 &&
    ov.conflicts.length === 0 &&
    Object.values(ov.memoryCounts).every((n) => n === 0) &&
    ov.lastShadowMerge === null &&
    ov.split === null &&
    ov.pendingDeliveries === 0
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The one sentence, with three numbers that matter                                           */
/* ------------------------------------------------------------------------------------------ */

function Pulse({
  ov,
  decisions,
  saves,
}: {
  ov: Overview;
  decisions: number;
  saves: number | undefined;
}) {
  const by = (st: Session['status']) => ov.sessions.filter((s) => s.status === st).length;
  const working = by('active');
  const conflicts = ov.conflicts.filter((c) => c.status === 'open' && c.severity !== 'info').length;
  const sentence = homeSentence({
    working,
    idle: by('idle'),
    limited: by('rate_limited'),
    decisions,
    conflicts,
    splitProblems: ov.needsYou.blockedParts + ov.needsYou.failedMergeChecks,
    savesWeek: saves,
  });
  const figures: { n: number; label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }[] = [
    { n: working, label: working === 1 ? 'agent working' : 'agents working', tone: 'good' },
    {
      n: decisions,
      label: decisions === 1 ? 'decision waits for you' : 'decisions wait for you',
      tone: decisions > 0 ? 'warn' : 'neutral',
    },
    {
      n: saves ?? 0,
      label: saves === 1 ? 'time Mindly helped this week' : 'times Mindly helped this week',
      tone: saves ? 'good' : 'neutral',
    },
  ];
  return (
    <section className="headline" aria-label="Summary">
      <p className="headline-text">{sentence}</p>
      <dl className="figures">
        {figures.map((f) => (
          <div key={f.label} className={cx('figure', `figure-${f.tone}`)}>
            <dt>{f.label}</dt>
            <dd>{f.n}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* First run                                                                                   */
/* ------------------------------------------------------------------------------------------ */

function GettingStarted() {
  return (
    <Panel
      title="Nothing has happened here yet"
      intro="Mindly listens to your agents through their own hooks. Three steps and this page fills itself."
      className="start"
    >
      <ol className="start-steps">
        <li>
          <strong>Connect your agents</strong>
          <span>
            In this folder, run <Mono>mindly init</Mono>. It shows every change before writing it.
          </span>
        </li>
        <li>
          <strong>Restart them</strong>
          <span>
            Agents read their hooks when they start. Open Claude Code, Codex, Cursor or Gemini CLI
            again in this folder.
          </span>
        </li>
        <li>
          <strong>Work as usual</strong>
          <span>
            Agents appear above within seconds. Rules you tell one agent reach all of them; a change
            one makes warns the others before they build on it.
          </span>
        </li>
      </ol>
    </Panel>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Agents right now: one card each                                                             */
/* ------------------------------------------------------------------------------------------ */

function lastEditOf(sessionId: string, events: MindlyEvent[]): { path: string; at: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.sessionId !== sessionId || e.type !== 'file.changed') continue;
    const p = e.payload as Record<string, unknown>;
    const paths = Array.isArray(p.paths)
      ? p.paths.filter((x): x is string => typeof x === 'string')
      : [];
    const path = typeof p.path === 'string' ? p.path : paths[0];
    if (path) return { path, at: e.createdAt };
  }
  return null;
}

function AgentsNow({
  sessions,
  tasks,
  intents,
  events,
}: {
  sessions: Session[];
  tasks: Task[];
  intents: Intent[];
  events: MindlyEvent[];
}) {
  const now = useNow();
  const ORDER: Record<Session['status'], number> = {
    active: 0,
    rate_limited: 1,
    idle: 2,
    ended: 3,
  };
  const sorted = [...sessions].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.lastSeenAt - a.lastSeenAt,
  );
  return (
    <Panel
      title="Agents right now"
      help="agents"
      intro={INTRO.agentsNow}
      meta={sessions.length > 0 ? count(sessions.length, 'agent') : undefined}
    >
      {sorted.length === 0 ? (
        <Empty>
          No agent is working in this folder right now. Start Claude Code, Codex, Cursor or Gemini
          CLI here and it appears within seconds.
        </Empty>
      ) : (
        <ul className="agent-cards">
          {sorted.map((s) => {
            const task = tasks.find((t) => t.id === s.currentTaskId);
            const editing = [
              ...new Set(
                intents.filter((i) => i.sessionId === s.id).flatMap((i) => i.targets.files),
              ),
            ];
            const doing = agentDoingWords({
              status: s.status,
              editing,
              lastEdit: lastEditOf(s.id, events),
              lastSeenAt: s.lastSeenAt,
              now,
            });
            return (
              <li key={s.id} className={cx('agent-card', `is-${s.status}`)}>
                <div className="agent-card-head">
                  <span className="dot-word">
                    <Dot agent={s.agentKind} />
                    <strong>{productName(s.agentKind)}</strong>
                  </span>
                  <span className={cx('agent-state', `state-${s.status}`)}>
                    {sessionStatusWords(s.status)}
                  </span>
                </div>
                <p className="agent-doing">
                  <CodeText
                    text={doing.replace(/((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.\w{1,6})/g, '`$1`')}
                  />
                </p>
                {task && (
                  <p className="agent-task" title={task.title}>
                    Task: {humanizeAgentText(task.title)}
                  </p>
                )}
                <p className="agent-meta">
                  {s.branch ? <Mono>{s.branch}</Mono> : 'no branch'}
                  <span className="sep" aria-hidden="true">
                    {' · '}
                  </span>
                  <span className="muted">
                    seen <Age ms={s.lastSeenAt} />
                  </span>
                  <span className="sep" aria-hidden="true">
                    {' · '}
                  </span>
                  <span className="muted">{shortId(s.id)}</span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Decisions only the user can make                                                            */
/* ------------------------------------------------------------------------------------------ */

const quoted = (s: string) => `“${s}”`;

function Decisions({
  ov,
  waiting,
  onChange,
}: {
  ov: Overview;
  /** Suggested memories (for samples) and handoffs (for rows); undefined until they load. */
  waiting: Resource<[Memory[], Handoff[]]>;
  onChange(): void;
}) {
  const { navigate, sessions, client } = useApp();
  const { busy, run } = useAction();
  const conflicts = ov.conflicts.filter((c) => c.status === 'open' && c.severity !== 'info');
  const memories = waiting.data?.[0];
  // Same rule as the overview's `needsYou.pendingHandoffs`: split parts are handled on the split
  // page, not here. Empty when the request failed, so the count row below covers them all.
  const handoffs =
    waiting.data?.[1].filter((h) => h.status === 'pending' && !h.packet.split) ??
    (waiting.error ? [] : undefined);
  const total = decisionCount(ov);

  const rows: ReactNode[] = [];

  for (const c of conflicts) {
    rows.push(
      <li key={`c:${c.id}`} className="decision">
        <Dot tone={c.severity === 'critical' ? 'bad' : 'warn'} />
        <div className="decision-body">
          <p className="decision-text">
            <CodeText text={conflictHeadline(c, sessions)} />
          </p>
          <p className="decision-why">
            {c.severity === 'critical'
              ? 'Something is broken right now. Fix it, then mark the conflict resolved.'
              : 'Check that the two changes still fit together, then mark it resolved.'}
          </p>
        </div>
        <span className="decision-action">
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
            Mark resolved
          </button>
        </span>
      </li>,
    );
  }

  const group = (kind: 'rule' | 'memory', pending: number, items: Memory[] | undefined) => {
    if (pending === 0) return;
    const shown = items?.slice(0, 3) ?? [];
    // The Memory page filters by one kind; suggested memories of several kinds get one link each.
    // Which kinds wait is only known once the samples load, so until then the button is disabled.
    const kinds: MemoryKind[] =
      kind === 'rule' ? ['rule'] : [...new Set((items ?? []).map((m) => m.kind))];
    const ready = kind === 'rule' || items !== undefined;
    rows.push(
      <li key={`g:${kind}`} className="decision">
        <Dot tone="warn" />
        <div className="decision-body">
          <p className="decision-text">{needGroupWords(kind, pending)}</p>
          <p className="decision-why">{needGroupWhy(kind)}</p>
          <ul className="decision-samples">
            {shown.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="sample-link"
                  onClick={() => navigate('memory', { trust: 'proposed', m: m.id })}
                >
                  {quoted(m.title)}
                </button>
                <span className="muted"> from {sourceWords(m.source, sessions)}</span>
              </li>
            ))}
            {shown.length > 0 && pending > shown.length && (
              <li className="muted">and {pending - shown.length} more</li>
            )}
          </ul>
        </div>
        <span className="decision-action">
          {kinds.length > 1 ? (
            <span className="decision-links">
              {kinds.map((k) => (
                <TextLink
                  key={k}
                  go
                  onClick={() => navigate('memory', { trust: 'proposed', kind: k })}
                >
                  Review {memoryKindPlural(k)}
                </TextLink>
              ))}
            </span>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={!ready}
              onClick={() =>
                navigate(
                  'memory',
                  kinds[0] ? { trust: 'proposed', kind: kinds[0] } : { trust: 'proposed' },
                )
              }
            >
              Review {pending === 1 ? 'it' : 'all'}
            </button>
          )}
        </span>
      </li>,
    );
  };
  group(
    'rule',
    ov.needsYou.proposedRules,
    memories?.filter((m) => m.kind === 'rule'),
  );
  group(
    'memory',
    ov.needsYou.proposedMemories,
    memories?.filter((m) => m.kind !== 'rule'),
  );

  if (ov.split) {
    for (const p of ov.split.blockedParts) {
      rows.push(
        <li key={`sp:${p.key}`} className="decision">
          <Dot tone="bad" />
          <div className="decision-body">
            <p className="decision-text">
              Split part {quoted(humanizeAgentText(p.title))} is blocked
            </p>
            <p className="decision-why">
              Its agent could not continue. Open the split to see what it is waiting for.
            </p>
          </div>
          <span className="decision-action">
            <TextLink go onClick={() => navigate('split')}>
              Open split
            </TextLink>
          </span>
        </li>,
      );
    }
    const check = ov.split.mergeCheck;
    if (check && (check.status === 'failed' || check.status === 'error')) {
      rows.push(
        <li key={`sc:${check.runId}`} className="decision">
          <Dot tone="bad" />
          <div className="decision-body">
            <p className="decision-text">
              {check.status === 'failed'
                ? "The split's parts don't merge cleanly or fail your checks"
                : "The split's merge check could not run"}
            </p>
            <p className="decision-why">
              {check.conflictedPaths.length > 0
                ? `Conflicts in ${check.conflictedPaths.slice(0, 3).join(', ')}.`
                : 'Nothing was merged. Open the split for the details.'}
            </p>
          </div>
          <span className="decision-action">
            <TextLink go onClick={() => navigate('split')}>
              Open split
            </TextLink>
          </span>
        </li>,
      );
    }
  }

  for (const h of handoffs ?? []) {
    rows.push(
      <li key={`h:${h.id}`} className="decision">
        <Dot tone="warn" />
        <div className="decision-body">
          <p className="decision-text">
            Unfinished work waits for {h.toAgentKind ? productName(h.toAgentKind) : 'any agent'}:{' '}
            {quoted(humanizeAgentText(h.packet.goal || h.summary))}
          </p>
          <p className="decision-why">
            Start that agent in this folder and it picks the work up with the goal, plan and files.
          </p>
        </div>
        <span className="decision-action">
          <TextLink go onClick={() => navigate('coordination', { focus: 'handoffs' })}>
            Details
          </TextLink>
        </span>
      </li>,
    );
  }

  // Home lists the newest handoffs only; the rest are one row, so the rows add up to the count.
  const moreHandoffs = handoffs ? ov.needsYou.pendingHandoffs - handoffs.length : 0;
  if (moreHandoffs > 0) {
    const waits = moreHandoffs === 1 ? 'waits' : 'wait';
    rows.push(
      <li key="h:more" className="decision">
        <Dot tone="warn" />
        <div className="decision-body">
          <p className="decision-text">
            {handoffs!.length > 0
              ? `${count(moreHandoffs, 'more handoff')} ${waits} for an agent`
              : `${count(moreHandoffs, 'handoff')} ${waits} for an agent`}
          </p>
          <p className="decision-why">
            Unfinished work an agent packaged up. Start the agent it names in this folder and it
            picks the work up.
          </p>
        </div>
        <span className="decision-action">
          <TextLink go onClick={() => navigate('coordination', { focus: 'handoffs' })}>
            Details
          </TextLink>
        </span>
      </li>,
    );
  }

  return (
    <Panel
      title="Needs your decision"
      help="needsYou"
      intro={INTRO.decisions}
      meta={total > 0 ? String(total) : undefined}
      className="needs"
    >
      {rows.length > 0 && <ul className="decisions">{rows}</ul>}
      {waiting.data === undefined ? (
        <Loaded res={waiting}>{() => null}</Loaded>
      ) : (
        rows.length === 0 && (
          <Empty>
            Nothing waits for you. Agents keep working; Mindly asks when a choice is yours.
          </Empty>
        )
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Activity                                                                                    */
/* ------------------------------------------------------------------------------------------ */

function RecentActivity({ events }: { events: MindlyEvent[] }) {
  const [all, setAll] = useState(false);
  return (
    <Panel
      title="Recent activity"
      intro={INTRO.activity}
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
