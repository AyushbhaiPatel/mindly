import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookResult } from '@synapse/core';
import { EMPTY_HOOK_RESULT } from '@synapse/core';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** Loads `test/fixtures/<agent>/<name>.json`. */
export function fixture(agent: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, agent, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** A result with the given fields set. */
export function result(partial: Partial<HookResult>): HookResult {
  return { ...EMPTY_HOOK_RESULT, ...partial };
}

/** Fresh temporary directory. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'synapse-adapters-'));
}

/** Asserts a value is present (test helper instead of non-null assertions). */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

/** Parses rendered stdout. */
export function out(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}
