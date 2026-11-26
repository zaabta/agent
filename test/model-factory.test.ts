import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLangGraphModel, langGraphModelOptions } from '../src/agent/model-factory.js';
import type { RuntimeModelSnapshot } from '../src/llm-admin/runtime-model.js';

const snapshot = (provider: string, model: string): RuntimeModelSnapshot => ({ provider, model, apiKey: provider === 'ollama' ? undefined : 'test-secret', ollamaThink: false, maxOutputTokens: 256 });

test('single LangGraph factory selects the configured OpenAI, OpenRouter, Ollama, and Google endpoints', () => {
  const openai = langGraphModelOptions(snapshot('openai', 'openai/gpt-test'));
  assert.equal(openai.model, 'gpt-test');
  assert.equal(openai.configuration, undefined);
  assert.equal(openai.temperature, 0);

  const openrouter = langGraphModelOptions({ ...snapshot('openrouter', 'openrouter/vendor/model'), capabilities: { temperature: true } });
  assert.equal(openrouter.model, 'vendor/model');
  assert.equal(openrouter.configuration?.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(openrouter.temperature, 0);

  const ollama = langGraphModelOptions(snapshot('ollama', 'ollama/qwen-test'));
  assert.equal(ollama.model, 'qwen-test');
  assert.equal(ollama.apiKey, 'local-ollama');
  assert.match(ollama.configuration?.baseURL ?? '', /\/v1$/);
  assert.deepEqual(ollama.modelKwargs, { think: false });
  assert.equal(ollama.temperature, 0);
  assert.equal(JSON.stringify(ollama.modelKwargs).includes('temperature'), false);

  const google = langGraphModelOptions(snapshot('google', 'google/gemini-test'));
  assert.equal(google.model, 'gemini-test');
  assert.equal(google.configuration?.baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai/');
  assert.equal(google.maxRetries, 0);
  assert.equal(google.modelKwargs, undefined);
  assert.equal(google.temperature, 0);
});

test('OpenAI reasoning models omit temperature while supported models keep configured values', () => {
  const reasoning = langGraphModelOptions(snapshot('openai', 'gpt-6-luna'));
  assert.equal(Object.hasOwn(reasoning, 'temperature'), false);
  assert.equal(Object.hasOwn(langGraphModelOptions(snapshot('openai', 'gpt-5.6-sol')), 'temperature'), false);
  assert.equal(Object.hasOwn(langGraphModelOptions(snapshot('openai', 'o3-mini')), 'temperature'), false);

  const configured = langGraphModelOptions({ ...snapshot('openai', 'gpt-4o'), temperature: 0.35 });
  assert.equal(configured.temperature, 0.35);

  // Explicit per-model registry capabilities override the generic compatibility policy.
  assert.equal(langGraphModelOptions({ ...snapshot('openai', 'gpt-6-luna'), capabilities: { temperature: true }, temperature: 0.6 }).temperature, 0.6);
  assert.equal(Object.hasOwn(langGraphModelOptions({ ...snapshot('openai', 'gpt-4o'), capabilities: { temperature: false }, temperature: 0.6 }), 'temperature'), false);
});

test('Planner and Answer snapshots use the same temperature compatibility policy', () => {
  const planner = langGraphModelOptions({ ...snapshot('openai', 'gpt-6-luna'), role: 'PLANNER' });
  const answer = langGraphModelOptions({ ...snapshot('openai', 'gpt-6-luna'), role: 'ANSWER' });
  assert.equal(Object.hasOwn(planner, 'temperature'), false);
  assert.equal(Object.hasOwn(answer, 'temperature'), false);
  assert.equal(langGraphModelOptions({ ...snapshot('openai', 'gpt-4o'), role: 'PLANNER', temperature: 0.25 }).temperature, 0.25);
  assert.equal(langGraphModelOptions({ ...snapshot('openai', 'gpt-4o'), role: 'ANSWER', temperature: 0.65 }).temperature, 0.65);
});

test('OpenRouter model metadata can suppress temperature without changing other provider settings', () => {
  const options = langGraphModelOptions({ ...snapshot('openrouter', 'vendor/reasoner'), capabilities: { temperature: false }, temperature: 0.4 });
  assert.equal(Object.hasOwn(options, 'temperature'), false);
  assert.equal(options.configuration?.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(Object.hasOwn(langGraphModelOptions(snapshot('openrouter', 'vendor/unknown')), 'temperature'), false);
});

test('provider factory validates missing credentials, provider, model id, and token limits before model creation', () => {
  assert.throws(() => langGraphModelOptions({ ...snapshot('google', 'gemini-test'), apiKey: undefined }), /ACTIVE_MODEL_UNAVAILABLE/);
  assert.throws(() => langGraphModelOptions(snapshot('unknown', 'model')), /INVALID_MODEL_PROVIDER/);
  assert.throws(() => langGraphModelOptions(snapshot('ollama', ' ')), /INVALID_MODEL_ID/);
  assert.throws(() => langGraphModelOptions({ ...snapshot('ollama', 'qwen-test'), maxOutputTokens: 0 }), /INVALID_RUNTIME_OUTPUT_TOKEN_LIMIT/);
});

test('factory constructs a LangChain chat model without making a provider request', () => {
  assert.equal(typeof createLangGraphModel(snapshot('google', 'gemini-test')).withStructuredOutput, 'function');
  assert.equal(typeof createLangGraphModel(snapshot('openai', 'gpt-test')).stream, 'function');
  const reasoningParams = (createLangGraphModel(snapshot('openai', 'gpt-6-luna')) as any).invocationParams();
  assert.equal(reasoningParams.temperature, undefined);
  assert.doesNotMatch(JSON.stringify(reasoningParams), /temperature/);
  assert.equal(Object.hasOwn(reasoningParams.modelKwargs ?? {}, 'temperature'), false);
  const supportedParams = (createLangGraphModel({ ...snapshot('openai', 'gpt-4o'), temperature: 0.4 }) as any).invocationParams();
  assert.equal(supportedParams.temperature, 0.4);
});
