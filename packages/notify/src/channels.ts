import { execFile } from 'node:child_process';
import { MindlyError } from '@mindly/core';
import { requireSecureUrl, toHeaderValue } from './sanitize.js';
import type { ExecFileLike, FetchLike, SafePayload } from './types.js';

/** Timeout for every outbound channel request or process. */
export const CHANNEL_TIMEOUT_MS = 5_000;

/**
 * Fixed AppleScript source. User text is never interpolated into it: title, body and subtitle
 * arrive as `argv` items, and `--` before them stops osascript from parsing a leading `-` as an
 * option.
 */
export const OSASCRIPT_SOURCE = [
  'on run argv',
  'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)',
  'end run',
].join('\n');

/** Default `execFile` wrapper: argument array, no shell, hard timeout. */
export const defaultExecFile: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: options.timeout, windowsHide: true, shell: false },
      (err) => (err ? reject(new MindlyError('unavailable', `${file} failed`)) : resolve()),
    );
  });

/** Result of a channel attempt before it is labelled with the channel name. */
export type ChannelOutcome = { status: 'sent' } | { status: 'skipped'; reason: string };

/** Escapes the characters the Desktop Notifications markup gives a meaning to. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Desktop notification via osascript (macOS) or notify-send (Linux). */
export async function sendDesktop(
  p: SafePayload,
  platform: NodeJS.Platform,
  execFileImpl: ExecFileLike,
): Promise<ChannelOutcome> {
  if (platform === 'darwin') {
    await execFileImpl(
      'osascript',
      ['-e', OSASCRIPT_SOURCE, '--', p.title, p.body, p.project ?? ''],
      {
        timeout: CHANNEL_TIMEOUT_MS,
      },
    );
    return { status: 'sent' };
  }
  if (platform === 'linux') {
    const urgency = p.priority === 'high' ? 'critical' : p.priority === 'low' ? 'low' : 'normal';
    const title = p.project ? `${p.title} (${p.project})` : p.title;
    // The summary is plain text; the body is markup to a notification server (bold, links,
    // images), so its three special characters are written as entities.
    await execFileImpl('notify-send', [`--urgency=${urgency}`, '--', title, escapeMarkup(p.body)], {
      timeout: CHANNEL_TIMEOUT_MS,
    });
    return { status: 'sent' };
  }
  return { status: 'skipped', reason: 'unsupported' };
}

async function post(
  fetchImpl: FetchLike,
  url: string,
  channel: string,
  init: { headers: Record<string, string>; body: string },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHANNEL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    // No cause: transport errors can echo the URL, which may contain a secret path.
    throw new MindlyError(
      controller.signal.aborted ? 'timeout' : 'unavailable',
      controller.signal.aborted ? `${channel} request timed out` : `${channel} request failed`,
    );
  } finally {
    clearTimeout(timer);
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status >= 300 && res.status < 400) {
    throw new MindlyError('forbidden', `${channel} redirect refused`);
  }
  if (!res.ok) throw new MindlyError('unavailable', `${channel} returned HTTP ${res.status}`);
}

const NTFY_PRIORITY = { low: '2', default: '3', high: '4' } as const;
const TOPIC_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * ntfy publish: `POST <url>/<topic>` (keeping the URL's query string) with a plain-text body and `Title`, `Priority`, `Tags`
 * headers. Header values are stripped of control characters (no CR/LF injection) and any
 * non-ASCII title is sent as an RFC 2047 encoded word, which ntfy decodes.
 */
export async function sendNtfy(
  p: SafePayload,
  channel: { url: string; topic: string },
  fetchImpl: FetchLike,
): Promise<ChannelOutcome> {
  const base = requireSecureUrl(channel.url, 'ntfy');
  if (!TOPIC_RE.test(channel.topic)) throw new MindlyError('invalid_input', 'ntfy topic invalid');
  // The query string stays: it is how an ntfy server takes an access token (`?auth=...`).
  const target = `${base.origin}${base.pathname.replace(/\/+$/, '')}/${channel.topic}${base.search}`;
  const body = [p.project ? `[${p.project}]` : '', p.body || p.title].filter(Boolean).join(' ');
  await post(fetchImpl, target, 'ntfy', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      Title: toHeaderValue(p.title),
      Priority: NTFY_PRIORITY[p.priority],
      Tags: toHeaderValue(`mindly,${p.trigger}`),
    },
    body,
  });
  return { status: 'sent' };
}

/** Generic webhook: `POST` JSON `{ trigger, title, body, project, ts }`. */
export async function sendWebhook(
  p: SafePayload,
  channel: { url: string },
  fetchImpl: FetchLike,
  now: number,
): Promise<ChannelOutcome> {
  const url = requireSecureUrl(channel.url, 'webhook');
  await post(fetchImpl, url.href, 'webhook', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      trigger: p.trigger,
      title: p.title,
      body: p.body,
      project: p.project,
      ts: new Date(now).toISOString(),
    }),
  });
  return { status: 'sent' };
}
