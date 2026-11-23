import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvidencePackage } from '../src/agent/evidence.js';

test('evidence packages preserve scoped provenance and keep conversation context unverified', () => {
  const hit = { sourceRef: 'report.pdf page 2', content: 'Revenue was 12.', citation: {
    documentId: 'doc-1', documentVersionId: 'version-1', chunkId: 'chunk-1', chunkIndex: 0, filename: 'report.pdf', pageNumber: 2,
  } };
  const result = createEvidencePackage({ requestId: 'request-1', scope: { tenantId: 'tenant-1', userId: 'user-1' },
    toolResults: [
      { name: 'documentSearch', result: { hits: [hit, hit] } },
      { name: 'dynamic-api', result: { customToolId: 'custom-1', configurationVersion: 4, data: { total: 12 } } },
      { name: 'structuredDataAnalytics', result: { operation: 'SUM', total: 12 } },
    ], history: [{ role: 'assistant', content: 'Earlier value was 12.' }] });

  assert.deepEqual(result.items.map(item => item.type), ['document', 'registered-tool', 'structured', 'conversation-context']);
  assert.equal(result.items[0]?.type === 'document' && result.items[0].citation.pageNumber, 2);
  assert.deepEqual(result.items[1]?.type === 'registered-tool' && [result.items[1].toolId, result.items[1].version, result.items[1].scope.tenantId], ['custom-1', 4, 'tenant-1']);
  assert.equal(result.items[3]?.type === 'conversation-context' && result.items[3].verified, false);
});
