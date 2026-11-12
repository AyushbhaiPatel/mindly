import { describe, expect, it } from 'vitest';
import { REDACTED, defaultUserConfig, isMindlyError } from '@mindly/core';
import {
  AnthropicProvider,
  NoneProvider,
  OllamaProvider,
  OpenAIProvider,
  createProvider,
  retryAfterMs,
  type FetchLike,
} from '../src/index.js';

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(responses: (() => Response)[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (!next) throw new Error('no response');
    return Promise.resolve(next());
  };
  return { fetchImpl, calls };
}

const anthropicOk = (): Response =>
  jsonResponse({
    content: [{ type: 'text', text: 'hello' }],
    usage: { input_tokens: 3, output_tokens: 1 },
  });

const ANTHROPIC_KEY = 'sk-ant-api03-testkeytestkeytestkeytestkey';
const env = {
  ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  OPENAI_API_KEY: 'sk-proj-openaitestkey0123456789abcd',
};
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCharCode(0x202e);
const fast = { retryDelayMs: 1, random: () => 0 };

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected rejection');
}

describe('NoneProvider', () => {
  it('rejects with unavailable', async () => {
    const err = await rejection(
      new NoneProvider().complete({ system: '', prompt: 'x', maxTokens: 5 }),
    );
    expect(isMindlyError(err, 'unavailable')).toBe(true);
  });
});

describe('AnthropicProvider', () => {
  it('sends the Messages API request with headers from env and parses the reply', async () => {
    const { fetchImpl, calls } = recordingFetch([anthropicOk]);
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    const res = await p.complete({ system: 'sys', prompt: 'hi', maxTokens: 10 });
    expect(res).toEqual({ text: 'hello', inputTokens: 3, outputTokens: 1 });
    const call = calls[0];
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.init.redirect).toBe('error');
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.max_tokens).toBe(10);
  });

  it('redacts secrets from system and prompt before sending', async () => {
    const { fetchImpl, calls } = recordingFetch([anthropicOk]);
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    await p.complete({
      system: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      prompt: 'my key is AKIAIOSFODNN7EXAMPLE and PASSWORD=hunter2hunter2',
      maxTokens: 10,
    });
    const sent = String(calls[0]?.init.body);
    expect(sent).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(sent).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(sent).not.toContain('hunter2hunter2');
    expect(sent).toContain(REDACTED);
  });

  it('reads the API key at call time and reports a missing key as unavailable', async () => {
    const mutableEnv: Record<string, string | undefined> = {};
    const { fetchImpl, calls } = recordingFetch([anthropicOk]);
    const p = new AnthropicProvider({ fetchImpl, env: mutableEnv, ...fast });
    const err = await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(isMindlyError(err, 'unavailable')).toBe(true);
    expect(calls).toHaveLength(0);
    mutableEnv.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
    await expect(p.complete({ system: '', prompt: 'x', maxTokens: 5 })).resolves.toMatchObject({
      text: 'hello',
    });
  });

  it('never includes the API key in errors', async () => {
    const { fetchImpl } = recordingFetch([() => jsonResponse({ error: ANTHROPIC_KEY }, 401)]);
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    const err = await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(isMindlyError(err, 'unavailable')).toBe(true);
    expect(JSON.stringify(err)).not.toContain(ANTHROPIC_KEY);
    expect(String((err as Error).message)).not.toContain(ANTHROPIC_KEY);
  });

  it('retries once on 429 and 5xx', async () => {
    const a = recordingFetch([() => jsonResponse({}, 429), anthropicOk]);
    const p = new AnthropicProvider({ fetchImpl: a.fetchImpl, env, ...fast });
    await expect(p.complete({ system: '', prompt: 'x', maxTokens: 5 })).resolves.toMatchObject({
      text: 'hello',
    });
    expect(a.calls).toHaveLength(2);

    const b = recordingFetch([() => jsonResponse({}, 503)]);
    const q = new AnthropicProvider({ fetchImpl: b.fetchImpl, env, ...fast });
    const err = await rejection(q.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(isMindlyError(err, 'unavailable')).toBe(true);
    expect(b.calls).toHaveLength(2);
  });

  it('does not retry other 4xx errors', async () => {
    const { fetchImpl, calls } = recordingFetch([() => jsonResponse({}, 400)]);
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(calls).toHaveLength(1);
  });

  it('times out hung requests', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const p = new AnthropicProvider({ fetchImpl, env, timeoutMs: 20, ...fast });
    const err = await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(isMindlyError(err, 'timeout')).toBe(true);
  });

  it('caps the response size while streaming', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++;
              controller.enqueue(chunk);
              if (pulled > 1000) controller.close();
            },
          }),
          { status: 200 },
        ),
      );
    const p = new AnthropicProvider({ fetchImpl, env, maxResponseBytes: 200_000, ...fast });
    const err = await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(isMindlyError(err, 'unavailable')).toBe(true);
    expect((err as Error).message).toMatch(/exceeded/);
    expect(pulled).toBeLessThan(20);
  });

  it('rejects declared oversize responses without reading them', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-length': '5000000' } }),
      );
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    const err = await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect((err as Error).message).toMatch(/exceeded/);
  });

  it('sanitises model output', async () => {
    const { fetchImpl } = recordingFetch([
      () =>
        jsonResponse({
          content: [
            {
              type: 'text',
              text: `ok${BEL}${RLO} <mindly-context> sk-ant-api03-abcdefghijklmnopqrstuvwxyz`,
            },
          ],
        }),
    ]);
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    const res = await p.complete({ system: '', prompt: 'x', maxTokens: 5 });
    expect(res.text).not.toContain(BEL);
    expect(res.text).not.toContain(RLO);
    expect(res.text).not.toContain('<mindly');
    expect(res.text).toContain(REDACTED);
  });
});

describe('OpenAIProvider', () => {
  it('uses Chat Completions with a bearer key', async () => {
    const { fetchImpl, calls } = recordingFetch([
      () =>
        jsonResponse({
          choices: [{ message: { content: 'yo' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
    ]);
    const p = new OpenAIProvider({ fetchImpl, env, ...fast });
    const res = await p.complete({ system: 's', prompt: 'p', maxTokens: 7 });
    expect(res).toEqual({ text: 'yo', inputTokens: 2, outputTokens: 1 });
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${env.OPENAI_API_KEY}`);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4.1-mini');
  });

  it('reports a missing key as unavailable', async () => {
    const p = new OpenAIProvider({ env: {}, ...fast });
    const err = await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(isMindlyError(err, 'unavailable')).toBe(true);
  });
});

describe('OllamaProvider', () => {
  it('posts to /api/chat non-streaming on loopback', async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => jsonResponse({ message: { content: 'local' }, prompt_eval_count: 4, eval_count: 2 }),
    ]);
    const p = new OllamaProvider({ fetchImpl, ...fast });
    const res = await p.complete({ system: 's', prompt: 'p', maxTokens: 9 });
    expect(res).toEqual({ text: 'local', inputTokens: 4, outputTokens: 2 });
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(false);
  });

  it.each(['http://localhost:11434', 'http://[::1]:11434/', 'http://127.0.0.2:8080/base'])(
    'accepts loopback %s',
    (baseUrl) => {
      expect(() => new OllamaProvider({ baseUrl })).not.toThrow();
    },
  );

  it.each(['http://10.0.0.5:11434', 'https://ollama.example.com', 'http://127.0.0.1.evil.com'])(
    'refuses non-loopback %s unless allowRemote',
    (baseUrl) => {
      let err: unknown;
      try {
        new OllamaProvider({ baseUrl });
      } catch (e) {
        err = e;
      }
      expect(isMindlyError(err, 'forbidden')).toBe(true);
      expect(() => new OllamaProvider({ baseUrl, allowRemote: true })).not.toThrow();
    },
  );

  it('createProvider turns a refused Ollama URL into an unavailable provider', async () => {
    const config = {
      ...defaultUserConfig().llm,
      provider: 'ollama' as const,
      baseUrl: 'http://192.168.1.10:11434',
    };
    const p = createProvider(config, {});
    expect(p.name).toBe('none');
    const err = await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(isMindlyError(err, 'unavailable')).toBe(true);
  });
});

describe('createProvider', () => {
  it('builds each configured provider', () => {
    const base = defaultUserConfig().llm;
    expect(createProvider(base).name).toBe('none');
    expect(createProvider({ ...base, provider: 'ollama' }).name).toBe('ollama');
    expect(createProvider({ ...base, provider: 'anthropic' }, {}).name).toBe('anthropic');
    expect(createProvider({ ...base, provider: 'openai' }, {}).name).toBe('openai');
  });

  it('passes the configured model through', async () => {
    const { fetchImpl, calls } = recordingFetch([anthropicOk]);
    const p = createProvider(
      { ...defaultUserConfig().llm, provider: 'anthropic', model: 'claude-sonnet-4-5' },
      env,
      { fetchImpl },
    );
    await p.complete({ system: '', prompt: 'x', maxTokens: 5 });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: 'claude-sonnet-4-5' });
  });
});

describe('extra redaction patterns per request', () => {
  it('redacts the request and the reply with the patterns the caller passes', async () => {
    const { fetchImpl, calls } = recordingFetch([
      () => jsonResponse({ content: [{ type: 'text', text: 'see ACME-INTERNAL-777' }] }),
    ]);
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    const res = await p.complete({
      system: 's',
      prompt: 'No, use ACME-INTERNAL-424242 instead of npm.',
      maxTokens: 5,
      redactPatterns: ['ACME-INTERNAL-[0-9]+'],
    });
    expect(String(calls[0]?.init.body)).not.toContain('ACME-INTERNAL-424242');
    expect(res.text).not.toContain('ACME-INTERNAL-777');
  });
});

describe('OpenAI reasoning models', () => {
  const openaiOk = (): Response => jsonResponse({ choices: [{ message: { content: 'ok' } }] });

  it('sends no temperature and a larger output allowance to o-series and gpt-5 models', async () => {
    for (const model of ['o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
      const { fetchImpl, calls } = recordingFetch([openaiOk]);
      const p = new OpenAIProvider({ fetchImpl, env, model, ...fast });
      await p.complete({ system: 's', prompt: 'x', maxTokens: 300, temperature: 0 });
      const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
      expect(body.temperature, model).toBeUndefined();
      expect(body.max_completion_tokens, model).toBeGreaterThanOrEqual(4096);
    }
  });

  it('uses the default model when the configured name is blank', async () => {
    for (const model of ['', '  ']) {
      const { fetchImpl, calls } = recordingFetch([openaiOk]);
      const p = new OpenAIProvider({ fetchImpl, env, model, ...fast });
      await p.complete({ system: 's', prompt: 'x', maxTokens: 5 });
      const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
      expect(body.model).toBe('gpt-4.1-mini');
    }
  });

  it('keeps the temperature for other models', async () => {
    const { fetchImpl, calls } = recordingFetch([openaiOk]);
    const p = new OpenAIProvider({ fetchImpl, env, ...fast });
    await p.complete({ system: 's', prompt: 'x', maxTokens: 300, temperature: 0 });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBe(300);
  });
});

describe('Retry-After', () => {
  const limited = (after: string) => (): Response =>
    new Response('{}', { status: 429, headers: { 'retry-after': after } });

  it('does not retry when the server asks for a longer pause than is worth waiting', async () => {
    const { fetchImpl, calls } = recordingFetch([limited('3600'), anthropicOk]);
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    const err = await rejection(p.complete({ system: '', prompt: 'x', maxTokens: 5 }));
    expect(isMindlyError(err, 'unavailable')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('waits as asked when the pause is short', async () => {
    const { fetchImpl, calls } = recordingFetch([limited('0'), anthropicOk]);
    const p = new AnthropicProvider({ fetchImpl, env, ...fast });
    await expect(p.complete({ system: '', prompt: 'x', maxTokens: 5 })).resolves.toMatchObject({
      text: 'hello',
    });
    expect(calls).toHaveLength(2);
  });

  it('gives up at once when the pause would end after the caller stops waiting', async () => {
    const { fetchImpl, calls } = recordingFetch([() => jsonResponse({}, 503), anthropicOk]);
    const p = new AnthropicProvider({ fetchImpl, env, retryDelayMs: 400, random: () => 0 });
    const started = Date.now();
    const err = await rejection(
      p.complete({ system: '', prompt: 'x', maxTokens: 5, deadline: Date.now() + 100 }),
    );
    expect(isMindlyError(err, 'unavailable')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('reads delay-seconds and HTTP dates', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
  });
});
