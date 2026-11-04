import { normalizeLine, sha256 } from '@mindly/core';

/** Lines shorter than this after normalisation are too generic to attribute (`}`, `end`, …). */
export const MIN_HUNK_LINE_LENGTH = 4;

/**
 * sha256 of every non-trivial line of `text` after `normalizeLine` (trim + collapse whitespace),
 * in order. Blank lines and lines shorter than 4 characters are skipped. Used for code
 * provenance: the hashes of lines an agent added can later be matched against current lines.
 */
export function hunkHashes(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const n = normalizeLine(line);
    if (n.length < MIN_HUNK_LINE_LENGTH) continue;
    out.push(sha256(n));
  }
  return out;
}

/** Hash of a single line under the same rules as `hunkHashes`, or null when it is trivial. */
export function lineHash(line: string): string | null {
  const n = normalizeLine(line);
  return n.length < MIN_HUNK_LINE_LENGTH ? null : sha256(n);
}

/** Added and removed lines of a unified diff. */
export interface DiffLines {
  /** Lines added by the diff (without the leading `+`). */
  added: string[];
  /** Lines removed by the diff (without the leading `-`). */
  removed: string[];
}

/** Extracts added and removed lines from a unified diff (file headers are ignored). */
export function diffLines(diff: string): DiffLines {
  const added: string[] = [];
  const removed: string[] = [];
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}
