import type { FileEdit, NormalizedHookEvent } from '@synapse/core';
import { findPatchText, parseApplyPatch } from '../codex/apply-patch.js';
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
  const patch = findPatchText(toolInput);
  if (patch !== null) return parseApplyPatch(patch);
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

/** Builds the normalised `tool` section of an event. */
export function buildTool(opts: BuildToolOptions): NonNullable<NormalizedHookEvent['tool']> {
  const cls = classifyTool(opts.name);
  const command = readCommand(opts.input, ['command', 'cmd']);
  const shell = opts.shell ?? cls.shell;
  let edits: FileEdit[] = [];
  let writes = opts.writes ?? cls.writes;
  if (writes || (shell && command !== null && command.includes('*** Begin Patch'))) {
    edits = extractEdits(opts.name, opts.input);
    if (edits.length > 0) writes = true;
  }
  const hasResponse = opts.response !== undefined;
  return {
    name: capText(opts.name, 200),
    writes,
    shell,
    edits,
    command: shell ? command : null,
    failed: opts.failed ?? (hasResponse ? didFail(opts.response) : false),
    outputExcerpt: hasResponse ? outputExcerpt(opts.response) : null,
  };
}
