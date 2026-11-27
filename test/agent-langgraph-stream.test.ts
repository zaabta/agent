import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentService } from '../src/agent/agent.service.js';

test('LangGraph SSE emits only the assembled answer and persists the same final result', async () => {
  const service = Object.create(AgentService.prototype) as any;
  const principal = { userId: 'user-a', tenantId: 'tenant-a', authMethod: 'jwt' as const };
  const persisted: unknown[] = [];
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  service.activeRuns = { bindConversation() {}, beginFinalization() {} };
  service.beginTurn = async () => ({
    conversationId: 'conversation-a',
    assistantMessageId: 'message-a',
    prompt: [{ role: 'user', content: 'what is in the report?' }],
    preserveConversationContext: false,
  });
  service.updateAssistantStage = async () => undefined;
  service.saveAssistant = async (...args: unknown[]) => {
    persisted.push(args);
  };
  service.finishAssistantTurn = async () => undefined;
  service.createGraph = (
    _principal: unknown,
    _runtime: unknown,
    progress: (event: string, data: Record<string, unknown>) => Promise<void>,
  ) => ({
    invoke: async () => {
      await progress('stage', { stage: 'planning', status: 'in_progress' });
      return {
        answer: 'The answer is 350 mm.',
        sources: [{ citationId: 'C1', documentId: 'doc-a', filename: 'report.pdf', sourceRef: 'report page 2', chunkIndex: 1, pageNumber: 2 }],
        evidenceReferences: [{ claimIndex: 0, evidenceIds: ['E1'], citationIds: ['C1'], sources: [{ citationId: 'C1', documentId: 'doc-a', filename: 'report.pdf', sourceRef: 'report page 2', chunkIndex: 1, pageNumber: 2 }] }],
        toolsCalled: ['documentSearch'],
        citationValidation: 'valid',
        verificationStatus: 'unverified',
        executionStatus: 'completed',
        outcome: 'success',
        requestId: 'request-a',
        llmCalls: 2,
      };
    },
  });
  const writer = async (name: string, data: Record<string, unknown>) => {
    events.push({ name, data });
  };
  const result = await (service as any).streamLangGraph(
    'what is in the report?',
    undefined,
    new AbortController().signal,
    writer,
    principal,
    'run-a',
    { provider: 'openai', model: 'gpt-test', ollamaThink: false },
  );
  assert.equal(result.answer, 'The answer is 350 mm.');
  assert.equal(events.at(-1)?.name, 'done');
  assert.equal(events.filter((event) => event.name === 'text-delta').length, 1);
  assert.ok(!events.some((event) => event.name === 'text-reset'));
  assert.deepEqual(events.find((event) => event.name === 'sources')?.data.sources, result.sources);
  assert.deepEqual((events.find((event) => event.name === 'done')?.data.evidenceReferences as any[])[0]?.citationIds, ['C1']);
  assert.equal((persisted[0] as unknown[])[2], result.answer);
  assert.deepEqual((persisted[0] as unknown[])[8], result.evidenceReferences);
});

test('LangGraph SSE failure marks the assistant turn failed and emits no completion', async () => {
  const service = Object.create(AgentService.prototype) as any;
  const principal = { userId: 'user-a', tenantId: 'tenant-a', authMethod: 'jwt' as const };
  const events: string[] = [];
  let finishStatus: string | undefined;
  service.activeRuns = { bindConversation() {}, beginFinalization() {} };
  service.beginTurn = async () => ({
    conversationId: 'conversation-a',
    assistantMessageId: 'message-a',
    prompt: [{ role: 'user', content: 'what is in the report?' }],
    preserveConversationContext: false,
  });
  service.updateAssistantStage = async () => undefined;
  service.finishAssistantTurn = async (_conversationId: string, _messageId: string, status: string) => {
    finishStatus = status;
  };
  service.createGraph = (
    _principal: unknown,
    _runtime: unknown,
    progress: (event: string, data: Record<string, unknown>) => Promise<void>,
  ) => ({
    invoke: async () => {
      await progress('stage', { stage: 'answer_provider', status: 'in_progress' });
      throw new Error('MODEL_STREAM_FAILED');
    },
  });
  await assert.rejects(
    (service as any).streamLangGraph(
      'what is in the report?',
      undefined,
      new AbortController().signal,
      async (name: string) => {
        events.push(name);
      },
      principal,
      'run-a',
      { provider: 'openai', model: 'gpt-test', ollamaThink: false },
    ),
    /CONNECTION_FAILED/,
  );
  assert.equal(finishStatus, 'failed');
  assert.ok(events.includes('status'));
  assert.ok(!events.includes('done'));
});
