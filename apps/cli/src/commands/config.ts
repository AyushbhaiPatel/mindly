import { existsSync } from 'node:fs';
import {
  ensureHome,
  loadUserConfig,
  mindlyHome,
  MindlyError,
  readRegularFileBounded,
  UserConfigSchema,
  writeJsonFile,
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

function configPath(out: Out): string {
  return ensureHome(mindlyHome(out.io.env)).config;
}

function readRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let json: unknown;
  try {
    json = JSON.parse(readRegularFileBounded(path, 256 * 1024));
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

/** `mindly config get [key]`: the effective value (defaults included). */
export function configGet(out: Out, key: string | undefined): number {
  const config = loadUserConfig(configPath(out));
  const value = key === undefined ? config : getPath(config, configKey(key));
  if (value === undefined) {
    throw new HintedError(
      'not_found',
      `There is no setting called ${key ?? ''}`,
      'See every setting and its value with: mindly config get',
    );
  }
  out.json(value);
  return 0;
}

/**
 * `mindly config set <key> <value>`: validates the whole file against `UserConfigSchema` before
 * writing it (atomically, mode 0600). Unknown keys are refused.
 */
export function configSet(out: Out, key: string, rawValue: string): number {
  const parts = configKey(key);
  const path = configPath(out);
  const raw = readRaw(path);
  const value = parseValue(rawValue);
  setPath(raw, parts, value);
  const parsed = UserConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MindlyError(
      'invalid_input',
      `invalid value for ${key}: ${z.prettifyError(parsed.error)}`,
    );
  }
  // zod strips unknown keys, so a key that is missing after parsing does not exist.
  if (getPath(parsed.data, parts) === undefined) {
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
