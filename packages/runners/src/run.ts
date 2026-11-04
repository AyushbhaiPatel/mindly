import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SynapseError } from '@synapse/core';
import { agentProfile, detectAgent } from './agents.js';
import type { AgentUsage, ParsedAgentOutput, RunMode, RunnerAgentKind } from './agents.js';
import { buildAgentEnv, runProcess } from './process.js';
import type { ProcessResult } from './process.js';

/** Default agentic turn limit for headless runs. */
export const DEFAULT_MAX_TURNS = 40;
/** Largest accepted prompt (characters). */
export const MAX_PROMPT_CHARS = 400_000;
const MAX_LAST_MESSAGE_BYTES = 1024 * 1024;

/** Options shared by every runner entry point. */
export interface RunnerOptions {
  /**
   * Environment used to find agent binaries (`PATH`) and as the source of the allow-listed
   * variables passed to agents. Default `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /** Delay between SIGTERM and SIGKILL on timeout/abort (default 5 s). */
  killGraceMs?: number;
  /** Bytes of agent stdout kept (default 2 MiB). */
  maxStdoutBytes?: number;
  /** Bytes of agent stderr kept (default 64 KiB). */
  maxStderrBytes?: number;
  /** Agentic turn limit where supported (default 40). */
  maxTurns?: number;
  /** Cancels the run (the process tree is killed). */
  signal?: AbortSignal;
}

/** `completed`: exit 0 and no agent-reported error. */
export type AgentRunStatus = 'completed' | 'failed' | 'timeout' | 'aborted' | 'error';

/** Result of one headless agent invocation. */
export interface AgentRunResult {
  agent: RunnerAgentKind;
  mode: RunMode;
  status: AgentRunStatus;
  exitCode: number | null;
  durationMs: number;
  parsed: ParsedAgentOutput;
  costUsd: number | null;
  usage: AgentUsage | null;
  /** Raw process outcome (stdout/stderr already capped). */
  process: ProcessResult;
}

/** Validates a timeout in seconds (1 s to 2 h). */
export function assertTimeoutSec(timeoutSec: unknown): asserts timeoutSec is number {
  if (
    typeof timeoutSec !== 'number' ||
    !Number.isFinite(timeoutSec) ||
    timeoutSec <= 0 ||
    timeoutSec > 7200
  ) {
    throw new SynapseError('invalid_input', 'timeoutSec must be between 1 and 7200');
  }
}

/** Validates a prompt (non-empty string, bounded, no NUL). */
export function assertPrompt(prompt: unknown): asserts prompt is string {
  if (
    typeof prompt !== 'string' ||
    prompt.trim() === '' ||
    prompt.length > MAX_PROMPT_CHARS ||
    prompt.includes('\0')
  ) {
    throw new SynapseError('invalid_input', 'invalid prompt');
  }
}

/**
 * Runs `kind` headlessly in `mode` with `cwd` as working directory. The prompt goes to stdin;
 * the child gets a minimal environment. Throws `unavailable` when the agent is not installed.
 */
export async function runAgent(
  kind: RunnerAgentKind,
  mode: RunMode,
  cwd: string,
  prompt: string,
  timeoutSec: number,
  options: RunnerOptions = {},
): Promise<AgentRunResult> {
  const profile = agentProfile(kind);
  assertTimeoutSec(timeoutSec);
  assertPrompt(prompt);
  const baseEnv = options.env ?? process.env;
  const bin = detectAgent(kind, baseEnv);
  if (!bin) throw new SynapseError('unavailable', `${kind} is not installed or not on PATH`);
  const maxTurns = Math.min(500, Math.max(1, Math.floor(options.maxTurns ?? DEFAULT_MAX_TURNS)));

  const tmp = mkdtempSync(join(tmpdir(), 'synapse-run-'));
  try {
    const lastMessageFile = join(tmp, 'last-message.txt');
    const argv = profile.buildArgv({ mode, cwd, maxTurns, lastMessageFile });
    const proc = await runProcess({
      bin,
      argv,
      cwd,
      env: buildAgentEnv(profile.authEnv, baseEnv),
      input: prompt,
      timeoutMs: Math.floor(timeoutSec * 1000),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      ...(options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
      ...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let lastMessage: string | null = null;
    if (profile.usesLastMessageFile) {
      try {
        const buf = readFileSync(lastMessageFile);
        lastMessage = buf.subarray(0, MAX_LAST_MESSAGE_BYTES).toString('utf8');
      } catch {
        lastMessage = null;
      }
    }
    const parsed = profile.parseOutput(proc.stdout, lastMessage);
    let status: AgentRunStatus;
    if (proc.spawnError !== null) status = 'error';
    else if (proc.timedOut) status = 'timeout';
    else if (proc.aborted) status = 'aborted';
    else if (proc.exitCode !== 0 || parsed.isError) status = 'failed';
    else status = 'completed';
    return {
      agent: kind,
      mode,
      status,
      exitCode: proc.exitCode,
      durationMs: proc.durationMs,
      parsed,
      costUsd: parsed.costUsd,
      usage: parsed.usage,
      process: proc,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
