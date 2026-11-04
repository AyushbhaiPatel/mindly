import { isAbsolute } from 'node:path';
import type { InstallOptions, InstallStep } from '@synapse/core';
import { invalidInput } from '@synapse/core';
import {
  cloneJson,
  parseJsonConfig,
  readConfigText,
  stepIfChanged,
  stringifyJsonConfig,
} from './config-files.js';
import { validateArgv } from './command.js';

/** Whether a plan installs or removes Synapse. */
export type PlanMode = 'install' | 'uninstall';

/** Validates install options shared by every adapter. */
export function validateInstallOptions(options: InstallOptions): void {
  validateArgv(options.command);
  if (!isAbsolute(options.homeDir)) throw invalidInput('homeDir must be an absolute path');
  if (options.projectRoot !== null && !isAbsolute(options.projectRoot)) {
    throw invalidInput('projectRoot must be an absolute path');
  }
}

/**
 * Reads a JSON config, lets `mutate` edit a deep copy, and returns a step when the serialised
 * result differs. On uninstall a missing file produces no step.
 */
export async function planJsonFile(
  file: string,
  description: string,
  mode: PlanMode,
  mutate: (config: Record<string, unknown>) => void,
  maxBytes?: number,
): Promise<InstallStep | null> {
  const previous = await readConfigText(file, maxBytes);
  if (previous === null && mode === 'uninstall') return null;
  const original = parseJsonConfig(file, previous);
  const config = cloneJson(original);
  mutate(config);
  const content = stringifyJsonConfig(config);
  // Semantically unchanged: leave the user's formatting alone.
  if (previous !== null && content === stringifyJsonConfig(original)) return null;
  return stepIfChanged(file, description, previous, content);
}

/** Drops nulls from a list of optional steps. */
export function compactSteps(steps: readonly (InstallStep | null)[]): InstallStep[] {
  return steps.filter((s): s is InstallStep => s !== null);
}
