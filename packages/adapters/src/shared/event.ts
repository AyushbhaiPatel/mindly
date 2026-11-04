import type {
  HookEventName,
  HookResult,
  NormalizedHookEvent,
  RenderedHookOutput,
} from '@synapse/core';
import { capText } from './payload.js';

/** Builds an event with every optional section empty. */
export function baseEvent(
  agentKind: string,
  event: HookEventName,
  nativeEvent: string,
  externalSessionId: string,
  cwd: string,
): NormalizedHookEvent {
  return {
    agentKind,
    event,
    nativeEvent,
    externalSessionId,
    cwd,
    transcriptPath: null,
    startSource: null,
    prompt: null,
    tool: null,
    lastMessage: null,
  };
}

/** Case-insensitive lookup of a native event name in a mapping table. */
export function lookupEvent<T>(
  table: Readonly<Record<string, T>>,
  nativeEvent: string,
): [string, T] | null {
  if (typeof nativeEvent !== 'string') return null;
  const direct = table[nativeEvent];
  if (direct !== undefined) return [nativeEvent, direct];
  const lower = nativeEvent.toLowerCase();
  for (const [name, value] of Object.entries(table)) {
    if (name.toLowerCase() === lower) return [name, value];
  }
  return null;
}

/** The rendered output that means "do nothing": empty stdout, exit 0. */
export const SILENT: RenderedHookOutput = Object.freeze({ stdout: '', exitCode: 0 });

/** Serialises a JSON hook answer, or stays silent when there is nothing to say. */
export function jsonOutput(obj: Record<string, unknown>): RenderedHookOutput {
  if (Object.keys(obj).length === 0) return SILENT;
  return { stdout: `${JSON.stringify(obj)}\n`, exitCode: 0 };
}

/** Max characters of additional context we hand an agent (Claude Code caps it at 10 000). */
export const MAX_CONTEXT_CHARS = 10_000;
/** Max characters for reasons and user-facing notices. */
export const MAX_NOTICE_CHARS = 2_000;

/** Non-empty, capped context text or null. */
export function contextText(result: HookResult): string | null {
  return result.context !== null && result.context.trim() !== ''
    ? capText(result.context, MAX_CONTEXT_CHARS)
    : null;
}

/** Non-empty, capped user message or null. */
export function userMessageText(result: HookResult): string | null {
  return result.userMessage !== null && result.userMessage.trim() !== ''
    ? capText(result.userMessage, MAX_NOTICE_CHARS)
    : null;
}

/** Reason for a deny/ask decision, with a default. */
export function reasonText(result: HookResult): string {
  return result.reason !== null && result.reason.trim() !== ''
    ? capText(result.reason, MAX_NOTICE_CHARS)
    : 'Blocked by a Synapse project rule.';
}
