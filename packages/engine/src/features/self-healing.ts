import { createHash } from 'node:crypto';
import { statSync, type Stats } from 'node:fs';
import { REDACTED, sha256, type MemoryEvidence, type Session } from '@mindly/core';
import type { TelepathyService } from '../coordination/telepathy.js';
import type { BusEvents, Kernel } from '../kernel.js';
import { stripManagedSection } from '../memory/managed-section.js';
import { evidenceHash, parseCitedLines, parseSpan, spanIn } from '../memory/evidence-hash.js';
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
/**
 * Characters hashed in one file for evidence stored in an earlier form, all of it together; past
 * it such evidence is not decided and keeps the validity it had.
 */
const MAX_LEGACY_WORK = 1_000_000;
/**
 * What a step costs, counted in characters of hashing against `MAX_LEGACY_WORK`: a hash beyond
 * its characters, one running digest (taking a copy, finishing it and one more character), and
 * one place visited in the file.
 */
const HASH_COST = 256;
const DIGEST_COST = 512;
const PLACE_COST = 16;
/** The allowance of `MAX_LEGACY_WORK`, for tests that check the work stays within it. */
export const EARLIER_FORM_WORK = MAX_LEGACY_WORK;

/** A character other than whitespace: a line with one is a line of the normalised file. */
const NON_SPACE_RE = /\S/;
/** Neutralised when an excerpt is made safe: its `<` becomes `‹`. */
const DELIMITER_RE = /<\s*\/?\s*mindly[-_a-z]*/gi;
/** Characters an excerpt made safe no longer has, or has as a line break (a lone `\r`). */
const SAFE_CHANGES_RE =
  // eslint-disable-next-line no-control-regex
  /\r(?!\n)|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** Whitespace, line breaks and the characters making safe removes: what `skeleton` leaves out. */
const SKELETON_DROP_RE =
  // eslint-disable-next-line no-control-regex
  /[\s\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]+/g;

/** Removed when an excerpt is made safe (`sanitizeForContext`, which this follows). */
function isUnsafe(c: number): boolean {
  return (
    c <= 0x08 ||
    (c >= 0x0b && c <= 0x1f) ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x2064) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
  );
}

/** Whitespace as `\s` and `trim` see it, other than the line feed that ends a line. */
function isSpace(c: number): boolean {
  return (
    c === 0x09 ||
    c === 0x0b ||
    c === 0x0c ||
    c === 0x0d ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** What a look for an excerpt says: it is there, it is not, or that could not be told. */
export type ExcerptState = 'present' | 'absent' | 'unknown';

/** Text with, for every character, where it came from. */
interface Mapped {
  text: string;
  at: Int32Array;
}

/**
 * `normalizeBlock` of `codes`, keeping where each character came from (`from[i]` for
 * `codes[i]`): lines split at line feeds, trimmed, inner whitespace collapsed to one space,
 * empty lines dropped. A collapsed space and a line break stand where their first character was.
 */
function normalizeMapped(codes: Uint16Array, length: number, from: Int32Array): Mapped {
  const out = new Uint16Array(length);
  const at = new Int32Array(length);
  let n = 0;
  let lineHas = false;
  let space = -1;
  let lineEnd = -1;
  for (let i = 0; i <= length; i++) {
    const c = i < length ? (codes[i] as number) : 0x0a;
    if (c === 0x0a) {
      if (lineHas) lineEnd = i < length ? (from[i] as number) : -1;
      lineHas = false;
      space = -1;
      continue;
    }
    if (isSpace(c)) {
      if (lineHas && space < 0) space = from[i] as number;
      continue;
    }
    if (!lineHas && n > 0) {
      out[n] = 0x0a;
      at[n++] = lineEnd;
    }
    if (space >= 0) {
      out[n] = 0x20;
      at[n++] = space;
      space = -1;
    }
    out[n] = c;
    at[n++] = from[i] as number;
    lineHas = true;
  }
  let text = '';
  for (let i = 0; i < n; i += 8192) {
    text += String.fromCharCode(...out.subarray(i, Math.min(n, i + 8192)));
  }
  return { text, at: at.slice(0, n) };
}

/**
 * The file made safe the way a stored excerpt was, in the same order (made safe, then
 * normalised): what the unredacted text of a stored excerpt can be compared with as it is.
 * `at[i]` is where `text[i]` is in the normalised file (-1 where it has no place of its own there,
 * as a space between characters the file has as one run), so a place found here maps back to the
 * text that was hashed.
 */
type SafeView = Mapped;

function safeView(raw: string, norm: string): SafeView {
  const neutral = (t: string): string => t.replace(DELIMITER_RE, (m) => m.replace('<', '‹'));
  const at = new Int32Array(norm.length);
  if (!SAFE_CHANGES_RE.test(raw)) {
    // Nothing is removed or turned into a line break (the usual case): the normalised file, every
    // character where it is.
    for (let i = 0; i < at.length; i++) at[i] = i;
    return { text: neutral(norm), at };
  }
  // Line by line, as the file is normalised: a line that making safe leaves as it is keeps its
  // place; only a line it changes is mapped character by character.
  const parts: string[] = [];
  let n = 0;
  let p = 0;
  for (let start = 0; start <= raw.length;) {
    const nl = raw.indexOf('\n', start);
    const end = nl === -1 ? raw.length : nl;
    const line = raw.slice(start, end);
    // A line of only whitespace is not a line of the normalised file; any other one is the next.
    if (NON_SPACE_RE.test(line)) {
      const normEnd = norm.indexOf('\n', p);
      const lineEnd = normEnd === -1 ? norm.length : normEnd;
      const normed = norm.slice(p, lineEnd);
      const mapped = SAFE_CHANGES_RE.test(line) ? safeLine(line, normed) : null;
      const text = mapped ? mapped.text : normed;
      if (text.length > 0) {
        if (n > 0) {
          // The line break before this line: the one before its line of the normalised file.
          parts.push('\n');
          at[n++] = p - 1;
        }
        parts.push(text);
        if (mapped) {
          for (let i = 0; i < text.length; i++) {
            const r = mapped.at[i] as number;
            at[n++] = r < 0 ? -1 : p + r;
          }
        } else {
          for (let i = 0; i < text.length; i++) at[n++] = p + i;
        }
      }
      p = lineEnd + 1;
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  const text = parts.join('');
  return { text: neutral(text), at: at.slice(0, n) };
}

/**
 * One line of the file as it is when made safe (a line break for a lone `\r`, unsafe characters
 * removed) and normalised, with where each character is in the line normalised (`normed`); null
 * when the line does not normalise to `normed` (not expected).
 */
function safeLine(line: string, normed: string): Mapped | null {
  const codes = new Uint16Array(line.length);
  const identity = new Int32Array(line.length);
  for (let i = 0; i < line.length; i++) {
    codes[i] = line.charCodeAt(i);
    identity[i] = i;
  }
  const own = normalizeMapped(codes, line.length, identity);
  if (own.text !== normed) return null;
  const toNormed = new Int32Array(line.length).fill(-1);
  for (let i = 0; i < own.at.length; i++) toNormed[own.at[i] as number] = i;
  const safeCodes = new Uint16Array(line.length);
  const safeFrom = new Int32Array(line.length);
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = codes[i] as number;
    if (c === 0x0d) {
      // A `\r` ending the line ends it with the line feed; another is a line break of its own.
      if (i === line.length - 1) continue;
      safeCodes[n] = 0x0a;
      safeFrom[n++] = i;
      continue;
    }
    if (isUnsafe(c)) continue;
    safeCodes[n] = c;
    safeFrom[n++] = i;
  }
  const safe = normalizeMapped(safeCodes, n, safeFrom);
  const at = new Int32Array(safe.at.length);
  for (let i = 0; i < at.length; i++) {
    const r = safe.at[i] as number;
    at[i] = r >= 0 ? (toNormed[r] as number) : -1;
  }
  return { text: safe.text, at };
}

/** A file as evidence is compared against it: normalised once, the rest worked out on demand. */
interface NormFile {
  content: string;
  /** Where each line of `content` starts. */
  lineStarts(): Int32Array;
  /** Where each line of the made-safe view starts (see `safe`). */
  safeLineStarts(): Int32Array;
  /** The file made safe the way a stored excerpt was (see `SafeView`). */
  safe(): SafeView;
  /**
   * False when `text` (kept text of a stored excerpt) cannot be in the file: its skeleton is not
   * in the file's (see `skeleton`).
   */
  mayHold(text: string): boolean;
  /**
   * Takes `chars` of hashing from the work allowed for evidence of earlier forms in this file;
   * false (and nothing taken) when it would go past it.
   */
  spend(chars: number): boolean;
  /** Characters taken so far (see `spend`). */
  spent(): number;
  /**
   * The first line of a run of `n` whole lines of the file with this hash; -1 when there is none,
   * null when finding out would go past the work allowed (see `spend`).
   */
  linesWith(n: number, hash: string): number | null;
}

/**
 * `text` without any whitespace or line break, without the characters making safe removes, and
 * with every `‹` read as `<`. Normalising only changes whitespace, and making safe only removes
 * characters, turns `\r` into a line break and neutralises a delimiter's `<` (only where the
 * delimiter is whole), so whatever an excerpt was taken from has a skeleton that holds the
 * skeleton of any piece of what it kept, however the excerpt was quoted.
 */
function skeleton(text: string): string {
  return text.replace(SKELETON_DROP_RE, '').replaceAll('‹', '<');
}

/** Where each line of `text` starts. */
function lineStartsOf(text: string): Int32Array {
  const s = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) s.push(i + 1);
  return Int32Array.from(s);
}

/** `raw`: the file as read. */
function normFile(raw: string): NormFile {
  const normContent = normalizeBlock(raw);
  let lines: string[] | null = null;
  let starts: Int32Array | null = null;
  let safeStarts: Int32Array | null = null;
  let view: SafeView | null = null;
  let bones: string | null = null;
  let work = 0;
  const runs = new Map<number, Map<string, number>>();
  const file: NormFile = {
    content: normContent,
    safe: () => (view ??= safeView(raw, normContent)),
    lineStarts: () => (starts ??= lineStartsOf(normContent)),
    safeLineStarts: () => (safeStarts ??= lineStartsOf(file.safe().text)),
    mayHold(text) {
      bones ??= skeleton(normContent);
      return bones.includes(skeleton(text));
    },
    spend(chars) {
      if (work + chars > MAX_LEGACY_WORK) return false;
      work += chars;
      return true;
    },
    spent: () => work,
    linesWith(n, hash) {
      let byHash = runs.get(n);
      if (!byHash) {
        lines ??= normContent.split('\n');
        const runCount = Math.max(0, lines.length - n + 1);
        if (!file.spend(normContent.length * n + runCount * HASH_COST)) return null;
        byHash = new Map();
        for (let i = 0; i + n <= lines.length; i++) {
          const h = sha256(n === 1 ? (lines[i] as string) : lines.slice(i, i + n).join('\n'));
          if (!byHash.has(h)) byHash.set(h, i);
        }
        runs.set(n, byHash);
      }
      return byHash.get(hash) ?? -1;
    },
  };
  return file;
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
 * in an earlier form whose text was not found, but is not shown to be gone either.
 */
export function excerptState(
  content: string,
  excerpt: string,
  contentHash: string | null,
): ExcerptState {
  return excerptIn(normFile(content), excerpt, contentHash).state;
}

/**
 * `excerptState` with the work it took from the allowance for evidence of earlier forms
 * (characters hashed or set aside for hashing): a measure of the cost that does not depend on
 * how fast the machine is. For tests.
 */
export function excerptWork(
  content: string,
  excerpt: string,
  contentHash: string | null,
): { state: ExcerptState; work: number } {
  const file = normFile(content);
  const state = excerptIn(file, excerpt, contentHash).state;
  return { state, work: file.spent() };
}

/** What a look found, and, for evidence of the earliest form found in place, where. */
interface Look {
  state: ExcerptState;
  /** The text the evidence was taken from, in the normalised file. */
  at?: { start: number; end: number };
}

function excerptIn(file: NormFile, excerpt: string, contentHash: string | null): Look {
  const normExcerpt = normalizeBlock(excerpt);
  if (normExcerpt.length > 0 && file.content.includes(normExcerpt)) return { state: 'present' };
  if (!contentHash) return { state: 'absent' };
  const span = parseSpan(contentHash);
  if (span) return { state: spanIn(file.content, span) ? 'present' : 'absent' };
  // Hashes of the whole lines an excerpt spanned, written by an earlier build of this release.
  const cited = parseCitedLines(contentHash);
  if (!cited && normExcerpt.length > 0 && sha256(normExcerpt) === contentHash) {
    // The stored excerpt is what was found; the substring test above is authoritative.
    return { state: 'absent' };
  }
  return earlierForm(file, normExcerpt, cited?.hash ?? contentHash, cited?.lines ?? null);
}

/**
 * Evidence stored in another form than it was found by an earlier version (redacted, made safe,
 * cut short), with the bare hash of the text found or (`lines`) the hash of the whole lines it
 * spanned. Such evidence is placed as well as the stored text allows, and it is only ever called
 * gone when what it kept is gone: the longest piece of it is neither in the file nor in the file
 * made safe (see `mayHold`). A place not found, work cut short or a place that maps inexactly says nothing:
 * `unknown`, and the evidence keeps the validity it had. All of it comes out of one allowance of
 * work for the file.
 */
function earlierForm(
  file: NormFile,
  normExcerpt: string,
  hash: string,
  lines: number | null,
): Look {
  const kept = keptText(normExcerpt);
  const key = longest(kept.parts);
  if (skeleton(key).length > 0 && !file.mayHold(key)) return { state: 'absent' };
  const found =
    (lines === null ? placeKept(file, kept, hash) : null) ??
    placeLines(file, kept, lines, hash) ??
    anyLines(file, lines ?? Math.max(1, normExcerpt.split('\n').length), hash);
  if (!found) return { state: 'unknown' };
  // Where the text found is: for the bare hash, exactly what the evidence was taken from.
  return lines === null ? { state: 'present', at: found } : { state: 'present' };
}

/** The first run of `n` whole lines with this hash, within the work allowed. */
function anyLines(file: NormFile, n: number, hash: string): { start: number; end: number } | null {
  const first = file.linesWith(n, hash);
  if (first === null || first < 0) return null;
  const starts = file.lineStarts();
  const start = starts[first] as number;
  const end = first + n < starts.length ? (starts[first + n] as number) - 1 : file.content.length;
  return { start, end };
}

/** The longest piece of kept text; none when every piece is only whitespace (line breaks). */
function longest(parts: readonly string[]): string {
  const best = parts.reduce((a, b) => (b.trim().length > a.trim().length ? b : a), '');
  return best.trim().length > 0 ? best : '';
}

/** What a stored excerpt kept of what was found: the text around its redactions. */
interface Kept {
  /** The kept text, with one marker for each redaction (and without the mark of a cut). */
  text: string;
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
  return { text, parts: text.split(REDACTED), cut };
}

/** True when line `i` of `norm` (lines start at `starts`) is only characters made safe away. */
function lineMadeSafeAway(norm: string, starts: Int32Array, i: number): boolean {
  const from = starts[i] as number;
  const to = i + 1 < starts.length ? (starts[i + 1] as number) - 1 : norm.length;
  for (let p = from; p < to; p++) {
    const c = norm.charCodeAt(p);
    if (!isUnsafe(c) && !isSpace(c)) return false;
  }
  return true;
}

/**
 * Evidence whose original was whole lines. The longest piece of what was kept lies on a known
 * line of the excerpt. Each place it occurs in the file made safe (which has the excerpt's
 * lines: making safe can drop a line or split one) gives the run of lines the excerpt spans
 * there; that run is mapped back to the file's own lines and hashed, also with the lines next to
 * it that making safe removed entirely (they are in the original, not in the excerpt). With
 * `lines`, only runs of that many lines. Found, or null.
 */
function placeLines(
  file: NormFile,
  kept: Kept,
  lines: number | null,
  hash: string,
): { start: number; end: number } | null {
  const key = longest(kept.parts);
  if (key.length === 0 || kept.cut) return null;
  let offset = 0;
  for (const p of kept.parts) {
    if (p === key) break;
    offset += p.length + REDACTED.length;
  }
  const lineInExcerpt = kept.text.slice(0, offset).split('\n').length - 1;
  const excerptLines = kept.text.split('\n').length;
  const view = file.safe();
  const viewStarts = file.safeLineStarts();
  const starts = file.lineStarts();
  const norm = file.content;
  let visited = 0;
  for (let o = view.text.indexOf(key); o !== -1; o = view.text.indexOf(key, o + 1)) {
    if (++visited > MAX_LEGACY_OCCURRENCES || !file.spend(PLACE_COST)) return null;
    const first = lineOf(viewStarts, o) - lineInExcerpt;
    const last = first + excerptLines - 1;
    if (first < 0 || last >= viewStarts.length) continue;
    const from = view.at[viewStarts[first] as number] as number;
    const lastEnd =
      last + 1 < viewStarts.length ? (viewStarts[last + 1] as number) - 2 : view.text.length - 1;
    const to = view.at[lastEnd] as number;
    if (from < 0 || to < 0) continue;
    const lineFrom = lineOf(starts, from);
    const lineTo = lineOf(starts, to);
    const above = lineFrom > 0 && lineMadeSafeAway(norm, starts, lineFrom - 1) ? 1 : 0;
    const below = lineTo + 1 < starts.length && lineMadeSafeAway(norm, starts, lineTo + 1) ? 1 : 0;
    for (let up = 0; up <= above; up++) {
      for (let down = 0; down <= below; down++) {
        const a = lineFrom - up;
        const b = lineTo + down;
        if (lines !== null && b - a + 1 !== lines) continue;
        const start = starts[a] as number;
        const end = b + 1 < starts.length ? (starts[b + 1] as number) - 1 : norm.length;
        if (!file.spend(end - start + HASH_COST)) return null;
        if (sha256(norm.slice(start, end)) === hash) return { start, end };
      }
    }
  }
  return null;
}

/** The line of `starts` that holds position `pos`. */
function lineOf(starts: Int32Array, pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Evidence of the earliest form that was part of a line. The text before its first redaction
 * starts the original and the text after its last one ends it (or, when it was cut short, comes
 * before the end). Both are looked for in the file made safe the same way, in one forward pass;
 * each pair close enough to be the excerpt is mapped back to the file and hashed there, nearest
 * first. Characters the excerpt lost when it was made safe may stand just before its start: the
 * start is tried with and without them. An excerpt cut short is extended one whole character at a
 * time on a running hash. Found, or null (also when the excerpt has no fixed start or end).
 */
function placeKept(
  file: NormFile,
  kept: Kept,
  contentHash: string,
): { start: number; end: number } | null {
  const { parts, cut } = kept;
  const fixed = parts.filter((p) => p !== '');
  const head = parts[0] as string;
  const tail = fixed[fixed.length - 1];
  if (head === '' || tail === undefined || (!cut && parts[parts.length - 1] === '')) return null;
  const view = file.safe();
  const norm = file.content;
  const text = view.text;
  const heads: number[] = [];
  for (let h = text.indexOf(head); h !== -1; h = text.indexOf(head, h + 1)) {
    if (heads.length >= MAX_LEGACY_OCCURRENCES || !file.spend(PLACE_COST)) return null;
    heads.push(h);
  }
  if (heads.length === 0) return null;
  let tries = 0;
  /** The original from the start at `h` to the tail ending at `tailEnd`; false: stop looking. */
  const pair = (h: number, tailEnd: number): { start: number; end: number } | false | null => {
    const mapped = view.at[h] as number;
    const last = view.at[tailEnd - 1] as number;
    if (mapped < 0 || last < 0) return null;
    let before = mapped;
    while (
      before > 0 &&
      isUnsafe(norm.charCodeAt(before - 1)) &&
      !isSpace(norm.charCodeAt(before - 1))
    ) {
      before--;
    }
    for (const start of before === mapped ? [mapped] : [mapped, before]) {
      if (++tries > MAX_LEGACY_TRIES) return false;
      let end = last + 1;
      if (!cut) {
        if (!file.spend(end - start + HASH_COST)) return false;
        if (sha256(norm.slice(start, end)) === contentHash) return { start, end };
        continue;
      }
      // Cut short: the original ends somewhere after this, within an excerpt's length. Hashed one
      // whole character at a time (a pair is never split: half of one is encoded on its own).
      if (isHighSurrogate(norm.charCodeAt(end - 1)) && isLowSurrogate(norm.charCodeAt(end))) end++;
      if (!file.spend(end - start + HASH_COST)) return false;
      const h = createHash('sha256').update(norm.slice(start, end));
      for (let e = end; e - start <= MAX_EXCERPT_CHARS;) {
        // Every digest is paid for: past the allowance, nothing more is tried in this file.
        if (!file.spend(DIGEST_COST)) return false;
        if (h.copy().digest('hex') === contentHash) return { start, end: e };
        if (e >= norm.length) break;
        const pairNext =
          isHighSurrogate(norm.charCodeAt(e)) && isLowSurrogate(norm.charCodeAt(e + 1));
        // An excerpt was cut to 2000 code units when it was accepted: its original may end with
        // the first half of a pair, encoded on its own.
        if (pairNext && !file.spend(DIGEST_COST)) return false;
        if (
          pairNext &&
          h
            .copy()
            .update(norm.slice(e, e + 1))
            .digest('hex') === contentHash
        ) {
          return { start, end: e + 1 };
        }
        const step = pairNext ? 2 : 1;
        h.update(norm.slice(e, e + step));
        e += step;
      }
    }
    return null;
  };

  if (fixed.length === 1) {
    // One piece of kept text: it starts the original and is the last text known of it.
    for (const h of heads) {
      const r = pair(h, h + head.length);
      if (r !== null) return r || null;
    }
    return null;
  }
  let visited = 0;
  let lo = 0;
  let hi = 0;
  for (let t = text.indexOf(tail, (heads[0] as number) + head.length); t !== -1;) {
    if (++visited > MAX_LEGACY_OCCURRENCES || !file.spend(PLACE_COST)) return null;
    const tailEnd = t + tail.length;
    while (hi < heads.length && (heads[hi] as number) + head.length <= t) hi++;
    while (lo < hi && tailEnd - (heads[lo] as number) > MAX_ORIGINAL_CHARS) lo++;
    for (let i = hi - 1; i >= lo; i--) {
      const r = pair(heads[i] as number, tailEnd);
      if (r !== null) return r || null;
    }
    if (lo === heads.length) break;
    t = text.indexOf(tail, t + 1);
  }
  return null;
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
    let found: ExcerptState = 'present';
    if (file.kind !== 'present') {
      found = 'absent';
    } else if (e.excerpt !== null) {
      const content = file.file();
      const look = excerptIn(content, e.excerpt, e.contentHash);
      found = look.state;
      if (look.at) {
        // Evidence of the earliest form found where it was taken from: from now on it is checked
        // by the exact text it was taken from.
        const hash = evidenceHash(
          content.content.slice(look.at.start, look.at.end),
          normalizeBlock(e.excerpt),
        );
        if (parseSpan(hash)) this.k.store.memories.setEvidenceHash(e.id, hash);
      }
    }
    if (found === 'unknown') {
      // Evidence stored in an earlier form that could not be placed, but is not gone either: it
      // stays as it was.
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
