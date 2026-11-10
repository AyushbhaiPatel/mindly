import { join } from 'node:path';
import {
  createLogger,
  defaultUserConfig,
  describeError,
  fileSink,
  homePaths,
  loadUserConfig,
  mindlyHome,
  nullSink,
  type HookResult,
  type Logger,
  type NormalizedHookEvent,
} from '@mindly/core';
import { getAdapter } from '@mindly/adapters';
import { notifyOutbox, type Mindly } from '@mindly/engine';
import { openMindly, type RuntimeOptions } from '@mindly/runtime';
import { readStdin, StdinTooLarge, type CliIo } from './io.js';

/** Largest hook payload read from stdin. */
export const MAX_HOOK_STDIN_BYTES = 2 * 1024 * 1024;

/** Injection points for tests. */
export interface HookDeps {
  open: (options: RuntimeOptions) => Pick<Mindly, 'hooks' | 'close'>;
  /**
   * Runs after the agent has its answer, with the time that is left: sends what waits in the
   * pager outbox. Optional so a test double of `open` needs none.
   */
  afterAnswer?: (mindly: Pick<Mindly, 'hooks' | 'close'>, budgetMs: number) => Promise<void>;
}

/** Longest a hook process stays around to send a waiting notification. */
export const HOOK_PAGER_BUDGET_MS = 1200;

const defaultDeps: HookDeps = {
  open: openMindly,
  afterAnswer: (mindly, budgetMs) => notifyOutbox(mindly as Mindly).drain(budgetMs),
};

export { readStdin };

function hookLogger(env: NodeJS.ProcessEnv): Logger {
  try {
    const paths = homePaths(mindlyHome(env));
    return createLogger({
      sink: fileSink(join(paths.logs, 'mindly.log')),
      base: { component: 'hook' },
    });
  } catch {
    return createLogger({ sink: nullSink });
  }
}

function hookTimeoutMs(env: NodeJS.ProcessEnv): number {
  try {
    return loadUserConfig(homePaths(mindlyHome(env)).config).hooks.timeoutMs;
  } catch {
    return defaultUserConfig().hooks.timeoutMs;
  }
}

/**
 * `mindly hook <agent> <nativeEvent>`: the hot path every agent hook calls.
 *
 * Fail-open: whatever goes wrong (unknown agent, oversized or malformed stdin, invalid config,
 * database trouble, the deadline of `hooks.timeoutMs` passing) nothing is printed and the exit
 * code is 0, so the agent carries on. The reason goes to the Mindly log.
 */
export async function runHook(
  agent: string,
  nativeEvent: string,
  io: CliIo,
  deps: HookDeps = defaultDeps,
): Promise<number> {
  const started = Date.now();
  const logger = hookLogger(io.env);
  const fail = (reason: string, fields: Record<string, unknown> = {}): number => {
    logger.warn('hook skipped', { agent, event: nativeEvent, reason, ...fields });
    return 0;
  };

  const adapter = getAdapter(agent);
  if (!adapter) return fail('unknown agent');

  let raw: string;
  try {
    raw = await readStdin(io.stdin, MAX_HOOK_STDIN_BYTES);
  } catch (err) {
    return fail(err instanceof StdinTooLarge ? 'payload too large' : 'stdin unreadable');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail('payload is not JSON');
  }

  let evt: NormalizedHookEvent | null;
  try {
    evt = adapter.parse(nativeEvent, payload);
  } catch (err) {
    return fail('payload rejected', { error: describeError(err) });
  }
  if (!evt) return 0;
  const event = evt;

  const timeoutMs = hookTimeoutMs(io.env);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const opened: { mindly: Pick<Mindly, 'hooks' | 'close'> | null } = { mindly: null };
  const work = (async (): Promise<HookResult> => {
    // Yield once so the deadline timer is armed before any synchronous database work.
    await Promise.resolve();
    const mindly = deps.open({ env: io.env, disableNotify: false });
    opened.mindly = mindly;
    return mindly.hooks.handle(event);
  })();

  let outcome: HookResult | 'timeout';
  try {
    outcome = await Promise.race([work, deadline]);
  } catch (err) {
    clearTimeout(timer);
    closeQuietly(opened.mindly);
    return fail('hook failed', { error: describeError(err) });
  }
  clearTimeout(timer);
  if (outcome === 'timeout') {
    // The handler keeps running in the background; main.ts exits the process right away.
    work.catch(() => undefined);
    return fail('deadline exceeded', { timeoutMs });
  }

  let rendered: { stdout: string; exitCode: number };
  try {
    rendered = adapter.render(event, outcome);
  } catch (err) {
    closeQuietly(opened.mindly);
    return fail('render failed', { error: describeError(err) });
  }
  logger.debug('hook handled', { agent, event: nativeEvent, ms: Date.now() - started });
  if (rendered.stdout !== '') io.stdout.write(rendered.stdout);

  // The agent has its answer. A notification raised by this hook (or left by an earlier one)
  // is sent now, within what is left of the hook's own deadline; what does not get out in time
  // stays in the outbox for the daemon or the next hook.
  const left = Math.min(HOOK_PAGER_BUDGET_MS, timeoutMs - (Date.now() - started) - 50);
  if (deps.afterAnswer && opened.mindly && left >= 100) {
    try {
      await deps.afterAnswer(opened.mindly, left);
    } catch (err) {
      logger.warn('pager outbox skipped', { error: describeError(err) });
    }
  }
  closeQuietly(opened.mindly);
  return rendered.exitCode;
}

function closeQuietly(mindly: Pick<Mindly, 'close'> | null): void {
  try {
    mindly?.close();
  } catch {
    // Closing must never turn a successful hook into a failure.
  }
}
