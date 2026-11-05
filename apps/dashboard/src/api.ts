import type {
  Conflict,
  ConflictStatus,
  ContextPacket,
  Delivery,
  DeliveryStatus,
  EventQuery,
  Handoff,
  Health,
  Intent,
  Memory,
  MemoryDetail,
  MemoryPatch,
  MemoryQuery,
  NewMemoryInput,
  Overview,
  Project,
  ProvenanceResult,
  ReplayInput,
  RestoreResult,
  Run,
  RunKind,
  Save,
  SavesResult,
  SaveStatus,
  Split,
  SplitDetail,
  SplitStatus,
  Session,
  Snapshot,
  SnapshotDiff,
  StandupResult,
  MindlyEvent,
  Task,
  TaskStatus,
  TrustStatus,
} from './types';

/** Error raised for any non-2xx response or network failure. `code` follows the daemon contract. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const STATUS_CODES: Record<number, string> = {
  400: 'invalid_input',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  421: 'bad_host',
  500: 'internal',
};

const FRIENDLY: Record<string, string> = {
  unauthenticated: 'Your dashboard session has expired. Run `mindly dashboard` to sign in again.',
  forbidden: 'The daemon refused this request.',
  untrusted_project:
    'This project’s config is not trusted yet. Review it under Settings before running checks.',
  not_found: 'That item no longer exists.',
  too_large: 'The request is too large.',
  bad_host: 'The daemon rejected the address this page was opened from. Use 127.0.0.1.',
  network: 'Cannot reach the Mindly daemon. Is it still running?',
};

/** Maps a status code and a (possibly malformed) JSON error body to an ApiError. Pure. */
export function toApiError(status: number, body: unknown): ApiError {
  let code = STATUS_CODES[status] ?? (status >= 500 ? 'internal' : 'error');
  let message = '';
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (err && typeof err === 'object') {
      const c = (err as { code?: unknown }).code;
      const m = (err as { message?: unknown }).message;
      if (typeof c === 'string' && /^[a-z_]{1,40}$/.test(c)) code = c;
      if (typeof m === 'string') message = m.slice(0, 500);
    }
  }
  if (!message) message = FRIENDLY[code] ?? `Request failed (${status}).`;
  return new ApiError(status, code, message);
}

/** A message suitable for showing to the user. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) return FRIENDLY.unauthenticated!;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

/** Everything the UI needs from the daemon. Implemented over HTTP and by the mock fixtures. */
export interface MindlyClient {
  readonly mock: boolean;
  health(): Promise<Health>;
  exchangeLogin(code: string): Promise<void>;
  logout(): Promise<void>;
  projects(): Promise<Project[]>;
  overview(projectId: string): Promise<Overview>;
  sessions(projectId: string, limit?: number): Promise<Session[]>;
  events(projectId: string, query?: EventQuery): Promise<MindlyEvent[]>;
  memories(projectId: string, query?: MemoryQuery): Promise<Memory[]>;
  createMemory(projectId: string, input: NewMemoryInput): Promise<Memory>;
  memory(id: string): Promise<MemoryDetail>;
  updateMemory(id: string, patch: MemoryPatch): Promise<Memory>;
  approveMemory(id: string): Promise<Memory>;
  rejectMemory(id: string): Promise<Memory>;
  archiveMemory(id: string): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  conflicts(projectId: string, status?: ConflictStatus): Promise<Conflict[]>;
  setConflictStatus(id: string, status: Exclude<ConflictStatus, 'open'>): Promise<Conflict>;
  tasks(projectId: string, status?: TaskStatus): Promise<Task[]>;
  intents(projectId: string): Promise<Intent[]>;
  deliveries(projectId: string, status?: DeliveryStatus): Promise<Delivery[]>;
  handoffs(projectId: string): Promise<Handoff[]>;
  splits(projectId: string, status?: SplitStatus): Promise<Split[]>;
  split(id: string): Promise<SplitDetail>;
  runs(projectId: string, kind?: RunKind, limit?: number): Promise<Run[]>;
  shadowMerge(projectId: string): Promise<Run>;
  review(projectId: string, sessionId: string, reviewer: string): Promise<Run>;
  replay(projectId: string, input: ReplayInput): Promise<Run>;
  xray(sessionId: string, limit?: number): Promise<ContextPacket[]>;
  provenance(projectId: string, file: string, line: number): Promise<ProvenanceResult>;
  standup(projectId: string, since?: number): Promise<StandupResult>;
  snapshots(projectId: string): Promise<Snapshot[]>;
  createSnapshot(projectId: string, label: string): Promise<Snapshot>;
  snapshotDiff(id: string): Promise<SnapshotDiff>;
  restoreSnapshot(id: string, branch?: string): Promise<RestoreResult>;
  trust(projectId: string): Promise<TrustStatus>;
  /** `configHash` must be the hash shown to the user; the daemon rejects a mismatch. */
  trustConfig(projectId: string, configHash: string): Promise<TrustStatus>;
  /** Saves since `since` (default: the last 7 days); default status: confirmed and pending. */
  saves(
    projectId: string,
    query?: { since?: number; status?: SaveStatus | 'all' },
  ): Promise<SavesResult>;
  /** "Not a save": removes it from every total. */
  rejectSave(id: string): Promise<Save>;
  /** The share card as SVG text; `details` adds the project name, sentences and files. */
  savesCard(projectId: string, details: boolean): Promise<string>;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** GET of a non-JSON resource (the share card SVG) as text. */
async function getText(path: string, accept: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { Accept: accept },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new ApiError(0, 'network', FRIENDLY.network!);
  }
  const text = await res.text();
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    throw toApiError(res.status, parsed);
  }
  return text;
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Mindly-CSRF'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'network', FRIENDLY.network!);
  }
  if (res.status === 204) return undefined as T;
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) throw toApiError(res.status, parsed);
  return parsed as T;
}

export function createHttpClient(): MindlyClient {
  const get = <T>(p: string) => request<T>('GET', p);
  const post = <T>(p: string, b: unknown = {}) => request<T>('POST', p, b);
  const proj = (id: string) => `/api/projects/${enc(id)}`;
  return {
    mock: false,
    health: () => get('/api/health'),
    exchangeLogin: async (code) => {
      await post('/api/auth/exchange', { code });
    },
    logout: async () => {
      await post('/api/auth/logout');
    },
    projects: () => get('/api/projects'),
    overview: (id) => get(`${proj(id)}/overview`),
    sessions: (id, limit) => get(`${proj(id)}/sessions${buildQuery({ limit })}`),
    events: (id, q = {}) =>
      get(
        `${proj(id)}/events${buildQuery({
          afterSeq: q.afterSeq,
          beforeSeq: q.beforeSeq,
          types: q.types?.join(','),
          sessionId: q.sessionId,
          limit: q.limit,
          order: q.order,
        })}`,
      ),
    memories: (id, q = {}) =>
      get(
        `${proj(id)}/memories${buildQuery({
          q: q.q,
          kind: q.kind,
          trust: q.trust,
          branch: q.branch,
          status: q.status,
          limit: q.limit,
        })}`,
      ),
    createMemory: (id, input) => post(`${proj(id)}/memories`, input),
    memory: (id) => get(`/api/memories/${enc(id)}`),
    updateMemory: (id, patch) => request('PATCH', `/api/memories/${enc(id)}`, patch),
    approveMemory: (id) => post(`/api/memories/${enc(id)}/approve`),
    rejectMemory: (id) => post(`/api/memories/${enc(id)}/reject`),
    archiveMemory: (id) => post(`/api/memories/${enc(id)}/archive`),
    deleteMemory: (id) => request('DELETE', `/api/memories/${enc(id)}`),
    conflicts: (id, status) => get(`${proj(id)}/conflicts${buildQuery({ status })}`),
    setConflictStatus: (id, status) => post(`/api/conflicts/${enc(id)}/status`, { status }),
    tasks: (id, status) => get(`${proj(id)}/tasks${buildQuery({ status })}`),
    intents: (id) => get(`${proj(id)}/intents`),
    deliveries: (id, status) => get(`${proj(id)}/deliveries${buildQuery({ status })}`),
    handoffs: (id) => get(`${proj(id)}/handoffs`),
    splits: (id, status) => get(`${proj(id)}/splits${buildQuery({ status })}`),
    split: (id) => get(`/api/splits/${enc(id)}`),
    runs: (id, kind, limit) => get(`${proj(id)}/runs${buildQuery({ kind, limit })}`),
    shadowMerge: (id) => post(`${proj(id)}/shadow-merge`),
    review: (id, sessionId, reviewer) => post(`${proj(id)}/review`, { sessionId, reviewer }),
    replay: (id, input) => post(`${proj(id)}/replay`, input),
    xray: (sessionId, limit) => get(`/api/sessions/${enc(sessionId)}/xray${buildQuery({ limit })}`),
    provenance: (id, file, line) => get(`${proj(id)}/provenance${buildQuery({ file, line })}`),
    standup: (id, since) => get(`${proj(id)}/standup${buildQuery({ since })}`),
    snapshots: (id) => get(`${proj(id)}/snapshots`),
    createSnapshot: (id, label) => post(`${proj(id)}/snapshots`, { label }),
    snapshotDiff: (id) => get(`/api/snapshots/${enc(id)}/diff`),
    restoreSnapshot: (id, branch) =>
      post(`/api/snapshots/${enc(id)}/restore`, branch ? { branch } : {}),
    trust: (id) => get(`${proj(id)}/trust`),
    trustConfig: (id, configHash) => post(`${proj(id)}/trust`, { configHash }),
    saves: (id, q = {}) =>
      get(`${proj(id)}/saves${buildQuery({ since: q.since, status: q.status })}`),
    rejectSave: (id) => post(`/api/saves/${enc(id)}/reject`),
    savesCard: (id, details) =>
      getText(
        `${proj(id)}/saves/card.svg${buildQuery({ details: details ? 1 : undefined })}`,
        'image/svg+xml',
      ),
  };
}

/**
 * Reads a one-time login code from `#login=<code>`, strips it from the URL immediately (so it
 * never lingers in history), and returns it.
 */
export function takeLoginCode(): string | null {
  const m = /(?:^#|&)login=([A-Za-z0-9_-]{8,128})(?:&|$)/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return m[1] ?? null;
}
