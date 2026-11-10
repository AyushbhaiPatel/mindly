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
  /**
   * Stays the same on every attempt to deliver this notification (`[A-Za-z0-9_-]`, at most 64
   * characters). Sent to webhooks as `id`, so a receiver can drop a repeat. When missing or
   * malformed it is derived from `dedupeKey`, or made up when there is none.
   */
  id?: string;
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

/** How one `send` call departs from the configured behaviour. */
export interface SendOptions {
  /**
   * Send even when the trigger is not listed in `notify.triggers`. For notifications the user
   * asked for in another way (a scheduled standup, a test of the channels).
   */
  ignoreTriggers?: boolean;
  /** Skip dedupe and the hourly budget (a test of the channels). */
  bypassLimits?: boolean;
}

/** Where the notifier reports what it could not send. Never receives URLs or payload text. */
export interface NotifierLog {
  warn(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
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
  /** See `Notification.id`. */
  id: string;
  trigger: NotifyTrigger;
  title: string;
  body: string;
  project: string | null;
  priority: NotifyPriority;
}
