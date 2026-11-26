import type { RuntimeModelSnapshot } from './runtime-model.js';

export type StructuredOutputMethod = 'jsonSchema' | 'functionCalling' | 'jsonMode';

/** OpenAI reasoning families accept only the API default temperature. Registry metadata can override this per model. */
export function openAIModelSupportsTemperature(modelId: string): boolean {
  return !/^(?:o[1-9](?:-|$)|gpt-[5-9](?:\.\d+)?-(?:luna|sol|terra|astra|codex|reasoning)(?:-|$))/i.test(
    modelId,
  );
}

export function modelSupportsTemperature(model: RuntimeModelSnapshot): boolean {
  const metadata = model.capabilities?.temperature;
  if (typeof metadata === 'boolean') return metadata;
  if (model.provider === 'openai')
    return openAIModelSupportsTemperature(model.model.replace(/^openai\//, ''));
  // OpenRouter hosts models from many providers; omit the option until that model's registry metadata confirms support.
  if (model.provider === 'openrouter') return false;
  return true;
}

/**
 * OpenAI's current model registry advertises tool calling for compatible GPT models,
 * while some newer models reject Chat Completions `response_format` JSON Schema.
 * Explicit per-model registry metadata takes precedence over this provider default.
 */
export function structuredOutputMethod(model: RuntimeModelSnapshot): StructuredOutputMethod | undefined {
  const configured = model.capabilities?.structuredOutputMethod;
  if (configured === 'jsonSchema' || configured === 'functionCalling' || configured === 'jsonMode')
    return configured;
  if (model.provider === 'openai') return 'functionCalling';
  return undefined;
}

/** LangChain's current auto-detection does not yet route GPT-6 reasoning models through Responses. */
export function requiresOpenAIResponsesApi(model: RuntimeModelSnapshot): boolean {
  if (model.provider !== 'openai') return false;
  const configured = model.capabilities?.apiProtocol;
  if (configured === 'chatCompletions') return false;
  if (configured === 'responses') return true;
  const modelId = model.model.replace(/^openai\//, '');
  return /^gpt-6(?:\.|-(?!chat))/i.test(modelId);
}
