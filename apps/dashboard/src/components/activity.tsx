import { useMemo } from 'react';
import { useApp } from '../state';
import type { MindlyEvent } from '../types';
import { EMPTY, describeEvent } from '../vocab';
import { Age, cx } from './ui';

/** Live log of what agents and Mindly did: time, agent, action. Newest first. */
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
  if (rows.length === 0) return <p className="empty">{EMPTY.activity}</p>;
  return (
    <ol className="log" aria-label="Activity, newest first">
      {rows.map(({ e, line }) => (
        <li key={e.seq} className={cx('log-row', `tone-${line.tone}`)}>
          <span className="log-time">
            <Age ms={e.createdAt} />
          </span>
          <span className={cx('log-actor', !line.actor && 'muted')}>{line.actor ?? '—'}</span>
          <span className="log-text">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}
