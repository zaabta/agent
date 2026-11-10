import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { AgentService } from '../src/agent/agent.service.js';

test('verified document references persist with a conversation and reload after service recreation', async () => {
  let savedContext: any;
  const messages = [
    { role: 'assistant', content: 'Two risks are documented [[orion.pdf (page 2)]]', createdAt: new Date('2026-11-09T12:00:01Z') },
    { role: 'user', content: 'Summarize Orion risks', createdAt: new Date('2026-11-09T12:00:00Z') },
  ];
  const db: any = {
    conversation: {
      findFirst: async ({ where }: any) => { assert.equal(where.tenantId, 'tenant-a'); assert.equal(where.ownerId, 'user-a'); return { id: 'conversation-a' }; },
      update: async () => ({}),
    },
    conversationContext: {
      upsert: async ({ create, update }: any) => { savedContext = { ...create, ...update }; return savedContext; },
      findFirst: async ({ where }: any) => {
        assert.deepEqual(where, { conversationId: 'conversation-a', tenantId: 'tenant-a', ownerId: 'user-a' });
        return savedContext ?? null;
      },
    },
    userMemory: { findMany: async () => [] },
    message: {
      findMany: async () => messages.map(item => ({ ...item, structuredSelection: null })),
      create: async ({ data }: any) => ({ id: 'assistant-new', ...data }),
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  const principal = { userId: 'user-a', tenantId: 'tenant-a' } as any;
  const firstService = new AgentService({} as any, db, {} as any);
  await (firstService as any).saveAssistant('conversation-a', 'assistant-new', 'Orion risks are listed. [[orion.pdf (page 2)]]', undefined, principal, [{
    documentId: '11111111-1111-4111-8111-111111111111', filename: 'orion.pdf', sourceRef: 'orion.pdf (page 2)', chunkIndex: 2,
    documentVersionId: '22222222-2222-4222-8222-222222222222',
  }]);

  // A new service instance reads the persisted state from the same durable store.
  const afterRestart = new AgentService({} as any, db, {} as any);
  const turn = await (afterRestart as any).beginTurn('ماذا عن التكلفة؟', 'conversation-a', principal);
  assert.equal(turn.prompt.at(-2).content, messages[0]!.content);
  assert.equal(turn.evidenceRefs[0].filename, 'orion.pdf');
  assert.equal(turn.evidenceRefs[0].documentVersionId, '22222222-2222-4222-8222-222222222222');
  assert.equal(turn.preserveConversationContext, true);

  // A later completed turn on a different topic clears prior document hints.
  savedContext.activeSelection = { documentId: 'old-selection' };
  await (afterRestart as any).saveAssistant('conversation-a', 'assistant-new', 'The warranty period is one year.', undefined, principal, [], false);
  assert.deepEqual(savedContext.evidenceRefs, []);
  assert.equal(savedContext.activeSelection, Prisma.DbNull);
  assert.doesNotMatch(savedContext.summary, /orion\.pdf/i);
});
