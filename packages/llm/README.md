# @synapse/llm

Optional model access for Synapse. Every feature that uses a model has a deterministic fallback,
so this package **fails soft**: providers throw typed `SynapseError`s, and the high-level helpers
return `null` instead of throwing.

## Configuration

Read from `UserConfig.llm` (`~/.synapse/config.json`):

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
import { createProvider, createLlmHelpers } from '@synapse/llm';

const llm = createLlmHelpers(createProvider(config.llm));
const verdict = await llm.classifyCorrection('no, use pnpm not npm'); // null => use fallback
```

Helpers: `classifyCorrection`, `summarizeTurn`, `detectContradiction`, `compressContext`. Each
prompts for a strict JSON object, validates it with zod and returns `null` on any failure.

## Security notes

- **Redaction**: `system` and `prompt` pass through core `redact()` (plus configured extra
  patterns) inside every provider before anything is sent.
- **API keys** are read from the environment on each call. They are never logged, stored or
  included in error messages; transport errors are rethrown without their `cause`.
- **Ollama is loopback-only** (`localhost`, `127.0.0.0/8`, `::1`) unless `llm.allowRemote` is
  true. `createProvider` turns a refused URL into a `NoneProvider` explaining why.
- **Transport limits**: 20 s timeout per attempt, 1 MB response cap enforced while streaming,
  redirects refused, one retry on 429/5xx with jitter.
- **Responses are untrusted**: output is redacted and passed through `sanitizeForContext`
  (control and invisible characters stripped, Synapse delimiters neutralised, length capped).
  Untrusted input is embedded as escaped JSON inside a `<data>` block that it cannot close.
