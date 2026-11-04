import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { MindlyError } from '@mindly/core';

/** Agents Mindly can run headlessly. */
export const RUNNER_AGENT_KINDS = ['claude-code', 'codex'] as const;
/** An agent kind supported by the runners. */
export type RunnerAgentKind = (typeof RUNNER_AGENT_KINDS)[number];

/**
 * `review`: strictly read-only (the agent's most restrictive mode).
 * `task`: may edit files inside its working directory; only ever used in an isolated worktree
 * (replay) or in a worktree the user already runs agents in (opt-in failover launch).
 */
export type RunMode = 'review' | 'task';

/** True when `kind` is a supported runner agent kind. */
export function isRunnerAgentKind(kind: unknown): kind is RunnerAgentKind {
  return typeof kind === 'string' && (RUNNER_AGENT_KINDS as readonly string[]).includes(kind);
}

/** Throws `invalid_input` unless `kind` is a supported runner agent kind. */
export function assertRunnerAgentKind(kind: unknown): asserts kind is RunnerAgentKind {
  if (!isRunnerAgentKind(kind)) throw new MindlyError('invalid_input', 'unsupported agent kind');
}

/** Token usage reported by an agent, normalised. Missing values are null. */
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

/** What could be extracted from an agent's output. Every field tolerates unknown formats. */
export interface ParsedAgentOutput {
  /** Final message text (may be empty). */
  text: string;
  /** True when the output was in the expected structured format. */
  structured: boolean;
  /** The agent itself reported an error. */
  isError: boolean;
  costUsd: number | null;
  usage: AgentUsage | null;
  sessionId: string | null;
  numTurns: number | null;
}

/** Context for building argv. */
export interface ArgvContext {
  mode: RunMode;
  /** Absolute working directory of the run. */
  cwd: string;
  /** Agentic turn limit, where the agent supports one. */
  maxTurns: number;
  /** File the agent should write its last message to, where supported (created by the runner). */
  lastMessageFile: string;
}

/** Per-agent CLI knowledge. Keep every flag here so it is easy to update when CLIs change. */
export interface AgentProfile {
  kind: RunnerAgentKind;
  /** Executable name looked up on PATH. */
  binary: string;
  /** Authentication/config variables passed through to the child when set. */
  authEnv: readonly string[];
  /** Whether `buildArgv` uses `lastMessageFile`. */
  usesLastMessageFile: boolean;
  /** argv (without the binary). The prompt is always sent on stdin, never in argv. */
  buildArgv(ctx: ArgvContext): string[];
  /** Parses stdout (and the last-message file content, when used). Never throws. */
  parseOutput(stdout: string, lastMessage: string | null): ParsedAgentOutput;
}

/**
 * Claude Code tools denied in review mode (bare names remove the tool from the model's context).
 * Read-only tools stay available through `--tools`.
 */
export const CLAUDE_REVIEW_DENIED_TOOLS = [
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
] as const;
/** Claude Code built-in tools available in review mode. */
export const CLAUDE_REVIEW_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/** Claude Code tools denied in task mode (no network access from a headless run). */
export const CLAUDE_TASK_DENIED_TOOLS = ['WebFetch', 'WebSearch'] as const;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function plain(text: string): ParsedAgentOutput {
  return {
    text: text.trim(),
    structured: false,
    isError: false,
    costUsd: null,
    usage: null,
    sessionId: null,
    numTurns: null,
  };
}

/**
 * Parses `claude -p --output-format json` output: one JSON object with `type: "result"`,
 * `result`, `is_error`, `total_cost_usd`, `usage`, `session_id`, `num_turns`. Falls back to the
 * raw text when the output is not that object.
 */
export function parseClaudeOutput(stdout: string): ParsedAgentOutput {
  const trimmed = stdout.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // Some versions may print log lines first; try the last line.
    const last = trimmed.split('\n').pop() ?? '';
    try {
      value = JSON.parse(last);
    } catch {
      return plain(stdout);
    }
  }
  // stream-json style arrays: take the final result message.
  if (Array.isArray(value)) {
    value = [...value].reverse().find((m) => isRecord(m) && m['type'] === 'result');
  }
  if (!isRecord(value)) return plain(stdout);
  const usageRaw = isRecord(value['usage']) ? value['usage'] : null;
  const usage: AgentUsage | null = usageRaw
    ? {
        inputTokens: num(usageRaw['input_tokens']),
        outputTokens: num(usageRaw['output_tokens']),
        cachedInputTokens: num(usageRaw['cache_read_input_tokens']),
      }
    : null;
  const subtype = str(value['subtype']);
  return {
    text: (str(value['result']) ?? '').trim(),
    structured: true,
    isError: value['is_error'] === true || (subtype !== null && subtype.startsWith('error')),
    costUsd: num(value['total_cost_usd']) ?? num(value['cost_usd']),
    usage,
    sessionId: str(value['session_id']),
    numTurns: num(value['num_turns']),
  };
}

/**
 * Parses `codex exec --json` output (JSON Lines events such as `thread.started`,
 * `item.completed` with an `agent_message` item, `turn.completed` with `usage`, `turn.failed`,
 * `error`). `lastMessage` (from `--output-last-message`) wins for the final text when present.
 * Unknown lines are ignored; with no events at all the raw text is used.
 */
export function parseCodexOutput(stdout: string, lastMessage: string | null): ParsedAgentOutput {
  let structured = false;
  let isError = false;
  let text: string | null = null;
  let sessionId: string | null = null;
  let turns = 0;
  let input: number | null = null;
  let output: number | null = null;
  let cached: number | null = null;
  const add = (a: number | null, b: number | null): number | null =>
    b === null ? a : (a ?? 0) + b;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isRecord(ev) || typeof ev['type'] !== 'string') continue;
    structured = true;
    const type = ev['type'];
    if (type === 'thread.started') sessionId = str(ev['thread_id']) ?? sessionId;
    else if (type === 'item.completed' && isRecord(ev['item'])) {
      const item = ev['item'];
      const itemType = str(item['type']) ?? str(item['item_type']);
      if (itemType === 'agent_message' || itemType === 'assistant_message') {
        text = str(item['text']) ?? text;
      }
    } else if (type === 'turn.completed') {
      turns++;
      if (isRecord(ev['usage'])) {
        input = add(input, num(ev['usage']['input_tokens']));
        output = add(output, num(ev['usage']['output_tokens']));
        cached = add(cached, num(ev['usage']['cached_input_tokens']));
      }
    } else if (type === 'turn.failed' || type === 'error') {
      isError = true;
    }
  }
  const finalText = lastMessage !== null && lastMessage.trim() !== '' ? lastMessage : text;
  if (!structured && finalText === null) return plain(stdout);
  return {
    text: (finalText ?? '').trim(),
    structured,
    isError,
    costUsd: null,
    usage:
      input === null && output === null && cached === null
        ? null
        : { inputTokens: input, outputTokens: output, cachedInputTokens: cached },
    sessionId,
    numTurns: structured ? turns : null,
  };
}

/**
 * CLI profiles. Sources (checked 2026-11):
 * - Claude Code: https://code.claude.com/docs/en/cli-reference, https://code.claude.com/docs/en/headless
 * - Codex: https://developers.openai.com/codex/noninteractive
 */
export const AGENT_PROFILES: Readonly<Record<RunnerAgentKind, AgentProfile>> = {
  'claude-code': {
    kind: 'claude-code',
    binary: 'claude',
    authEnv: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
    ],
    usesLastMessageFile: false,
    buildArgv(ctx) {
      // No positional prompt: `claude -p` reads the prompt from stdin.
      const common = [
        '-p',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--max-turns',
        String(ctx.maxTurns),
      ];
      if (ctx.mode === 'review') {
        return [
          ...common,
          '--permission-mode',
          'plan',
          '--tools',
          CLAUDE_REVIEW_TOOLS.join(','),
          '--disallowedTools',
          CLAUDE_REVIEW_DENIED_TOOLS.join(','),
        ];
      }
      return [
        ...common,
        '--permission-mode',
        'acceptEdits',
        '--disallowedTools',
        CLAUDE_TASK_DENIED_TOOLS.join(','),
      ];
    },
    parseOutput: (stdout) => parseClaudeOutput(stdout),
  },
  codex: {
    kind: 'codex',
    binary: 'codex',
    authEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME'],
    usesLastMessageFile: true,
    buildArgv(ctx) {
      return [
        'exec',
        '--sandbox',
        ctx.mode === 'review' ? 'read-only' : 'workspace-write',
        // exec never asks interactively; pin the policy explicitly (config override).
        '-c',
        'approval_policy="never"',
        '--ephemeral',
        '--json',
        '-C',
        ctx.cwd,
        '--output-last-message',
        ctx.lastMessageFile,
        // `-` reads the prompt from stdin.
        '-',
      ];
    },
    parseOutput: (stdout, lastMessage) => parseCodexOutput(stdout, lastMessage),
  },
};

/** Returns the profile for `kind`, or throws `invalid_input`. */
export function agentProfile(kind: unknown): AgentProfile {
  assertRunnerAgentKind(kind);
  return AGENT_PROFILES[kind];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the agent's binary by scanning the `PATH` entries of `env` (default `process.env`) for
 * an executable file. Relative and empty PATH entries are ignored so a repository cannot plant a
 * binary through `.` on PATH. Returns the absolute path, or null when not installed.
 */
export function detectAgent(kind: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  const profile = agentProfile(kind);
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const exts =
    process.platform === 'win32'
      ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e !== '')]
      : [''];
  for (const dir of pathVar.split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, profile.binary + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
