import { z } from 'zod';
import type {
  HookEventName,
  HookResult,
  NormalizedHookEvent,
  RenderedHookOutput,
} from '@mindly/core';
import {
  baseEvent,
  contextText,
  jsonOutput,
  lookupEvent,
  reasonText,
  SILENT,
  userMessageText,
} from './event.js';
import { isRecord, MAX_PATH_CHARS, readNonEmptyString, readString } from './payload.js';
import { buildTool } from './tools.js';

/*
 * Claude Code and Codex share one hook protocol: a JSON object on stdin with `session_id`, `cwd`,
 * `hook_event_name`, `transcript_path` and event-specific fields, and a JSON answer on stdout
 * using `hookSpecificOutput` / `systemMessage`.
 */

/** How a native event maps to Mindly. */
export interface NativeEventSpec {
  event: HookEventName;
  /** The native event only fires for failed tool calls. */
  failed?: boolean;
}

const RequiredSchema = z.looseObject({
  session_id: z.string().trim().min(1).max(512),
  cwd: z.string().min(1).max(MAX_PATH_CHARS),
});

/** Copies camelCase spellings to snake_case when only the former are present. */
function normaliseIds(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  if (out['session_id'] === undefined && out['sessionId'] !== undefined)
    out['session_id'] = out['sessionId'];
  if (out['cwd'] === undefined && out['workingDirectory'] !== undefined)
    out['cwd'] = out['workingDirectory'];
  return out;
}

/** Parses a Claude Code / Codex style hook payload. Never throws. */
export function parseClaudeStyle(
  agentKind: string,
  table: Readonly<Record<string, NativeEventSpec>>,
  nativeEvent: string,
  payload: unknown,
): NormalizedHookEvent | null {
  try {
    const found = lookupEvent(table, nativeEvent);
    if (found === null || !isRecord(payload)) return null;
    const [name, spec] = found;
    const parsed = RequiredSchema.safeParse(normaliseIds(payload));
    if (!parsed.success) return null;
    const p = parsed.data;
    const ev = baseEvent(agentKind, spec.event, name, p.session_id, p.cwd);
    ev.transcriptPath = readNonEmptyString(
      p,
      ['transcript_path', 'transcriptPath'],
      MAX_PATH_CHARS,
    );
    switch (spec.event) {
      case 'session_start':
        ev.startSource = readNonEmptyString(p, ['source'], 64);
        break;
      case 'prompt':
        ev.prompt = readString(p, ['prompt', 'user_prompt']);
        break;
      case 'pre_tool':
      case 'post_tool': {
        const toolName = readNonEmptyString(p, ['tool_name', 'toolName'], 200);
        if (toolName === null) return null;
        const input = p['tool_input'] ?? p['toolInput'] ?? {};
        if (spec.event === 'pre_tool') {
          ev.tool = buildTool({ name: toolName, input });
        } else {
          const response = p['tool_response'] ?? p['tool_output'] ?? p['error'] ?? null;
          ev.tool = buildTool({
            name: toolName,
            input,
            response,
            ...(spec.failed === true ? { failed: true } : {}),
          });
        }
        break;
      }
      case 'stop':
        ev.lastMessage = readString(p, ['last_assistant_message', 'lastAssistantMessage']);
        break;
      case 'session_end':
        break;
    }
    return ev;
  } catch {
    return null;
  }
}

/** Agent-specific rendering capabilities. */
export interface ClaudeStyleRenderOptions {
  /** Native event name to echo in `hookSpecificOutput.hookEventName` per Mindly event. */
  names: Readonly<Record<HookEventName, string>>;
  /** Whether PreToolUse accepts `permissionDecision: "ask"`. */
  supportsAsk: boolean;
  /** Mindly events whose output may carry `systemMessage`. */
  systemMessageEvents: ReadonlySet<HookEventName>;
}

/**
 * Renders a result as Claude Code / Codex hook JSON. `allow` decisions are never emitted (they
 * would bypass the agent's own permission prompts); Stop never gets `additionalContext` (it would
 * keep the agent running).
 */
export function renderClaudeStyle(
  event: NormalizedHookEvent,
  result: HookResult,
  options: ClaudeStyleRenderOptions,
): RenderedHookOutput {
  try {
    const out: Record<string, unknown> = {};
    const hookEventName =
      event.nativeEvent !== undefined && event.nativeEvent !== ''
        ? event.nativeEvent
        : options.names[event.event];
    const specific: Record<string, unknown> = {};
    let context = contextText(result);

    if (event.event === 'pre_tool') {
      if (result.decision === 'deny' || (result.decision === 'ask' && options.supportsAsk)) {
        specific['permissionDecision'] = result.decision;
        specific['permissionDecisionReason'] = reasonText(result);
      } else if (result.decision === 'ask') {
        // No "ask" support: surface the reason as context instead of silently dropping it.
        const reason = reasonText(result);
        context = context === null ? reason : `${reason}\n\n${context}`;
      }
    }
    if (
      context !== null &&
      (event.event === 'session_start' ||
        event.event === 'prompt' ||
        event.event === 'pre_tool' ||
        event.event === 'post_tool')
    ) {
      specific['additionalContext'] = context;
    }
    if (Object.keys(specific).length > 0) {
      out['hookSpecificOutput'] = { hookEventName, ...specific };
    }
    const notice = userMessageText(result);
    if (notice !== null && options.systemMessageEvents.has(event.event)) {
      out['systemMessage'] = notice;
    }
    return jsonOutput(out);
  } catch {
    return SILENT;
  }
}
