import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { createOpenAI } from '@ai-sdk/openai';
import { backendCallLLMSchema, backendCallSchema } from '../src/agent/backend-tools.js';
import { buildPlannerPrompt, planLLMSchema, planLLMSchemaWithoutTools, plannerGenerationOptions, summarizePlannerValidationIssues } from '../src/agent/agent.workflow.js';
import { resolveRuntimeModels } from '../src/mastra/runtime-model.js';

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsKey(item, key));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([name, item]) => name === key || containsKey(item, key));
  }
  return false;
}

test('Nemotron planner JSON Schema omits propertyNames while preserving arbitrary tool arguments', () => {
  const plannerJsonSchema = z.toJSONSchema(planLLMSchema);
  assert.equal(containsKey(plannerJsonSchema, 'propertyNames'), false);
  assert.equal(containsKey(z.toJSONSchema(backendCallLLMSchema), 'propertyNames'), false);

  const backendBranch = (plannerJsonSchema as { oneOf: Array<{ properties: Record<string, any> }> }).oneOf
    .find(branch => branch.properties.operation?.const === 'tool_call');
  assert.ok(backendBranch);
  const argsSchema = backendBranch.properties.toolCall.properties.args;
  assert.deepEqual(argsSchema.properties, {});
  assert.deepEqual(argsSchema.additionalProperties, {});

  const call = { id: 'document_search', args: { query: 'drawing dimensions', limit: 3 } };
  assert.deepEqual(backendCallLLMSchema.parse(call), call);
  assert.deepEqual(backendCallSchema.parse(call), call);
});

test('planner schema retains every operation and runtime backend validation stays unchanged', () => {
  const schema = z.toJSONSchema(planLLMSchema) as { oneOf: Array<{ properties: Record<string, any> }> };
  const operations = schema.oneOf.map(branch => branch.properties.operation.const).sort();
  assert.deepEqual(operations, ['aggregate', 'clarify', 'discover', 'list', 'lookup', 'respond', 'retrieve', 'tool_call']);

  assert.equal(backendCallSchema.safeParse({ id: 'Invalid-ID', args: {} }).success, false);
  assert.equal(backendCallSchema.safeParse({ id: 'valid_id', args: { x: true } }).success, true);
});

test('planner schema excludes backend-tool routing when no backend tools are registered', () => {
  const schema = z.toJSONSchema(planLLMSchemaWithoutTools) as { oneOf: Array<{ properties: Record<string, any> }> };
  const operations = schema.oneOf.map(branch => branch.properties.operation.const).sort();
  assert.deepEqual(operations, ['aggregate', 'clarify', 'discover', 'list', 'lookup', 'respond', 'retrieve']);
});

test('Gemini planner uses validated JSON mode for dynamic tool arguments', () => {
  const options = plannerGenerationOptions({ provider: 'google', model: 'gemini-3.6-flash', ollamaThink: false });
  assert.equal(options.providerOptions?.google?.structuredOutputs, false);
  assert.deepEqual(options.providerOptions?.google?.thinkingConfig, { thinkingLevel: 'low', includeThoughts: false });
  assert.equal(plannerGenerationOptions({ provider: 'gemini', model: 'gemini-3.6-flash', ollamaThink: false }).providerOptions?.google?.structuredOutputs, false);
  assert.deepEqual(plannerGenerationOptions({ provider: 'openrouter', model: 'model', ollamaThink: false }), {});
});

test('OpenAI planner uses JSON mode and validates the complete plan locally', async () => {
  const received: any[] = [];
  const plan = { operation: 'tool_call', requiredSources: ['registered_tool'], toolCall: { id: 'custom_233145be28474f2ca2b2f7b028a2a1dc', args: { q: 'luna' } } };
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    received.push(JSON.parse(raw));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 0, model: 'gpt-4.1-mini', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as any).port;
    const runtime = { provider: 'openai', model: 'gpt-4.1-mini', ollamaThink: false };
    const schemaText = JSON.stringify(z.toJSONSchema(planLLMSchema));
    const prompt = buildPlannerPrompt({
      schema: planLLMSchema, retrievalLanguage: 'Preserve the user language.', conversationSummary: '', history: [],
      contextEntities: [], userMemories: [], evidenceRefs: [], catalog: [{ id: plan.toolCall.id, description: 'Search a catalog.', input: { type: 'object', properties: { q: { type: 'string' } } } }],
      message: 'Search for luna.', provider: 'openai',
    });
    const agent = new Agent({ id: 'openai-planner-json-mode-test', name: 'Planner', instructions: 'Return a plan.', model: createOpenAI({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}/v1` }).chat(runtime.model) as any });
    const result = await agent.generate(prompt, { ...plannerGenerationOptions(runtime), structuredOutput: { schema: planLLMSchema, errorStrategy: 'strict' }, maxSteps: 1 });
    assert.deepEqual(planLLMSchema.parse(result.object), plan);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].response_format, { type: 'json_object' });
    assert.ok(received[0].messages.some((message: any) => message.content.includes(schemaText)));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Planner prompt includes schemas for JSON-mode providers and omits them for native structured output', () => {
  const input = {
    schema: planLLMSchema, retrievalLanguage: 'Preserve the user language.', conversationSummary: '', history: [],
    contextEntities: [], userMemories: [], evidenceRefs: [], catalog: [{ id: 'custom_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'museumSearch', displayName: 'Museum Search', description: 'Check museum opening hours', input: { type: 'object', properties: { city: { type: 'string' } } } }],
    message: 'Is the museum open on Monday?',
  };
  const ollama = buildPlannerPrompt({ ...input, provider: 'ollama' });
  const gemini = buildPlannerPrompt({ ...input, provider: 'google' });
  const openai = buildPlannerPrompt({ ...input, provider: 'openai' });
  const schemaText = JSON.stringify(z.toJSONSchema(planLLMSchema));
  assert.equal(ollama.includes(schemaText), false);
  assert.equal(gemini.includes(schemaText), true);
  assert.equal(openai.includes(schemaText), true);
  assert.match(ollama, /Check museum opening hours/);
  assert.doesNotMatch(ollama, /museumSearch|Museum Search/);
  assert.match(ollama, /authorized capability catalog/i);
});

test('planner validation diagnostics hide dynamic argument keys and values', () => {
  assert.deepEqual(summarizePlannerValidationIssues({ issues: [
    { path: ['toolCall', 'args', 'customer_api_key'], code: 'invalid_type' },
  ] }, 'tool_call', 1), [{ attempt: 1, branch: 'tool_call', path: 'toolCall.args.*', code: 'invalid_type' }]);
});

test('Planner output budget resolves from existing runtime settings and is isolated from ANSWER', async () => {
  const values = [
    { key: 'PLANNER_PROVIDER', value: 'ollama' }, { key: 'PLANNER_MODEL', value: 'lfm2.5-thinking:1.2b' },
    { key: 'ANSWER_PROVIDER', value: 'ollama' }, { key: 'ANSWER_MODEL', value: 'qwen3:8b' },
    { key: 'PLANNER_MAX_OUTPUT_TOKENS', value: '1024' },
  ];
  const runtime = await resolveRuntimeModels({
    runtimeSetting: { findMany: async () => values },
    registeredModel: { findUnique: async () => ({ enabled: true, available: true, compatible: true }) },
  } as any);
  assert.equal(runtime.planner.maxOutputTokens, 1024);
  assert.equal(runtime.answer.maxOutputTokens, undefined);
});
