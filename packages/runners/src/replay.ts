import { SynapseError, describeError, redact, sanitizeForContext, uuidv7 } from '@synapse/core';
import {
  assertValidRefName,
  assertValidRevision,
  captureWorktreeCommit,
  findRepoRoot,
  materializeTree,
  resolveCommit,
  runChecks,
  runGit,
} from '@synapse/git';
import type { CheckResult, CheckSpec, MaterializedTree } from '@synapse/git';
import { assertRunnerAgentKind, detectAgent } from './agents.js';
import type { AgentUsage, RunnerAgentKind } from './agents.js';
import { assertPrompt, assertTimeoutSec, runAgent } from './run.js';
import type { RunnerOptions } from './run.js';

/** Hidden ref namespace holding replay results. */
export const REPLAY_REF_PREFIX = 'refs/synapse/replays/';
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_REPLAY_AGENTS = 4;
const MAX_SUMMARY_CHARS = 4000;

/** Throws `invalid_input` unless `id` is a safe run id (letters, digits, `_` and `-`). */
export function assertValidRunId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
    throw new SynapseError('invalid_input', 'invalid run id');
  }
}

/** `refs/synapse/replays/<runId>/<agent>`, validated. */
export function replayRefName(runId: string, agent: string): string {
  assertValidRunId(runId);
  assertRunnerAgentKind(agent);
  const ref = `${REPLAY_REF_PREFIX}${runId}/${agent}`;
  assertValidRefName(ref);
  return ref;
}

/** Input for `runReplay`. */
export interface ReplayInput {
  repoRoot: string;
  /** Commit every agent starts from (object id, `HEAD` or a ref name). */
  baseCommit: string;
  /** Task given to every agent. */
  prompt: string;
  agents: readonly string[];
  /**
   * Checks run against each result. Only pass checks from a trusted project config (the user
   * approved its hash); null skips checks.
   */
  checks: readonly CheckSpec[] | null;
  /** Per-agent time limit in seconds. */
  timeoutSec: number;
  /** Run id used in result refs; generated (UUIDv7) when omitted. */
  runId?: string;
  /** Agents run at the same time: 1 (default) or 2. */
  concurrency?: 1 | 2;
}

/** Per-file line counts between base and result (`null` for binary files). */
export interface NumstatEntry {
  path: string;
  added: number | null;
  deleted: number | null;
}

/** Outcome for one agent in a replay. */
export interface ReplayAgentResult {
  agent: RunnerAgentKind;
  status: 'completed' | 'failed' | 'timeout' | 'aborted' | 'error' | 'unavailable';
  exitCode: number | null;
  durationMs: number;
  costUsd: number | null;
  usage: AgentUsage | null;
  /** Agent's final message, redacted, sanitised and capped. */
  summary: string;
  /** Captured result commit (null when capture failed or the agent was unavailable). */
  resultCommit: string | null;
  /** Ref keeping `resultCommit` reachable. */
  resultRef: string | null;
  files: NumstatEntry[];
  totals: { files: number; added: number; deleted: number };
  /** Output of `git diff --shortstat`, e.g. "2 files changed, 10 insertions(+)". */
  shortstat: string;
  /** Paths the agent changed that were not captured because they are on the secret deny-list. */
  skipped: string[];
  checks: CheckResult[] | null;
  error: string | null;
}

/** Comparison returned by `runReplay`. */
export interface ReplayComparison {
  runId: string;
  baseCommit: string;
  startedAt: number;
  finishedAt: number;
  results: ReplayAgentResult[];
}

/** Parses `git diff --numstat -z --no-renames` output. */
export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const record of output.split('\0')) {
    if (record === '') continue;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record.replace(/^\n+/, ''));
    if (!m) continue;
    entries.push({
      path: m[3] as string,
      added: m[1] === '-' ? null : Number(m[1]),
      deleted: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return entries;
}

function emptyResult(agent: RunnerAgentKind): ReplayAgentResult {
  return {
    agent,
    status: 'error',
    exitCode: null,
    durationMs: 0,
    costUsd: null,
    usage: null,
    summary: '',
    resultCommit: null,
    resultRef: null,
    files: [],
    totals: { files: 0, added: 0, deleted: 0 },
    shortstat: '',
    skipped: [],
    checks: null,
    error: null,
  };
}

async function replayOne(
  root: string,
  base: string,
  runId: string,
  agent: RunnerAgentKind,
  prompt: string,
  input: ReplayInput,
  options: RunnerOptions,
): Promise<ReplayAgentResult> {
  const result = emptyResult(agent);
  if (!detectAgent(agent, options.env ?? process.env)) {
    result.status = 'unavailable';
    result.error = `${agent} is not installed or not on PATH`;
    return result;
  }
  const started = Date.now();
  let tree: MaterializedTree | null = null;
  try {
    tree = await materializeTree(root, base);
    const run = await runAgent(agent, 'task', tree.path, prompt, input.timeoutSec, options);
    result.status = run.status;
    result.exitCode = run.exitCode;
    result.costUsd = run.costUsd;
    result.usage = run.usage;
    result.summary = sanitizeForContext(redact(run.parsed.text).text, MAX_SUMMARY_CHARS);

    // Capture whatever the agent left behind, even after a failure or timeout.
    const captured = await captureWorktreeCommit(tree.path, {
      message: `synapse replay ${runId} ${agent}`,
    });
    result.skipped = captured.skipped;
    const ref = replayRefName(runId, agent);
    await runGit(['update-ref', ref, captured.commit], { cwd: root });
    result.resultCommit = captured.commit;
    result.resultRef = ref;

    const numstat = await runGit(
      ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', base, captured.commit, '--'],
      { cwd: root },
    );
    result.files = parseNumstat(numstat.stdout);
    result.totals = {
      files: result.files.length,
      added: result.files.reduce((n, f) => n + (f.added ?? 0), 0),
      deleted: result.files.reduce((n, f) => n + (f.deleted ?? 0), 0),
    };
    result.shortstat = (
      await runGit(
        ['diff', '--shortstat', '--no-renames', '--no-ext-diff', base, captured.commit, '--'],
        { cwd: root },
      )
    ).stdout.trim();

    if (input.checks && input.checks.length > 0) {
      result.checks = await runChecks(tree.path, input.checks);
    }
    if (run.status !== 'completed') {
      result.error = `agent ${run.status}${run.exitCode === null ? '' : ` (exit ${run.exitCode})`}`;
    }
  } catch (err) {
    result.status = 'error';
    result.error = describeError(err);
  } finally {
    result.durationMs = Date.now() - started;
    if (tree) {
      try {
        await tree.dispose();
      } catch (err) {
        result.error = result.error ?? `worktree cleanup failed: ${describeError(err)}`;
      }
    }
  }
  return result;
}

/**
 * A/B replay: gives the same prompt to several agents, each in its own detached temporary
 * worktree at `baseCommit`, in `task` mode. Each result is captured as a commit kept under
 * `refs/synapse/replays/<runId>/<agent>`, compared with the base (numstat/shortstat) and, when
 * trusted checks are provided, checked. Worktrees are always removed, also when an agent fails.
 */
export async function runReplay(
  input: ReplayInput,
  options: RunnerOptions = {},
): Promise<ReplayComparison> {
  assertPrompt(input.prompt);
  assertTimeoutSec(input.timeoutSec);
  assertValidRevision(input.baseCommit);
  if (
    !Array.isArray(input.agents) ||
    input.agents.length === 0 ||
    input.agents.length > MAX_REPLAY_AGENTS
  ) {
    throw new SynapseError('invalid_input', `replay needs 1 to ${MAX_REPLAY_AGENTS} agents`);
  }
  for (const a of input.agents) assertRunnerAgentKind(a);
  const agents = input.agents as readonly RunnerAgentKind[];
  if (new Set(agents).size !== agents.length) {
    throw new SynapseError('invalid_input', 'duplicate agent in replay');
  }
  if (input.checks !== null && !Array.isArray(input.checks)) {
    throw new SynapseError('invalid_input', 'checks must be an array or null');
  }
  const runId = input.runId ?? uuidv7();
  assertValidRunId(runId);
  const concurrency = input.concurrency ?? 1;
  if (concurrency !== 1 && concurrency !== 2) {
    throw new SynapseError('invalid_input', 'concurrency must be 1 or 2');
  }

  const root = await findRepoRoot(input.repoRoot);
  const base = await resolveCommit(root, input.baseCommit);
  if (!base) throw new SynapseError('not_found', 'base commit not found');
  const prompt = redact(input.prompt).text;
  const startedAt = Date.now();

  const results: ReplayAgentResult[] = new Array<ReplayAgentResult>(agents.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < agents.length) {
      const i = next++;
      results[i] = await replayOne(
        root,
        base,
        runId,
        agents[i] as RunnerAgentKind,
        prompt,
        input,
        options,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, agents.length) }, worker));
  return { runId, baseCommit: base, startedAt, finishedAt: Date.now(), results };
}
