import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { describeError, type MindlyClient } from './api';
import type { Topic } from './live';
import type { Project, Session, MindlyEvent } from './types';

export interface Toast {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

export interface AppState {
  client: MindlyClient;
  project: Project;
  /** All recent sessions of the project, keyed by id, for naming actors. */
  sessions: ReadonlyMap<string, Session>;
  /** Live events received since the page loaded (newest last), plus the initial backlog. */
  events: MindlyEvent[];
  /** True once the current project's event backlog has loaded; false while loading or failed. */
  eventsLoaded: boolean;
  versions: Readonly<Record<Topic, number>>;
  notify(text: string, tone?: Toast['tone']): void;
  navigate(tab: string, params?: Record<string, string>): void;
  /** Reads the project list again, after something stored on a project changed. */
  reloadProjects(): Promise<void>;
  params: URLSearchParams;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext missing');
  return ctx;
}

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload(): void;
}

/**
 * Loads data and reloads it whenever one of `topics` is invalidated by the live feed or `deps`
 * change. Keeps showing the previous data while refreshing so panels don't flicker.
 */
export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  topics: readonly Topic[] = [],
): Resource<T> {
  const { versions } = useApp();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const topicKey = topics.map((t) => versions[t]).join(':');
  const depKey = JSON.stringify(deps);
  const lastDepKey = useRef(depKey);

  useEffect(() => {
    let cancelled = false;
    if (lastDepKey.current !== depKey) {
      lastDepKey.current = depKey;
      setData(undefined);
    }
    setLoading(true);
    loadRef.current().then(
      (v) => {
        if (cancelled) return;
        setData(v);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [depKey, topicKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Runs a mutation, reports success/failure as a toast, and returns whether it succeeded. */
export function useAction() {
  const { notify } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      setBusy(key);
      try {
        await fn();
        if (success) notify(success, 'good');
        return true;
      } catch (e) {
        notify(describeError(e), 'bad');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [notify],
  );
  return { busy, run };
}
