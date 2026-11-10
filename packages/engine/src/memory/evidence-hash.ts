import { sha256 } from '@mindly/core';

/*
 * The hash stored with a piece of file evidence, and how it is looked for again.
 *
 * An excerpt is accepted when it is found in the file, normalised (`normalizeBlock`), and it is
 * stored redacted and sanitised. When that left it as it was, the stored text is looked for as a
 * substring and the hash is the bare sha256 of the excerpt, as it always was.
 *
 * When the stored text differs from what was found (a secret was redacted, a delimiter was
 * neutralised, it was shortened), it cannot be looked for as written. The hash then describes
 * the text that was found, `span:<length>:<rolling hash>:<sha256>`, and the evidence holds while
 * that text is still somewhere in the file: any occurrence counts, as for a plain excerpt. The
 * rolling hash finds the windows of that length worth hashing in one pass over the file,
 * whatever the length; sha256 decides.
 *
 * Two earlier forms are still read: the bare sha256 of an excerpt that was then stored redacted,
 * and `lines:<n>:<sha256>`, the hash of the whole lines an excerpt spanned.
 */

const SPAN_RE = /^span:(\d{1,6}):([0-9a-f]{8}):([0-9a-f]{64})$/;
const LINES_RE = /^lines:(\d{1,6}):([0-9a-f]{64})$/;
/** Multiplier of the rolling hash (arithmetic is modulo 2^32). */
const BASE = 0x01000193;

/** Evidence text stored in another form than it was found: its length and hashes. */
export interface Span {
  length: number;
  roll: number;
  hash: string;
}

/** The lines an earlier form of evidence cites: how many, and the hash of their text. */
export interface CitedLines {
  lines: number;
  hash: string;
}

/** Rolling hash of `text` (unsigned, modulo 2^32). */
function rollOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, BASE) + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * The hash to store for evidence. `found` is the normalised excerpt as found in the file, and
 * `stored` the normalised text that is kept for it (redacted, sanitised).
 */
export function evidenceHash(found: string, stored: string): string {
  if (stored === found || found.length === 0) return sha256(found);
  return `span:${found.length}:${rollOf(found).toString(16).padStart(8, '0')}:${sha256(found)}`;
}

/** Reads a stored `span:` hash; null for the other forms. */
export function parseSpan(contentHash: string): Span | null {
  const m = SPAN_RE.exec(contentHash);
  if (!m) return null;
  const length = Number(m[1]);
  return length >= 1 ? { length, roll: parseInt(m[2] as string, 16), hash: m[3] as string } : null;
}

/** Reads a stored `lines:` hash; null for the other forms. */
export function parseCitedLines(contentHash: string): CitedLines | null {
  const m = LINES_RE.exec(contentHash);
  if (!m) return null;
  const lines = Number(m[1]);
  return lines >= 1 ? { lines, hash: m[2] as string } : null;
}

/**
 * True when the text a span describes occurs anywhere in `content` (normalised). One pass over
 * the content, independent of the span's length; only windows whose rolling hash matches are
 * hashed with sha256.
 */
export function spanIn(content: string, span: Span): boolean {
  const n = span.length;
  if (n > content.length) return false;
  let pow = 1;
  for (let i = 1; i < n; i++) pow = Math.imul(pow, BASE);
  let h = 0;
  for (let i = 0; i < n; i++) h = (Math.imul(h, BASE) + content.charCodeAt(i)) | 0;
  for (let start = 0; ; start++) {
    if (h >>> 0 === span.roll && sha256(content.slice(start, start + n)) === span.hash) return true;
    const out = start + n;
    if (out >= content.length) return false;
    h =
      (Math.imul((h - Math.imul(content.charCodeAt(start), pow)) | 0, BASE) +
        content.charCodeAt(out)) |
      0;
  }
}
