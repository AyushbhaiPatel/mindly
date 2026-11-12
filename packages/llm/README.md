# @mindly/llm

Optional model access for Mindly. Every feature that uses a model has a deterministic fallback,
so this package **fails soft**: providers throw typed `MindlyError`s, and the high-level helpers
return `null` instead of throwing.

## Configuration

Read from `UserConfig.llm` (`~/.mindly/config.json`):

```json
{ "llm": { "provider": "ollama", "model": "llama3.2", "baseUrl": "http://127.0.0.1:11434" } }
```

| Provider    | Endpoint                                     | Key (env, read at call time) | Default model      |
| ----------- | -------------------------------------------- | ---------------------------- | ------------------ |
| `none`      | -                                            | -                            | -                  |
| `ollama`    | `<baseUrl>/api/chat` (non-streaming)         | -                            | `llama3.2`         |
| `anthropic` | `https://api.anthropic.com/v1/messages`      | `ANTHROPIC_API_KEY`          | `claude-haiku-4-5` |
| `openai`    | `https://api.openai.com/v1/chat/completions` | `OPENAI_API_KEY`             | `gpt-4.1-mini`     |

```ts
import { createProvider, createLlmHelpers } from '@mindly/llm';

const llm = createLlmHelpers(createProvider(config.llm));
const verdict = await llm.classifyCorrection('no, use pnpm not npm'); // null => use fallback
```

Helpers: `classifyCorrection`, `summarizeTurn`, `detectContradiction`, `compressContext`. Each
prompts for a strict JSON object, validates it with zod and returns `null` on any failure. Every
helper also takes per-call options: a `signal` that ends the call (it then returns `null`),
`redactPatterns` added to the provider's own, and `onFailure`, which hears a short reason (with no
key, prompt or reply) whenever a call gives no answer, so a caller can log that the model is not
working.

## Security notes

- **Redaction**: `system` and `prompt` pass through core `redact()` inside every provider before
  anything is sent, with the provider's extra patterns and those of the request
  (`CompletionRequest.redactPatterns`). The reply is redacted with the same patterns.
- **API keys** are read from the environment on each call. They are never logged, stored or
  included in error messages; transport errors are rethrown without their `cause`.
- **Ollama is loopback-only** (`localhost`, `127.0.0.0/8`, `::1`) unless `llm.allowRemote` is
  true. `createProvider` turns a refused URL into a `NoneProvider` explaining why.
- **Transport limits**: 20 s timeout per attempt, 1 MB response cap enforced while streaming,
  redirects refused, one retry on 429/5xx with jitter. A `Retry-After` header is honoured; when it
  asks for more than 5 s the call fails at once instead of retrying.
- **OpenAI reasoning models** (model ids starting with `o` and a digit, or `gpt-5`) get no
  `temperature` and a larger output allowance, since they accept only the default temperature
  and spend output tokens on reasoning. The rule follows OpenAI's model naming and is not checked
  against the live API.
- **Responses are untrusted**: output is redacted and passed through `sanitizeForContext`
  (control and invisible characters stripped, Mindly delimiters neutralised, length capped).
  Untrusted input is embedded as escaped JSON inside a `<data>` block that it cannot close.
