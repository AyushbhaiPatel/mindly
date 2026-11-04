import type { NOTIFY_TRIGGERS } from '@mindly/core';

/** A notification trigger name, as configured in `UserConfig.notify.triggers`. */
export type NotifyTrigger = (typeof NOTIFY_TRIGGERS)[number];

/** Notification priority. */
export type NotifyPriority = 'low' | 'default' | 'high';

/**
 * A pager notification. Keep it minimal: a status line and counts. Callers must never pass
 * source code, diffs, prompt text or agent transcripts in `title` or `body`; the notifier redacts
 * and truncates as a backstop, not as a licence to send sensitive text.
 */
export interface Notification {
  trigger: NotifyTrigger;
  title: string;
  body: string;
  projectName?: string;
  priority?: NotifyPriority;
  /** Notifications with the same key are sent at most once per dedupe window (10 minutes). */
  dedupeKey?: string;
}

/** Outcome of one channel for one notification. */
export interface SendResult {
  channel: 'desktop' | 'ntfy' | 'webhook';
  status: 'sent' | 'skipped' | 'failed';
  /**
   * Why it was skipped or failed: `trigger_disabled`, `deduped`, `rate_limited`, `unsupported`,
   * or a short error description that never contains URLs, headers or payload text.
   */
  reason?: string;
}

/** Minimal `fetch` signature so tests can inject a fake. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** `execFile` wrapper: resolves on exit code 0, rejects otherwise. Never uses a shell. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<void>;

/** A payload that has already been redacted, flattened and truncated. */
export interface SafePayload {
  trigger: NotifyTrigger;
  title: string;
  body: string;
  project: string | null;
  priority: NotifyPriority;
}
