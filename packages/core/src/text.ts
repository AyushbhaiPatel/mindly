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
