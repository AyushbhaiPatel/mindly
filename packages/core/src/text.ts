import { createHash } from 'node:crypto';

/** sha256 hex digest of a UTF-8 string or buffer. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Rough token estimate (≈4 characters per token for English and code). Never returns 0 for text. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Truncates to at most `max` characters, appending an ellipsis marker when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// C0/C1 control characters except TAB and LF.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Characters that render as nothing (Unicode Cf and Default_Ignorable_Code_Point: bidi controls,
// zero-width characters, the soft hyphen, tag characters, variation selectors, fillers, ...).
// They can hide text, or split a token so the redactor does not see it.
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// What a single token (path, glob, id) must not hold: line breaks and other control characters,
// and bidi overrides and isolates, which make a name read differently from what it is. Not the
// other invisible characters: variation selectors and joiners belong to emoji and to ideographic
// variants, and real file names have them.
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_TOKEN_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

// Our own context delimiters; content must never be able to close or forge a block.
const DELIMITER_RE = /<\s*\/?\s*mindly[-_a-z]*/gi;

/**
 * True when a value meant to be a single token (path, glob, id) contains line breaks, control
 * characters or bidi overrides/isolates that could forge structure in rendered context.
 */
export function hasUnsafeChars(value: string): boolean {
  return UNSAFE_IN_TOKEN_RE.test(value);
}

/**
 * Makes untrusted text safe to embed in a context block given to an agent:
 * strips control and invisible characters, neutralises Mindly delimiter tags, collapses runs of
 * blank lines and caps the length. It does not (and cannot) make the *meaning* safe; that is why
 * context is always labelled as reference data with its trust level.
 */
export function sanitizeForContext(text: string, maxChars = 4000): string {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, '')
    .replace(INVISIBLE_RE, '')
    .replace(DELIMITER_RE, (m) => m.replace('<', '‹'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(cleaned, maxChars);
}

/** Single-line variant for titles and labels. */
export function sanitizeLine(text: string, maxChars = 200): string {
  return sanitizeForContext(text, maxChars * 2)
    .replace(/\s+/g, ' ')
    .slice(0, maxChars)
    .trim();
}

/** Normalises a source line for hunk hashing: trims and collapses inner whitespace. */
export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/** Stable short fingerprint for deduplication keys. */
export function fingerprint(...parts: readonly (string | number | null | undefined)[]): string {
  return sha256(parts.map((p) => String(p ?? '')).join('\u0000')).slice(0, 32);
}

let graphemes: Intl.Segmenter | null | undefined;

/** The grapheme segmenter, or null on a runtime built without it. */
function graphemeSegmenter(): Intl.Segmenter | null {
  if (graphemes === undefined) {
    try {
      graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      graphemes = null;
    }
  }
  return graphemes;
}

/** True when cutting `line` at `at` would split a surrogate pair. */
const splitsPair = (line: string, at: number): boolean =>
  at > 0 &&
  at < line.length &&
  (line.charCodeAt(at - 1) & 0xfc00) === 0xd800 &&
  (line.charCodeAt(at) & 0xfc00) === 0xdc00;

/**
 * Shortens `line` to at most `max` UTF-16 units by taking its middle out: the first third stays,
 * then `…`, then the end. Both cuts fall between characters as a reader sees them, never inside
 * a surrogate pair nor between a letter and the marks joined to it, so each side stays whole
 * text (a side may come out a little shorter for that).
 *
 * A single character longer than half a side (a letter under hundreds of marks) would leave that
 * side empty or nearly so: there the cut falls between code points instead, so that both ends of
 * the line are always shown.
 */
export function cutMiddle(line: string, max: number): string {
  if (line.length <= max) return line;
  if (max <= 1) return max <= 0 ? '' : '…';
  const head = Math.floor((max - 1) / 3);
  const tail = max - 1 - head;
  const tailFrom = line.length - tail;
  let headEnd = 0;
  let tailStart = line.length;
  const segmenter = graphemeSegmenter();
  if (segmenter) {
    for (const { index } of segmenter.segment(line)) {
      if (index <= head) headEnd = index;
      if (index >= tailFrom) {
        tailStart = index;
        break;
      }
    }
  }
  if (headEnd < head / 2) headEnd = splitsPair(line, head) ? head - 1 : head;
  if (line.length - tailStart < tail / 2) {
    tailStart = splitsPair(line, tailFrom) ? tailFrom + 1 : tailFrom;
  }
  // A mark that segmentation leaves apart from its letter (some spacing vowel signs) is not
  // shown without it.
  const marks = /^\p{M}+/u.exec(line.slice(tailStart, tailStart + 32))?.[0].length ?? 0;
  if (marks > 0 && marks < 32 && line.length - (tailStart + marks) >= tail / 2) tailStart += marks;
  return `${line.slice(0, headEnd)}…${line.slice(tailStart)}`;
}
