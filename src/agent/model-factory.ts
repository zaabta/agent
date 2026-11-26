import { ChatOpenAI } from '@langchain/openai';
import { config } from '../config.js';
import type { RuntimeModelSnapshot } from '../llm-admin/runtime-model.js';
import { modelSupportsTemperature, requiresOpenAIResponsesApi } from '../llm-admin/model-capabilities.js';

export type LangGraphProvider = 'openai' | 'openrouter' | 'ollama' | 'google';

export function langGraphModelOptions(snapshot: RuntimeModelSnapshot) {
  if (!['openai', 'openrouter', 'ollama', 'google'].includes(snapshot.provider))
    throw new Error('INVALID_MODEL_PROVIDER');
  if (!snapshot.model?.trim()) throw new Error('INVALID_MODEL_ID');
  if (snapshot.provider !== 'ollama' && !snapshot.apiKey?.trim()) throw new Error('ACTIVE_MODEL_UNAVAILABLE');
  if (
    snapshot.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(snapshot.maxOutputTokens) || snapshot.maxOutputTokens <= 0)
  )
    throw new Error('INVALID_RUNTIME_OUTPUT_TOKEN_LIMIT');
  const temperature = snapshot.temperature ?? 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    throw new Error('INVALID_RUNTIME_TEMPERATURE');

  const baseURL =
    snapshot.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : snapshot.provider === 'ollama'
        ? `${config.ollamaUrl.replace(/\/+$/, '')}/v1`
        : snapshot.provider === 'google'
          ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
          : undefined;
  const model = snapshot.model.replace(new RegExp(`^${snapshot.provider}/`), '');
  return {
    model,
    apiKey: snapshot.apiKey ?? (snapshot.provider === 'ollama' ? 'local-ollama' : undefined),
    ...(baseURL ? { configuration: { baseURL } } : {}),
    ...(requiresOpenAIResponsesApi(snapshot) ? { useResponsesApi: true } : {}),
    timeout: snapshot.requestTimeoutMs ?? 120_000,
    maxRetries: 0,
    ...(modelSupportsTemperature(snapshot) ? { temperature } : {}),
    streamUsage: snapshot.provider !== 'google',
    ...(snapshot.provider === 'ollama' ? { modelKwargs: { think: snapshot.ollamaThink } } : {}),
    ...(snapshot.maxOutputTokens ? { maxTokens: snapshot.maxOutputTokens } : {}),
  };
}

/** Single provider adapter used by the Router, Planner, and Answer roles. */
export function createLangGraphModel(snapshot: RuntimeModelSnapshot) {
  return new ChatOpenAI(langGraphModelOptions(snapshot));
}
