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
import type { ExecFileLike, FetchLike, Notification, SafePayload, SendResult } from './types.js';

/** Injectable dependencies for {@link createNotifier}. */
export interface NotifierOptions {
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileLike;
  clock?: Clock;
  /** Extra redaction patterns (typically `UserConfig.redaction.extraPatterns`). */
  redactPatterns?: readonly string[];
}

/** Sends pager notifications through the configured channels. */
export interface Notifier {
  /**
   * Sends `n` to every configured channel. Never throws. Returns one result per channel; an
   * empty array means no channels are configured.
   */
  send(n: Notification): Promise<SendResult[]>;
}

type Channel = UserConfig['notify']['channels'][number];

/**
 * Creates the pager. Nothing is sent unless `n.trigger` is listed in `config.triggers`. Payloads
 * are redacted, flattened to one line and capped (title 80, body 240 chars). Duplicate
 * `dedupeKey`s are suppressed for 10 minutes and at most 30 notifications go out per hour.
 */
export function createNotifier(config: UserConfig['notify'], opts: NotifierOptions = {}): Notifier {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const platform = opts.platform ?? process.platform;
  const execFileImpl = opts.execFileImpl ?? defaultExecFile;
  const clock = opts.clock ?? systemClock;
  const limiter = new NotifyLimiter(clock);
  const channels: readonly Channel[] = [...config.channels];
  const triggers = new Set(config.triggers);

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
    async send(n) {
      if (channels.length === 0) return [];
      const skip = (reason: string): SendResult[] =>
        channels.map((c) => ({ channel: c.type, status: 'skipped', reason }));
      if (!triggers.has(n.trigger)) return skip('trigger_disabled');
      const suppressed = limiter.admit(n.dedupeKey);
      if (suppressed) return skip(suppressed);
      let payload: SafePayload;
      try {
        payload = toSafePayload(n, opts.redactPatterns);
      } catch {
        return channels.map((c) => ({
          channel: c.type,
          status: 'failed',
          reason: 'invalid payload',
        }));
      }
      return Promise.all(channels.map((c) => runChannel(c, payload)));
    },
  };
}
