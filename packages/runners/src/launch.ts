import { redact, sanitizeForContext, sanitizeLine } from '@mindly/core';
import { findRepoRoot } from '@mindly/git';
import { assertRunnerAgentKind } from './agents.js';
import type { AgentUsage, RunnerAgentKind } from './agents.js';
import { assertPrompt, assertTimeoutSec, runAgent } from './run.js';
import type { AgentRunStatus, RunnerOptions } from './run.js';

/** Input for `launchTask`. */
export interface LaunchInput {
  agent: string;
  /** Existing git worktree the agent works in. */
  cwd: string;
  prompt: string;
  timeoutSec: number;
}

/** Summary of a launched task. */
export interface LaunchResult {
  agent: RunnerAgentKind;
  /** Worktree root the agent ran in. */
  cwd: string;
  status: AgentRunStatus;
  exitCode: number | null;
  durationMs: number;
  /** Agent's final message, redacted, sanitised and capped. */
  summary: string;
  sessionId: string | null;
  costUsd: number | null;
  usage: AgentUsage | null;
  error: string | null;
}

/**
 * Launches an agent headlessly in `task` mode inside an existing git worktree (opt-in failover).
 *
 * The engine must only call this when the user enabled `config.failover.autoLaunch` (default
 * false) or explicitly asked for the launch. `cwd` is validated with `findRepoRoot` and the
 * agent runs at that worktree's root with a minimal environment; the prompt goes via stdin.
 */
export async function launchTask(
  input: LaunchInput,
  options: RunnerOptions = {},
): Promise<LaunchResult> {
  assertRunnerAgentKind(input.agent);
  assertPrompt(input.prompt);
  assertTimeoutSec(input.timeoutSec);
  const root = await findRepoRoot(input.cwd);
  const run = await runAgent(
    input.agent,
    'task',
    root,
    redact(input.prompt).text,
    input.timeoutSec,
    options,
  );
  let error: string | null = null;
  if (run.status !== 'completed') {
    const stderr = sanitizeLine(redact(run.process.stderr).text, 300);
    error = `agent ${run.status}${run.exitCode === null ? '' : ` (exit ${run.exitCode})`}${
      stderr ? `: ${stderr}` : ''
    }`;
  }
  return {
    agent: input.agent,
    cwd: root,
    status: run.status,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    summary: sanitizeForContext(redact(run.parsed.text).text, 4000),
    sessionId: run.parsed.sessionId,
    costUsd: run.costUsd,
    usage: run.usage,
    error,
  };
}
