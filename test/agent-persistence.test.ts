import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentService } from '../src/agent/agent.service.js';

test('unverified fallback is saved as failed and excluded from conversation evidence', async () => {
  const updates: any[] = [];
  let savedContext = 0;
  const transaction = {
    message: {
      updateMany: async (args: unknown) => {
        updates.push(args);
      },
    },
    conversation: { update: async () => undefined },
  };
  const service = Object.create(AgentService.prototype) as any;
  service.prisma = {
    ...transaction,
    conversationContext: { upsert: true },
    $transaction: async (callback: (tx: typeof transaction) => Promise<void>) => callback(transaction),
  };
  service.conversationContext = {
    saveTurn: async () => {
      savedContext++;
    },
  };

  await service.saveAssistant(
    'conversation',
    'message',
    'Could not verify',
    undefined,
    { tenantId: 'tenant', userId: 'user' },
    [],
    false,
    'failed',
  );

  assert.equal(updates[0].data.status, 'failed');
  assert.equal(updates[0].data.stage, 'failed');
  assert.equal(savedContext, 0);
});

test('verified evidence references are persisted with the assistant message', async () => {
  let update: any;
  const transaction = {
    message: { updateMany: async (args: any) => { update = args; } },
    conversation: { update: async () => undefined },
  };
  const service = Object.create(AgentService.prototype) as any;
  service.prisma = {
    ...transaction,
    $transaction: async (operations: unknown[]) => operations,
  };
  const evidenceReferences = [{
    claimIndex: 0,
    evidenceIds: ['E1'],
    citationIds: ['C1'],
    sources: [{ citationId: 'C1', documentId: 'doc-a', filename: 'pricing.md', sourceRef: 'Section 2', chunkIndex: 3 }],
  }];

  await service.saveAssistant('conversation', 'message', 'The price is listed in the file.', undefined, undefined, [], false, 'completed', evidenceReferences);

  assert.deepEqual(update.data.evidenceReferences, evidenceReferences);
});
