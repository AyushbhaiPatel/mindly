/*
 * Defensive readers for agent hook payloads. Payload *shape* is validated with zod in each
 * adapter; these helpers read optional fields that may be missing, mistyped or spelled in more
 * than one way, and cap every string so a hostile or runaway payload cannot slow a hook down.
 */

/** Maximum characters kept for any free-text field (prompts, edit text, commands). */
export const MAX_TEXT_CHARS = 200_000;
/** Maximum characters kept for paths and ids. */
export const MAX_PATH_CHARS = 4_096;
/** Maximum characters kept for post-tool output excerpts. */
export const MAX_EXCERPT_CHARS = 4_000;
/** Maximum number of file edits extracted from a single tool call. */
export const MAX_EDITS = 500;

/** Narrows to a plain (non-array) object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Truncates to `max` UTF-16 units without leaving a dangling high surrogate. */
export function capText(text: string, max: number = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text;
  let out = text.slice(0, Math.max(0, max));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** First string value found under any of `keys` (capped), or null. */
export function readString(
  obj: unknown,
  keys: readonly string[],
  max: number = MAX_TEXT_CHARS,
): string | null {
  if (!isRecord(obj)) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string') return capText(v, max);
  }
  return null;
}

/** Like `readString` but treats empty / whitespace-only strings as missing. */
export function readNonEmptyString(
  obj: unknown,
  keys: readonly string[],
  max: number = MAX_TEXT_CHARS,
): string | null {
  if (!isRecord(obj)) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return capText(v, max);
  }
  return null;
}

/** First boolean value found under any of `keys`, or null. */
export function readBoolean(obj: unknown, keys: readonly string[]): boolean | null {
  if (!isRecord(obj)) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'boolean') return v;
  }
  return null;
}

/** First finite number found under any of `keys`, or null. */
export function readNumber(obj: unknown, keys: readonly string[]): number | null {
  if (!isRecord(obj)) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** Returns `value` as a record, or an empty object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Reads a command that may be a string or an argv array (Codex reports both shapes). Arrays are
 * joined with spaces; the result is only used for matching, never executed.
 */
export function readCommand(obj: unknown, keys: readonly string[]): string | null {
  if (!isRecord(obj)) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string') return capText(v);
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
      return capText((v as string[]).join(' '));
    }
  }
  return null;
}
