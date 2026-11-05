/*
 * The section of an agent instruction file (AGENTS.md, CLAUDE.md, GEMINI.md) that Mindly owns.
 * Mindly writes the project's approved rules between two marker lines and never touches anything
 * outside them. Rule import and evidence checks ignore the section, so Mindly never reads back
 * what it wrote.
 */

export const RULES_START = '<!-- mindly:rules:start -->';
export const RULES_END = '<!-- mindly:rules:end -->';

/** Character offsets of the managed section: the start of its first line, the end of its last. */
export interface SectionBounds {
  start: number;
  end: number;
}

/** A CommonMark fence opener: up to three spaces, then three or more backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A fence closer: up to three spaces, a run of one fence character, trailing blanks only. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * A marker line: the marker with at most three spaces before it. A line indented further is an
 * indented code block (or nested list content), never a marker.
 */
function isMarker(line: string, marker: string): boolean {
  const indent = line.length - line.trimStart().length;
  return indent <= 3 && /^ *$/.test(line.slice(0, indent)) && line.trim() === marker;
}

/**
 * Finds the managed section. Marker lines inside fenced code blocks (following the CommonMark
 * rules: a fence is closed only by a run of the same character at least as long as the opener, and
 * an unclosed fence runs to the end of the file) and indented code are ignored.
 *
 * Returns null when the text has no marker at all, and 'damaged' when the markers are not exactly
 * one start followed by one end, or when the marker text appears in the file but not as a section
 * (for example inside a code block that is never closed), or when there is no section and the file
 * ends inside an unclosed code block. A damaged file is never written to, so
 * Mindly cannot append a second section to a file whose existing one it fails to recognise.
 */
export function findSection(text: string): SectionBounds | null | 'damaged' {
  const starts: SectionBounds[] = [];
  const ends: SectionBounds[] = [];
  let fence: { char: string; length: number } | null = null;
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    const line = text.slice(at, nl < 0 ? text.length : nl).replace(/\r$/, '');
    const bounds = { start: at, end: at + line.length };
    if (fence) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close.charAt(0) === fence.char && close.length >= fence.length) fence = null;
    } else {
      const open = FENCE_OPEN.exec(line);
      const run = open?.[1];
      // A backtick fence's info string cannot contain a backtick (that line is inline code).
      if (run && !(run.startsWith('`') && (open?.[2] ?? '').includes('`'))) {
        fence = { char: run.charAt(0), length: run.length };
      } else if (isMarker(line, RULES_START)) starts.push(bounds);
      else if (isMarker(line, RULES_END)) ends.push(bounds);
    }
    if (nl < 0) break;
    at = nl + 1;
  }
  const mentioned = text.includes(RULES_START) || text.includes(RULES_END);
  // A file that ends inside an unclosed code block cannot take a new section: appended at the end,
  // it would land inside the code block, where agents read it as code and later syncs refuse it.
  if (starts.length === 0 && ends.length === 0) return mentioned || fence ? 'damaged' : null;
  const [s] = starts;
  const [e] = ends;
  if (starts.length !== 1 || ends.length !== 1 || !s || !e || e.start < s.end) return 'damaged';
  return { start: s.start, end: e.end };
}

/** The line ending a file uses: CRLF when it has any, LF otherwise. */
export function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Puts `section` into `text`: replaces the existing managed section in place, or appends it after
 * a blank line. Bytes outside the section are kept as they are (a file without a final newline
 * gets one before the appended section).
 */
export function writeSection(text: string, section: string, bounds: SectionBounds | null): string {
  if (bounds) return text.slice(0, bounds.start) + section + text.slice(bounds.end);
  const eol = eolOf(text);
  if (text === '') return section + eol;
  const base = text.endsWith('\n') ? text : text + eol;
  return base + eol + section + eol;
}

/** Removes the managed section and the blank line {@link writeSection} added before it. */
export function removeSection(text: string, bounds: SectionBounds): string {
  const eol = eolOf(text);
  let before = text.slice(0, bounds.start);
  let after = text.slice(bounds.end);
  if (after.startsWith(eol)) after = after.slice(eol.length);
  const blankBefore = before === '' || before.endsWith(eol + eol);
  if (after === '' && before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
  else if (blankBefore && after.startsWith(eol)) after = after.slice(eol.length);
  return before + after;
}

/** `text` without the managed section, for reading a file the way its author wrote it. */
export function stripManagedSection(text: string): string {
  const bounds = findSection(text);
  if (bounds === null || bounds === 'damaged') return text;
  return text.slice(0, bounds.start) + text.slice(bounds.end);
}
