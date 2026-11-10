/*
 * Characters that render as nothing (Unicode Cf and Default_Ignorable_Code_Point: zero-width
 * characters, bidi controls, the soft hyphen, tag characters, variation selectors, fillers, ...)
 * and control characters other than TAB and LF. One of them inside a secret hides it from a
 * pattern, and cleaning text for display later removes it and puts the secret back together; one
 * between a word and a secret, once removed, glues them so a pattern that wants a word boundary
 * misses the secret.
 *
 * Redaction therefore looks for secrets in several copies of the text (without these characters,
 * with each of them turned into a space, mixes of the two, and one where each run between word
 * characters is a mark that the patterns read past, see `CopyMode`), and replaces what any of them
 * finds in the original text, which otherwise keeps every character it had: a joiner in an emoji,
 * a Persian zero-width non-joiner, a variation selector, or the bidi override a code review must
 * see.
 */

const HIDDEN =
  '[\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]';
const HIDDEN_TEST = new RegExp(HIDDEN, 'u');

/** Whether `text` holds a character that renders as nothing or a control character. */
export function hasHiddenChars(text: string): boolean {
  return HIDDEN_TEST.test(text);
}

/** `text` without the characters that render as nothing and without control characters. */
export function withoutHiddenChars(text: string): string {
  return text.replace(new RegExp(HIDDEN, 'gu'), '');
}

/**
 * A copy of a text made for matching, and where its units come from in the original. The copy is
 * made of segments, in order: a stretch of the original kept as it is, or one space (or `MARK`)
 * standing for a run of hidden characters. Segment `k` starts at unit `copyAt[k]` of the copy and
 * at `originalAt[k]` of the original; a space or mark segment ends at `originalEnd[k]`, a kept one
 * has -1. `mode` is how the copy was made.
 */
export interface MatchCopy {
  mode: CopyMode;
  text: string;
  copyAt: Int32Array;
  originalAt: Int32Array;
  originalEnd: Int32Array;
}

/**
 * How a copy for matching treats each run of hidden characters. `removed` drops every run and
 * `space` turns every run into one space. The others decide only for a run between two word
 * characters (a run elsewhere is dropped, which changes no word boundary): within a word made of
 * word characters and such runs, `first` turns its first run into a space, `last` its last one,
 * `ends` both, and the runs inside are dropped. `mark` turns every run between two word characters
 * into `MARK`, which is no word character, so a word boundary holds on both sides of it, and which
 * the patterns run on this copy pass over inside a secret (see `allowMarks` in redact.ts): a
 * secret split inside and glued to words on either side, however many runs there are, is found
 * in this one copy.
 */
export type CopyMode = 'removed' | 'space' | 'first' | 'last' | 'ends' | 'mark';

/** Every way of making a copy for matching, in the order `redact` uses them. */
export const COPY_MODES: readonly CopyMode[] = [
  'removed',
  'space',
  'first',
  'last',
  'ends',
  'mark',
];

/**
 * The character a `mark` copy puts for a run of hidden characters between word characters: a
 * private-use character, which is neither hidden nor a word character. A text that already holds
 * it gets no `mark` copy.
 */
export const MARK = '\uE000';

/** A run of hidden characters, and where it sits among word characters. */
interface Run {
  start: number;
  end: number;
  /** Between two word characters. */
  inner: boolean;
  /** The first (and/or last) run between word characters within its word. */
  first: boolean;
  last: boolean;
}

function isWordUnit(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 // 0-9 A-Z a-z _
  );
}

/** The maximal runs of hidden characters of `original`, once. */
function hiddenRuns(original: string): Run[] {
  const runs: Run[] = [];
  const re = new RegExp(HIDDEN, 'gu');
  for (let m = re.exec(original); m !== null; m = re.exec(original)) {
    const last = runs[runs.length - 1];
    if (last && last.end === m.index) last.end = m.index + m[0].length;
    else {
      runs.push({
        start: m.index,
        end: m.index + m[0].length,
        inner: false,
        first: false,
        last: false,
      });
    }
  }
  // Group the runs between two word characters by the word they sit in.
  let group: Run[] = [];
  const close = (): void => {
    const head = group[0];
    const tail = group[group.length - 1];
    if (head) head.first = true;
    if (tail) tail.last = true;
    group = [];
  };
  let prevEnd = 0;
  for (const r of runs) {
    const inner =
      r.start > 0 &&
      r.end < original.length &&
      isWordUnit(original.charCodeAt(r.start - 1)) &&
      isWordUnit(original.charCodeAt(r.end));
    let sameWord = group.length > 0;
    for (let o = prevEnd; sameWord && o < r.start; o++) {
      if (!isWordUnit(original.charCodeAt(o))) sameWord = false;
    }
    if (!inner || !sameWord) close();
    r.inner = inner;
    if (inner) group.push(r);
    prevEnd = r.end;
  }
  close();
  return runs;
}

function spaced(r: Run, mode: CopyMode): boolean {
  switch (mode) {
    case 'removed':
      return false;
    case 'space':
      return true;
    case 'first':
      return r.first;
    case 'last':
      return r.last;
    case 'ends':
      return r.first || r.last;
    case 'mark':
      return false;
  }
}

function buildCopy(original: string, runs: readonly Run[], mode: CopyMode): MatchCopy {
  const parts: string[] = [];
  const size = 2 * runs.length + 1;
  const copyAt = new Int32Array(size);
  const originalAt = new Int32Array(size);
  const originalEnd = new Int32Array(size);
  let k = 0;
  let unit = 0;
  let from = 0;
  const segment = (at: number, endAt: number, text: string): void => {
    if (text.length === 0) return;
    copyAt[k] = unit;
    originalAt[k] = at;
    originalEnd[k] = endAt;
    k++;
    unit += text.length;
    parts.push(text);
  };
  for (const r of runs) {
    segment(from, -1, original.slice(from, r.start));
    if (mode === 'mark' && r.inner) segment(r.start, r.end, MARK);
    else if (spaced(r, mode)) segment(r.start, r.end, ' ');
    from = r.end;
  }
  segment(from, -1, original.slice(from));
  return {
    mode,
    text: parts.join(''),
    copyAt: copyAt.subarray(0, k),
    originalAt: originalAt.subarray(0, k),
    originalEnd: originalEnd.subarray(0, k),
  };
}

/** The stretch of the original that unit `u` of `copy` stands for: a whole run for a space or mark. */
function unitInOriginal(copy: MatchCopy, u: number): [number, number] {
  let lo = 0;
  let hi = copy.copyAt.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((copy.copyAt[mid] ?? 0) <= u) lo = mid;
    else hi = mid - 1;
  }
  const at = (copy.originalAt[lo] ?? 0) + (u - (copy.copyAt[lo] ?? 0));
  const spaceEnd = copy.originalEnd[lo] ?? -1;
  return spaceEnd >= 0 ? [copy.originalAt[lo] ?? 0, spaceEnd] : [at, at + 1];
}

/** The copy of `original` made for matching in `mode` (see `CopyMode`). */
export function matchCopy(original: string, mode: CopyMode): MatchCopy {
  return buildCopy(original, hiddenRuns(original), mode);
}

/**
 * Every distinct copy of `original` for matching, one per `COPY_MODES` entry that differs, made
 * one at a time as they are asked for. The `mark` copy is made only when a run sits between word
 * characters, and never for a text that holds `MARK` itself.
 */
export function* matchCopies(original: string): Generator<MatchCopy> {
  const runs = hiddenRuns(original);
  const mixed = runs.some((r) => r.first || r.last);
  const multi = runs.some((r) => r.first !== r.last);
  const modes: CopyMode[] = ['removed', 'space'];
  // Without runs between word characters the mixed copies are the copy without hidden
  // characters; with only one such run per word, all three are the same.
  if (mixed) modes.push(...(multi ? (['first', 'last', 'ends'] as const) : (['ends'] as const)));
  if (mixed && !original.includes(MARK)) modes.push('mark');
  for (const m of modes) yield buildCopy(original, runs, m);
}

function onlyHidden(text: string): boolean {
  return withoutHiddenChars(text) === '';
}

/** A replacement in the coordinates of some text: `[start, end)` becomes `text`. */
export interface Span {
  start: number;
  end: number;
  text: string;
}

/**
 * The stretch of the original that units `[s, e)` of `copy` stand for, hidden characters inside
 * it included. An empty stretch sits right before unit `s` (or at the end of the original).
 */
export function originalSpan(
  copy: MatchCopy,
  s: number,
  e: number,
  originalLength: number,
): [number, number] {
  const units = copy.text.length;
  if (e <= s) {
    const at = s < units ? unitInOriginal(copy, s)[0] : originalLength;
    return [at, at];
  }
  const first = s < units ? unitInOriginal(copy, s)[0] : originalLength;
  const last = e - 1 < units ? unitInOriginal(copy, e - 1)[1] : originalLength;
  return [first, last];
}

/**
 * Applies replacements given in the coordinates of `original`. Overlapping ones become one,
 * replaced with `merged`. Everything outside them is kept as it is. Returns the text and how
 * many replacements it holds.
 */
export function replaceSpans(
  original: string,
  spans: readonly Span[],
  merged: string,
): { text: string; count: number } {
  // A span that smaller ones cover, but for gaps of hidden characters, is two secrets a copy
  // glued together: the smaller ones are kept, and so are the hidden characters between them.
  const byStart = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = byStart.filter((big, i) => {
    const inner: Span[] = [];
    for (let j = i + 1; j < byStart.length; j++) {
      const o = byStart[j];
      if (!o || o.start >= big.end) break;
      if (o.end <= big.end && o.end - o.start < big.end - big.start) inner.push(o);
    }
    if (inner.length < 2) return true;
    let at = big.start;
    for (const o of inner) {
      if (o.start > at && !onlyHidden(original.slice(at, o.start))) return true;
      at = Math.max(at, o.end);
    }
    return at < big.end && !onlyHidden(original.slice(at, big.end));
  });
  const sorted = kept.sort((a, b) => a.start - b.start || b.end - a.end);
  const joined: Span[] = [];
  for (const s of sorted) {
    const last = joined[joined.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end || s.text !== last.text) {
        joined[joined.length - 1] = {
          start: last.start,
          end: Math.max(last.end, s.end),
          text: merged,
        };
      }
      continue;
    }
    joined.push(s);
  }
  const out: string[] = [];
  let cursor = 0;
  for (const s of joined) {
    out.push(original.slice(cursor, s.start), s.text);
    cursor = s.end;
  }
  out.push(original.slice(cursor));
  return { text: out.join(''), count: joined.length };
}
