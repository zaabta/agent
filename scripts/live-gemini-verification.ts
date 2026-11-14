import '../src/config.js';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const model = 'google/gemini-3.6-flash';
const tools = {
  first: createTool({ id: 'first', description: 'Return the first marker.', inputSchema: z.object({ marker: z.string() }), execute: async ({ marker }) => ({ marker }) }),
  second: createTool({ id: 'second', description: 'Return the second marker.', inputSchema: z.object({ marker: z.string() }), execute: async ({ marker }) => ({ marker }) }),
};
const agent = new Agent({ id: 'gemini-live-verification', name: 'Gemini verification', model, instructions: 'Follow user output constraints exactly. Use all requested tools.' , tools });

async function measured(name: string, fn: () => Promise<any>) {
  const start = performance.now();
  const result = await fn();
  const latencyMs = Math.round(performance.now() - start);
  const usage = result.usage ?? result.totalUsage;
  console.log(JSON.stringify({ name, latencyMs, text: result.text, steps: result.steps?.length, toolCalls: result.toolCalls?.map((call: any) => call.payload?.toolName ?? call.toolName), usage, model: result.response?.modelId, finishReason: result.finishReason }));
  return result;
}

if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY was not mapped from GEMINI_API_KEY');
console.log(JSON.stringify({ configuredModel: model, keyPresent: true }));
await measured('english-chat', () => agent.generate('Reply with exactly READY.'));
await measured('arabic-chat', () => agent.generate('أجب بكلمة جاهز فقط.'));
await measured('turkish-chat', () => agent.generate('Yalnızca HAZIR kelimesiyle yanıt ver.'));
await measured('structured-plan', () => agent.generate('Return operation=retrieve and query="contract dates".', {
  structuredOutput: { schema: z.object({ operation: z.literal('retrieve'), query: z.string() }), errorStrategy: 'strict' },
}));
await measured('multiple-tools', () => agent.generate('Call first with marker A and second with marker B, then summarize both.', { maxSteps: 3 }));
await measured('conversation-follow-up', () => agent.generate([
  { role: 'user', content: 'My project code is ALPHA-17.' },
  { role: 'assistant', content: 'Understood. The project code is ALPHA-17.' },
  { role: 'user', content: 'What was the code I gave you?' },
]));
await measured('sse-stream', async () => {
  const result = await agent.stream('Reply with exactly STREAM_OK.');
  let text = '';
  for await (const chunk of result.textStream) text += chunk;
  const final = await result.getFullOutput();
  return { ...final, text, totalUsage: final.totalUsage };
});
