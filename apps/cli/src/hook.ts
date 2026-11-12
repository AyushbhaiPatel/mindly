import { join } from 'node:path';
import {
  ancestorChain,
  createLogger,
  defaultUserConfig,
  describeError,
  fileSink,
  HOOK_ANCESTRY_PREFIX,
  HOOK_ANCESTRY_RETRY_MS,
  HOOK_ANCESTRY_TTL_MS,
  hookAncestryKey,
  homePaths,
  type AncestryRetry,
  type ProcessRef,
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
export function rememberClient(
  mindly: unknown,
  evt: NormalizedHookEvent,
  options: { now?: number; chain?: () => ProcessRef[] } = {},
): void {
  try {
    const kv = (mindly as { store?: { kv?: Mindly['store']['kv'] } }).store?.kv;
    if (!kv) return;
    const now = options.now ?? Date.now();
    const key = hookAncestryKey(evt.agentKind, evt.externalSessionId);
    if (evt.event === 'session_end') {
      kv.delete(key);
      return;
    }
    const stored = kv.get<unknown>(key);
    if (evt.event !== 'session_start' && stored !== null) {
      // Recorded already, or not readable a moment ago: try again only once that has passed.
      const retry = (stored as Partial<AncestryRetry>).retryAfter;
      if (typeof retry !== 'number' || retry > now) return;
    }
    // Sessions that ended without a session end (a closed window) leave their record behind;
    // a new session clears out the ones nobody wrote for a long time, a bounded number at once.
    if (evt.event === 'session_start') {
      kv.deleteStale?.(HOOK_ANCESTRY_PREFIX, now - HOOK_ANCESTRY_TTL_MS, 50);
    }
    // Only PIDs and start times are kept: the program names are not needed to match a session.
    const chain = (options.chain ?? (() => ancestorChain(process.pid)))().map(({ pid, start }) => ({
      pid,
      start,
    }));
    // Nothing read (a slow or failing process table) is not stored as an answer: the next hook
    // tries again, a minute later at the earliest.
    const retry: AncestryRetry = { retryAfter: now + HOOK_ANCESTRY_RETRY_MS };
    kv.set(key, chain.length > 0 ? chain : retry);
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
