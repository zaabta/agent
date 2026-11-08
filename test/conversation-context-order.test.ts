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
    conversation: { findFirst: async () => ({ id: 'conversation' }), update: async () => ({}) },
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
});
