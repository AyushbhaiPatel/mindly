import { statSync } from 'node:fs';
import { REDACTED, sha256, type MemoryEvidence, type Session } from '@mindly/core';
import type { TelepathyService } from '../coordination/telepathy.js';
import type { BusEvents, Kernel } from '../kernel.js';
import { stripManagedSection } from '../memory/managed-section.js';
import { normalizeBlock, readBounded, type MemoryService } from '../memory/service.js';
import type { Mindly } from '../mindly.js';
import {
  attachService,
  guarded,
  liveSessions,
  MAX_FILES_PER_EVENT,
  safeProjectPath,
} from './shared.js';

const MAX_SWEEP_EVIDENCE = 2000;
const MAX_WINDOW_LINES = 20_000;

/** Outcome of re-checking one evidence row. */
export interface EvidenceCheck {
  evidenceId: string;
  memoryId: string;
  path: string;
  /** `unknown` when the file could not be read (too large, unreadable, denied). */
  state: 'valid' | 'invalid' | 'unknown';
  /** True when this check marked the memory stale. */
  markedStale: boolean;
  /** True when invalid evidence became valid again. */
  restored: boolean;
}

/** Summary of a project-wide sweep. */
export interface SweepResult {
  checked: number;
  invalid: number;
  markedStale: number;
  restored: number;
}

/** Starts and ends tried when looking for the original text of a redacted excerpt. */
const MAX_REDACTED_ANCHORS = 24;
/** The longest original a stored excerpt can stand for (excerpts are capped at 2000 characters). */
const MAX_ORIGINAL_CHARS = 4000;

/**
 * Decides whether an evidence excerpt is still present in `content`. Matches the normalised
 * stored excerpt as a substring, the way it was accepted when the memory was stored. A stored
 * excerpt that was redacted or sanitised differs from the original, so it is looked for through
 * the stored content hash: any run of whole normalised lines, or the text between what stands
 * before and after a redaction, whose hash equals it.
 */
export function excerptPresent(
  content: string,
  excerpt: string,
  contentHash: string | null,
): boolean {
  return excerptIn(normalizeBlock(content), excerpt, contentHash);
}

/** `excerptPresent` for content that is already normalised (a file is normalised once). */
function excerptIn(normContent: string, excerpt: string, contentHash: string | null): boolean {
  const normExcerpt = normalizeBlock(excerpt);
  if (normExcerpt.length > 0 && normContent.includes(normExcerpt)) return true;
  if (!contentHash) return false;
  if (normExcerpt.length > 0 && sha256(normExcerpt) === contentHash) {
    // The stored excerpt is the original; the substring test above is authoritative.
    return false;
  }
  const n = Math.max(1, normExcerpt.split('\n').length);
  const lines = normContent.split('\n').slice(0, MAX_WINDOW_LINES);
  for (let i = 0; i + n <= lines.length; i++) {
    if (sha256(lines.slice(i, i + n).join('\n')) === contentHash) return true;
  }
  return redactedPresent(normContent, normExcerpt, contentHash);
}

/**
 * Looks for the original of a redacted excerpt that is not a run of whole lines (a part of a
 * line, or text whose redaction removed lines). The text before the first redaction and after
 * the last one is as it was: the original starts at an occurrence of the first and ends at an
 * occurrence of the second, and the hash says which. When a redaction opens or closes the
 * excerpt there is no such start or end; the excerpt then holds while its remaining parts are
 * still there, in order.
 */
function redactedPresent(normContent: string, normExcerpt: string, contentHash: string): boolean {
  const parts = normExcerpt.split(REDACTED);
  if (parts.length < 2) return false;
  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  if (first === '' || last === '') {
    let at = 0;
    for (const part of parts) {
      if (part === '') continue;
      const found = normContent.indexOf(part, at);
      if (found === -1) return false;
      at = found + part.length;
    }
    // When nothing but a redaction is left of the excerpt, it cannot be shown to have changed.
    return true;
  }
  let start = normContent.indexOf(first);
  for (let i = 0; start !== -1 && i < MAX_REDACTED_ANCHORS; i++) {
    let end = normContent.indexOf(last, start + first.length);
    for (let j = 0; end !== -1 && j < MAX_REDACTED_ANCHORS; j++) {
      const stop = end + last.length;
      if (stop - start > MAX_ORIGINAL_CHARS) break;
      if (sha256(normContent.slice(start, stop)) === contentHash) return true;
      end = normContent.indexOf(last, end + 1);
    }
    start = normContent.indexOf(first, start + 1);
  }
  return false;
}

/**
 * Self-healing memory: when a file changes, re-checks every memory whose evidence points at it.
 * Evidence that no longer exists marks the memory `stale` and tells the live sessions. Evidence
 * that reappears is marked valid again, but trust is never restored automatically.
 */
export class SelfHealingService {
  constructor(
    private readonly k: Kernel,
    private readonly memory: MemoryService,
    private readonly telepathy: TelepathyService,
  ) {}

  /** Bus entry point. Never throws. */
  async onFilesChanged(p: BusEvents['files.changed']): Promise<EvidenceCheck[]> {
    const out: EvidenceCheck[] = [];
    for (const f of p.files.slice(0, MAX_FILES_PER_EVENT)) {
      await guarded(this.k, 'self-healing', () => {
        out.push(...this.recheckFile(p.projectId, p.projectRoot, f.path, p.session));
      });
    }
    return out;
  }

  /** Re-checks all evidence rows referencing `path`. `actor` is the session that changed it. */
  recheckFile(
    projectId: string,
    projectRoot: string,
    path: string,
    actor: Session | null,
  ): EvidenceCheck[] {
    const rows = this.k.store.memories.evidenceForFile(projectId, path);
    if (rows.length === 0) return [];
    const reader = this.fileReader(projectRoot);
    return rows.map((e) => this.check(projectId, e, reader, actor));
  }

  /**
   * Re-checks all file evidence of a project (bounded); used by the daemon's periodic sweep.
   * Files are read at most once each.
   */
  sweep(projectId: string, max = MAX_SWEEP_EVIDENCE): SweepResult {
    const project = this.k.store.projects.get(projectId);
    const reader = this.fileReader(project.root);
    const result: SweepResult = { checked: 0, invalid: 0, markedStale: 0, restored: 0 };
    for (const e of this.k.store.memories.allFileEvidence(projectId, max)) {
      const c = this.check(projectId, e, reader, null);
      if (c.state === 'unknown') continue;
      result.checked++;
      if (c.state === 'invalid') result.invalid++;
      if (c.markedStale) result.markedStale++;
      if (c.restored) result.restored++;
    }
    return result;
  }

  private fileReader(projectRoot: string): (rel: string) => FileState {
    const cache = new Map<string, FileState>();
    return (rel) => {
      const hit = cache.get(rel);
      if (hit) return hit;
      const state = this.readFile(projectRoot, rel);
      cache.set(rel, state);
      return state;
    };
  }

  private readFile(projectRoot: string, rel: string): FileState {
    const p = safeProjectPath(this.k, projectRoot, rel);
    if (!p) return { kind: 'unreadable' };
    let isFile: boolean;
    try {
      isFile = statSync(p.abs).isFile();
    } catch {
      return { kind: 'missing' };
    }
    if (!isFile) return { kind: 'missing' };
    const content = readBounded(p.abs);
    // Rules Mindly wrote into an instruction file are not evidence for those same rules.
    return content === null
      ? { kind: 'unreadable' }
      : { kind: 'present', content: normalizeBlock(stripManagedSection(content)) };
  }

  private check(
    projectId: string,
    e: MemoryEvidence,
    read: (rel: string) => FileState,
    actor: Session | null,
  ): EvidenceCheck {
    const base = { evidenceId: e.id, memoryId: e.memoryId, path: e.ref };
    const file = read(e.ref);
    if (file.kind === 'unreadable') {
      return { ...base, state: 'unknown', markedStale: false, restored: false };
    }
    const valid =
      file.kind === 'present' &&
      (e.excerpt === null || excerptIn(file.content, e.excerpt, e.contentHash));
    this.k.store.memories.markEvidence(e.id, valid);
    if (valid) {
      return { ...base, state: 'valid', markedStale: false, restored: !e.valid };
    }
    let markedStale = false;
    const m = this.k.store.memories.find(e.memoryId);
    if (m && m.status === 'active' && m.trust !== 'stale' && m.trust !== 'rejected') {
      const reason =
        file.kind === 'missing' ? `${e.ref} was deleted` : `evidence in ${e.ref} changed`;
      const stale = this.memory.markStale(m.id, reason);
      markedStale = true;
      const recipients = liveSessions(this.k, projectId).map((s) => s.id);
      if (actor && !recipients.includes(actor.id)) recipients.push(actor.id);
      if (recipients.length > 0) {
        this.telepathy.send({
          projectId,
          // `from: null` so the acting session is notified as well.
          from: null,
          to: { sessionIds: recipients },
          kind: 'stale_memory',
          priority: 6,
          title: `Memory "${stale.title}" may be outdated because ${e.ref} changed`,
          body: `The ${stale.kind} relied on text in ${e.ref} that is no longer there. It is now marked stale; verify it before relying on it, and update or archive it if it no longer holds.`,
          dedupeKey: `stale:${m.id}:${e.id}`,
        });
      }
    }
    return { ...base, state: 'invalid', markedStale, restored: false };
  }
}

/** `content` is normalised (`normalizeBlock`) once, for every evidence row of the file. */
type FileState =
  { kind: 'present'; content: string } | { kind: 'missing' } | { kind: 'unreadable' };

/** Feature module: re-verifies memory evidence on `files.changed`. */
export const selfHealingModule = (mindly: Mindly): void => {
  const service = attachService(
    mindly,
    'self-healing',
    new SelfHealingService(mindly.kernel, mindly.memory, mindly.telepathy),
  );
  mindly.bus.on('files.changed', 'self-healing', async (p) => {
    await service.onFilesChanged(p);
  });
};
