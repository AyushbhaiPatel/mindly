import { loadUserConfig, ensureHome, mindlyHome, type UserConfig } from '@mindly/core';
import { installDefaultModules, Mindly, type MindlyOptions } from '@mindly/engine';
import { createGitPort, createLlmPort, createNotifierPort } from './ports.js';

export { createGitPort, createLlmPort, createNotifierPort } from './ports.js';

export interface RuntimeOptions extends Omit<MindlyOptions, 'ports' | 'config'> {
  /** Skip optional model access even if configured (hooks on a tight budget). */
  disableLlm?: boolean;
  /** Skip notifications (e.g. in tests). */
  disableNotify?: boolean;
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
  const mindly = Mindly.open({
    ...options,
    home,
    config,
    headless: options.headless ?? env['MINDLY_HEADLESS_RUN'] === '1',
    ports: {
      git: createGitPort(),
      ...(options.disableLlm ? {} : { llm: createLlmPort(config.llm, env) }),
      ...(options.disableNotify ? {} : { notifier: createNotifierPort(config.notify) }),
    },
  });
  installDefaultModules(mindly);
  return mindly;
}
