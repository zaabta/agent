import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentService } from '../src/agent/agent.service.js';

test('same-transaction timestamps retain user then assistant order in model context', async () => {
  const createdAt = new Date('2026-11-08T00:00:00Z');
  // UUID order deliberately opposes dialogue order. This store applies the
  // requested ordering, rather than always returning the desired fixture order.
  const rows = [
    { id: 'z-user', role: 'user', content: 'Describe Orion', createdAt },
    { id: 'a-assistant', role: 'assistant', content: 'Orion requires review [[requirements.md]]', createdAt },
  ];
  const db: any = {
    conversation: { findFirst: async ({ where }: any) => { assert.equal(where.tenantId, 'tenant'); assert.equal(where.ownerId, 'user'); return { id: 'conversation' }; }, update: async () => ({}) },
    conversationContext: { findFirst: async ({ where }: any) => {
      assert.deepEqual(where, { conversationId: 'conversation', tenantId: 'tenant', ownerId: 'user' });
      return { evidenceRefs: [{ documentId: '11111111-1111-4111-8111-111111111111', filename: 'orion.pdf', sourceRef: 'orion.pdf (page 2)', documentVersionId: '22222222-2222-4222-8222-222222222222' }], activeSelection: null };
    } },
    userMemory: { findMany: async ({ where, take }: any) => {
      assert.deepEqual(where, { tenantId: 'tenant', userId: 'user', deletedAt: null }); assert.equal(take, 8);
      return [{ category: 'preference', content: 'Use concise answers' }];
    } },
    message: {
      findMany: async ({ orderBy, take }: any) => [...rows].sort((a: any, b: any) => {
        for (const order of orderBy) {
          const [key, direction] = Object.entries(order)[0]!;
          const comparison = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
          if (comparison) return direction === 'asc' ? comparison : -comparison;
        }
        return 0;
      }).slice(0, take),
      create: async ({ data }: any) => ({ id: 'new', ...data }),
    },
    $transaction: (operations: any[]) => Promise.all(operations),
  };
  const service = new AgentService({} as any, db, {} as any);
  const turn = await (service as any).beginTurn('What about its risks?', 'conversation', { userId: 'user', tenantId: 'tenant' });
  assert.deepEqual(turn.prompt, [
    { role: 'user', content: rows[0]!.content },
    { role: 'assistant', content: rows[1]!.content },
    { role: 'user', content: 'What about its risks?' },
  ]);
  assert.deepEqual(turn.evidenceRefs, [{ documentId: '11111111-1111-4111-8111-111111111111', filename: 'orion.pdf', sourceRef: 'orion.pdf (page 2)', documentVersionId: '22222222-2222-4222-8222-222222222222' }]);
  assert.deepEqual(turn.userMemories, [{ category: 'preference', content: 'Use concise answers' }]);
});
