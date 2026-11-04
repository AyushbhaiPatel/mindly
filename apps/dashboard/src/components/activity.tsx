import { useMemo } from 'react';
import { useApp } from '../state';
import type { MindlyEvent } from '../types';
import { describeEvent } from '../vocab';
import { Time, cx } from './ui';

/** Live log of what agents and Mindly did, as plain sentences. Newest first. */
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
    return (
      <p className="empty empty-pad">
        Nothing has happened yet. When an agent starts, edits a file or suggests a memory, it shows
        up here as it happens.
      </p>
    );
  return (
    <ol className="log" aria-label="Activity, newest first">
      {rows.map(({ e, line }) => (
        <li key={e.seq} className={cx('log-row', `tone-${line.tone}`)}>
          <span className="log-time">
            <Time ms={e.createdAt} />
          </span>
          <span className="log-text">
            {line.actor && <span className="log-actor">{line.actor}</span>} {line.text}
          </span>
        </li>
      ))}
    </ol>
  );
}
