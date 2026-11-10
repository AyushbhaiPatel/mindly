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
  /**
   * `unknown` when the file could not be read (too large, unreadable, denied), or when a redacted
   * excerpt could not be placed within the work allowed for one check.
   */
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

/** The longest original a stored excerpt can stand for (excerpts are capped at 2000 characters). */
const MAX_ORIGINAL_CHARS = 4000;
/** Candidate texts hashed while looking for the original of one redacted excerpt. */
const MAX_REDACTED_TRIES = 20_000;
/** Places inside one line, and neighbouring lines, tried for an edge that was redacted. */
const MAX_EDGE_IN_LINE = 48;
const MAX_EDGE_LINES = 20;
/** Where a value can start or end inside a line. */
const BOUNDARY = /[\s"'`,;:=(){}[\]<>]/;

/** What a look for an excerpt says: it is there, it is not, or that could not be told in budget. */
export type ExcerptState = 'present' | 'absent' | 'unknown';

/**
 * Decides whether an evidence excerpt is still present in `content`. Matches the normalised
 * stored excerpt as a substring, the way it was accepted when the memory was stored. A stored
 * excerpt that was redacted or sanitised differs from the original, so the original is looked
 * for through the stored content hash: any run of whole normalised lines, or a text placed by
 * what the redaction left of the excerpt, whose hash equals it.
 */
export function excerptPresent(
  content: string,
  excerpt: string,
  contentHash: string | null,
): boolean {
  return excerptState(content, excerpt, contentHash) === 'present';
}

/** `excerptPresent` that also says when the answer could not be worked out within its budget. */
export function excerptState(
  content: string,
  excerpt: string,
  contentHash: string | null,
): ExcerptState {
  return excerptIn(normalizeBlock(content), excerpt, contentHash);
}

/** `excerptState` for content that is already normalised (a file is normalised once). */
function excerptIn(normContent: string, excerpt: string, contentHash: string | null): ExcerptState {
  const normExcerpt = normalizeBlock(excerpt);
  if (normExcerpt.length > 0 && normContent.includes(normExcerpt)) return 'present';
  if (!contentHash) return 'absent';
  if (normExcerpt.length > 0 && sha256(normExcerpt) === contentHash) {
    // The stored excerpt is the original; the substring test above is authoritative.
    return 'absent';
  }
  const n = Math.max(1, normExcerpt.split('\n').length);
  const lines = normContent.split('\n').slice(0, MAX_WINDOW_LINES);
  for (let i = 0; i + n <= lines.length; i++) {
    if (sha256(lines.slice(i, i + n).join('\n')) === contentHash) return 'present';
  }
  return redactedIn(normContent, normExcerpt, contentHash);
}

/** Where the original may start when the excerpt opens with a redaction: nearest places first. */
function edgeStarts(content: string, anchor: number): number[] {
  const lineStart = content.lastIndexOf('\n', anchor - 1) + 1;
  const out = [lineStart];
  for (let i = anchor - 1; i > lineStart && out.length < MAX_EDGE_IN_LINE; i--) {
    if (BOUNDARY.test(content[i - 1] as string)) out.push(i);
  }
  // A redaction can have taken whole lines before this one (a key block).
  let at = lineStart;
  for (let n = 0; n < MAX_EDGE_LINES && at > 0; n++) {
    at = content.lastIndexOf('\n', at - 2) + 1;
    out.push(at);
  }
  return out;
}

/** Where the original may end when the excerpt closes with a redaction: nearest places first. */
function edgeEnds(content: string, anchorEnd: number): number[] {
  const nl = content.indexOf('\n', anchorEnd);
  const lineEnd = nl === -1 ? content.length : nl;
  const out = [lineEnd];
  for (let i = anchorEnd + 1; i < lineEnd && out.length < MAX_EDGE_IN_LINE; i++) {
    if (BOUNDARY.test(content[i] as string)) out.push(i);
  }
  let at = lineEnd;
  for (let n = 0; n < MAX_EDGE_LINES && at < content.length; n++) {
    const next = content.indexOf('\n', at + 1);
    at = next === -1 ? content.length : next;
    out.push(at);
  }
  return out;
}

/**
 * Looks for the original of a redacted excerpt that is not a run of whole lines (a part of a
 * line, or text whose redaction removed lines). The stored hash is the judge throughout: a
 * candidate counts only when its hash is the stored one.
 *
 * What the redaction left of the excerpt is as it was, so the original lies around an occurrence
 * of that text. An edge that is fixed text gives the start or end exactly. An edge that was
 * redacted is tried at the places a value can start or end: the boundary of its line, the
 * separators inside the line, and the lines next to it. An excerpt that is nothing but a
 * redaction is tried as each value of the file. When the candidates run past the budget the
 * answer is `unknown`, never `absent`.
 */
function redactedIn(normContent: string, normExcerpt: string, contentHash: string): ExcerptState {
  const parts = normExcerpt.split(REDACTED);
  if (parts.length < 2) return 'absent';
  let tries = 0;
  const is = (start: number, end: number): boolean | null => {
    if (end <= start || end - start > MAX_ORIGINAL_CHARS) return false;
    if (++tries > MAX_REDACTED_TRIES) return null;
    return sha256(normContent.slice(start, end)) === contentHash;
  };
  const fixed = parts.filter((p) => p !== '');
  if (fixed.length === 0) {
    // Only a secret was quoted: it stood between two separators.
    let start = 0;
    for (let i = 0; i <= normContent.length; i++) {
      if (i < normContent.length && !BOUNDARY.test(normContent[i] as string)) continue;
      if (i > start) {
        const hit = is(start, i);
        if (hit === null) return 'unknown';
        if (hit) return 'present';
      }
      start = i + 1;
    }
    return 'absent';
  }
  const head = fixed[0] as string;
  const tail = fixed[fixed.length - 1] as string;
  const openEdge = parts[0] === '';
  const closeEdge = parts[parts.length - 1] === '';
  for (let a = normContent.indexOf(head); a !== -1; a = normContent.indexOf(head, a + 1)) {
    const starts = openEdge ? edgeStarts(normContent, a) : [a];
    let from = a + head.length;
    for (;;) {
      // With one piece of fixed text, that piece is both ends.
      const t = fixed.length === 1 ? a : normContent.indexOf(tail, from);
      if (t === -1) break;
      const anchorEnd = t + (fixed.length === 1 ? head.length : tail.length);
      if (anchorEnd - a > MAX_ORIGINAL_CHARS) break;
      const ends = closeEdge ? edgeEnds(normContent, anchorEnd) : [anchorEnd];
      for (const start of starts) {
        for (const end of ends) {
          const hit = is(start, end);
          if (hit === null) return 'unknown';
          if (hit) return 'present';
        }
      }
      if (fixed.length === 1) break;
      from = t + 1;
    }
    if (++tries > MAX_REDACTED_TRIES) return 'unknown';
  }
  return 'absent';
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
    const found =
      file.kind !== 'present'
        ? 'absent'
        : e.excerpt === null
          ? 'present'
          : excerptIn(file.content, e.excerpt, e.contentHash);
    if (found === 'unknown') {
      // Too many places the redacted text could be: what was known before stays as it is.
      return { ...base, state: 'unknown', markedStale: false, restored: false };
    }
    const valid = found === 'present';
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
