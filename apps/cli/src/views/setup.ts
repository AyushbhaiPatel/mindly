import { listWords, type Screen, type Step } from '../present/index.js';

/** What `mindly init` did. */
export interface InitSummary {
  home: string;
  /** Agents changed by this run. */
  connected: string[];
  /** Agents that needed no change. */
  already: string[];
  /** Of all the above, the ones that get Mindly's tools only (no hooks). */
  toolsOnly: string[];
  codex: boolean;
  /** The instruction to add to MCP-only agents' rules files. */
  rule: string;
}

/** Renders the end of `mindly init`: what is connected and what to do next. */
export function renderInitSummary(sc: Screen, d: InitSummary): void {
  sc.blank();
  const all = [...d.connected, ...d.already];
  if (all.length === 0) {
    sc.text(`${sc.mark('warn')} Mindly's storage is ready, but no agent is connected yet.`);
    sc.note(`Data folder: ${d.home}`, 2);
    sc.next([
      { cmd: 'mindly init --agents claude-code,codex,cursor', why: 'connect agents by name' },
      { cmd: 'mindly init --list-agents', why: 'see every supported agent' },
    ]);
    return;
  }
  sc.text(`${sc.mark('ok')} Mindly is ready.`);
  if (d.connected.length) sc.text(`Connected now: ${listWords(d.connected)}`, 2);
  if (d.already.length) sc.text(`Already connected: ${listWords(d.already)}`, 2);
  sc.note(`Data folder: ${d.home}`, 2);
  if (d.toolsOnly.length) {
    sc.blank();
    sc.text(
      `${listWords(d.toolsOnly)} ${d.toolsOnly.length === 1 ? 'gets' : 'get'} Mindly's tools but no automatic capture. Add this line to ${d.toolsOnly.length === 1 ? 'its' : 'their'} rules or instructions file: "${d.rule}"`,
    );
  }
  const steps: Step[] = [];
  if (d.connected.length) {
    steps.push({ why: 'Restart running agent sessions so they load Mindly.' });
  }
  if (d.codex) {
    steps.push({
      why: 'In Codex, run /hooks and approve the Mindly hooks (Codex does not run new hooks until you do).',
    });
  }
  steps.push({ cmd: 'mindly status', why: 'see your agents once they start' });
  sc.next(steps);
}
