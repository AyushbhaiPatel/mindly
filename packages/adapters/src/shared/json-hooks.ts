import { MindlyError } from '@mindly/core';
import { isMindlyHookCommand } from './command.js';
import { ensureRecord } from './config-files.js';
import { isRecord } from './payload.js';

/** One hook Mindly registers. */
export interface HookSpec {
  /** Native event name, e.g. `PreToolUse` or `beforeSubmitPrompt`. */
  event: string;
  /** Tool-name matcher, when the agent supports one. */
  matcher?: string;
  command: string;
  /** Timeout in the agent's own unit (seconds for most agents, milliseconds for Gemini CLI). */
  timeout?: number;
  /** Display name, for agents that show one (Gemini CLI's `/hooks panel`). */
  name?: string;
}

/**
 * Removes Mindly's hooks for `agentKind` from a Claude Code / Codex style `hooks` object
 * (`{ Event: [{ matcher, hooks: [{ type, command }] }] }`). Matcher groups that only contained
 * Mindly hooks are dropped, as are event keys left empty. User entries are untouched.
 */
export function removeGroupedHooks(hooks: Record<string, unknown>, agentKind: string): void {
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let changed = false;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) {
        kept.push(group);
        continue;
      }
      const inner = group['hooks'] as unknown[];
      const filtered = inner.filter(
        (h) => !(isRecord(h) && isMindlyHookCommand(h['command'], agentKind)),
      );
      if (filtered.length === inner.length) {
        kept.push(group);
        continue;
      }
      changed = true;
      if (filtered.length > 0) kept.push({ ...group, hooks: filtered });
    }
    if (!changed) continue;
    if (kept.length === 0) Reflect.deleteProperty(hooks, event);
    else hooks[event] = kept;
  }
}

/** Appends Mindly matcher groups to a Claude Code / Codex style `hooks` object. */
export function addGroupedHooks(
  hooks: Record<string, unknown>,
  specs: readonly HookSpec[],
  path: string,
): void {
  for (const spec of specs) {
    const list = eventList(hooks, spec.event, path);
    const handler: Record<string, unknown> = { type: 'command', command: spec.command };
    if (spec.name !== undefined) handler['name'] = spec.name;
    if (spec.timeout !== undefined) handler['timeout'] = spec.timeout;
    const group: Record<string, unknown> = {};
    if (spec.matcher !== undefined) group['matcher'] = spec.matcher;
    group['hooks'] = [handler];
    list.push(group);
  }
}

/** Removes Mindly's hooks for `agentKind` from a Cursor style `hooks` object (`{ event: [{ command }] }`). */
export function removeFlatHooks(hooks: Record<string, unknown>, agentKind: string): void {
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter(
      (h) => !(isRecord(h) && isMindlyHookCommand(h['command'], agentKind)),
    );
    if (kept.length === entries.length) continue;
    if (kept.length === 0) Reflect.deleteProperty(hooks, event);
    else hooks[event] = kept;
  }
}

/** Appends Mindly entries to a Cursor style `hooks` object. */
export function addFlatHooks(
  hooks: Record<string, unknown>,
  specs: readonly HookSpec[],
  path: string,
): void {
  for (const spec of specs) {
    const entry: Record<string, unknown> = { command: spec.command };
    if (spec.timeout !== undefined) entry['timeout'] = spec.timeout;
    eventList(hooks, spec.event, path).push(entry);
  }
}

function eventList(hooks: Record<string, unknown>, event: string, path: string): unknown[] {
  const existing = hooks[event];
  if (existing === undefined || existing === null) {
    const created: unknown[] = [];
    hooks[event] = created;
    return created;
  }
  if (!Array.isArray(existing)) {
    throw new MindlyError('invalid_input', `hooks.${event} in ${path} must be an array`);
  }
  return existing;
}

/** Returns the `hooks` object of a config, creating it when absent. */
export function hooksObject(
  config: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  return ensureRecord(config, 'hooks', path);
}

/** Deletes `config[key]` when it is an empty object. */
export function dropIfEmpty(config: Record<string, unknown>, key: string): void {
  const v = config[key];
  if (isRecord(v) && Object.keys(v).length === 0) Reflect.deleteProperty(config, key);
}
