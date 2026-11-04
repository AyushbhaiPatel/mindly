import { isMindlyError, type UserConfig } from '@mindly/core';
import {
  AnthropicProvider,
  NoneProvider,
  OllamaProvider,
  OpenAIProvider,
  type ProviderOptions,
} from './providers.js';
import type { EnvLike, LlmProvider } from './types.js';

/** Transport overrides for {@link createProvider}; `model` and `env` come from the arguments. */
export type CreateProviderOptions = Omit<ProviderOptions, 'model' | 'env'>;

/**
 * Builds the provider described by `UserConfig.llm`. Never throws: a refused or invalid
 * configuration (for example a non-loopback Ollama URL without `allowRemote`) yields a
 * {@link NoneProvider} whose `complete()` rejects with `unavailable` and explains why.
 */
export function createProvider(
  config: UserConfig['llm'],
  env: EnvLike = process.env,
  options: CreateProviderOptions = {},
): LlmProvider {
  const common: ProviderOptions = { ...options, model: config.model, env };
  try {
    switch (config.provider) {
      case 'none':
        return new NoneProvider();
      case 'ollama':
        return new OllamaProvider({
          ...common,
          baseUrl: config.baseUrl,
          allowRemote: config.allowRemote,
        });
      case 'anthropic':
        return new AnthropicProvider(common);
      case 'openai':
        return new OpenAIProvider(common);
    }
  } catch (err) {
    if (isMindlyError(err)) return new NoneProvider(err.message);
    return new NoneProvider('LLM provider could not be created');
  }
  return new NoneProvider();
}
