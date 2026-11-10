import { join } from 'node:path';
import {
  ancestorChain,
  createLogger,
  defaultUserConfig,
  describeError,
  fileSink,
  hookAncestryKey,
  homePaths,
  loadUserConfig,
  mindlyHome,
  nullSink,
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
    const result = await mindly.hooks.handle(event);
    rememberClient(mindly, event);
    return result;
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

/**
 * Records which processes started this hook, once per session. The hooks of an agent window and
 * its MCP server are started by the same client process, so a server finds the session that is
 * its own among several of one agent by comparing these with its own ancestors.
 *
 * On Linux this reads a few files under /proc; elsewhere it is one `ps` call, made for the first
 * hook of a session only (an empty result is kept too, so it is not tried again). Whatever goes
 * wrong is ignored: a hook never fails or waits because of it.
 */
export function rememberClient(mindly: unknown, evt: NormalizedHookEvent): void {
  try {
    const kv = (mindly as { store?: { kv?: Mindly['store']['kv'] } }).store?.kv;
    if (!kv) return;
    const key = hookAncestryKey(evt.agentKind, evt.externalSessionId);
    if (evt.event === 'session_end') {
      kv.delete(key);
      return;
    }
    if (evt.event !== 'session_start' && kv.get<unknown>(key) !== null) return;
    kv.set(key, ancestorChain(process.pid));
  } catch {
    // Not knowing the client only means the server falls back to its guess.
  }
}

function closeQuietly(mindly: Pick<Mindly, 'close'> | null): void {
  try {
    mindly?.close();
  } catch {
    // Closing must never turn a successful hook into a failure.
  }
}
