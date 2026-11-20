import { config } from '../config.js';
import type { RuntimeModelSnapshot } from './runtime-model.js';

/** Provider-specific generation settings for the installed Mastra model router. */
export function localGenerationOptions(runtime?:RuntimeModelSnapshot): { providerOptions?: Record<string, any>; modelSettings?: { maxOutputTokens: number } } {
  const provider=runtime?.provider??config.modelProvider,model=runtime?.model??config.model,ollamaThink=runtime?.ollamaThink??config.ollamaThink;
  const providerOptions=provider === 'ollama' && (!ollamaThink || runtime?.role === 'ANSWER')
    ? { ollama: { reasoningEffort: 'none' } }
    : provider === 'google' && model.toLowerCase().replace(/^google\//,'') === 'gemini-3.6-flash'
      ? { google: { thinkingConfig: { thinkingLevel: config.geminiThinkingLevel, includeThoughts: false } } }
      : undefined;
  const maxOutputTokens=runtime?.maxOutputTokens;
  return { ...(providerOptions?{providerOptions}:{}), ...(maxOutputTokens?{modelSettings:{maxOutputTokens}}:{}) };
}
