/*
 * Characters that render as nothing (Unicode Cf and Default_Ignorable_Code_Point: zero-width
 * characters, bidi controls, the soft hyphen, tag characters, variation selectors, fillers, ...)
 * and control characters other than TAB and LF. One of them inside a secret hides it from a
 * pattern, and cleaning text for display later removes it and puts the secret back together.
 *
 * Redaction therefore looks for secrets in a copy without them, and replaces the secrets it finds
 * in the original text, which otherwise keeps every character it had: a joiner in an emoji, a
 * Persian zero-width non-joiner, a variation selector, or the bidi override a code review must see.
 */

const HIDDEN =
  '[\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]';
const HIDDEN_TEST = new RegExp(HIDDEN, 'u');
const HIDDEN_ALL = new RegExp(HIDDEN, 'gu');

/** Whether `text` holds a character that renders as nothing or a control character. */
export function hasHiddenChars(text: string): boolean {
  return HIDDEN_TEST.test(text);
}

/** `text` without the characters that render as nothing and without control characters. */
export function withoutHiddenChars(text: string): string {
  return text.replace(HIDDEN_ALL, '');
}

/** Longest stretch of text after a replacement used to find where the original resumes. */
const ANCHOR_CHARS = 64;

/**
 * Carries the replacements that turned `visible` (= `withoutHiddenChars(original)`) into
 * `replaced` over to `original`: each replaced stretch of `visible` is replaced in `original`,
 * hidden characters inside it included, and everything else of `original` is kept as it is.
 * Every replacement holds `marker`. Returns null when the two cannot be lined up; the result is
 * checked, so the caller never gets text whose visible part differs from `replaced`.
 */
export function replaceInOriginal(
  original: string,
  visible: string,
  replaced: string,
  marker: string,
): string | null {
  // Offset in `original` of each UTF-16 unit of `visible`.
  const at: number[] = [];
  for (let o = 0; o < original.length;) {
    const cp = original.codePointAt(o) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    if (!HIDDEN_TEST.test(String.fromCodePoint(cp))) {
      for (let u = 0; u < len; u++) at.push(o + u);
    }
    o += len;
  }
  if (at.length !== visible.length) return null;

  const edits: { start: number; end: number; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (j < replaced.length || i < visible.length) {
    if (i < visible.length && j < replaced.length && visible[i] === replaced[j]) {
      i++;
      j++;
      continue;
    }
    // A replacement starts at or just before `j` (its first characters may equal the text's).
    let m = replaced.lastIndexOf(marker, j);
    if (m < 0 || m + marker.length <= j) m = replaced.startsWith(marker, j) ? j : -1;
    if (m < 0) return null;
    i -= j - m;
    const after = m + marker.length;
    const next = replaced.indexOf(marker, after);
    const limit = next < 0 ? replaced.length : next;
    const width = Math.min(ANCHOR_CHARS, limit - after);
    let resume: number;
    if (width === 0) {
      if (limit !== replaced.length) return null;
      resume = visible.length;
    } else {
      resume = visible.indexOf(replaced.slice(after, after + width), i + 1);
    }
    if (i < 0 || resume <= i) return null;
    edits.push({ start: i, end: resume, text: marker });
    i = resume;
    j = after;
  }

  let out = '';
  let cursor = 0;
  for (const e of edits) {
    out += original.slice(cursor, at[e.start]) + e.text;
    // Hidden characters right after the replaced stretch are not part of it.
    cursor = (at[e.end - 1] ?? original.length) + 1;
  }
  out += original.slice(cursor);
  return withoutHiddenChars(out) === replaced ? out : null;
}
