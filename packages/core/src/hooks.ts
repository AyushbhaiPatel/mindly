import type { AgentKind } from './domain.js';

/*
 * Agent-neutral hook contract. Adapters translate each agent's native hook payload into a
 * `NormalizedHookEvent`, the engine answers with a `HookResult`, and the adapter renders that
 * result in the agent's expected output format. The engine never sees agent-specific shapes.
 */

export const HOOK_EVENTS = [
  'session_start',
  'prompt',
  'pre_tool',
  'post_tool',
  'stop',
  'session_end',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Text-level description of one file modification made (or about to be made) by a tool. */
export interface FileEdit {
  /** Path as given by the agent (absolute or relative to cwd); the engine validates it. */
  path: string;
  /** Text the edit introduces (new_string, written content, patch '+' lines). */
  addedText: string;
  /** Text the edit removes, when known. */
  removedText: string;
  /** True when the tool replaces or creates the whole file. */
  wholeFile: boolean;
}

export interface NormalizedHookEvent {
  agentKind: AgentKind;
  event: HookEventName;
  /** The agent's own session id. */
  externalSessionId: string;
  /** Working directory reported by the agent. */
  cwd: string;
  transcriptPath: string | null;
  /** session_start: why the session started (startup, resume, clear, compact). */
  startSource: string | null;
  /** prompt: the user's prompt text (raw; the engine redacts before storing). */
  prompt: string | null;
  /** pre_tool / post_tool. */
  tool: {
    name: string;
    /** True for tools that modify files (Edit, Write, apply_patch, …). */
    writes: boolean;
    /** True for shell-like tools. */
    shell: boolean;
    edits: FileEdit[];
    /** Shell command text, if any (only used for intent and mistake matching; never executed). */
    command: string | null;
    /** post_tool: whether the tool reported failure. */
    failed: boolean;
    /** post_tool: short error/output excerpt (raw; redacted by the engine). */
    outputExcerpt: string | null;
  } | null;
  /** stop: last assistant message excerpt when the agent provides it. */
  lastMessage: string | null;
}

export interface HookResult {
  /** Context to add to the agent's conversation, already rendered and sanitised. */
  context: string | null;
  /** pre_tool only. `deny` is used solely for user-created `enforce` rules. */
  decision: 'allow' | 'deny' | 'ask' | null;
  /** Explanation shown with a deny/ask decision. */
  reason: string | null;
  /** Short notice to show the human user (not the model), when the agent supports it. */
  userMessage: string | null;
}

export const EMPTY_HOOK_RESULT: HookResult = Object.freeze({
  context: null,
  decision: null,
  reason: null,
  userMessage: null,
}) as HookResult;

/** What an adapter returns to the CLI after rendering a result. */
export interface RenderedHookOutput {
  stdout: string;
  exitCode: number;
}

/** A single configuration change an installer intends to make, shown to the user first. */
export interface InstallStep {
  file: string;
  description: string;
  /** Full new file content (the installer writes atomically and keeps a backup). */
  content: string;
  /** Previous content, or null if the file is new. */
  previous: string | null;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly displayName: string;
  /** Whether the agent appears to be installed for the current user. */
  detect(): Promise<boolean>;
  /** Parses a native hook payload. Returns null for events Synapse does not handle. */
  parse(nativeEvent: string, payload: unknown): NormalizedHookEvent | null;
  /** Renders a result in the agent's native hook output format. */
  render(event: NormalizedHookEvent, result: HookResult): RenderedHookOutput;
  /** Computes (without applying) the config changes needed to connect this agent. */
  planInstall(options: InstallOptions): Promise<InstallStep[]>;
  /** Computes the config changes needed to disconnect this agent. */
  planUninstall(options: InstallOptions): Promise<InstallStep[]>;
}

export interface InstallOptions {
  /** Absolute path of the `synapse` executable (or `node /path/cli.js`) hooks should call. */
  command: string[];
  /** Install for a single project (project-level config) instead of user-wide. */
  projectRoot: string | null;
  homeDir: string;
}
