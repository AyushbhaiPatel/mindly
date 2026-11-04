import { MindlyError, redactText, sanitizeForContext } from '@mindly/core';
import { z } from 'zod';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  postJson,
  type HttpSettings,
} from './http.js';
import { isLoopbackHostname } from './net.js';
import type {
  CompletionRequest,
  CompletionResult,
  EnvLike,
  FetchLike,
  LlmProvider,
} from './types.js';

/** Default Ollama endpoint (loopback only). */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
/** Default Ollama model when the config does not name one. */
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';
/** Anthropic Messages API endpoint. */
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** Default Anthropic model. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
/** OpenAI Chat Completions endpoint. */
export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
/** Default OpenAI model. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

/** Hard cap on characters of model output handed back to callers. */
export const MAX_COMPLETION_CHARS = 100_000;
const MAX_TOKENS_LIMIT = 8192;

/** Options shared by every HTTP-backed provider. All are optional. */
export interface ProviderOptions {
  model?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  /** Per-attempt timeout in milliseconds (default 20 000). */
  timeoutMs?: number | undefined;
  /** Response body cap in bytes (default 1 MB). */
  maxResponseBytes?: number | undefined;
  /** Base retry delay in milliseconds (default 500, plus up to 100% jitter). */
  retryDelayMs?: number | undefined;
  /** Jitter source, `Math.random` by default. */
  random?: (() => number) | undefined;
  /** Extra redaction patterns (typically `UserConfig.redaction.extraPatterns`). */
  redactPatterns?: readonly string[] | undefined;
  /** Environment used to look up API keys at call time (default `process.env`). */
  env?: EnvLike | undefined;
}

/** Provider that is always unavailable. Used when no model is configured. */
export class NoneProvider implements LlmProvider {
  readonly name = 'none';
  readonly #reason: string;

  constructor(reason = 'no LLM provider configured') {
    this.#reason = reason;
  }

  complete(_req: CompletionRequest): Promise<CompletionResult> {
    return Promise.reject(new MindlyError('unavailable', this.#reason));
  }
}

interface Prepared {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature: number | undefined;
}

abstract class HttpProvider implements LlmProvider {
  abstract readonly name: string;
  protected readonly model: string;
  protected readonly http: HttpSettings;
  protected readonly env: EnvLike;
  readonly #redactPatterns: readonly string[];

  protected constructor(defaultModel: string, options: ProviderOptions) {
    this.model = options.model ?? defaultModel;
    this.env = options.env ?? process.env;
    this.#redactPatterns = options.redactPatterns ?? [];
    this.http = {
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      random: options.random ?? Math.random,
    };
  }

  abstract complete(req: CompletionRequest): Promise<CompletionResult>;

  /** Redacts outgoing text and normalises numeric parameters. */
  protected prepare(req: CompletionRequest): Prepared {
    const extraPatterns = this.#redactPatterns;
    const maxTokens = Math.min(MAX_TOKENS_LIMIT, Math.max(1, Math.floor(req.maxTokens) || 1));
    const t = req.temperature;
    return {
      system: redactText(req.system, { extraPatterns }),
      prompt: redactText(req.prompt, { extraPatterns }),
      maxTokens,
      temperature: t === undefined || !Number.isFinite(t) ? undefined : Math.min(2, Math.max(0, t)),
    };
  }

  /** Model output is untrusted: redact echoed secrets and strip control/invisible characters. */
  protected finish(text: string, inputTokens?: number, outputTokens?: number): CompletionResult {
    const clean = sanitizeForContext(
      redactText(text, { extraPatterns: this.#redactPatterns }),
      MAX_COMPLETION_CHARS,
    );
    const result: CompletionResult = { text: clean };
    if (inputTokens !== undefined) result.inputTokens = inputTokens;
    if (outputTokens !== undefined) result.outputTokens = outputTokens;
    return result;
  }

  protected requireKey(envName: string): string {
    const key = this.env[envName];
    if (!key || key.trim() === '') {
      throw new MindlyError('unavailable', `${this.name}: ${envName} is not set`);
    }
    return key.trim();
  }

  protected parse<T>(schema: z.ZodType<T>, json: unknown): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new MindlyError('unavailable', `${this.name} returned an unexpected response shape`);
    }
    return parsed.data;
  }
}

const tokenCount = z.number().int().nonnegative().optional();

const OllamaResponseSchema = z.object({
  message: z.object({ content: z.string() }),
  prompt_eval_count: tokenCount,
  eval_count: tokenCount,
});

/** Options for {@link OllamaProvider}. */
export interface OllamaProviderOptions extends ProviderOptions {
  /** Default `http://127.0.0.1:11434`. Must be loopback unless `allowRemote` is true. */
  baseUrl?: string | undefined;
  allowRemote?: boolean | undefined;
}

/**
 * Validates an Ollama base URL. Throws `forbidden` for non-loopback hosts unless `allowRemote`,
 * and `invalid_input` for malformed or non-http(s) URLs.
 */
export function validateOllamaBaseUrl(baseUrl: string, allowRemote: boolean): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new MindlyError('invalid_input', 'ollama baseUrl is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MindlyError('invalid_input', 'ollama baseUrl must use http or https');
  }
  if (url.username || url.password) {
    throw new MindlyError('invalid_input', 'ollama baseUrl must not contain credentials');
  }
  if (!allowRemote && !isLoopbackHostname(url.hostname)) {
    throw new MindlyError(
      'forbidden',
      'ollama baseUrl must point at localhost; set llm.allowRemote to use a remote host',
    );
  }
  return url;
}

/** Local Ollama via `/api/chat` (non-streaming). Refuses non-loopback hosts by default. */
export class OllamaProvider extends HttpProvider {
  readonly name = 'ollama';
  readonly #endpoint: string;

  constructor(options: OllamaProviderOptions = {}) {
    super(DEFAULT_OLLAMA_MODEL, options);
    const base = validateOllamaBaseUrl(
      options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
      options.allowRemote ?? false,
    );
    this.#endpoint = new URL('api/chat', base.href.endsWith('/') ? base : `${base.href}/`).href;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const p = this.prepare(req);
    const options: Record<string, number> = { num_predict: p.maxTokens };
    if (p.temperature !== undefined) options.temperature = p.temperature;
    const json = await postJson(
      {
        provider: this.name,
        url: this.#endpoint,
        headers: { 'content-type': 'application/json' },
        body: {
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: p.system },
            { role: 'user', content: p.prompt },
          ],
          options,
        },
        signal: req.signal,
      },
      this.http,
    );
    const res = this.parse(OllamaResponseSchema, json);
    return this.finish(res.message.content, res.prompt_eval_count, res.eval_count);
  }
}

const AnthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }).optional(),
});

/** Anthropic Messages API. Reads `ANTHROPIC_API_KEY` from the environment at call time. */
export class AnthropicProvider extends HttpProvider {
  readonly name = 'anthropic';

  constructor(options: ProviderOptions = {}) {
    super(DEFAULT_ANTHROPIC_MODEL, options);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const key = this.requireKey('ANTHROPIC_API_KEY');
    const p = this.prepare(req);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: p.maxTokens,
      system: p.system,
      messages: [{ role: 'user', content: p.prompt }],
    };
    if (p.temperature !== undefined) body.temperature = Math.min(1, p.temperature);
    const json = await postJson(
      {
        provider: this.name,
        url: ANTHROPIC_MESSAGES_URL,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body,
        signal: req.signal,
      },
      this.http,
    );
    const res = this.parse(AnthropicResponseSchema, json);
    const text = res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return this.finish(text, res.usage?.input_tokens, res.usage?.output_tokens);
  }
}

const OpenAIResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({ prompt_tokens: tokenCount, completion_tokens: tokenCount }).optional(),
});

/** OpenAI Chat Completions API. Reads `OPENAI_API_KEY` from the environment at call time. */
export class OpenAIProvider extends HttpProvider {
  readonly name = 'openai';

  constructor(options: ProviderOptions = {}) {
    super(DEFAULT_OPENAI_MODEL, options);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const key = this.requireKey('OPENAI_API_KEY');
    const p = this.prepare(req);
    const body: Record<string, unknown> = {
      model: this.model,
      max_completion_tokens: p.maxTokens,
      messages: [
        { role: 'system', content: p.system },
        { role: 'user', content: p.prompt },
      ],
    };
    if (p.temperature !== undefined) body.temperature = p.temperature;
    const json = await postJson(
      {
        provider: this.name,
        url: OPENAI_CHAT_URL,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body,
        signal: req.signal,
      },
      this.http,
    );
    const res = this.parse(OpenAIResponseSchema, json);
    const text = res.choices[0]?.message.content ?? '';
    return this.finish(text, res.usage?.prompt_tokens, res.usage?.completion_tokens);
  }
}
