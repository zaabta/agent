import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSitePilotAgent } from '../src/mastra/factory.js';
import type { TypegraphService } from '../src/typegraph/typegraph.service.js';
import type { StructuredDataService } from '../src/documents/structured-data.service.js';

test('Mastra exposes tenant-bound retrieval, inventory, exact lookup, and analytics tools', async () => {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const typegraph = {
    searchDocuments: async (...args: unknown[]) => { calls.push({ kind: 'search', args }); return { query: 'x', hits: [], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: 0 } }; },
    listDocuments: async (...args: unknown[]) => { calls.push({ kind: 'list', args }); return { documents: [], durationMs: 0 }; },
  } as unknown as TypegraphService;
  const structuredData = {
    lookup: async (...args: unknown[]) => { calls.push({ kind: 'structured', args }); return { query: 'x', hits: [] }; },
    aggregate: async (...args: unknown[]) => { calls.push({ kind: 'analytics', args }); return { operation: 'COUNT', sources: [] }; },
    discoverDatasets: async (...args: unknown[]) => { calls.push({ kind: 'discovery', args }); return []; },
    lookupRows: async (...args: unknown[]) => { calls.push({ kind: 'rows', args }); return { records: [], sources: [] }; },
  } as unknown as StructuredDataService;
  const agent = createSitePilotAgent(typegraph, structuredData, 'tenant-test', 'user-test');
  const tools = await agent.listTools();

  assert.deepEqual(Object.keys(tools).sort(), ['datasetDiscovery', 'documentSearch', 'listDocuments', 'structuredDataAnalytics', 'structuredDataLookup', 'structuredRowLookup']);
  await (tools as any).documentSearch.execute({ query: 'project leader', topK: 8 });
  await (tools as any).listDocuments.execute({});
  await (tools as any).structuredDataLookup.execute({ value: 'CASE-17' });
  await (tools as any).structuredDataAnalytics.execute({ operation: 'GROUP_BY', columnName: 'Violation Type' });
  await (tools as any).datasetDiscovery.execute({});
  await (tools as any).structuredRowLookup.execute({ filters: [{ columnName: 'Region', operator: 'EQ', value: 'West' }], limit: 5 });
  assert.deepEqual(calls.map(call => call.kind), ['search', 'list', 'structured', 'analytics', 'discovery', 'rows']);
  assert.deepEqual(calls[0]!.args, ['project leader', 8, 'tenant-test', 'user-test']);
  assert.deepEqual(calls[1]!.args, ['tenant-test', 'user-test']);
  assert.deepEqual(calls[2]!.args, ['CASE-17', 'tenant-test']);
  assert.deepEqual(calls[3]!.args, ['GROUP_BY', 'Violation Type', 'tenant-test', { documentId: undefined, sheetName: undefined, filters: undefined }]);
  assert.deepEqual(calls[4]!.args, ['tenant-test', undefined]);
  assert.deepEqual(calls[5]!.args, [[{ columnName: 'Region', operator: 'EQ', value: 'West' }], 'tenant-test', { documentId: undefined, sheetName: undefined }, 5]);
});
