import { existsSync } from 'node:fs';
import {
  ensureHome,
  loadUserConfig,
  mindlyHome,
  MindlyError,
  readRegularFileBounded,
  UserConfigSchema,
  writeJsonFile,
  type UserConfig,
} from '@mindly/core';
import { z } from 'zod';
import { HintedError, UsageError, type Out } from '../util.js';

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,63}(\.[A-Za-z][A-Za-z0-9]{0,63}){0,5}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Splits and validates a dotted config key such as `hooks.timeoutMs`. */
export function configKey(key: string): string[] {
  if (!KEY_RE.test(key)) throw new UsageError('config keys look like hooks.timeoutMs');
  const parts = key.split('.');
  if (parts.some((p) => FORBIDDEN_KEYS.has(p))) throw new UsageError('invalid config key');
  return parts;
}

function getPath(obj: unknown, parts: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, parts: readonly string[], value: unknown): void {
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    const next = Object.hasOwn(cur, p) ? cur[p] : undefined;
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cur[p] = fresh;
      cur = fresh;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  cur[parts[parts.length - 1] as string] = value;
}

/** A value typed on the command line: JSON when it parses (numbers, booleans, arrays), else text. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const WRAPPERS = new Set([
  'optional',
  'default',
  'prefault',
  'nullable',
  'nonoptional',
  'readonly',
]);

interface Setting {
  /** The setting's own type, with optional/default wrappers removed. */
  schema: z.ZodType;
  /** True when the setting may be absent and has no default (`standup.time`, `llm.model`). */
  optional: boolean;
}

function unwrap(schema: z.ZodType): Setting {
  let cur = schema;
  let optional = false;
  let hasDefault = false;
  while (WRAPPERS.has(cur.def.type)) {
    if (cur.def.type === 'optional') optional = true;
    if (cur.def.type === 'default' || cur.def.type === 'prefault') hasDefault = true;
    cur = (cur.def as unknown as { innerType: z.ZodType }).innerType;
  }
  return { schema: cur, optional: optional && !hasDefault };
}

/** The setting `parts` names in `UserConfigSchema`, or null when there is none. */
function settingAt(parts: readonly string[]): Setting | null {
  let cur = unwrap(UserConfigSchema);
  for (const p of parts) {
    if (!(cur.schema instanceof z.ZodObject)) return null;
    const shape = cur.schema.shape as Record<string, z.ZodType>;
    const next = Object.hasOwn(shape, p) ? shape[p] : undefined;
    if (next === undefined) return null;
    cur = unwrap(next);
  }
  return cur;
}

function noSuchSetting(key: string): HintedError {
  return new HintedError(
    'not_found',
    `There is no setting called ${key}`,
    'See every setting and its value with: mindly config get',
  );
}

/**
 * The value to store for what was typed, by the setting's type: a text setting takes the text as
 * typed (so a model called `4` stays text); a list takes a JSON array for several items, and any
 * other value as its one item (never split on commas: a pattern such as `{20,40}` or a glob such
 * as `{prod,staging}` holds commas of its own); anything else is JSON.
 */
export function settingValue(setting: Setting | null, raw: string): unknown {
  const json = parseValue(raw);
  const type = setting?.schema.def.type;
  if (type === 'string' || type === 'enum') return typeof json === 'string' ? json : raw;
  if (type === 'array' && !Array.isArray(json)) {
    const element = unwrap((setting?.schema.def as unknown as { element: z.ZodType }).element);
    const kind = element.schema.def.type;
    if (kind === 'string' || kind === 'enum') return [typeof json === 'string' ? json : raw];
  }
  return json;
}

function configPath(out: Out): string {
  return ensureHome(mindlyHome(out.io.env)).config;
}

function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  // Refused files (a symlink, a directory, too large) say so themselves.
  let text: string;
  try {
    text = readRegularFileBounded(path, 256 * 1024);
  } catch (cause) {
    const why = cause instanceof MindlyError ? cause.message : 'it could not be read';
    throw new HintedError(
      'invalid_input',
      `Mindly does not read ${path}: ${why}`,
      'The config must be a regular file, not a link to one: replace it with the file itself',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new MindlyError('invalid_input', `${path} is not valid JSON; fix or remove it`, {
      cause,
    });
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new MindlyError('invalid_input', `${path} must contain a JSON object`);
  }
  return json as Record<string, unknown>;
}

/** `mindly config path`. */
export function configPathCmd(out: Out): number {
  out.line(configPath(out));
  return 0;
}

/**
 * `mindly config get [key]`: the effective value (defaults included). A setting that exists but
 * is not set (it is optional and has no default) prints `null`.
 */
export function configGet(out: Out, key: string | undefined): number {
  const config = loadUserConfig(configPath(out));
  const parts = key === undefined ? [] : configKey(key);
  const value = getPath(config, parts);
  if (value === undefined) {
    if (settingAt(parts) === null) throw noSuchSetting(key ?? '');
    out.json(null);
    return 0;
  }
  out.json(value);
  return 0;
}

function validated(raw: Record<string, unknown>, key: string): UserConfig {
  const parsed = UserConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MindlyError(
      'invalid_input',
      `invalid value for ${key}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * `mindly config set <key> <value>`: validates the whole file against `UserConfigSchema` before
 * writing it (atomically, mode 0600). Unknown keys are refused.
 */
export function configSet(out: Out, key: string, rawValue: string): number {
  const parts = configKey(key);
  const path = configPath(out);
  const raw = readRaw(path);
  const setting = settingAt(parts);
  const value = settingValue(setting, rawValue);
  setPath(raw, parts, value);
  validated(raw, key);
  // zod strips unknown keys, so validation alone does not catch a key that does not exist.
  if (setting === null) {
    throw new HintedError(
      'invalid_input',
      `There is no setting called ${key}`,
      'See every setting and its value with: mindly config get',
    );
  }
  writeJsonFile(path, raw);
  out.line(`${key} = ${JSON.stringify(value)}`);
  return 0;
}

/**
 * `mindly config unset <key>`: removes one setting (or a whole group) from the file, so it goes
 * back to its default; an optional setting such as `standup.time` is turned off.
 */
export function configUnset(out: Out, key: string): number {
  const parts = configKey(key);
  const path = configPath(out);
  if (settingAt(parts) === null) throw noSuchSetting(key);
  const raw = readRaw(path);
  if (getPath(raw, parts) === undefined) {
    out.line(`${key} is not set in ${path}: nothing changed.`);
    return 0;
  }
  // Remove the key, then the groups this leaves empty.
  for (let depth = parts.length; depth > 0; depth--) {
    const holder = getPath(raw, parts.slice(0, depth - 1)) as Record<string, unknown>;
    const name = parts[depth - 1] as string;
    if (depth < parts.length) {
      const child = holder[name];
      const empty = child !== null && typeof child === 'object' && Object.keys(child).length === 0;
      if (!empty) break;
    }
    Reflect.deleteProperty(holder, name);
  }
  const now = getPath(validated(raw, key), parts);
  writeJsonFile(path, raw);
  out.line(
    now === undefined
      ? `${key} is no longer set.`
      : `${key} is back to its default: ${JSON.stringify(now)}`,
  );
  return 0;
}
