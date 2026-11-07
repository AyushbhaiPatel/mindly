import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createHttpClient, describeError, takeLoginCode, type MindlyClient } from './api';
import { Drawer, Tabs, TextLink, cx } from './components/ui';
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
import { AgentsView, type AgentsSub } from './views/Agents';
import { HistoryView, type HistorySub } from './views/History';
import { HomeView } from './views/Home';
import { MemoryView } from './views/Memory';
import { SettingsView } from './views/Settings';
import { GUIDE, PAGES, SUBPAGES, type Page } from './vocab';

const PAGE_KEYS = new Set<string>(PAGES.map((p) => p.key));

const MOCK = import.meta.env.VITE_MINDLY_MOCK === '1';
const PROJECT_KEY = 'mindly.project';
const MAX_EVENTS = 400;

interface Route {
  page: Page;
  params: URLSearchParams;
}

/**
 * Older links and the views' own `navigate()` calls still use the previous page names; each maps
 * to a page and, where the page has sections, the section to open.
 */
const ALIASES: Record<string, { page: Page; sub?: string }> = {
  overview: { page: 'home' },
  coordination: { page: 'agents', sub: 'team' },
  split: { page: 'agents', sub: 'split' },
  runs: { page: 'history', sub: 'runs' },
  insight: { page: 'history', sub: 'xray' },
};

function canonical(
  path: string,
  params: Record<string, string>,
): { page: Page; params: Record<string, string> } {
  if (PAGE_KEYS.has(path)) return { page: path as Page, params };
  const alias = ALIASES[path];
  if (!alias) return { page: 'home', params };
  return { page: alias.page, params: alias.sub ? { sub: alias.sub, ...params } : params };
}

function readRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const c = canonical(path, Object.fromEntries(params));
  return { page: c.page, params: new URLSearchParams(c.params) };
}

function writeRoute(tab: string, params: Record<string, string> = {}) {
  const c = canonical(tab, params);
  const q = new URLSearchParams(c.params).toString();
  const next = `#/${c.page}${q ? `?${q}` : ''}`;
  if (location.hash !== next) location.hash = next;
}

function subOf<K extends string>(params: URLSearchParams, keys: readonly { key: K }[]): K {
  const v = params.get('sub');
  return (keys.find((k) => k.key === v)?.key ?? keys[0]!.key) as K;
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
        <p>Connecting to Mindly on this machine…</p>
      </div>
    );
  }
  if (boot.state === 'unauth') {
    return (
      <main className="splash">
        <Sky />
        <Logo />
        <h1>
          Open it from your <em>terminal</em>
        </h1>
        {boot.reason && <p className="splash-warn">{boot.reason}</p>}
        <p>This page opens with a one-time link. In the project you want to watch, run:</p>
        <pre className="splash-cmd">mindly dashboard</pre>
        <p className="muted">
          The link signs this browser in for 12 hours. Nothing leaves this machine.
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
          Can’t reach <em>Mindly</em>
        </h1>
        <p>{boot.message}</p>
        <p className="muted">
          Start the background service with <code className="mono">mindly daemon start</code>, or
          reopen with <code className="mono">mindly dashboard</code>.
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
          there. The project shows up here on its own.
        </p>
      </main>
    );
  }
  return <Shell client={boot.client} liveFactory={boot.live} projects={boot.projects} />;
}

/** The product mark: the pixel elephant and the lowercase wordmark. */
function Logo() {
  return (
    <span className="logo">
      <img src="/favicon.svg" alt="" width="22" height="22" className="logo-mark" />
      mindly
    </span>
  );
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
const TITLES: Record<Page, readonly [lead: string, accent: string]> = {
  home: ['', 'Home'],
  memory: ['Project', 'memory'],
  agents: ['Your', 'agents'],
  history: ['', 'History'],
  settings: ['', 'Settings'],
};

function PageHead({ page, project }: { page: Page; project: Project }) {
  const [lead, accent] = TITLES[page];
  const intro = PAGES.find((p) => p.key === page)?.intro;
  return (
    <header className="page-head">
      <p className="page-role">
        <span className="page-project">{project.name}</span>
        <span aria-hidden="true" className="page-sep">
          {'·'}
        </span>
        <code className="mono root-path" title={project.root}>
          {project.root}
        </code>
      </p>
      <h1 className="page-title">
        {lead ? `${lead} ` : ''}
        <em>{accent}</em>
      </h1>
      {intro && <p className="page-intro">{intro}</p>}
    </header>
  );
}

/** "What am I looking at?": the pages and the handful of words Mindly uses, in one drawer. */
function GuideDrawer({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Drawer open={open} onClose={onClose} title="What am I looking at?">
      <div className="guide">
        <p>
          Mindly sits between your coding agents and this repository. It remembers what the project
          decided, tells each agent what the others are doing, and steps in before an edit breaks
          something. This page shows all of that; it never changes your code on its own.
        </p>
        <h3>The pages</h3>
        <dl className="guide-list">
          {PAGES.map((p) => (
            <div key={p.key}>
              <dt>{p.label}</dt>
              <dd>{p.intro}</dd>
            </div>
          ))}
        </dl>
        <h3>The words</h3>
        <dl className="guide-list">
          {GUIDE.map((g) => (
            <div key={g.term}>
              <dt>{g.term}</dt>
              <dd>{g.text}</dd>
            </div>
          ))}
        </dl>
        <p className="muted">
          The same things are one command away in the terminal:{' '}
          <code className="mono">mindly status</code>, <code className="mono">mindly rules</code>,{' '}
          <code className="mono">mindly saves</code>.
        </p>
      </div>
    </Drawer>
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
  splits: 0,
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
  // The project whose backlog loaded, so a slow or failed request never reads as "no events".
  const [eventsLoadedFor, setEventsLoadedFor] = useState<string | null>(null);
  const [sessionList, setSessionList] = useState<Session[]>([]);
  const [versions, setVersions] = useState<Record<Topic, number>>(EMPTY_VERSIONS);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [guide, setGuide] = useState(false);
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
    setEventsLoadedFor(null);
    setSessionList([]);
    client
      .events(projectId, { limit: 80, order: 'desc' })
      .then((evs) => {
        if (cancelled) return;
        const sorted = [...evs].sort((a, b) => a.seq - b.seq);
        setEvents(sorted);
        setEventsLoadedFor(projectId);
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
      eventsLoaded: eventsLoadedFor === project.id,
      versions,
      notify,
      navigate,
      params: route.params,
    }),
    [client, project, sessions, events, eventsLoadedFor, versions, notify, navigate, route.params],
  );

  const changeProject = (id: string) => {
    setProjectId(id);
    const sub = route.params.get('sub');
    writeRoute(route.page, sub ? { p: id, sub } : { p: id });
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
        <nav aria-label="Pages" className="topbar-tabs">
          <Tabs
            tabs={PAGES.map((p) => ({ key: p.key, label: p.label }))}
            value={route.page}
            onChange={(k) => writeRoute(k, { p: projectId })}
            label="Pages"
            idPrefix="view"
          />
        </nav>
        <div className="topbar-status">
          {client.mock && <span className="mock-tag">sample data</span>}
          <TextLink onClick={() => setGuide(true)} title="What am I looking at?">
            <span className="guide-btn" aria-hidden="true">
              ?
            </span>
            <span className="guide-word">Guide</span>
          </TextLink>
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
        aria-labelledby={`view-tab-${route.page}`}
        tabIndex={-1}
      >
        <PageHead key={`${route.page}:${projectId}`} page={route.page} project={project} />
        {route.page === 'home' && <HomeView key={projectId} />}
        {route.page === 'memory' && <MemoryView key={projectId} />}
        {route.page === 'agents' && (
          <AgentsView key={projectId} sub={subOf<AgentsSub>(route.params, SUBPAGES.agents)} />
        )}
        {route.page === 'history' && (
          <HistoryView key={projectId} sub={subOf<HistorySub>(route.params, SUBPAGES.history)} />
        )}
        {route.page === 'settings' && <SettingsView key={projectId} />}
      </main>
      <GuideDrawer open={guide} onClose={() => setGuide(false)} />
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
