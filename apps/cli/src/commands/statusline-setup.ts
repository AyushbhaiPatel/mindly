import {
  applyInstallSteps,
  chainedStatusLineScript,
  effectiveStatusLine,
  planStatusLineInstall,
  statusLineLauncherExists,
} from '@mindly/adapters';
import { describeError, type AgentAdapter } from '@mindly/core';
import { confirm } from '../io.js';
import type { Out } from '../util.js';
import type { DoctorItem } from '../views/doctor.js';
import { printPlan, userHome, type AgentPlan } from './setup.js';

/** The init options the status line offer reads. */
interface OfferOptions {
  yes?: boolean;
  dryRun?: boolean;
  /** false with --no-statusline. */
  statusline?: boolean;
}

/**
 * Part of mindly init: offers Mindly's Claude Code status line when Claude Code is being
 * connected. A status line the user already has is never replaced; init explains how to chain
 * it instead. With --dry-run the change is only shown, with --yes it is applied without asking.
 */
export async function offerStatusLine(
  out: Out,
  o: OfferOptions,
  plans: readonly AgentPlan[],
  command: string[],
  projectRoot: string | null,
): Promise<void> {
  const claude = plans.find((p) => p.agent === 'claude-code');
  if (claude === undefined || o.statusline === false) return;
  const plan = await planStatusLineInstall({
    command,
    projectRoot,
    homeDir: userHome(out.io.env),
  });
  if (plan.state.kind === 'foreign') {
    out.line();
    out.line(
      'Claude Code already has a status line (' +
        plan.file +
        '), so Mindly left it alone. To show both, save this as a script and point statusLine.command at it:',
    );
    const script = chainedStatusLineScript(
      plan.state.command ?? '<your status line command>',
      command,
    );
    for (const l of script.trimEnd().split('\n')) out.line('  ' + out.style.dim(l));
    return;
  }
  if (plan.steps.length === 0) return;
  out.line();
  printPlan(out, [{ ...claude, steps: plan.steps }], '');
  if (o.dryRun) return;
  if (o.yes !== true && out.io.prompt === null) {
    out.line(
      'Status line not added: no terminal to ask on. Add it with: mindly init --agents claude-code --yes',
    );
    return;
  }
  if (!(await confirm(out.io, "Show Mindly in Claude Code's status line?", o.yes === true))) {
    out.line('Status line not added.');
    return;
  }
  for (const applied of applyInstallSteps(plan.steps)) {
    out.line('Wrote ' + applied.file + (applied.backup ? ' (backup: ' + applied.backup + ')' : ''));
  }
}

/**
 * mindly doctor line for Claude Code's status line: Mindly's (and whether its launcher still
 * exists), someone else's, or none. Null when Claude Code is not installed and has none.
 */
export async function statusLineCheck(
  env: NodeJS.ProcessEnv,
  adapter: AgentAdapter,
  command: string[],
  projectRoot: string | null,
): Promise<DoctorItem | null> {
  const name = 'statusline';
  try {
    const { file, state } = await effectiveStatusLine({
      homeDir: userHome(env),
      projectRoot,
      command,
    });
    if (state.kind === 'none') {
      if (!(await adapter.detect())) return null;
      return {
        check: {
          name,
          status: 'info',
          detail: 'not installed (optional: mindly init --agents claude-code)',
        },
        group: 'Optional',
        text: 'Claude Code status line is not set up (add it with: mindly init --agents claude-code)',
        fix: null,
      };
    }
    if (state.kind === 'foreign') {
      return {
        check: { name, status: 'info', detail: 'another statusLine is configured in ' + file },
        group: 'Optional',
        text:
          'Claude Code shows another status line (' +
          file +
          '); to add Mindly to it, run mindly statusline from that command',
        fix: null,
      };
    }
    if (!(await statusLineLauncherExists(state.command, env))) {
      return {
        check: { name, status: 'warn', detail: 'mindly binary not found: ' + state.command },
        group: 'Agents',
        text: "Claude Code's status line runs a Mindly that cannot be found",
        fix: { cmd: 'mindly init --agents claude-code', why: 'point it at this Mindly' },
      };
    }
    return {
      check: { name, status: 'ok', detail: 'installed in ' + file },
      group: 'Agents',
      text: 'Claude Code status line shows Mindly',
      fix: null,
    };
  } catch (err) {
    return {
      check: { name, status: 'warn', detail: describeError(err) },
      group: 'Agents',
      text: "Claude Code's status line settings could not be read (" + describeError(err) + ')',
      fix: { why: "Check Claude Code's settings.json files" },
    };
  }
}
