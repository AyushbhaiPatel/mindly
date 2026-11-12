import type { FileEdit, NormalizedHookEvent } from '@mindly/core';
import { findPatchText, readApplyPatch } from '../codex/apply-patch.js';
import {
  capText,
  isRecord,
  MAX_EDITS,
  MAX_EXCERPT_CHARS,
  MAX_PATH_CHARS,
  readBoolean,
  readCommand,
  readNumber,
  readString,
} from './payload.js';

/** Tool names (any agent) that modify files. Compared case-insensitively. */
const WRITE_TOOLS = new Set(
  [
    'Edit',
    'MultiEdit',
    'Write',
    'NotebookEdit',
    'apply_patch',
    'afterFileEdit',
    'edit_file',
    'search_replace',
    'write_file',
    'create_file',
    'delete_file',
    'StrReplace',
    'Delete',
  ].map((n) => n.toLowerCase()),
);

/** Tool names (any agent) that run shell commands. Compared case-insensitively. */
const SHELL_TOOLS = new Set(
  [
    'Bash',
    'shell',
    'Shell',
    'exec',
    'exec_command',
    'local_shell',
    'unified_exec',
    'container.exec',
    'run_terminal_cmd',
    'terminal',
    'beforeShellExecution',
    'afterShellExecution',
  ].map((n) => n.toLowerCase()),
);

/** Classifies a tool name. */
export function classifyTool(name: string): { writes: boolean; shell: boolean } {
  const lower = name.toLowerCase();
  return { writes: WRITE_TOOLS.has(lower), shell: SHELL_TOOLS.has(lower) };
}

const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file'];

function readPath(obj: unknown): string | null {
  const p = readString(obj, PATH_KEYS, MAX_PATH_CHARS + 1);
  if (p === null || p.trim() === '' || p.length > MAX_PATH_CHARS || p.includes('\0')) return null;
  return p;
}

/**
 * Extracts file edits from a tool input using the field conventions shared by Claude Code and
 * Cursor (`file_path`, `old_string`/`new_string`, `edits[]`, `content`, `new_source`) and Codex
 * patches. Unknown shapes yield an empty list.
 */
export function extractEdits(toolName: string, toolInput: unknown): FileEdit[] {
  return readEdits(toolName, toolInput).edits;
}

/**
 * {@link extractEdits}, and whether the input holds more edits than are reported (`cut`): a
 * patch or edit list beyond the cap changes files that are not in the list.
 */
export function readEdits(
  toolName: string,
  toolInput: unknown,
): { edits: FileEdit[]; cut: boolean } {
  const patch = findPatchText(toolInput);
  if (patch !== null) return readApplyPatch(patch);
  const listed = isRecord(toolInput) ? toolInput['edits'] : undefined;
  const edits = editsOf(toolName, toolInput);
  if (!Array.isArray(listed) || listed.length <= MAX_EDITS) return { edits, cut: false };
  // Edits beyond the cap only matter when they change a file the reported ones do not: many
  // edits of one file (MultiEdit) are that file, whatever their number.
  const reported = new Set(edits.map((e) => e.path));
  const fallback = readPath(toolInput);
  const cut = listed.slice(MAX_EDITS).some((e) => !reported.has(readPath(e) ?? fallback ?? ''));
  return { edits, cut };
}

function editsOf(toolName: string, toolInput: unknown): FileEdit[] {
  if (!isRecord(toolInput)) return [];
  const path = readPath(toolInput);
  if (path === null) return [];
  const lower = toolName.toLowerCase();

  const edits = toolInput['edits'];
  if (Array.isArray(edits)) {
    const out: FileEdit[] = [];
    for (const e of edits.slice(0, MAX_EDITS)) {
      if (!isRecord(e)) continue;
      const added = readString(e, ['new_string', 'newString', 'new_text']);
      const removed = readString(e, ['old_string', 'oldString', 'old_text']);
      if (added === null && removed === null) continue;
      out.push({
        path: readPath(e) ?? path,
        addedText: added ?? '',
        removedText: removed ?? '',
        wholeFile: false,
      });
    }
    return out;
  }

  const newString = readString(toolInput, ['new_string', 'newString']);
  const oldString = readString(toolInput, ['old_string', 'oldString']);
  if (newString !== null || oldString !== null) {
    return [{ path, addedText: newString ?? '', removedText: oldString ?? '', wholeFile: false }];
  }

  const source = readString(toolInput, ['new_source']);
  if (source !== null) {
    return [{ path, addedText: source, removedText: '', wholeFile: false }];
  }

  const content = readString(toolInput, ['content', 'contents', 'file_text', 'text']);
  if (content !== null || lower === 'write') {
    return [{ path, addedText: content ?? '', removedText: '', wholeFile: true }];
  }
  if (lower === 'delete' || lower === 'delete_file') {
    return [{ path, addedText: '', removedText: '', wholeFile: true }];
  }
  return [{ path, addedText: '', removedText: '', wholeFile: false }];
}

/** Excerpt of a tool's output or error, preferring error text. */
function outputExcerpt(response: unknown): string | null {
  if (typeof response === 'string')
    return response === '' ? null : capText(response, MAX_EXCERPT_CHARS);
  if (!isRecord(response)) return null;
  for (const key of [
    'error',
    'stderr',
    'output',
    'stdout',
    'aggregated_output',
    'result',
    'message',
  ]) {
    const v = response[key];
    if (typeof v === 'string' && v.trim() !== '') return capText(v, MAX_EXCERPT_CHARS);
  }
  return null;
}

/** Best-effort failure detection across the response shapes agents report. */
function didFail(response: unknown): boolean {
  if (!isRecord(response)) return false;
  if (readBoolean(response, ['is_error', 'isError', 'interrupted']) === true) return true;
  if (readBoolean(response, ['success', 'ok']) === false) return true;
  const exit = readNumber(response, ['exit_code', 'exitCode', 'returncode', 'status_code']);
  if (exit !== null && exit !== 0) return true;
  const err = response['error'];
  return (typeof err === 'string' && err.trim() !== '') || isRecord(err);
}

/** Options for {@link buildTool}. */
export interface BuildToolOptions {
  name: string;
  input: unknown;
  response?: unknown;
  /** Forces `failed` (e.g. Claude Code's PostToolUseFailure event). */
  failed?: boolean;
  /** Forces `writes` (e.g. Cursor's afterFileEdit event). */
  writes?: boolean;
  /** Forces `shell`. */
  shell?: boolean;
}

/** The first line of `apply_patch` given a here-document with a quoted delimiter. */
const PATCH_HEAD =
  /^\s*(?:apply_patch|applypatch)[ \t]+<<(-?)[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*$/;

/**
 * A shell call that bash never runs: `apply_patch` given a patch in a here-document whose
 * delimiter is quoted (so nothing in it is expanded), as the whole command, the delimiter ending
 * it on its last line and on no line before (with `<<-`, after leading tabs too). The agent takes
 * it as its patch tool. Anything else, a bare patch text or a here-document bash expands or ends
 * early, is shell code.
 */
function isPatchCall(command: string): boolean {
  if (!command.includes('*** Begin Patch')) return false;
  const lines = command.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const head = PATCH_HEAD.exec(lines[0] ?? '');
  if (head === null || lines.length < 4) return false;
  const tabs = head[1] === '-';
  const delimiter = head[3] as string;
  const ends = (line: string): boolean => (tabs ? line.replace(/^\t+/, '') : line) === delimiter;
  if (!ends(lines[lines.length - 1] as string)) return false;
  const body = lines.slice(1, -1);
  if (body.some(ends)) return false;
  return (
    (body[0] ?? '').trimEnd() === '*** Begin Patch' &&
    (body[body.length - 1] ?? '').trimEnd() === '*** End Patch'
  );
}

/** Builds the normalised `tool` section of an event. */
export function buildTool(opts: BuildToolOptions): NonNullable<NormalizedHookEvent['tool']> {
  const cls = classifyTool(opts.name);
  const command = readCommand(opts.input, ['command', 'cmd']);
  const shell = opts.shell ?? cls.shell;
  let edits: FileEdit[] = [];
  let editsCut = false;
  let writes = opts.writes ?? cls.writes;
  if (writes) {
    ({ edits, cut: editsCut } = readEdits(opts.name, opts.input));
  } else if (shell && command !== null && command.includes('*** Begin Patch')) {
    // A shell call is the agent's patch only when bash would run nothing of it. Any other line
    // holding a patch stays a shell line, read as one, and its patch's files are read besides.
    ({ edits, cut: editsCut } = readEdits(opts.name, opts.input));
    if (edits.length > 0 && isPatchCall(command)) writes = true;
  }
  const hasResponse = opts.response !== undefined;
  return {
    name: capText(opts.name, 200),
    writes,
    shell,
    edits,
    ...(editsCut ? { editsCut } : {}),
    command: shell ? command : null,
    failed: opts.failed ?? (hasResponse ? didFail(opts.response) : false),
    outputExcerpt: hasResponse ? outputExcerpt(opts.response) : null,
  };
}
