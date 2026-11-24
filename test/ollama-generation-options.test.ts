import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { planLLMSchema, plannerGenerationOptions } from '../src/agent/agent.workflow.js';
import { config } from '../src/config.js';
import { createSitePilotAgent } from '../src/mastra/factory.js';
import { asMastraModel } from '../src/mastra/runtime-model.js';
import { workflowGroundingInstructions } from '../src/agent/grounding-instructions.js';
import { localGenerationOptions } from '../src/mastra/generation-options.js';

test('unconfigured Answer output tokens defer to the provider/model default', () => {
  assert.deepEqual(localGenerationOptions({ provider: 'openai', model: 'gpt-4.1', ollamaThink: false, role: 'ANSWER' }), {});
  assert.deepEqual(localGenerationOptions({ provider: 'ollama', model: 'qwen3:8b', ollamaThink: false, role: 'ANSWER' }), { providerOptions: { ollama: { reasoningEffort: 'none' } } });
  assert.deepEqual(localGenerationOptions({ provider: 'ollama', model: 'qwen3:8b', ollamaThink: false, role: 'ANSWER', maxOutputTokens: 6000 }).modelSettings, { maxOutputTokens: 6000 });
});

test('Qwen no-thinking setting reaches actual Mastra HTTP requests in the correct wire format', async () => {
  const previous = { modelProvider: config.modelProvider, model: config.model, ollamaUrl: config.ollamaUrl, ollamaThink: config.ollamaThink };
  const received: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    received.push(JSON.parse(raw));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 0, model: 'qwen3:8b', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(config, { modelProvider: 'ollama', model: 'qwen3:8b', ollamaThink: false, ollamaUrl: `http://127.0.0.1:${(server.address() as any).port}` });
  try {
    const agent = createSitePilotAgent({} as any, {} as any);
    const answerRuntime = { provider: 'ollama', model: 'qwen3:8b', ollamaThink: true, role: 'ANSWER' as const, maxOutputTokens: 384 };
    const result = await agent.generate('Say hello', { maxSteps: 1, toolChoice: 'none', instructions: workflowGroundingInstructions, activeTools: [], ...localGenerationOptions(answerRuntime) });
    assert.equal(result.text, 'Hello');
    assert.equal(received.length, 1);
    assert.equal(received[0].reasoning_effort, 'none');
    assert.equal(received[0].max_tokens, 384);
    assert.equal(received[0].tools, undefined);
    assert.equal(received[0].messages[0].content, workflowGroundingInstructions);
    assert.ok(!received[0].messages[0].content.includes('Only cite exact sourceRef values returned by the tools'));
    assert.deepEqual(localGenerationOptions({ ...answerRuntime, role: 'PLANNER', ollamaThink: true }), { modelSettings: { maxOutputTokens: 384 } });
    config.ollamaThink = true;
    assert.deepEqual(localGenerationOptions(), {});
    config.ollamaThink = false; config.modelProvider = 'openrouter';
    assert.deepEqual(localGenerationOptions(), {});
  } finally { Object.assign(config, previous); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Ollama Answer streaming also sends no-thinking and bounded output options', async () => {
  const previousUrl = config.ollamaUrl;
  const received: any[] = [];
  let finishReason: string | undefined = 'stop';
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    received.push(JSON.parse(raw));
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'qwen3:8b', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'qwen3:8b', choices: [{ index: 0, delta: {}, ...(finishReason ? { finish_reason: finishReason } : {}) }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  config.ollamaUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const runtime = { provider: 'ollama', model: 'qwen3:8b', ollamaThink: true, role: 'ANSWER' as const, maxOutputTokens: 256 };
    const agent = new Agent({ id: 'ollama-answer-stream-test', name: 'Answer', instructions: workflowGroundingInstructions, model: asMastraModel(runtime).primary as any });
    const result = await agent.stream('Say hello', { maxSteps: 1, toolChoice: 'none', activeTools: [], ...localGenerationOptions(runtime) });
    const reasons: string[] = [];
    for await (const chunk of result.fullStream) if (chunk.type === 'step-finish') reasons.push(chunk.payload.stepResult.reason);
    assert.equal(received.length, 1);
    assert.equal(received[0].stream, true);
    assert.equal(received[0].reasoning_effort, 'none');
    assert.equal(received[0].max_tokens, 256);
    assert.deepEqual(reasons, ['stop']);

    finishReason = 'length';
    const truncated = await agent.stream('Say hello', { maxSteps: 1, toolChoice: 'none', activeTools: [], ...localGenerationOptions(runtime) });
    const truncatedReasons: string[] = [];
    for await (const chunk of truncated.fullStream) if (chunk.type === 'step-finish') truncatedReasons.push(chunk.payload.stepResult.reason);
    assert.deepEqual(truncatedReasons, ['length']);

    finishReason = undefined;
    const missing = await agent.stream('Say hello', { maxSteps: 1, toolChoice: 'none', activeTools: [], ...localGenerationOptions(runtime) });
    const missingReasons: string[] = [];
    for await (const chunk of missing.fullStream) if (chunk.type === 'step-finish') missingReasons.push(chunk.payload.stepResult.reason);
    assert.ok(!missingReasons.includes('stop'), 'missing provider completion metadata must never normalize to success');
  } finally {
    config.ollamaUrl = previousUrl;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Planner structured output sends the full dynamic-tool schema to Ollama', async () => {
  const previousUrl = config.ollamaUrl;
  const received: any[] = [];
  const plan = { operation: 'tool_call', requiredSources: ['registered_tool'], toolCall: { id: 'custom_11111111111141118111111111111111', args: { q: 'Istanbul' } } };
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    received.push(JSON.parse(raw));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 0, model: 'lfm2.5-thinking:1.2b', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  config.ollamaUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const runtime = { provider: 'ollama', model: 'lfm2.5-thinking:1.2b', ollamaThink: false, maxOutputTokens: 512 };
    const agent = new Agent({ id: 'planner-schema-test', name: 'Planner', instructions: 'Return a plan.', model: asMastraModel(runtime).primary as any });
    const result = await agent.generate('Choose the matching custom API tool for an Istanbul search.', {
      ...plannerGenerationOptions(runtime),
      structuredOutput: { schema: planLLMSchema, errorStrategy: 'strict' },
      modelSettings: { maxOutputTokens: runtime.maxOutputTokens },
      maxSteps: 1,
    });
    assert.deepEqual(planLLMSchema.parse(result.object), plan);
    assert.equal(received.length, 1);
    assert.equal(received[0].response_format.type, 'json_schema');
    assert.equal(received[0].response_format.json_schema.strict, true);
    assert.equal(received[0].max_tokens, 512);
    assert.equal(received[0].reasoning_effort, 'none');
    const sentSchema: any = received[0].response_format.json_schema.schema;
    assert.equal(sentSchema.oneOf.length, 8);
    assert.deepEqual(sentSchema.oneOf.map((branch: any) => branch.properties.operation.const).sort(), ['aggregate', 'clarify', 'discover', 'list', 'lookup', 'respond', 'retrieve', 'tool_call']);
    const sentToolCall = sentSchema.oneOf.find((branch: any) => branch.properties.operation.const === 'tool_call');
    assert.match(plan.toolCall.id, new RegExp(sentToolCall.properties.toolCall.properties.id.pattern));
    assert.equal(sentToolCall.properties.toolCall.properties.args.additionalProperties, true);
    assert.deepEqual(planLLMSchema.parse(plan).toolCall, { id: 'custom_11111111111141118111111111111111', args: { q: 'Istanbul' } });
  } finally {
    config.ollamaUrl = previousUrl;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Gemini Planner keeps JSON mode while receiving the same Zod validation schema', async () => {
  const previousFetch = globalThis.fetch;
  const options = plannerGenerationOptions({ provider: 'google', model: 'gemini-3.6-flash', ollamaThink: false });
  assert.equal(options.providerOptions?.google?.structuredOutputs, false);
  const plan = { operation: 'respond', requiredSources: [], reply: 'Hello' };
  let requestBody: any;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(plan) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const agent = new Agent({ id: 'gemini-planner-schema-test', name: 'Planner', instructions: 'Return a plan.', model: asMastraModel({ provider: 'google', model: 'gemini-3.6-flash', apiKey: 'test-key', ollamaThink: false }).primary as any });
    const result = await agent.generate('Respond with a short greeting.', {
      ...options,
      structuredOutput: { schema: planLLMSchema, errorStrategy: 'strict' },
      modelSettings: { maxOutputTokens: 512 },
      maxSteps: 1,
    });
    assert.deepEqual(planLLMSchema.parse(result.object), plan);
    assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
    assert.equal(requestBody.generationConfig.responseSchema, undefined);
    assert.equal(requestBody.generationConfig.maxOutputTokens, 512);
  } finally { globalThis.fetch = previousFetch; }
});

test('Gemini Answer adapter preserves stop and max-token completion reasons', async () => {
  const previousFetch = globalThis.fetch;
  let finishReason: string | undefined = 'STOP';
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'A supported answer [E1]' }] }, ...(finishReason ? { finishReason } : {}) }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 5, totalTokenCount: 7 } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    const runtime = { provider: 'google', model: 'gemini-3.6-flash', apiKey: 'test-key', role: 'ANSWER' as const, ollamaThink: false, maxOutputTokens: 256 };
    const agent = new Agent({ id: 'gemini-answer-finish-test', name: 'Answer', instructions: 'Answer from evidence.', model: asMastraModel(runtime).primary as any });
    const complete = await agent.stream('Answer from evidence.', { maxSteps: 1, toolChoice: 'none', activeTools: [], modelSettings: { maxOutputTokens: 256 } });
    const completeReasons: string[] = [];
    for await (const chunk of complete.fullStream) if (chunk.type === 'step-finish') completeReasons.push(chunk.payload.stepResult.reason);
    assert.deepEqual(completeReasons, ['stop']);

    finishReason = 'MAX_TOKENS';
    const truncated = await agent.stream('Answer from evidence.', { maxSteps: 1, toolChoice: 'none', activeTools: [], modelSettings: { maxOutputTokens: 256 } });
    const truncatedReasons: string[] = [];
    for await (const chunk of truncated.fullStream) if (chunk.type === 'step-finish') truncatedReasons.push(chunk.payload.stepResult.reason);
    assert.deepEqual(truncatedReasons, ['length']);

    finishReason = undefined;
    const missing = await agent.stream('Answer from evidence.', { maxSteps: 1, toolChoice: 'none', activeTools: [], modelSettings: { maxOutputTokens: 256 } });
    const missingReasons: string[] = [];
    for await (const chunk of missing.fullStream) if (chunk.type === 'step-finish') missingReasons.push(chunk.payload.stepResult.reason);
    assert.ok(!missingReasons.includes('stop'), 'missing provider completion metadata must never normalize to success');
  } finally { globalThis.fetch = previousFetch; }
});
