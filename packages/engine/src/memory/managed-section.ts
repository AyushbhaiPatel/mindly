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

const FENCE = /^\s*(```|~~~)/;

/**
 * Finds the managed section. Marker lines inside fenced code blocks are ignored. Returns null when
 * the text has no markers, and 'damaged' when they are not exactly one start followed by one end.
 */
export function findSection(text: string): SectionBounds | null | 'damaged' {
  const starts: SectionBounds[] = [];
  const ends: SectionBounds[] = [];
  let inFence = false;
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    const line = text.slice(at, nl < 0 ? text.length : nl).replace(/\r$/, '');
    const bounds = { start: at, end: at + line.length };
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence && line.trim() === RULES_START) starts.push(bounds);
    else if (!inFence && line.trim() === RULES_END) ends.push(bounds);
    if (nl < 0) break;
    at = nl + 1;
  }
  if (starts.length === 0 && ends.length === 0) return null;
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
