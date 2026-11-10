import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { ConversationContextService } from '../src/agent/conversation-context.service.js';

const principal = { userId: 'user-a', tenantId: 'tenant-a' } as any;
const ref = (id: string, filename: string) => ({
  documentId: id,
  filename,
  sourceRef: `${filename} (page 1)`,
  chunkIndex: 1,
  documentVersionId: `${id.slice(0, 8)}-2222-4222-8222-222222222222`,
});

test('conversation context merges citation-free followups and multiple document refs, then clears stale topic scope on reopen', async () => {
  let row: any = null;
  const whereClauses: any[] = [];
  const model = {
    findFirst: async ({ where }: any) => { whereClauses.push(where); return row; },
    upsert: async ({ create, update }: any) => { row = { ...(row ?? create), ...update }; return row; },
  };
  const db: any = { conversationContext: model };
  const service = new ConversationContextService(db);
  const tx = db as Prisma.TransactionClient;

  await service.saveTurn(tx, 'conversation-a', principal,
    'We decided to retain the Orion format.', [ref('11111111-1111-4111-8111-111111111111', 'orion.pdf'), ref('33333333-3333-4333-8333-333333333333', 'costs.xlsx')],
    { groupBy: 'department' } as any, false);
  const initialDecision = [...row.decisions];
  assert.equal(row.evidenceRefs.length, 2);

  await service.saveTurn(tx, 'conversation-a', principal, 'The cost is not stated in the retrieved passage.', [], undefined, true);
  assert.equal(row.evidenceRefs.length, 2, 'citation-free related turn must retain both bounded reference hints');
  assert.deepEqual(row.decisions, initialDecision, 'context without a new decision must retain prior decisions');
  assert.equal(row.activeSelection.groupBy, 'department');
  assert.match(row.summary, /orion\.pdf/);
  assert.match(row.summary, /costs\.xlsx/);

  const reopened = new ConversationContextService(db);
  const persisted = await reopened.load('conversation-a', principal);
  assert.equal(persisted?.evidenceRefs && (persisted.evidenceRefs as any[]).length, 2);
  assert.deepEqual(whereClauses.at(-1), { conversationId: 'conversation-a', tenantId: 'tenant-a', ownerId: 'user-a' });

  await reopened.saveTurn(tx, 'conversation-a', principal, 'A new topic has no document evidence.', [], undefined, false);
  assert.deepEqual(row.evidenceRefs, []);
  assert.equal(row.activeSelection, Prisma.DbNull);
  assert.equal(row.decisions.includes(initialDecision[0]), true, 'important decisions persist across topic changes');
  assert.doesNotMatch(row.summary, /orion\.pdf|costs\.xlsx/i);
  await assert.rejects(
    () => reopened.saveTurn(tx, 'conversation-a', { userId: 'user-b', tenantId: 'tenant-b' } as any, 'must not cross scope', [], undefined, true),
    /CONVERSATION_CONTEXT_SCOPE_MISMATCH/,
  );
});

test('conversation context bounds accumulated decisions, entities, refs, and summary', async () => {
  let row: any = null;
  const model = {
    findFirst: async () => row,
    upsert: async ({ create, update }: any) => { row = { ...(row ?? create), ...update }; return row; },
  };
  const service = new ConversationContextService({ conversationContext: model } as any);
  for (let i = 1; i <= 35; i++) {
    const id = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`;
    await service.saveTurn({ conversationContext: model } as any, 'conversation-a', principal,
      `We decided to keep option ${i}.`, [{ ...ref(id, `doc-${i}.pdf`), sourceRef: `doc-${i}.pdf (page 1)` }], undefined, true);
  }
  assert.ok(row.evidenceRefs.length <= 12);
  assert.ok(row.entities.length <= 30);
  assert.ok(row.decisions.length <= 20);
  assert.ok(row.summary.length <= 2000);
});
