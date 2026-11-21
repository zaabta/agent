import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentService } from '../src/agent/agent.service.js';
import { safeAgentFailure } from '../src/agent/provider-errors.js';

test('Answer stream emits deltas live and only accepts a finished generation', async () => {
  const service = Object.create(AgentService.prototype) as any;
  const runtime = { role: 'ANSWER', provider: 'ollama', model: 'fixture', requestTimeoutMs: 1000, maxStreamDurationMs: 1000 };
  const wrap = (chunks: unknown[]) => service.withProviderHandling({
    stream: async () => ({
      fullStream: (async function* () { for (const chunk of chunks) yield chunk; })(),
      getFullOutput: async () => ({ text: 'fixture' }),
    }),
  }, runtime);
  const output = await wrap([
    { type: 'text-delta', payload: { text: 'first ' } },
    { type: 'text-delta', payload: { text: 'second' } },
    { type: 'step-finish', payload: { stepResult: { reason: 'stop' } } },
  ]).stream([], {});
  const received: string[] = [];
  for await (const chunk of output.fullStream) if (chunk.type === 'text-delta') received.push(chunk.payload.text);
  assert.deepEqual(received, ['first ', 'second']);

  for (const chunks of [
    [{ type: 'text-delta', payload: { text: 'partial' } }],
    [{ type: 'step-finish', payload: { stepResult: { reason: 'other' } } }],
  ]) {
    const failed = await wrap(chunks).stream([], {});
    await assert.rejects(async () => { for await (const _chunk of failed.fullStream) { /* drain */ } }, error =>
      safeAgentFailure(error)?.code === (chunks[0]?.type === 'text-delta' || (chunks[0] as any)?.payload?.stepResult?.reason === 'other' ? 'CONNECTION_FAILED' : 'OUTPUT_TRUNCATED'));
  }

  const truncated = await wrap([{ type: 'step-finish', payload: { stepResult: { reason: 'length' } } }]).stream([], {});
  const finishReasons: string[] = [];
  for await (const chunk of truncated.fullStream) if (chunk.type === 'step-finish') finishReasons.push(chunk.payload.stepResult.reason);
  assert.deepEqual(finishReasons, ['length'], 'the workflow must see truncation to attempt provider-supported continuation');
});
