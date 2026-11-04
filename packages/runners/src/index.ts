/**
 * `@mindly/runners`: headless runs of coding agents (Claude Code, Codex) for cross-agent review,
 * A/B replay and opt-in failover launch. Depends on `@mindly/core`, `@mindly/git` and Node
 * built-ins.
 *
 * Every agent is started with `spawn` and an argument array (never a shell), the prompt on stdin,
 * a minimal environment, a hard timeout that kills the whole process group, and capped output.
 */

import { detectAgent, isRunnerAgentKind } from './agents.js';
import { launchTask } from './launch.js';
import type { LaunchInput, LaunchResult } from './launch.js';
import { runReplay } from './replay.js';
import type { ReplayComparison, ReplayInput } from './replay.js';
import { runReview } from './review.js';
import type { ReviewInput, ReviewResult } from './review.js';
import type { RunnerOptions } from './run.js';

export {
  AGENT_PROFILES,
  CLAUDE_REVIEW_DENIED_TOOLS,
  CLAUDE_REVIEW_TOOLS,
  CLAUDE_TASK_DENIED_TOOLS,
  RUNNER_AGENT_KINDS,
  agentProfile,
  assertRunnerAgentKind,
  detectAgent,
  isRunnerAgentKind,
  parseClaudeOutput,
  parseCodexOutput,
} from './agents.js';
export type {
  AgentProfile,
  AgentUsage,
  ArgvContext,
  ParsedAgentOutput,
  RunMode,
  RunnerAgentKind,
} from './agents.js';

export {
  BASE_ENV_ALLOW_LIST,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  MAX_RUN_TIMEOUT_MS,
  buildAgentEnv,
  runProcess,
} from './process.js';
export type { ProcessResult, RunProcessOptions } from './process.js';

export { DEFAULT_MAX_TURNS, MAX_PROMPT_CHARS, runAgent } from './run.js';
export type { AgentRunResult, AgentRunStatus, RunnerOptions } from './run.js';

export {
  MAX_REVIEW_DIFF_CHARS,
  MAX_REVIEW_FINDINGS,
  buildReviewPrompt,
  parseFindings,
  prepareDiff,
  runReview,
} from './review.js';
export type { ReviewFinding, ReviewInput, ReviewResult, ReviewSeverity } from './review.js';

export {
  REPLAY_REF_PREFIX,
  assertValidRunId,
  parseNumstat,
  replayRefName,
  runReplay,
} from './replay.js';
export type { NumstatEntry, ReplayAgentResult, ReplayComparison, ReplayInput } from './replay.js';

export { launchTask } from './launch.js';
export type { LaunchInput, LaunchResult } from './launch.js';

/** The runner surface the engine consumes (constructor-injected so tests can fake it). */
export interface RunnerPort {
  /** Cross-agent review in read-only mode. */
  review(input: ReviewInput): Promise<ReviewResult>;
  /** A/B replay in isolated worktrees. */
  replay(input: ReplayInput): Promise<ReplayComparison>;
  /** Opt-in failover launch; only call when `config.failover.autoLaunch` is true. */
  launch(input: LaunchInput): Promise<LaunchResult>;
  /** True when `kind` is supported and its binary is on PATH. */
  available(kind: string): Promise<boolean>;
}

/** Creates a `RunnerPort` with shared options (environment, caps, kill grace, turn limit). */
export function createRunners(options: RunnerOptions = {}): RunnerPort {
  return {
    review: (input) => runReview(input, options),
    replay: (input) => runReplay(input, options),
    launch: (input) => launchTask(input, options),
    available: async (kind) =>
      isRunnerAgentKind(kind) && detectAgent(kind, options.env ?? process.env) !== null,
  };
}
