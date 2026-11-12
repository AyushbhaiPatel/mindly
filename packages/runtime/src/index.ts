import { loadUserConfig, ensureHome, mindlyHome, type UserConfig } from '@mindly/core';
import { installDefaultModules, Mindly, type MindlyOptions } from '@mindly/engine';
import type { NotifierLog } from '@mindly/notify';
import { createGitPort, createLlmPort, createNotifierPort } from './ports.js';

export {
  createCheckpointGitPort,
  createGitPort,
  createLlmPort,
  createNotifierPort,
  createSplitGitPort,
  createStepGitPort,
} from './ports.js';

export interface RuntimeOptions extends Omit<MindlyOptions, 'ports' | 'config'> {
  /** Skip optional model access even if configured (hooks on a tight budget). */
  disableLlm?: boolean;
  /** Skip notifications (e.g. in tests). */
  disableNotify?: boolean;
  /**
   * Follow the event log to record saves (default true). The MCP server passes false so nothing an
   * agent does through MCP can create or change a save.
   */
  saves?: boolean;
}

/**
 * Opens a fully wired Mindly instance: real git, optional model and pager ports, and every
 * default feature module. This is what the CLI, hook handler, MCP server and daemon use.
 */
export function openMindly(options: RuntimeOptions = {}): Mindly {
  const env = options.env ?? process.env;
  const home = options.home ?? mindlyHome(env);
  const paths = ensureHome(home);
  const config: UserConfig = loadUserConfig(paths.config);
  // The notifier is made before the engine and its logger exist: it logs through this.
  const pagerLog: { to: NotifierLog | null } = { to: null };
  const mindly = Mindly.open({
    ...options,
    home,
    config,
    headless: options.headless ?? env['MINDLY_HEADLESS_RUN'] === '1',
    ports: {
      git: createGitPort(),
      ...(options.disableLlm ? {} : { llm: createLlmPort(config.llm, env) }),
      ...(options.disableNotify
        ? {}
        : {
            notifier: createNotifierPort(config.notify, {
              redactPatterns: config.redaction.extraPatterns,
              log: {
                warn: (message, fields) => pagerLog.to?.warn(message, fields),
                debug: (message, fields) => pagerLog.to?.debug(message, fields),
              },
            }),
          }),
    },
  });
  pagerLog.to = mindly.kernel.logger;
  installDefaultModules(mindly, { saves: options.saves !== false });
  return mindly;
}
