import { Tabs } from '../components/ui';
import { useApp } from '../state';
import { SUBPAGES } from '../vocab';
import { CoordinationView } from './Coordination';
import { SplitView } from './Split';

export type AgentsSub = (typeof SUBPAGES.agents)[number]['key'];

/** Agents: how the agents work together (tasks, edits in progress, updates, handoffs) and the split. */
export function AgentsView({ sub }: { sub: AgentsSub }) {
  const { navigate } = useApp();
  return (
    <div className="view">
      <div className="subnav">
        <Tabs
          idPrefix="agents"
          label="Agents sections"
          value={sub}
          onChange={(k) => navigate('agents', { sub: k })}
          tabs={SUBPAGES.agents.map((t) => ({ key: t.key, label: t.label }))}
        />
      </div>
      <div id="agents-panel" role="tabpanel" aria-labelledby={`agents-tab-${sub}`}>
        {sub === 'team' && <CoordinationView />}
        {sub === 'split' && <SplitView />}
      </div>
    </div>
  );
}
