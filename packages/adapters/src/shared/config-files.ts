import { readFile, stat } from 'node:fs/promises';
import type { InstallStep } from '@mindly/core';
import { MindlyError } from '@mindly/core';
import { isRecord } from './payload.js';

/** Default size cap for agent config files we read and rewrite. */
export const MAX_AGENT_CONFIG_BYTES = 1024 * 1024;

/**
 * Reads a config file as UTF-8, or returns null when it does not exist. Refuses files larger than
 * `maxBytes` and anything that is not a regular file.
 */
export async function readConfigText(
  path: string,
  maxBytes: number = MAX_AGENT_CONFIG_BYTES,
): Promise<string | null> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new MindlyError('invalid_input', `${path} is a symlink loop`);
    throw new MindlyError('unavailable', `cannot read agent config: ${path}`, { cause: err });
  }
  if (!info.isFile()) {
    throw new MindlyError('invalid_input', `agent config is not a regular file: ${path}`);
  }
  if (info.size > maxBytes) {
    throw new MindlyError('invalid_input', `agent config is too large to edit safely: ${path}`);
  }
  return readFile(path, 'utf8');
}

/**
 * Parses an agent's JSON config. Missing or blank files yield `{}`; invalid JSON or a non-object
 * top level is refused with a `MindlyError` so we never overwrite a file we do not understand.
 */
export function parseJsonConfig(path: string, text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw new MindlyError(
      'invalid_input',
      `${path} is not valid JSON; fix or remove it before running the installer`,
      { cause },
    );
  }
  if (!isRecord(value)) {
    throw new MindlyError('invalid_input', `${path} must contain a JSON object`);
  }
  return value;
}

/** Serialises a JSON config the way agents write them (2-space indent, trailing newline). */
export function stringifyJsonConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Deep-clones a JSON value. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Returns a step when the content changed, otherwise null. */
export function stepIfChanged(
  file: string,
  description: string,
  previous: string | null,
  content: string,
): InstallStep | null {
  if (previous !== null && previous === content) return null;
  return { file, description, content, previous };
}

/** Returns `obj[key]` as a record, creating (and attaching) an empty one if absent. */
export function ensureRecord(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const existing = obj[key];
  if (existing === undefined || existing === null) {
    const created: Record<string, unknown> = {};
    obj[key] = created;
    return created;
  }
  if (!isRecord(existing)) {
    throw new MindlyError('invalid_input', `"${key}" in ${path} must be an object`);
  }
  return existing;
}
