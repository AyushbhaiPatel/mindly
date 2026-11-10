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
  type AgentAdapter,
  type HookResult,
  type Logger,
  type NormalizedHookEvent,
} from '@mindly/core';
import { getAdapter } from '@mindly/adapters';
import type { Mindly } from '@mindly/engine';
import { openMindly, type RuntimeOptions } from '@mindly/runtime';
import { readStdin, StdinTooLarge, type CliIo } from './io.js';

/** Largest hook payload read from stdin. */
export const MAX_HOOK_STDIN_BYTES = 2 * 1024 * 1024;

/** Injection points for tests. */
export interface HookDeps {
  open: (options: RuntimeOptions) => Pick<Mindly, 'hooks' | 'close'>;
}

const defaultDeps: HookDeps = { open: openMindly };

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
    if (!(err instanceof StdinTooLarge)) return fail('stdin unreadable');
    // A write too large to read cannot be checked: refused, not let through unchecked.
    const refused = refuseUnreadWrite(adapter, nativeEvent, io.cwd, err.toolName);
    if (refused !== null) io.stdout.write(refused.stdout);
    return refused === null ? fail('payload too large') : refused.exitCode;
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
  closeQuietly(opened.mindly);

  let rendered: { stdout: string; exitCode: number };
  try {
    rendered = adapter.render(event, outcome);
  } catch (err) {
    return fail('render failed', { error: describeError(err) });
  }
  logger.debug('hook handled', { agent, event: nativeEvent, ms: Date.now() - started });
  if (rendered.stdout !== '') io.stdout.write(rendered.stdout);
  return rendered.exitCode;
}

function closeQuietly(mindly: Pick<Mindly, 'close'> | null): void {
  try {
    mindly?.close();
  } catch {
    // Closing must never turn a successful hook into a failure.
  }
}

/**
 * The answer to a pre-tool event of a writing or shell tool whose payload was too large to read:
 * a refusal, rendered as the agent expects. Null for any other event, and when the tool cannot
 * be told from how the payload starts: those fail open.
 */
function refuseUnreadWrite(
  adapter: AgentAdapter,
  nativeEvent: string,
  cwd: string,
  name: string | null,
): { stdout: string; exitCode: number } | null {
  try {
    // Only the event name and the payload's tool name are known: a stand-in payload tells what
    // kind of event and tool it is.
    const stand = { session_id: 'x', conversation_id: 'x', cwd, workspace_roots: [cwd] };
    const input = { file_path: 'x', content: '', command: 'x' };
    // Without a name, only an event that is a write or a shell command whatever the tool counts.
    const evt = adapter.parse(nativeEvent, {
      ...stand,
      tool_name: name ?? 'Read',
      tool_input: input,
    });
    if (evt?.event !== 'pre_tool' || !(evt.tool?.writes || evt.tool?.shell)) return null;
    return adapter.render(evt, {
      context: null,
      userMessage: null,
      decision: 'deny',
      reason:
        'Mindly could not check this change: it is too large to check. Make the change in smaller steps.',
    });
  } catch {
    return null;
  }
}
