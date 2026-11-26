import type { RuntimeModelSnapshot } from './runtime-model.js';

/** OpenAI reasoning families accept only the API default temperature. Registry metadata can override this per model. */
export function openAIModelSupportsTemperature(modelId: string): boolean {
  return !/^(?:o[1-9](?:-|$)|gpt-[5-9](?:\.\d+)?-(?:luna|sol|terra|astra|codex|reasoning)(?:-|$))/i.test(modelId);
}

export function modelSupportsTemperature(model: RuntimeModelSnapshot): boolean {
  const metadata = model.capabilities?.temperature;
  if (typeof metadata === 'boolean') return metadata;
  if (model.provider === 'openai') return openAIModelSupportsTemperature(model.model.replace(/^openai\//, ''));
  // OpenRouter hosts models from many providers; omit the option until that model's registry metadata confirms support.
  if (model.provider === 'openrouter') return false;
  return true;
}
