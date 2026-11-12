import { isMindlyError, systemClock, type Clock, type UserConfig } from '@mindly/core';
import {
  defaultExecFile,
  sendDesktop,
  sendNtfy,
  sendWebhook,
  type ChannelOutcome,
} from './channels.js';
import { NotifyLimiter } from './limiter.js';
import { toSafePayload } from './sanitize.js';
import type {
  ExecFileLike,
  FetchLike,
  Notification,
  NotifierLog,
  SafePayload,
  SendOptions,
  SendResult,
} from './types.js';

/** Injectable dependencies for {@link createNotifier}. */
export interface NotifierOptions {
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileLike;
  clock?: Clock;
  /** Extra redaction patterns (typically `UserConfig.redaction.extraPatterns`). */
  redactPatterns?: readonly string[];
  /** Told once about each channel failure and each disabled trigger; nothing is logged without it. */
  log?: NotifierLog;
}

/** Sends pager notifications through the configured channels. */
export interface Notifier {
  /**
   * Sends `n` to every configured channel. Never throws. Returns one result per channel; an
   * empty array means no channels are configured.
   */
  send(n: Notification, options?: SendOptions): Promise<SendResult[]>;
}

/**
 * Whether a notification needs no further attempt: it reached a channel, went out a moment ago
 * under the same key, or there is nothing to send it to (no channel, trigger off, a platform
 * without desktop notifications). False when a channel that was tried failed and none took it,
 * or the hourly budget held it back: such a notification can be tried again later.
 */
export function isSettled(results: readonly SendResult[]): boolean {
  if (results.length === 0) return true;
  if (results.some((r) => r.status === 'sent')) return true;
  if (results.some((r) => r.status === 'failed')) return false;
  return !results.some((r) => r.reason === 'rate_limited');
}

type Channel = UserConfig['notify']['channels'][number];

/**
 * Creates the pager. Nothing is sent unless `n.trigger` is listed in `config.triggers`. Payloads
 * are redacted, flattened to one line and capped (title 80, body 240 chars). Duplicate
 * `dedupeKey`s are suppressed for 10 minutes and at most 30 notifications go out per hour; both
 * count only notifications that reached a channel, so one that failed everywhere can be sent
 * again.
 */
export function createNotifier(config: UserConfig['notify'], opts: NotifierOptions = {}): Notifier {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const platform = opts.platform ?? process.platform;
  const execFileImpl = opts.execFileImpl ?? defaultExecFile;
  const clock = opts.clock ?? systemClock;
  const limiter = new NotifyLimiter(clock);
  const channels: readonly Channel[] = [...config.channels];
  const triggers = new Set(config.triggers);
  const told = new Set<string>();
  /** Logs each distinct problem once per notifier, so a dead endpoint does not fill the log. */
  const once = (level: 'warn' | 'debug', key: string, message: string, fields: object): void => {
    if (!opts.log || told.has(key) || told.size >= 200) return;
    told.add(key);
    opts.log[level](message, { ...fields });
  };

  const dispatch = async (channel: Channel, payload: SafePayload): Promise<ChannelOutcome> => {
    switch (channel.type) {
      case 'desktop':
        return sendDesktop(payload, platform, execFileImpl);
      case 'ntfy':
        return sendNtfy(payload, channel, fetchImpl);
      case 'webhook':
        return sendWebhook(payload, channel, fetchImpl, clock.now());
    }
  };

  const runChannel = async (channel: Channel, payload: SafePayload): Promise<SendResult> => {
    try {
      const outcome = await dispatch(channel, payload);
      return outcome.status === 'sent'
        ? { channel: channel.type, status: 'sent' }
        : { channel: channel.type, status: 'skipped', reason: outcome.reason };
    } catch (err) {
      const reason = isMindlyError(err) ? err.message : `${channel.type} failed`;
      return { channel: channel.type, status: 'failed', reason };
    }
  };

  return {
    async send(n, options = {}) {
      if (channels.length === 0) return [];
      const skip = (reason: string): SendResult[] =>
        channels.map((c) => ({ channel: c.type, status: 'skipped', reason }));
      if (!options.ignoreTriggers && !triggers.has(n.trigger)) {
        once('debug', `trigger:${n.trigger}`, 'notification not sent: its trigger is off', {
          trigger: n.trigger,
        });
        return skip('trigger_disabled');
      }
      const limited = !options.bypassLimits;
      if (limited) {
        const suppressed = limiter.check(n.dedupeKey);
        if (suppressed) return skip(suppressed);
      }
      let payload: SafePayload;
      try {
        payload = toSafePayload(n, opts.redactPatterns);
      } catch {
        if (limited) limiter.released(n.dedupeKey);
        return channels.map((c) => ({
          channel: c.type,
          status: 'failed',
          reason: 'invalid payload',
        }));
      }
      const results = await Promise.all(channels.map((c) => runChannel(c, payload)));
      for (const r of results) {
        if (r.status !== 'failed') continue;
        // The reason is a fixed description: it never holds the URL or the text that was sent.
        once('warn', `failed:${r.channel}:${r.reason ?? ''}`, 'notification channel failed', {
          channel: r.channel,
          reason: r.reason ?? 'failed',
          trigger: n.trigger,
        });
      }
      if (limited) {
        if (results.some((r) => r.status === 'sent')) limiter.delivered(n.dedupeKey);
        else if (results.some((r) => r.status === 'failed')) limiter.failed(n.dedupeKey);
        else limiter.released(n.dedupeKey);
      }
      return results;
    },
  };
}
