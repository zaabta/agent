import { config } from '../config.js';

/** Mastra's OpenAI-compatible adapter expects camelCase provider option names
 * and serializes reasoningEffort to reasoning_effort on the HTTP wire. */
export function localGenerationOptions() {
  if (config.modelProvider !== 'ollama' || !config.model.toLowerCase().startsWith('qwen3') || config.ollamaThink) return {};
  return { providerOptions: { ollama: { reasoningEffort: 'none' } } };
}
