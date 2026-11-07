import { Tabs } from '../components/ui';
import { useApp } from '../state';
import { SUBPAGES } from '../vocab';
import { Provenance, Snapshots, Standup, XRay } from './Insight';
import { RunsView } from './Runs';

export type HistorySub = (typeof SUBPAGES.history)[number]['key'];

/** History: what ran, what each agent was told, who wrote which line, standups and snapshots. */
export function HistoryView({ sub }: { sub: HistorySub }) {
  const { navigate } = useApp();
  return (
    <div className="view">
      <div className="subnav">
        <Tabs
          idPrefix="history"
          label="History sections"
          value={sub}
          onChange={(k) => navigate('history', { sub: k })}
          tabs={SUBPAGES.history.map((t) => ({ key: t.key, label: t.label }))}
        />
      </div>
      <div id="history-panel" role="tabpanel" aria-labelledby={`history-tab-${sub}`}>
        {sub === 'runs' && <RunsView />}
        {sub === 'xray' && <XRay />}
        {sub === 'provenance' && <Provenance />}
        {sub === 'standup' && <Standup />}
        {sub === 'snapshots' && <Snapshots />}
      </div>
    </div>
  );
}
