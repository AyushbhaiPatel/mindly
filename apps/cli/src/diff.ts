import { redactText } from '@mindly/core';
import { stripControl } from './util.js';

/** A compact, line-based summary of a file change. */
export interface DiffSummary {
  added: number;
  removed: number;
  /** `+ line` / `- line` / `  ...` rows, already redacted and capped. */
  lines: string[];
}

/** Largest middle section (after trimming common prefix/suffix) diffed line by line. */
const MAX_LCS_LINES = 2000;

function lcsDiff(
  a: readonly string[],
  b: readonly string[],
): { op: '+' | '-' | ' '; text: string }[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..], stored flat.
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => dp[i * (m + 1) + j] as number;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: { op: '+' | '-' | ' '; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i] as string });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ op: '-', text: a[i++] as string });
    } else {
      ops.push({ op: '+', text: b[j++] as string });
    }
  }
  while (i < n) ops.push({ op: '-', text: a[i++] as string });
  while (j < m) ops.push({ op: '+', text: b[j++] as string });
  return ops;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function display(line: string, maxWidth: number): string {
  // Redact secrets that may sit in the user's agent config and strip terminal control characters.
  const safe = stripControl(redactText(line));
  return safe.length > maxWidth ? `${safe.slice(0, maxWidth - 3)}...` : safe;
}

/**
 * Summarises the change from `previous` (null for a new file) to `next`: counts and up to
 * `maxLines` changed lines, each cut to `maxWidth` characters. Secrets are redacted in the
 * displayed lines.
 */
export function diffSummary(
  previous: string | null,
  next: string,
  maxLines = 40,
  maxWidth = 160,
): DiffSummary {
  const a = previous === null ? [] : splitLines(previous);
  const b = splitLines(next);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops =
    midA.length <= MAX_LCS_LINES && midB.length <= MAX_LCS_LINES
      ? lcsDiff(midA, midB).filter((o) => o.op !== ' ')
      : [
          ...midA.map((text) => ({ op: '-' as const, text })),
          ...midB.map((text) => ({ op: '+' as const, text })),
        ];
  const added = ops.filter((o) => o.op === '+').length;
  const removed = ops.length - added;
  const lines = ops.slice(0, maxLines).map((o) => `${o.op} ${display(o.text, maxWidth)}`);
  if (ops.length > maxLines) lines.push(`  ... ${ops.length - maxLines} more changed lines`);
  return { added, removed, lines };
}
