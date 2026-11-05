import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createHttpClient, describeError, takeLoginCode, type MindlyClient } from './api';
import { Tabs, cx, type TabDef } from './components/ui';
import {
  createLiveFeed,
  topicsFor,
  type LiveFactory,
  type LiveFeed,
  type LiveStatus,
  type Topic,
} from './live';
import { AppContext, type AppState, type Toast } from './state';
import { applyTheme, loadString, loadTheme, nextTheme, saveString, type ThemePref } from './theme';
import type { Project, Session, MindlyEvent } from './types';
import { CoordinationView } from './views/Coordination';
import { InsightView } from './views/Insight';
import { MemoryView } from './views/Memory';
import { OverviewView } from './views/Overview';
import { RunsView } from './views/Runs';
import { SettingsView } from './views/Settings';

type TabKey = 'overview' | 'memory' | 'coordination' | 'runs' | 'insight' | 'settings';
const TABS: TabDef<TabKey>[] = [
  { key: 'overview', label: 'Mission Control' },
  { key: 'memory', label: 'Memory' },
  { key: 'coordination', label: 'Coordination' },
  { key: 'runs', label: 'Runs' },
  { key: 'insight', label: 'Insight' },
  { key: 'settings', label: 'Trust & settings' },
];
const TAB_KEYS = new Set<string>(TABS.map((t) => t.key));

const MOCK = import.meta.env.VITE_MINDLY_MOCK === '1';
const PROJECT_KEY = 'mindly.project';
const MAX_EVENTS = 400;

interface Route {
  tab: TabKey;
  params: URLSearchParams;
}

function readRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  const tab = TAB_KEYS.has(path) ? (path as TabKey) : 'overview';
  return { tab, params: new URLSearchParams(query) };
}

function writeRoute(tab: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams(params).toString();
  const next = `#/${tab}${q ? `?${q}` : ''}`;
  if (location.hash !== next) location.hash = next;
}

type Boot =
  | { state: 'loading' }
  | { state: 'unauth'; reason: string | null }
  | { state: 'error'; message: string }
  | { state: 'ready'; client: MindlyClient; live: LiveFactory; projects: Project[] };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });

  const start = useCallback(async () => {
    setBoot({ state: 'loading' });
    let client: MindlyClient;
    let live: LiveFactory = createLiveFeed;
    if (MOCK) {
      const mock = await import('./mock');
      client = mock.createMockClient();
      live = mock.createMockLiveFeed;
    } else {
      client = createHttpClient();
    }
    const code = takeLoginCode();
    if (code) {
      try {
        await client.exchangeLogin(code);
      } catch (e) {
        setBoot({
          state: 'unauth',
          reason:
            e instanceof ApiError && e.code !== 'network'
              ? 'That login link has expired or was already used. Links work once, for 60 seconds.'
              : describeError(e),
        });
        return;
      }
    }
    try {
      const projects = await client.projects();
      setBoot({ state: 'ready', client, live, projects });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setBoot({ state: 'unauth', reason: null });
      else setBoot({ state: 'error', message: describeError(e) });
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  if (boot.state === 'loading') {
    return (
      <div className="splash" role="status">
        <Sky />
        <Logo />
        <p>Connecting to the Mindly daemon…</p>
      </div>
    );
  }
  if (boot.state === 'unauth') {
    return (
      <main className="splash">
        <Sky />
        <Logo />
        <h1>
          Sign in from your <em>terminal</em>
        </h1>
        {boot.reason && <p className="splash-warn">{boot.reason}</p>}
        <p>Mission Control opens with a one-time link. In the project you want to watch, run:</p>
        <pre className="splash-cmd">mindly dashboard</pre>
        <p className="muted">
          The link signs this browser in for 12 hours. Nothing is sent anywhere except this
          machine’s Mindly daemon.
        </p>
      </main>
    );
  }
  if (boot.state === 'error') {
    return (
      <main className="splash">
        <Sky />
        <Logo />
        <h1>
          Can’t reach the <em>daemon</em>
        </h1>
        <p>{boot.message}</p>
        <p className="muted">
          Start it with <code className="mono">mindly daemon</code> or reopen with{' '}
          <code className="mono">mindly dashboard</code>.
        </p>
        <button type="button" className="btn-primary" onClick={() => void start()}>
          Try again
        </button>
      </main>
    );
  }
  if (boot.projects.length === 0) {
    return (
      <main className="splash">
        <Sky />
        <Logo />
        <h1>
          No projects <em>yet</em>
        </h1>
        <p>
          Run <code className="mono">mindly init</code> inside a git repository, then start an agent
          there. It will show up here.
        </p>
      </main>
    );
  }
  return <Shell client={boot.client} liveFactory={boot.live} projects={boot.projects} />;
}

/** The product mark: a lowercase wordmark in Newsreader, like the portfolio's name mark. */
function Logo() {
  return <span className="logo">mindly</span>;
}

/**
 * The portfolio's sky: a fixed, decorative layer (gradient, one wide glow, blurred cloud bands)
 * behind every page. Purely visual, hidden from assistive technology.
 */
function Sky() {
  return (
    <div className="sky" aria-hidden="true">
      <i className="sky-glow" />
      <i className="sky-band b1" />
      <i className="sky-band b2" />
      <i className="sky-band b3" />
    </div>
  );
}

/** Page titles in Newsreader; the last word is set in italic, like the portfolio's name. */
const TITLES: Record<TabKey, readonly [lead: string, accent: string]> = {
  overview: ['Mission', 'Control'],
  memory: ['', 'Memory'],
  coordination: ['', 'Coordination'],
  runs: ['', 'Runs'],
  insight: ['', 'Insight'],
  settings: ['Trust &', 'settings'],
};

function PageHead({ tab, project }: { tab: TabKey; project: Project }) {
  const [lead, accent] = TITLES[tab];
  return (
    <header className="page-head">
      <h1 className="page-title">
        {lead ? `${lead} ` : ''}
        <em>{accent}</em>
      </h1>
      <p className="page-role">
        <span className="page-project">{project.name}</span>
        <span aria-hidden="true" className="page-sep">
          {'·'}
        </span>
        <code className="mono root-path" title={project.root}>
          {project.root}
        </code>
      </p>
    </header>
  );
}

const EMPTY_VERSIONS: Record<Topic, number> = {
  sessions: 0,
  memories: 0,
  conflicts: 0,
  tasks: 0,
  intents: 0,
  deliveries: 0,
  handoffs: 0,
  runs: 0,
  snapshots: 0,
  xray: 0,
  saves: 0,
  overview: 0,
};

function Shell({
  client,
  liveFactory,
  projects,
}: {
  client: MindlyClient;
  liveFactory: LiveFactory;
  projects: Project[];
}) {
  const [route, setRoute] = useState<Route>(readRoute);
  const [projectId, setProjectId] = useState<string>(() => {
    const fromHash = readRoute().params.get('p');
    const saved = fromHash ?? loadString(PROJECT_KEY);
    return projects.some((p) => p.id === saved) ? saved! : projects[0]!.id;
  });
  const project = projects.find((p) => p.id === projectId) ?? projects[0]!;
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [events, setEvents] = useState<MindlyEvent[]>([]);
  const [sessionList, setSessionList] = useState<Session[]>([]);
  const [versions, setVersions] = useState<Record<Topic, number>>(EMPTY_VERSIONS);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const liveRef = useRef<LiveFeed | null>(null);
  const pendingTopics = useRef(new Set<Topic>());
  const flushTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const notify = useCallback((text: string, tone: Toast['tone'] = 'neutral') => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5000);
  }, []);

  const invalidate = useCallback((topics: Iterable<Topic>) => {
    for (const t of topics) pendingTopics.current.add(t);
    window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => {
      const ts = [...pendingTopics.current];
      pendingTopics.current.clear();
      if (ts.length === 0) return;
      setVersions((v) => {
        const next = { ...v };
        for (const t of ts) next[t] += 1;
        return next;
      });
    }, 400);
  }, []);

  // Live feed: one socket for the page's lifetime.
  useEffect(() => {
    const feed = liveFactory({
      onStatus: setLiveStatus,
      onEvents: (_pid, evs) => {
        setEvents((cur) => {
          const seen = new Set(cur.map((e) => e.seq));
          const fresh = evs.filter((e) => !seen.has(e.seq));
          if (fresh.length === 0) return cur;
          return [...cur, ...fresh].sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS);
        });
        const topics = new Set<Topic>();
        for (const e of evs) for (const t of topicsFor(e.type)) topics.add(t);
        invalidate(topics);
      },
    });
    liveRef.current = feed;
    return () => {
      feed.close();
      liveRef.current = null;
    };
  }, [liveFactory, invalidate]);

  // Project switch: load backlog of events and sessions, then subscribe after the last seq.
  useEffect(() => {
    let cancelled = false;
    saveString(PROJECT_KEY, projectId);
    setEvents([]);
    setSessionList([]);
    client
      .events(projectId, { limit: 80, order: 'desc' })
      .then((evs) => {
        if (cancelled) return;
        const sorted = [...evs].sort((a, b) => a.seq - b.seq);
        setEvents(sorted);
        liveRef.current?.subscribe(projectId, sorted.at(-1)?.seq);
      })
      .catch(() => {
        if (!cancelled) liveRef.current?.subscribe(projectId);
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  useEffect(() => {
    let cancelled = false;
    client.sessions(projectId, 200).then(
      (s) => {
        if (!cancelled) setSessionList(s);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, projectId, versions.sessions]);

  const sessions = useMemo(() => new Map(sessionList.map((s) => [s.id, s])), [sessionList]);

  const navigate = useCallback(
    (tab: string, params: Record<string, string> = {}) => {
      writeRoute(tab, { p: projectId, ...params });
    },
    [projectId],
  );

  const state: AppState = useMemo(
    () => ({
      client,
      project,
      sessions,
      events,
      versions,
      notify,
      navigate,
      params: route.params,
    }),
    [client, project, sessions, events, versions, notify, navigate, route.params],
  );

  const changeProject = (id: string) => {
    setProjectId(id);
    writeRoute(route.tab, { p: id });
  };

  const liveLabel: Record<LiveStatus, string> = {
    connecting: 'connecting',
    live: 'live',
    reconnecting: 'reconnecting',
    offline: 'offline',
  };

  return (
    <AppContext.Provider value={state}>
      <button
        type="button"
        className="skip"
        onClick={() => document.getElementById('view-panel')?.focus()}
      >
        Skip to content
      </button>
      <Sky />
      <header className="topbar">
        <div className="topbar-brand">
          <Logo />
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <label className="project-picker">
            <span className="visually-hidden">Project</span>
            <select value={projectId} onChange={(e) => changeProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <nav aria-label="Views" className="topbar-tabs">
          <Tabs
            tabs={TABS}
            value={route.tab}
            onChange={(k) => writeRoute(k, { p: projectId })}
            label="Views"
            idPrefix="view"
          />
        </nav>
        <div className="topbar-status">
          {client.mock && <span className="mock-tag">mock data</span>}
          <span className={cx('live-pill', `live-${liveStatus}`)} role="status" aria-live="polite">
            <span className="live-dot" aria-hidden="true" />
            {liveLabel[liveStatus]}
          </span>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => {
              const t = nextTheme(theme);
              setTheme(t);
              applyTheme(t);
            }}
            aria-label={`Theme: ${theme}. Switch theme`}
            title="Switch theme"
          >
            <span className="theme-glyph" aria-hidden="true" />
            {theme === 'system' ? 'auto' : theme}
          </button>
        </div>
      </header>
      <main
        id="view-panel"
        className="main"
        role="tabpanel"
        aria-labelledby={`view-tab-${route.tab}`}
        tabIndex={-1}
      >
        <PageHead key={`${route.tab}:${projectId}`} tab={route.tab} project={project} />
        {route.tab === 'overview' && <OverviewView key={projectId} />}
        {route.tab === 'memory' && <MemoryView key={projectId} />}
        {route.tab === 'coordination' && <CoordinationView key={projectId} />}
        {route.tab === 'runs' && <RunsView key={projectId} />}
        {route.tab === 'insight' && <InsightView key={projectId} />}
        {route.tab === 'settings' && <SettingsView key={projectId} />}
      </main>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.tone}`)} role="status">
            <span className="dot" aria-hidden="true" />
            {t.text}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
