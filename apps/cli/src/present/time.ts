/**
 * Human times for CLI output: relative ("2m ago", "yesterday 14:05") in local time, never UTC
 * (see docs/output-style.md).
 */

const pad = (n: number): string => String(n).padStart(2, '0');

function clock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `2026-11-04 09:30` in local time (only where precision matters, e.g. provenance). */
export function absoluteTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)}`;
}

/**
 * `just now`, `5m ago`, `3h ago`, `yesterday 14:05`, `4d ago`, then the date. Times in the future
 * (clock skew between processes) read as "just now".
 */
export function relativeTime(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  const today = dayStart(now);
  if (ms >= today) return `${Math.floor(s / 3600)}h ago`;
  // "Yesterday" by calendar day, from the local midnight before today's.
  const yesterday = dayStart(today - 1);
  if (ms >= yesterday) return `yesterday ${clock(new Date(ms))}`;
  const days = Math.round((today - dayStart(ms)) / 86_400_000);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `30m`, `24h`, `3 days`: a span of time in words. */
export function spanWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${Math.round(ms / 86_400_000)} days`;
}
