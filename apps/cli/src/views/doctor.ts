import {
  agentName,
  count,
  listWords,
  type Marker,
  type Screen,
  type Step,
} from '../present/index.js';

/** One doctor check with its human wording. */
export interface DoctorItem {
  /** The `--json` shape (unchanged). */
  check: { name: string; status: 'ok' | 'warn' | 'fail' | 'info'; detail: string };
  group: 'Setup' | 'Agents' | 'Optional';
  /** Plain sentence shown to people. */
  text: string;
  /** Exact command (or instruction) that fixes a problem. */
  fix: Step | null;
}

const MARKERS: Record<DoctorItem['check']['status'], Marker> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  info: 'item',
};

/** Merges `mindly init --agents a` + `mindly init --agents b` into one command. */
function fixSteps(problems: readonly DoctorItem[]): Step[] {
  const agents: string[] = [];
  const steps: Step[] = [];
  for (const p of problems) {
    if (p.fix === null) continue;
    const m = /^mindly init --agents ([a-z0-9-]+)$/.exec(p.fix.cmd ?? '');
    if (m) agents.push(m[1] as string);
    else if (!steps.some((s) => s.cmd === p.fix?.cmd && s.why === p.fix?.why)) steps.push(p.fix);
  }
  if (agents.length) {
    steps.push({
      cmd: `mindly init --agents ${agents.join(',')}`,
      why: `connect ${listWords(agents.map(agentName))}`,
    });
  }
  return steps;
}

/** Renders `mindly doctor`: Setup, Agents and Optional, then a verdict with the fixes. */
export function renderDoctor(sc: Screen, items: readonly DoctorItem[]): void {
  const failed = items.filter((i) => i.check.status === 'fail');
  const warned = items.filter((i) => i.check.status === 'warn');
  const problems = [...failed, ...warned];
  sc.summary(
    failed.length
      ? `Mindly doctor ${sc.sym.dot} ${count(failed.length, 'problem')} to fix`
      : warned.length
        ? `Mindly doctor ${sc.sym.dot} working, ${count(warned.length, 'thing')} to check`
        : `Mindly doctor ${sc.sym.dot} all good`,
  );
  for (const group of ['Setup', 'Agents', 'Optional'] as const) {
    const rows = items.filter((i) => i.group === group);
    if (rows.length === 0) {
      if (group === 'Agents') {
        sc.section('Agents');
        sc.rows([
          {
            marker: 'warn',
            text: 'No agent is connected to Mindly yet (connect one with: mindly init)',
          },
        ]);
      }
      continue;
    }
    sc.section(group);
    sc.rows(rows.map((i) => ({ marker: MARKERS[i.check.status], text: i.text })));
  }
  sc.blank();
  const noAgents = !items.some((i) => i.group === 'Agents');
  if (failed.length) {
    sc.text(
      `${sc.mark('fail')} Mindly cannot work until you fix ${failed.length === 1 ? 'this problem' : `these ${failed.length} problems`}.`,
    );
  } else if (warned.length) {
    sc.text(
      `${sc.mark('warn')} Mindly works, but ${warned.length === 1 ? '1 thing needs' : `${warned.length} things need`} your attention.`,
    );
  } else if (noAgents) {
    sc.text(`${sc.mark('warn')} Mindly is installed, but no agent uses it yet.`);
  } else {
    sc.text(`${sc.mark('ok')} Everything looks good.`);
  }
  const steps = fixSteps(problems);
  if (noAgents && problems.length === 0)
    steps.push({ cmd: 'mindly init', why: 'connect your agents' });
  sc.next(steps);
}
