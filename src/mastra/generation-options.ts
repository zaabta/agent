import { config } from '../config.js';

/** Provider-specific generation settings for the installed Mastra model router. */
export function localGenerationOptions(): { providerOptions?: Record<string, any> } {
  if (config.modelProvider === 'google' && config.model.toLowerCase() === 'google/gemini-3.6-flash') {
    return { providerOptions: { google: { thinkingConfig: { thinkingLevel: config.geminiThinkingLevel, includeThoughts: false } } } };
  }
  if (config.modelProvider === 'ollama' && config.model.toLowerCase().startsWith('qwen3') && !config.ollamaThink) {
    // Mastra's OpenAI-compatible adapter serializes this camelCase option as
    // reasoning_effort on the Ollama HTTP wire.
    return { providerOptions: { ollama: { reasoningEffort: 'none' } } };
  }
  return {};
}
