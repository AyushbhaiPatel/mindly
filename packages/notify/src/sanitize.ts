import { redactText, sanitizeLine, MindlyError, truncate } from '@mindly/core';
import type { Notification, SafePayload } from './types.js';

/** Maximum title length in characters. */
export const MAX_TITLE_CHARS = 80;
/** Maximum body length in characters. */
export const MAX_BODY_CHARS = 240;
/** Maximum project name length in characters. */
export const MAX_PROJECT_CHARS = 60;

/** Redacts, collapses to a single line and caps a piece of notification text. */
export function safeLine(text: string, max: number, extraPatterns: readonly string[] = []): string {
  const flat = sanitizeLine(redactText(text, { extraPatterns }), max * 2);
  return truncate(flat, max);
}

/** Produces the minimal payload every channel sends. */
export function toSafePayload(n: Notification, extraPatterns: readonly string[] = []): SafePayload {
  const title = safeLine(n.title, MAX_TITLE_CHARS, extraPatterns) || 'Mindly';
  const project =
    n.projectName === undefined ? null : safeLine(n.projectName, MAX_PROJECT_CHARS, extraPatterns);
  return {
    trigger: n.trigger,
    title,
    body: safeLine(n.body, MAX_BODY_CHARS, extraPatterns),
    project: project === '' ? null : project,
    priority: n.priority ?? 'default',
  };
}

/**
 * Makes a value safe for an HTTP header: removes CR, LF and every other control character
 * (header injection), then, if anything outside printable ASCII remains, encodes the value as an
 * RFC 2047 `=?UTF-8?B?...?=` encoded word, which ntfy decodes.
 */
export function toHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (/^[\x20-\x7E]*$/.test(stripped)) return stripped;
  return `=?UTF-8?B?${Buffer.from(stripped, 'utf8').toString('base64')}?=`;
}

/** True for `localhost`, `127.0.0.0/8` and `::1`. Hostnames are not resolved. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Parses a channel URL and enforces transport security: `https:` always, `http:` only for a
 * loopback host, and no embedded credentials. Error messages never echo the URL, which may carry
 * a secret path (webhook tokens).
 */
export function requireSecureUrl(raw: string, channel: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MindlyError('invalid_input', `${channel} url is not valid`);
  }
  if (url.username || url.password) {
    throw new MindlyError('forbidden', `${channel} url must not contain credentials`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
  throw new MindlyError('forbidden', `${channel} url must use https (http only for localhost)`);
}
