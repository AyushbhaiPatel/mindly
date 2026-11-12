import type { FileEdit } from '@mindly/core';
import { capText, MAX_EDITS, MAX_PATH_CHARS, MAX_TEXT_CHARS } from '../shared/payload.js';

/** Inputs larger than this are truncated before parsing. */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

const BEGIN = '*** Begin Patch';
const HEADER_RE = /^\*\*\* (Add|Update|Delete) File:\s*(.*)$/;
const MOVE_RE = /^\*\*\* Move to:\s*(.*)$/;

interface Section {
  path: string;
  /** Where an `Update File` section moves the file to (`*** Move to:`), when it does. */
  movedTo: string | null;
  kind: 'Add' | 'Update' | 'Delete';
  added: string[];
  removed: string[];
  addedLen: number;
  removedLen: number;
}

function validPath(raw: string): string | null {
  const path = raw.trim();
  if (path === '' || path.length > MAX_PATH_CHARS || path.includes('\0')) return null;
  return path;
}

function push(lines: string[], len: number, line: string): number {
  if (len >= MAX_TEXT_CHARS) return len;
  lines.push(line);
  return len + line.length + 1;
}

/**
 * Parses a Codex `apply_patch` envelope into per-file edits.
 *
 * Format (`*** Begin Patch` ... `*** End Patch`): sections start with `*** Add File: <path>`,
 * `*** Update File: <path>` (optionally followed by `*** Move to: <path>`, reported as an edit of
 * the new path plus the removal of the old one) or
 * `*** Delete File: <path>`. Inside sections, `@@` lines introduce hunks, `+` lines are added,
 * `-` lines removed and ` ` lines are context. The parser is lenient and bounded: input is capped
 * at 2 MB, text per file at 200 KB, sections with an invalid path are skipped, and unknown lines
 * are ignored. It never throws.
 */
export function parseApplyPatch(input: string): FileEdit[] {
  return readApplyPatch(input).edits;
}

/**
 * Like {@link parseApplyPatch}, and says whether the patch was `cut`: it holds more sections than
 * are reported, or more text than is read. The cap counts sections, so a patch of moves (two
 * edits each) is reported as fully as any other. A cut patch changes files that are not in
 * `edits`; whoever checks the edits must not take them for the whole write.
 */
export function readApplyPatch(input: string): { edits: FileEdit[]; cut: boolean } {
  let cut = input.length >= MAX_PATCH_BYTES;
  const text = input.length > MAX_PATCH_BYTES ? input.slice(0, MAX_PATCH_BYTES) : input;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const header = HEADER_RE.exec(line);
    if (header) {
      current = null;
      const path = validPath(header[2] ?? '');
      if (path !== null && sections.length >= MAX_EDITS) cut = true;
      if (path !== null && sections.length < MAX_EDITS) {
        current = {
          path,
          movedTo: null,
          kind: header[1] as Section['kind'],
          added: [],
          removed: [],
          addedLen: 0,
          removedLen: 0,
        };
        sections.push(current);
      }
      continue;
    }
    if (line.startsWith('*** ')) {
      // A move target keeps the section open; Begin/End Patch/End of File markers are structural.
      const move = MOVE_RE.exec(line);
      if (move) {
        if (current?.kind === 'Update') current.movedTo = validPath(move[1] ?? '');
        continue;
      }
      if (line.startsWith('*** End Patch')) current = null;
      continue;
    }
    if (current === null || current.kind === 'Delete') continue;
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) {
      current.addedLen = push(current.added, current.addedLen, line.slice(1));
    } else if (line.startsWith('-') && current.kind === 'Update') {
      current.removedLen = push(current.removed, current.removedLen, line.slice(1));
    }
  }

  const edits: FileEdit[] = [];
  for (const s of sections) {
    const addedText = capText(s.added.join('\n'));
    const removedText = capText(s.removed.join('\n'));
    if (s.movedTo !== null && s.movedTo !== s.path) {
      // A move writes the new path and removes the old one: both are files the patch changes.
      edits.push({ path: s.movedTo, addedText, removedText, wholeFile: false });
      edits.push({ path: s.path, addedText: '', removedText: '', wholeFile: true });
      continue;
    }
    edits.push({ path: s.path, addedText, removedText, wholeFile: s.kind !== 'Update' });
  }
  return { edits, cut };
}

/**
 * Finds patch text in a Codex `apply_patch` (or shell) tool input. Codex reports it as
 * `tool_input.command` (string) or as an argv array such as `["apply_patch", "<patch>"]`; older
 * builds used `input` / `patch`. Shell commands with an inline heredoc patch are also recognised.
 */
export function findPatchText(toolInput: unknown): string | null {
  const candidates: unknown[] = [];
  if (typeof toolInput === 'string') candidates.push(toolInput);
  else if (Array.isArray(toolInput)) candidates.push(...toolInput);
  else if (typeof toolInput === 'object' && toolInput !== null) {
    const rec = toolInput as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'input', 'patch']) {
      const v = rec[key];
      if (Array.isArray(v)) candidates.push(...v);
      else candidates.push(v);
    }
  }
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes(BEGIN)) {
      return c.length > MAX_PATCH_BYTES ? c.slice(0, MAX_PATCH_BYTES) : c;
    }
  }
  return null;
}
