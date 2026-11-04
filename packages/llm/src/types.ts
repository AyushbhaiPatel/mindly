/** A single, non-streaming completion request. */
export interface CompletionRequest {
  /** System instructions. Redacted before it leaves the process. */
  system: string;
  /** User prompt. Redacted before it leaves the process. */
  prompt: string;
  /** Upper bound on generated tokens. Clamped to 1..8192. */
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Completion output. `text` is untrusted model output that has already been sanitised. */
export interface CompletionResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** A model provider. Implementations throw `MindlyError` on every failure. */
export interface LlmProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Minimal `fetch` signature so tests can inject a fake. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Environment lookup used for API keys. Read at call time only. */
export type EnvLike = Readonly<Record<string, string | undefined>>;
