import {
  invalidInput,
  isDeniedPath,
  notFound,
  redactText,
  resolveInsideRoot,
  sanitizeLine,
  MindlyError,
  type MemoryKind,
  type Trust,
} from '@mindly/core';
import { sessionLabel } from '../coordination/work.js';
import type { Kernel } from '../kernel.js';
import { readBounded } from '../memory/service.js';
import type { Mindly } from '../mindly.js';
import { attachService } from './shared.js';

/** One recorded agent edit that introduced the line. */
export interface ProvenanceChange {
  sessionId: string;
  agentKind: string | null;
  label: string | null;
  at: number;
  tool: string;
  /** Redacted one-line summary of the prompt that triggered the edit, if recorded. */
  prompt: string | null;
  promptEventId: string | null;
}

/** A memory backed by evidence in the queried file. */
export interface ProvenanceMemory {
  id: string;
  kind: MemoryKind;
  title: string;
  trust: Trust;
  evidenceValid: boolean;
}

/** Answer to `mindly why file:line`. */
export interface ProvenanceResult {
  path: string;
  line: number;
  /** The current line, redacted and sanitised. */
  text: string;
  /** Most recent first; empty when no agent edit is on record for this line. */
  changes: ProvenanceChange[];
  memories: ProvenanceMemory[];
}

/** Code provenance: maps a current line back to the agent session and prompt that wrote it. */
export class ProvenanceService {
  constructor(private readonly k: Kernel) {}

  /**
   * Explains where `file:line` came from. Throws `path_outside_project`, `forbidden`,
   * `not_found` or `invalid_input` for bad input; returns empty `changes` when nothing is known.
   */
  why(projectId: string, projectRoot: string, file: string, line: number): ProvenanceResult {
    if (!Number.isInteger(line) || line < 1) throw invalidInput('line must be a positive integer');
    const resolved = resolveInsideRoot(projectRoot, file);
    if (resolved.rel === '') throw invalidInput('path must be a file in the project');
    if (isDeniedPath(resolved.rel, this.k.config.redaction.denyPaths)) {
      throw new MindlyError('forbidden', 'path is on the deny-list');
    }
    const content = readBounded(resolved.abs);
    if (content === null) throw notFound('file', resolved.rel);
    const raw = content.split(/\r?\n/)[line - 1];
    if (raw === undefined) throw invalidInput('line is beyond the end of the file');
    const rel = resolved.rel;

    const seen = new Set<string>();
    const changes: ProvenanceChange[] = [];
    for (const hash of this.k.ports.git.hunkHashes(raw).slice(0, 5)) {
      for (const c of this.k.store.fileChanges.findByHash(projectId, rel, hash)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        const session = this.k.store.sessions.find(c.sessionId);
        changes.push({
          sessionId: c.sessionId,
          agentKind: session?.agentKind ?? null,
          label: session ? sessionLabel(session) : null,
          at: c.createdAt,
          tool: c.tool,
          prompt: this.promptSummary(projectId, c.promptEventId),
          promptEventId: c.promptEventId,
        });
      }
    }
    changes.sort((a, b) => b.at - a.at);

    const memories: ProvenanceMemory[] = [];
    const byMemory = new Map<string, boolean>();
    for (const e of this.k.store.memories.evidenceForFile(projectId, rel)) {
      byMemory.set(e.memoryId, (byMemory.get(e.memoryId) ?? false) || e.valid);
    }
    for (const [id, valid] of [...byMemory].slice(0, 50)) {
      const m = this.k.store.memories.find(id);
      if (!m || m.status !== 'active') continue;
      memories.push({ id, kind: m.kind, title: m.title, trust: m.trust, evidenceValid: valid });
    }

    return {
      path: rel,
      line,
      text: sanitizeLine(redactText(raw), 500),
      changes,
      memories,
    };
  }

  private promptSummary(projectId: string, eventId: string | null): string | null {
    if (!eventId) return null;
    const evt = this.k.store.events.getById(eventId);
    if (!evt || evt.projectId !== projectId || evt.type !== 'prompt.submitted') return null;
    const summary = evt.payload['summary'];
    return typeof summary === 'string' ? sanitizeLine(redactText(summary), 200) : null;
  }
}

/** Feature module: attaches the provenance service (no bus handlers). */
export const provenanceModule = (mindly: Mindly): void => {
  attachService(mindly, 'provenance', new ProvenanceService(mindly.kernel));
};
