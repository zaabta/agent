import { config } from '../config.js';
import type { RuntimeModelSnapshot } from './runtime-model.js';

/** Provider-specific generation settings for the installed Mastra model router. */
export function localGenerationOptions(runtime?:RuntimeModelSnapshot): { providerOptions?: Record<string, any> } {
  const provider=runtime?.provider??config.modelProvider,model=runtime?.model??config.model,ollamaThink=runtime?.ollamaThink??config.ollamaThink;
  if (provider === 'google' && model.toLowerCase().replace(/^google\//,'') === 'gemini-3.6-flash') {
    return { providerOptions: { google: { thinkingConfig: { thinkingLevel: config.geminiThinkingLevel, includeThoughts: false } } } };
  }
  if (provider === 'ollama' && model.toLowerCase().startsWith('qwen3') && !ollamaThink) {
    // Mastra's OpenAI-compatible adapter serializes this camelCase option as
    // reasoning_effort on the Ollama HTTP wire.
    return { providerOptions: { ollama: { reasoningEffort: 'none' } } };
  }
  return {};
}
