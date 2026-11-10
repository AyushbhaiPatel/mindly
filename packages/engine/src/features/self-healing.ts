import { createHash } from 'node:crypto';
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

/** The longest excerpt that was stored (excerpts are capped at 2000 characters before cleaning). */
const MAX_EXCERPT_CHARS = 2000;
/** Hashes taken while extending an excerpt that was stored cut short. */
const MAX_CUT_DIGESTS = 6000;
/**
 * Characters hashed per file for runs of whole lines, for evidence of earlier forms. Past it the
 * answer is `unknown` and the evidence keeps the validity it had (one large file, long excerpts).
 */
const MAX_LINE_RUN_WORK = 16_000_000;

/** Removed when an excerpt is made safe (`sanitizeForContext`), which this follows. */
const UNSAFE_CHAR_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
/** Neutralised when an excerpt is made safe: its `<` becomes `‹`. */
const DELIMITER_RE = /<\s*\/?\s*mindly[-_a-z]*/gi;

/** What a look for an excerpt says: it is there, it is not, or that could not be told. */
export type ExcerptState = 'present' | 'absent' | 'unknown';

/**
 * The normalised file made safe the way a stored excerpt was, then normalised again: what the
 * unredacted text of a stored excerpt can be compared with as it is. `at[i]` is where `text[i]`
 * is in the normalised file, so a place found here maps back to the text that was hashed.
 */
interface SafeView {
  text: string;
  at: Int32Array;
}

function safeView(norm: string): SafeView {
  const neutral = (t: string): string => t.replace(DELIMITER_RE, (m) => m.replace('<', '‹'));
  const unsafe = new RegExp(UNSAFE_CHAR_RE.source, 'g');
  if (!unsafe.test(norm)) {
    // Nothing is removed (the usual case): the same text, every character where it was.
    const at = new Int32Array(norm.length);
    for (let i = 0; i < at.length; i++) at[i] = i;
    return { text: neutral(norm), at };
  }
  const chunks: string[] = [];
  const at = new Int32Array(norm.length);
  let n = 0;
  let lineStart = 0;
  for (;;) {
    const nl = norm.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? norm.length : nl;
    const line = norm.slice(lineStart, lineEnd);
    let kept: string;
    const keptAt: number[] = [];
    if (!UNSAFE_CHAR_RE.test(line)) {
      kept = line;
    } else {
      // Removing characters can leave spaces to collapse and trim, as normalising does.
      const out: string[] = [];
      for (let i = 0; i < line.length; i++) {
        const c = line[i] as string;
        if (UNSAFE_CHAR_RE.test(c)) continue;
        if (c === ' ' && (out.length === 0 || out[out.length - 1] === ' ')) continue;
        out.push(c);
        keptAt.push(lineStart + i);
      }
      while (out.length > 0 && out[out.length - 1] === ' ') {
        out.pop();
        keptAt.pop();
      }
      kept = out.join('');
    }
    if (kept.length > 0) {
      if (n > 0) {
        // The line break before this line, at the end of the previous one.
        chunks.push('\n');
        at[n++] = lineStart - 1;
      }
      chunks.push(kept);
      if (kept === line) {
        for (let i = 0; i < line.length; i++) at[n++] = lineStart + i;
      } else {
        for (const i of keptAt) at[n++] = i;
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return { text: neutral(chunks.join('')), at: at.subarray(0, n) };
}

/** A file as evidence is compared against it: normalised once, the rest worked out on demand. */
interface NormFile {
  content: string;
  /**
   * True when some run of `n` whole lines of the file has this hash; null when finding out would
   * go past the work allowed for the file.
   */
  hasLines(n: number, hash: string): boolean | null;
  /** The file made safe the way a stored excerpt was (see `SafeView`). */
  safe(): SafeView;
}

/** `raw`: the file as read. */
function normFile(raw: string): NormFile {
  const normContent = normalizeBlock(raw);
  let lines: string[] | null = null;
  let view: SafeView | null = null;
  let work = 0;
  const runs = new Map<number, Set<string>>();
  return {
    content: normContent,
    safe: () => (view ??= safeView(normContent)),
    hasLines(n, hash) {
      let set = runs.get(n);
      if (!set) {
        const cost = normContent.length * n;
        if (work + cost > MAX_LINE_RUN_WORK) return null;
        work += cost;
        lines ??= normContent.split('\n');
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
  return excerptIn(normFile(content), excerpt, contentHash);
}

function excerptIn(file: NormFile, excerpt: string, contentHash: string | null): ExcerptState {
  const normExcerpt = normalizeBlock(excerpt);
  if (normExcerpt.length > 0 && file.content.includes(normExcerpt)) return 'present';
  if (!contentHash) return 'absent';
  const span = parseSpan(contentHash);
  if (span) return spanIn(file.content, span) ? 'present' : 'absent';
  // Hashes of whole lines, written by an earlier build of this release only.
  const cited = parseCitedLines(contentHash);
  if (cited) {
    const found = file.hasLines(cited.lines, cited.hash);
    return found === null ? 'unknown' : found ? 'present' : 'absent';
  }

  // The bare hash of the excerpt as it was found.
  if (normExcerpt.length > 0 && sha256(normExcerpt) === contentHash) {
    // The stored excerpt is what was found; the substring test above is authoritative.
    return 'absent';
  }
  // Stored in another form than it was found, by an earlier version: redacted, made safe, cut
  // short. What is left of it is compared with the file made safe the same way, cheapest first.
  const kept = keptText(normExcerpt);
  const view = file.safe();
  const key = kept.parts.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (key.length > 0 && !view.text.includes(key)) return 'absent';
  const placed = placeKept(view, file.content, kept, contentHash);
  if (placed !== 'unplaced') return placed;
  // It opens or closes with a redaction, so it has no fixed start or end: an original that was
  // whole lines is looked for by the hash of each run of as many lines.
  const lines = file.hasLines(Math.max(1, normExcerpt.split('\n').length), contentHash);
  return lines === null ? 'unknown' : lines ? 'present' : 'absent';
}

/** What a stored excerpt kept of what was found: the text around its redactions. */
interface Kept {
  /** The text between redactions, in order (empty where a redaction opens or closes it). */
  parts: string[];
  /** True when the excerpt was cut short: the original went on after the last part. */
  cut: boolean;
}

function keptText(normExcerpt: string): Kept {
  let text = normExcerpt;
  let cut = false;
  if (text.endsWith('…')) {
    cut = true;
    text = text.slice(0, -1).trimEnd();
    // Cut inside a redaction: what is left of the marker stands for it.
    for (let k = REDACTED.length - 1; k > 0; k--) {
      if (text.endsWith(REDACTED.slice(0, k))) {
        text = text.slice(0, -k) + REDACTED;
        break;
      }
    }
  }
  return { parts: text.split(REDACTED), cut };
}

/**
 * Places evidence stored in another form than it was found. The text before its first redaction
 * starts the original and the text after its last one ends it (or, when it was cut short, comes
 * before the end). Both are looked for in the file made safe the same way, in one forward pass;
 * each pair close enough to be the excerpt is mapped back to the file and hashed there, nearest
 * first. A few hundred pairs at most, and the occurrences visited are bounded too; past either
 * limit the answer is `unknown` and the evidence keeps the validity it had. An excerpt that opens
 * with a redaction, or closes with one without being cut, has no such start or end: `unplaced`.
 */
function placeKept(
  view: SafeView,
  norm: string,
  kept: Kept,
  contentHash: string,
): ExcerptState | 'unplaced' {
  const { parts, cut } = kept;
  const fixed = parts.filter((p) => p !== '');
  const head = parts[0] as string;
  const tail = fixed[fixed.length - 1];
  if (head === '' || tail === undefined || (!cut && parts[parts.length - 1] === '')) {
    return 'unplaced';
  }
  const text = view.text;
  const heads: number[] = [];
  for (let h = text.indexOf(head); h !== -1; h = text.indexOf(head, h + 1)) {
    if (heads.length >= MAX_LEGACY_OCCURRENCES) return 'unknown';
    heads.push(h);
  }
  if (heads.length === 0) return 'absent';
  const single = fixed.length === 1;
  let tries = 0;
  let digests = 0;
  let visited = 0;
  let lo = 0;
  let hi = 0;
  const first = heads[0] as number;
  for (let t = single ? first : text.indexOf(tail, first + head.length); t !== -1;) {
    if (++visited > MAX_LEGACY_OCCURRENCES) return 'unknown';
    const tailEnd = t + tail.length;
    if (single) {
      lo = heads.indexOf(t);
      hi = lo + 1;
    } else {
      while (hi < heads.length && (heads[hi] as number) + head.length <= t) hi++;
      while (lo < hi && tailEnd - (heads[lo] as number) > MAX_ORIGINAL_CHARS) lo++;
    }
    for (let i = hi - 1; i >= lo; i--) {
      if (++tries > MAX_LEGACY_TRIES) return 'unknown';
      const start = view.at[heads[i] as number] as number;
      const end = (view.at[tailEnd - 1] as number) + 1;
      if (!cut) {
        if (sha256(norm.slice(start, end)) === contentHash) return 'present';
        continue;
      }
      // Cut short: the original ends somewhere after this, within an excerpt's length.
      const h = createHash('sha256').update(norm.slice(start, end));
      for (let e = end; e <= norm.length && e - start <= MAX_EXCERPT_CHARS;) {
        if (++digests > MAX_CUT_DIGESTS) return 'unknown';
        if (h.copy().digest('hex') === contentHash) return 'present';
        if (e === norm.length) break;
        // One whole character at a time.
        const step = isHighSurrogate(norm.charCodeAt(e)) && e + 1 < norm.length ? 2 : 1;
        h.update(norm.slice(e, e + step));
        e += step;
      }
    }
    if (single) {
      t = text.indexOf(tail, t + 1);
      continue;
    }
    if (lo === heads.length) break;
    t = text.indexOf(tail, t + 1);
  }
  return 'absent';
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
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
      file: () => (file ??= normFile(stripManagedSection(content))),
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
