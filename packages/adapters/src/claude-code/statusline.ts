import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { InstallOptions, InstallStep } from '@mindly/core';
import { shellJoin, shellQuote } from '../shared/command.js';
import { parseJsonConfig, readConfigText } from '../shared/config-files.js';
import { findOnPath } from '../shared/detect.js';
import { isRecord } from '../shared/payload.js';
import { compactSteps, planJsonFile, validateInstallOptions } from '../shared/plan.js';

/*
 * Claude Code status line (https://code.claude.com/docs/en/statusline). Settings shape:
 * "statusLine": { "type": "command", "command": "<shell command>", "padding"?: number }.
 * Mindly installs "<command> statusline" and only ever edits or removes a statusLine whose command
 * is a bare Mindly invocation, so a status line the user wrote is never touched.
 */

/** The mindly subcommand Claude Code runs for the status line. */
export const STATUSLINE_SUBCOMMAND = 'statusline';

/** What a Claude Code settings file holds under statusLine. */
export type StatusLineState =
  | { kind: 'none' }
  /** Mindly's own status line; current when it runs exactly the command Mindly would install. */
  | { kind: 'mindly'; command: string; current: boolean }
  /** Someone else's status line (left alone). command is null for non-command types. */
  | { kind: 'foreign'; command: string | null };

/** The shell command Mindly installs: <command> statusline. */
export function statusLineCommand(command: readonly string[]): string {
  return shellJoin([...command, STATUSLINE_SUBCOMMAND]);
}

/**
 * Splits a command written by shellJoin (bare safe words and single-quoted words). Returns null
 * for anything else, e.g. pipes, ";", "&&", "$(…)" or double quotes.
 */
function plainWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (ch === ' ' || ch === '\t') {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (ch === '\\' && command[i + 1] === "'") {
      word = (word ?? '') + "'";
      i++;
    } else if (/[A-Za-z0-9_@%+=:,./~-]/.test(ch)) {
      word = (word ?? '') + ch;
    } else {
      return null;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * True when command is a status line Mindly installed: exactly "<…/mindly> statusline" or
 * "<node> <…mindly…/dist/main.js> statusline", or the command ownCommand would install. A user's
 * own script or a chain such as "my.sh; mindly statusline" is never Mindly's.
 */
export function isMindlyStatusLineCommand(
  command: unknown,
  ownCommand?: readonly string[],
): boolean {
  if (typeof command !== 'string') return false;
  if (ownCommand !== undefined && command.trim() === statusLineCommand(ownCommand)) return true;
  const words = plainWords(command.trim());
  if (words === null || words.at(-1) !== STATUSLINE_SUBCOMMAND) return false;
  const [first = '', second = ''] = words;
  if (words.length === 2) return basename(first) === 'mindly';
  return (
    words.length === 3 &&
    (basename(second) === 'mindly' ||
      (/[\\/]dist[\\/]main\.js$/.test(second) && second.toLowerCase().includes('mindly')))
  );
}

/** Classifies the statusLine value of a parsed settings object. */
export function statusLineStateOf(
  settings: Record<string, unknown>,
  ownCommand?: readonly string[],
): StatusLineState {
  const value = settings['statusLine'];
  if (value === undefined || value === null) return { kind: 'none' };
  const command = isRecord(value) && typeof value['command'] === 'string' ? value['command'] : null;
  if (
    command !== null &&
    isRecord(value) &&
    value['type'] === 'command' &&
    isMindlyStatusLineCommand(command, ownCommand)
  ) {
    const current = ownCommand !== undefined && command === statusLineCommand(ownCommand);
    return { kind: 'mindly', command, current };
  }
  return { kind: 'foreign', command };
}

/** Removes statusLine from a settings object when Mindly installed it. */
export function removeMindlyStatusLine(
  settings: Record<string, unknown>,
  ownCommand?: readonly string[],
): void {
  if (statusLineStateOf(settings, ownCommand).kind === 'mindly') {
    Reflect.deleteProperty(settings, 'statusLine');
  }
}

/** A planned status line install: what was there before and the change, if any. */
export interface StatusLinePlan {
  file: string;
  state: StatusLineState;
  steps: InstallStep[];
}

/**
 * Plans adding Mindly's status line to Claude Code's settings.json (user-wide, or the project's
 * with projectRoot). An absent statusLine is added and Mindly's own is pointed at the current
 * command; any other statusLine is left alone (state foreign, no steps). Other keys are kept.
 */
export async function planStatusLineInstall(options: InstallOptions): Promise<StatusLinePlan> {
  validateInstallOptions(options);
  const file = join(options.projectRoot ?? options.homeDir, '.claude', 'settings.json');
  const state = statusLineStateOf(
    parseJsonConfig(file, await readConfigText(file)),
    options.command,
  );
  if (state.kind === 'foreign' || (state.kind === 'mindly' && state.current)) {
    return { file, state, steps: [] };
  }
  const step = await planJsonFile(
    file,
    'Show Mindly in the Claude Code status line',
    'install',
    (config) => {
      const existing = config['statusLine'];
      config['statusLine'] = {
        ...(isRecord(existing) ? existing : {}),
        type: 'command',
        command: statusLineCommand(options.command),
      };
    },
  );
  return { file, state, steps: compactSteps([step]) };
}

/**
 * The statusLine Claude Code uses here and the file it comes from: project settings.local.json,
 * then project settings.json, then the user's settings.json. file is null when none sets one.
 */
export async function effectiveStatusLine(
  options: Pick<InstallOptions, 'homeDir' | 'projectRoot'> & { command?: readonly string[] },
): Promise<{ file: string | null; state: StatusLineState }> {
  const files = [join(options.homeDir, '.claude', 'settings.json')];
  if (options.projectRoot !== null) {
    const dir = join(options.projectRoot, '.claude');
    files.unshift(join(dir, 'settings.local.json'), join(dir, 'settings.json'));
  }
  for (const file of files) {
    const settings = parseJsonConfig(file, await readConfigText(file));
    const state = statusLineStateOf(settings, options.command);
    if (state.kind !== 'none') return { file, state };
  }
  return { file: null, state: { kind: 'none' } };
}

async function isFile(path: string, executable: boolean): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (executable && process.platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the program a Mindly status line command runs still exists: an absolute launcher must
 * be an executable file, a bare one must be on PATH, and a script after node must exist.
 */
export async function statusLineLauncherExists(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const words = plainWords(command.trim());
  if (words === null || words.length < 2) return false;
  const [bin = '', script] = words.slice(0, -1);
  const binOk = bin.includes('/') ? await isFile(bin, true) : (await findOnPath(bin, env)) !== null;
  return binOk && (script === undefined || (await isFile(script, false)));
}

/** A wrapper script that shows an existing status line and then Mindly's, one row each. */
export function chainedStatusLineScript(existing: string, command: readonly string[]): string {
  return [
    '#!/bin/sh',
    '# Claude Code status line: your own line, then Mindly.',
    'input=$(cat)',
    'printf \'%s\' "$input" | sh -c ' + shellQuote(existing),
    'printf \'%s\' "$input" | ' + statusLineCommand(command),
    '',
  ].join('\n');
}
