import assert from 'node:assert/strict';
import test from 'node:test';
import { persistPlannerDiagnostic, readTenantTrace } from '../src/mastra/observability.js';

test('planner diagnostics persist only the bounded allowlist and prune expired rows', async () => {
  let saved: any;
  let retention: any;
  const prisma: any = { plannerDiagnostic: {
    upsert: async (args: any) => { saved = args; },
    deleteMany: async (args: any) => { retention = args; },
  } };
  await persistPlannerDiagnostic(prisma, {
    requestId: '52dcb39c-70f7-4143-8fe3-3e074d30fa4a', tenantId: 'tenant',
    availableToolIds: ['safe-tool'], selectedOperation: 'clarify', schemaValidationOutcome: 'valid',
    validationIssues: Array.from({ length: 10 }, (_, attempt) => ({ attempt: 1, branch: 'tool_call', path: 'toolCall.args.*', code: 'invalid_type', rawValue: 'private' })),
    prompt: 'private prompt', credentials: 'secret', rawToolArguments: { private: true },
  } as any);
  assert.deepEqual(saved.create, {
    requestId: '52dcb39c-70f7-4143-8fe3-3e074d30fa4a', tenantId: 'tenant', availableToolIds: ['safe-tool'],
    selectedOperation: 'clarify', selectedToolId: undefined, schemaValidationOutcome: 'valid',
    argumentSchemaValidationOutcome: undefined, fallbackReason: undefined,
    validationIssues: Array.from({ length: 8 }, () => ({ attempt: 1, branch: 'tool_call', path: 'toolCall.args.*', code: 'invalid_type' })),
  });
  assert.ok(retention.where.createdAt.lt instanceof Date);
  assert.ok(Date.now() - retention.where.createdAt.lt.getTime() >= 30 * 24 * 60 * 60 * 1000);
});

test('owner trace reader retrieves persisted diagnostics by request and tenant', async () => {
  const calls: any[] = [];
  const prisma: any = { plannerDiagnostic: { findUnique: async (args: any) => {
    calls.push(args);
    return { tenantId: 'tenant', availableToolIds: ['safe-tool'], selectedOperation: 'clarify', selectedToolId: null,
      schemaValidationOutcome: 'valid', argumentSchemaValidationOutcome: null, fallbackReason: null, createdAt: new Date(0) };
  } } };
  const result = await readTenantTrace('52dcb39c70f741438fe33e074d30fa4a', 'tenant', prisma);
  assert.equal(calls[0].where.requestId, '52dcb39c-70f7-4143-8fe3-3e074d30fa4a');
  assert.equal((result as any).selectedOperation, 'clarify');
  assert.deepEqual((result as any).availableToolIds, ['safe-tool']);
  assert.equal(await readTenantTrace('52dcb39c70f741438fe33e074d30fa4a', 'other-tenant', prisma), undefined);
});
