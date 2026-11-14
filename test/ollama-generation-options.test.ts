import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { createSitePilotAgent } from '../src/mastra/factory.js';
import { workflowGroundingInstructions } from '../src/agent/grounding-instructions.js';
import { localGenerationOptions } from '../src/mastra/generation-options.js';

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
    const result = await agent.generate('Say hello', { maxSteps: 1, toolChoice: 'none', instructions: workflowGroundingInstructions, activeTools: [], ...localGenerationOptions() });
    assert.equal(result.text, 'Hello');
    assert.equal(received.length, 1);
    assert.equal(received[0].reasoning_effort, 'none');
    assert.equal(received[0].tools, undefined);
    assert.equal(received[0].messages[0].content, workflowGroundingInstructions);
    assert.ok(!received[0].messages[0].content.includes('Only cite exact sourceRef values returned by the tools'));
    config.ollamaThink = true;
    assert.deepEqual(localGenerationOptions(), {});
    config.ollamaThink = false; config.modelProvider = 'openrouter';
    assert.deepEqual(localGenerationOptions(), {});
  } finally { Object.assign(config, previous); await new Promise<void>(resolve => server.close(() => resolve())); }
});
