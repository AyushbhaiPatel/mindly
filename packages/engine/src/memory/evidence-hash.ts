import { sha256 } from '@mindly/core';

/*
 * The hash stored with a piece of file evidence.
 *
 * An excerpt is accepted when it is found anywhere in the file, and it is stored redacted, so the
 * stored text cannot always be looked for again. What can be checked exactly, whatever the
 * excerpt looked like, is the lines of the file it was taken from: the hash covers the whole
 * normalised lines the excerpt spans, with their number, as `lines:<n>:<sha256>`. The evidence
 * holds while some run of `n` lines of the file still has that hash. A change anywhere on the
 * cited lines ends it, also outside the quoted part.
 *
 * Evidence stored before this form carries the bare sha256 of the normalised excerpt.
 */

const CITED_RE = /^lines:(\d{1,6}):([0-9a-f]{64})$/;

/** The lines a piece of evidence cites: how many, and the hash of their normalised text. */
export interface CitedLines {
  lines: number;
  hash: string;
}

/**
 * The hash to store for an excerpt found in a file. Both arguments are normalised
 * (`normalizeBlock`). When the excerpt is not in the content there are no lines to cite, and the
 * hash of the excerpt itself is returned (such evidence is refused by the caller).
 */
export function citedLinesHash(normContent: string, normExcerpt: string): string {
  const at = normExcerpt.length > 0 ? normContent.indexOf(normExcerpt) : -1;
  if (at === -1) return sha256(normExcerpt);
  const start = normContent.lastIndexOf('\n', at - 1) + 1;
  const nl = normContent.indexOf('\n', at + normExcerpt.length);
  const cited = normContent.slice(start, nl === -1 ? normContent.length : nl);
  return `lines:${cited.split('\n').length}:${sha256(cited)}`;
}

/** Reads a stored hash of the `lines:<n>:<sha256>` form; null for the earlier bare hash. */
export function parseCitedLines(contentHash: string): CitedLines | null {
  const m = CITED_RE.exec(contentHash);
  if (!m) return null;
  const lines = Number(m[1]);
  return lines >= 1 ? { lines, hash: m[2] as string } : null;
}
