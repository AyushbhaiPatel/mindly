import { statSync, type Stats } from 'node:fs';
import { REDACTED, sha256, type MemoryEvidence, type Session } from '@mindly/core';
import type { TelepathyService } from '../coordination/telepathy.js';
import type { BusEvents, Kernel } from '../kernel.js';
import { stripManagedSection } from '../memory/managed-section.js';
import { parseCitedLines, parseSpan, spanIn } from '../memory/evidence-hash.js';
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
   * `unknown` when the file could not be read (too large, unreadable, denied), or when evidence
   * stored with the earlier kind of hash could not be placed in it.
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
/** Candidate texts hashed for one excerpt stored with the earlier kind of hash. */
const MAX_LEGACY_TRIES = 300;
/** Occurrences of either end visited for one such excerpt: the work stays linear and small. */
const MAX_LEGACY_OCCURRENCES = 200_000;

/** What a look for an excerpt says: it is there, it is not, or that could not be told. */
export type ExcerptState = 'present' | 'absent' | 'unknown';

/** A file as evidence is compared against it: normalised once, with its line runs hashed on demand. */
interface NormFile {
  content: string;
  /** True when some run of `n` whole lines of the file has this hash. */
  hasLines(n: number, hash: string): boolean;
}

function normFile(normContent: string): NormFile {
  let lines: string[] | null = null;
  const runs = new Map<number, Set<string>>();
  return {
    content: normContent,
    hasLines(n, hash) {
      let set = runs.get(n);
      if (!set) {
        lines ??= normContent.split('\n').slice(0, MAX_WINDOW_LINES);
        set = new Set<string>();
        for (let i = 0; i + n <= lines.length; i++) {
          set.add(sha256(n === 1 ? (lines[i] as string) : lines.slice(i, i + n).join('\n')));
        }
        runs.set(n, set);
      }
      return set.has(hash);
    },
  };
}

/**
 * Decides whether an evidence excerpt is still present in `content`: the normalised stored
 * excerpt is in it as a substring, the way it was accepted. Evidence stored in another form than
 * it was found (redacted, sanitised) carries a hash of the text that was found, and holds while
 * that text occurs anywhere in the file (see `evidenceHash`). Either way it is one pass over the
 * file, whatever the excerpt's length.
 */
export function excerptPresent(
  content: string,
  excerpt: string,
  contentHash: string | null,
): boolean {
  return excerptState(content, excerpt, contentHash) === 'present';
}

/**
 * `excerptPresent` that also says when it could not tell. That only happens for evidence stored
 * with the earlier kind of hash for a redacted excerpt.
 */
export function excerptState(
  content: string,
  excerpt: string,
  contentHash: string | null,
): ExcerptState {
  return excerptIn(normFile(normalizeBlock(content)), excerpt, contentHash);
}

function excerptIn(file: NormFile, excerpt: string, contentHash: string | null): ExcerptState {
  const normExcerpt = normalizeBlock(excerpt);
  if (normExcerpt.length > 0 && file.content.includes(normExcerpt)) return 'present';
  if (!contentHash) return 'absent';
  const span = parseSpan(contentHash);
  if (span) return spanIn(file.content, span) ? 'present' : 'absent';
  // Hashes of whole lines, written by an earlier build of this release only.
  const cited = parseCitedLines(contentHash);
  if (cited) return file.hasLines(cited.lines, cited.hash) ? 'present' : 'absent';

  // The bare hash of the excerpt.
  if (normExcerpt.length > 0 && sha256(normExcerpt) === contentHash) {
    // The stored excerpt is what was found; the substring test above is authoritative.
    return 'absent';
  }
  // Stored redacted by an earlier version: the original was a run of whole lines, or a part of one.
  // Either way it holds the text the redaction left; when the longest piece of it is not in the
  // file there is nothing to hash. (A piece with a neutralised delimiter differs from the file.)
  const key = normExcerpt.split(REDACTED).reduce((a, b) => (b.length > a.length ? b : a), '');
  if (key.length > 0 && !key.includes('‹') && !file.content.includes(key)) return 'absent';
  if (file.hasLines(Math.max(1, normExcerpt.split('\n').length), contentHash)) return 'present';
  return legacyPartIn(file.content, normExcerpt, contentHash);
}

/**
 * Evidence stored with the hash of its excerpt, where the excerpt was part of a line and was
 * redacted. The text before the first redaction and after the last one is as it was, so the
 * original starts at an occurrence of the first and ends at an occurrence of the second, and the
 * hash says which pair. An excerpt that opens or closes with a redaction has no such start or
 * end and cannot be placed.
 *
 * Both ends are found in one forward pass, and only pairs close enough to be an excerpt are
 * hashed, nearest first. A few hundred hashes at most, and the occurrences visited are bounded
 * too; past either limit the answer is `unknown` and the evidence keeps the validity it had.
 */
function legacyPartIn(normContent: string, normExcerpt: string, contentHash: string): ExcerptState {
  const parts = normExcerpt.split(REDACTED);
  const head = parts[0] as string;
  const tail = parts[parts.length - 1] as string;
  if (parts.length < 2 || head === '' || tail === '') return 'absent';
  const heads: number[] = [];
  for (let h = normContent.indexOf(head); h !== -1; h = normContent.indexOf(head, h + 1)) {
    if (heads.length >= MAX_LEGACY_OCCURRENCES) return 'unknown';
    heads.push(h);
  }
  // Without its start the text cannot be there: no need to look at the ends.
  if (heads.length === 0) return 'absent';
  let tries = 0;
  let visited = 0;
  // Heads in [lo, hi) can start an original that ends at the current tail.
  let lo = 0;
  let hi = 0;
  for (let t = normContent.indexOf(tail, heads[0]! + head.length); t !== -1;) {
    if (++visited > MAX_LEGACY_OCCURRENCES) return 'unknown';
    const end = t + tail.length;
    while (hi < heads.length && (heads[hi] as number) + head.length <= t) hi++;
    while (lo < hi && end - (heads[lo] as number) > MAX_ORIGINAL_CHARS) lo++;
    for (let i = hi - 1; i >= lo; i--) {
      if (++tries > MAX_LEGACY_TRIES) return 'unknown';
      if (sha256(normContent.slice(heads[i] as number, end)) === contentHash) return 'present';
    }
    // No head left that a later tail could close: done.
    if (lo === heads.length) break;
    t = normContent.indexOf(tail, t + 1);
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
    // Taken before the content is read, so it describes no newer file than the one read.
    let st: Stats;
    try {
      st = statSync(p.abs);
    } catch {
      return { kind: 'missing' };
    }
    if (!st.isFile()) return { kind: 'missing' };
    const content = readBounded(p.abs);
    if (content === null) return { kind: 'unreadable' };
    let file: NormFile | null = null;
    return {
      kind: 'present',
      seen: `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`,
      // Rules Mindly wrote into an instruction file are not evidence for those same rules.
      file: () => (file ??= normFile(normalizeBlock(stripManagedSection(content)))),
    };
  }

  /** Where it is kept what a file looked like when a piece of evidence was found gone from it. */
  private goneKey(projectId: string, evidenceId: string): string {
    return `self-healing:gone:${projectId}:${evidenceId}`;
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
    const goneKey = this.goneKey(projectId, e.id);
    if (file.kind === 'present' && !e.valid && this.k.store.kv.get<string>(goneKey) === file.seen) {
      // Found gone from this very file (same size, times and inode): nothing to look at again.
      // Anything else, an older time or another inode included, is looked at.
      return { ...base, state: 'invalid', markedStale: false, restored: false };
    }
    const found =
      file.kind !== 'present'
        ? 'absent'
        : e.excerpt === null
          ? 'present'
          : excerptIn(file.file(), e.excerpt, e.contentHash);
    if (found === 'unknown') {
      // Evidence with the earlier kind of hash that could not be placed: it stays as it was.
      return { ...base, state: 'unknown', markedStale: false, restored: false };
    }
    const valid = found === 'present';
    this.k.store.memories.markEvidence(e.id, valid);
    if (valid || file.kind !== 'present') this.k.store.kv.delete(goneKey);
    else this.k.store.kv.set(goneKey, file.seen);
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

/** A present file is normalised once, when the first evidence row needs it. */
type FileState =
  /** `seen`: size, modification and change times and inode of the file when it was read. */
  | { kind: 'present'; seen: string; file: () => NormFile }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

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
