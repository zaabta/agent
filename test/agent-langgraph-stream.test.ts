import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentService } from '../src/agent/agent.service.js';

test('LangGraph SSE emits provisional text, verified sources, completion and persists the final answer', async () => {
  const service = Object.create(AgentService.prototype) as any;
  const principal = { userId: 'user-a', tenantId: 'tenant-a', authMethod: 'jwt' as const };
  const persisted: unknown[] = [];
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  service.activeRuns = { bindConversation() {}, beginFinalization() {} };
  service.beginTurn = async () => ({ conversationId: 'conversation-a', assistantMessageId: 'message-a', prompt: [{ role: 'user', content: 'what is in the report?' }], preserveConversationContext: false });
  service.updateAssistantStage = async () => undefined;
  service.saveAssistant = async (...args: unknown[]) => { persisted.push(args); };
  service.finishAssistantTurn = async () => undefined;
  service.createGraph = (_principal: unknown, _runtime: unknown, progress: (event: string, data: Record<string, unknown>) => Promise<void>) => ({
    invoke: async () => {
      await progress('stage', { stage: 'planning', status: 'in_progress' });
      await progress('text-delta', { text: 'The answer is 350 mm. ', verification: 'provisional' });
      return { answer: 'The answer is 350 mm [[report page 2]].', sources: [{ documentId: 'doc-a', filename: 'report.pdf', sourceRef: 'report page 2', chunkIndex: 1 }], toolsCalled: ['documentSearch'], citationValidation: 'valid', verificationStatus: 'verified', executionStatus: 'completed', outcome: 'success', requestId: 'request-a', llmCalls: 2 };
    },
  });
  const writer = async (name: string, data: Record<string, unknown>) => { events.push({ name, data }); };
  const result = await (service as any).streamLangGraph('what is in the report?', undefined, new AbortController().signal, writer, principal, 'run-a', { provider: 'openai', model: 'gpt-test', ollamaThink: false });
  assert.equal(result.answer, 'The answer is 350 mm [[report page 2]].');
  assert.equal(events.at(-1)?.name, 'done');
  assert.ok(events.some(event => event.name === 'text-reset' && event.data.reason === 'integrity-validation'));
  assert.deepEqual(events.find(event => event.name === 'sources')?.data.sources, result.sources);
  assert.equal((persisted[0] as unknown[])[2], result.answer);
});
