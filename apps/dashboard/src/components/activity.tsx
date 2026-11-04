import { useMemo } from 'react';
import { clockTime, describeEvent } from '../format';
import { useApp } from '../state';
import type { MindlyEvent } from '../types';
import { cx } from './ui';

/** Terminal-style log of live events rendered as plain sentences. Newest first. */
export function ActivityStream({ events, limit = 60 }: { events: MindlyEvent[]; limit?: number }) {
  const { sessions } = useApp();
  const rows = useMemo(
    () =>
      [...events]
        .reverse()
        .slice(0, limit)
        .map((e) => ({ e, line: describeEvent(e, sessions) })),
    [events, sessions, limit],
  );
  if (rows.length === 0)
    return <p className="empty">No activity yet. Start an agent in this project.</p>;
  return (
    <ol className="log" aria-label="Activity, newest first">
      {rows.map(({ e, line }) => (
        <li key={e.seq} className={cx('log-row', `tone-${line.tone}`)}>
          <span className="log-seq" aria-hidden="true">
            {e.seq}
          </span>
          <time className="log-time" dateTime={new Date(e.createdAt).toISOString()}>
            {clockTime(e.createdAt)}
          </time>
          <span className="log-text">
            {line.actor && <span className="log-actor">{line.actor}</span>} {line.text}
          </span>
          <span className="log-type">{e.type}</span>
        </li>
      ))}
    </ol>
  );
}
