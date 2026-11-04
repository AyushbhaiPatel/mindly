import { MindlyError } from '@mindly/core';
import type { FetchLike } from './types.js';

/** Default per-attempt request timeout. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Default cap on response body size. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
/** Base delay before the single retry; the actual delay adds up to 100% jitter. */
export const DEFAULT_RETRY_DELAY_MS = 500;

const MAX_ATTEMPTS = 2;

/** Transport settings shared by the HTTP providers. */
export interface HttpSettings {
  fetchImpl: FetchLike;
  timeoutMs: number;
  maxResponseBytes: number;
  retryDelayMs: number;
  random: () => number;
}

/** One JSON POST. Header values may hold credentials and must never be logged or echoed. */
export interface PostJsonRequest {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal | undefined;
}

type Attempt = { kind: 'ok'; json: unknown } | { kind: 'http_error'; status: number };

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MindlyError('unavailable', 'request aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new MindlyError('unavailable', 'request aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reads a response body while counting bytes; aborts as soon as the cap is exceeded. */
export async function readCappedText(
  res: Response,
  maxBytes: number,
  provider: string,
): Promise<string> {
  const tooLarge = (): MindlyError =>
    new MindlyError('unavailable', `${provider} response exceeded ${maxBytes} bytes`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function attemptOnce(req: PostJsonRequest, http: HttpSettings): Promise<Attempt> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, http.timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  if (req.signal?.aborted) controller.abort();
  req.signal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    const res = await http.fetchImpl(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'http_error', status: res.status };
    }
    const text = await readCappedText(res, http.maxResponseBytes, req.provider);
    try {
      return { kind: 'ok', json: JSON.parse(text) as unknown };
    } catch {
      throw new MindlyError('unavailable', `${req.provider} returned a non-JSON response`);
    }
  } catch (err) {
    if (timedOut) {
      throw new MindlyError(
        'timeout',
        `${req.provider} request timed out after ${http.timeoutMs}ms`,
      );
    }
    if (err instanceof MindlyError) throw err;
    if (req.signal?.aborted)
      throw new MindlyError('unavailable', `${req.provider} request aborted`);
    // Deliberately no `cause`: transport errors are not guaranteed to be free of request data.
    throw new MindlyError('unavailable', `${req.provider} request failed`);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * POSTs JSON and returns the parsed JSON response. Enforces a per-attempt timeout, a streaming
 * response size cap, refuses redirects and retries once on 429/5xx with jittered backoff.
 * Errors are `MindlyError`s whose messages never contain headers, bodies or URLs with secrets.
 */
export async function postJson(req: PostJsonRequest, http: HttpSettings): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const outcome = await attemptOnce(req, http);
    if (outcome.kind === 'ok') return outcome.json;
    if (isRetryable(outcome.status) && attempt < MAX_ATTEMPTS) {
      const delay = http.retryDelayMs * (1 + Math.min(1, Math.max(0, http.random())));
      await abortableSleep(delay, req.signal);
      continue;
    }
    throw new MindlyError(
      'unavailable',
      `${req.provider} request failed with HTTP ${outcome.status}`,
      { details: { status: outcome.status } },
    );
  }
}
