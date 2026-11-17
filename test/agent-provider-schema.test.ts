import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { backendCallLLMSchema, backendCallSchema } from '../src/agent/backend-tools.js';
import { planLLMSchema, planLLMSchemaWithoutTools, plannerGenerationOptions, summarizePlannerValidationIssues } from '../src/agent/agent.workflow.js';

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

test('planner validation diagnostics hide dynamic argument keys and values', () => {
  assert.deepEqual(summarizePlannerValidationIssues({ issues: [
    { path: ['toolCall', 'args', 'customer_api_key'], code: 'invalid_type' },
  ] }, 'tool_call', 1), [{ attempt: 1, branch: 'tool_call', path: 'toolCall.args.*', code: 'invalid_type' }]);
});
