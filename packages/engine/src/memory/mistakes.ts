import { fingerprint, redactText, sanitizeLine, type Memory, type Session } from '@mindly/core';
import type { Kernel } from '../kernel.js';
import type { MemoryService } from './service.js';

/*
 * Mistake memory: failed approaches are remembered and surfaced before an agent repeats them.
 * Today the automatic signal is a failing shell command; agents can also record mistakes
 * explicitly through MCP (`mindly_record_mistake`).
 */

/**
 * Reduces a shell command to a comparable key: the program and its first subcommand, ignoring
 * env assignments, flags and values (`npm test -- --watch` and `npm test` share a key).
 */
export function commandKey(command: string): string {
  const keep: string[] = [];
  for (const t of command.trim().split(/\s+/).slice(0, 12)) {
    if (t === '|' || t === '&&' || t === ';' || t === '||') break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t.startsWith('-')) continue;
    keep.push(t);
    if (keep.length === 2) break;
  }
  return keep.join(' ').toLowerCase().slice(0, 120);
}

export class MistakeService {
  constructor(
    private readonly k: Kernel,
    private readonly memory: MemoryService,
  ) {}

  recordFailedCommand(input: {
    projectId: string;
    projectRoot: string;
    session: Session;
    command: string;
    output: string | null;
  }): Memory | null {
    const key = commandKey(input.command);
    if (!key) return null;
    const command = sanitizeLine(redactText(input.command), 200);
    return this.memory.remember({
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      kind: 'mistake',
      title: `Command fails: ${key}`,
      // Tool output is attacker-influenced (it can echo file contents), so it is never stored or
      // replayed to other agents; the command and the fact that it failed are enough.
      body: `\`${command}\` failed in a ${input.session.agentKind} session.`,
      tags: ['mistake', 'command', `cmd-${fingerprint(key).slice(0, 10)}`],
      source: { type: 'agent', sessionId: input.session.id, agentKind: input.session.agentKind },
      reason: 'command failed',
    });
  }

  /** Mistakes relevant to a command an agent is about to run. */
  forCommand(projectId: string, command: string): Memory[] {
    const key = commandKey(command);
    if (!key) return [];
    const tag = `cmd-${fingerprint(key).slice(0, 10)}`;
    return this.k.store.memories
      .list(projectId, {
        kinds: ['mistake'],
        trust: ['proposed', 'approved', 'verified'],
        limit: 200,
      })
      .filter((m) => m.tags.includes(tag))
      .slice(0, 3);
  }

  /** Mistakes scoped to (or mentioning) a file. */
  forPath(projectId: string, path: string): Memory[] {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return this.k.store.memories
      .search(projectId, `${path} ${base}`, { kinds: ['mistake'], limit: 5 })
      .map((h) => h.memory)
      .filter((m) => m.body.includes(path) || m.scope.paths.length > 0);
  }
}
