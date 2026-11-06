import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizedDocumentSearchFallback,
  deterministicAnalyticsAnswer,
  deterministicDatasetSchemaAnswer,
  hasStructuredToolFailure,
  hasStructuredQueryResult,
  needsWorkspaceRecovery,
  withRetrievedEvidence,
} from '../src/agent/agent.service.js';
import type { DocumentSearchHit, TypegraphService } from '../src/typegraph/typegraph.service.js';
import type { AuthPrincipal } from '../src/auth/auth.types.js';

const principal = { userId: 'user-a', tenantId: 'tenant-a', role: 'MEMBER' } as AuthPrincipal;

test('fallback eligibility depends on missing evidence, regardless of wording', () => {
  for (const question of ['unseen English wording', 'Türkçe yeni bir soru', 'سؤال عربي جديد']) assert.equal(needsWorkspaceRecovery([]), true, question);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'document-search', result: { hits: [] } } }]), true);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'document-search', result: { hits: [{ sourceRef: 'source-a' }] } } }]), false);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'structured-data-lookup', result: { hits: [{ sourceRef: 'sheet row 4' }] } } }]), false);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'dataset-discovery', result: { datasets: [{ documentId: 'd1' }] } } }]), false);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'dataset-discovery', result: { datasets: [] } } }]), false);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'structured-data-analytics', result: { operation: 'COUNT', total: 0, datasets: [], sources: [] } } }]), false);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'structured-row-lookup', result: { records: [], sources: [] } } }]), false);
  assert.equal(needsWorkspaceRecovery([{ payload: { toolName: 'list-documents', result: { documents: [], durationMs: 1 } } }]), true);
  assert.equal(hasStructuredQueryResult([{ payload: { toolName: 'structured-data-analytics', result: { operation: 'COUNT', total: 0, datasets: [], sources: [] } } }]), true);
  assert.equal(hasStructuredQueryResult([{ payload: { toolName: 'structured-data-analytics', result: { error: true, message: 'invalid argument' } } }]), false);
  assert.equal(hasStructuredToolFailure([{ payload: { toolName: 'structured-row-lookup', result: { error: true, message: 'invalid input' } } }]), true);
  assert.equal(hasStructuredToolFailure([{ payload: { toolName: 'structured-data-analytics', result: { operation: 'COUNT', total: 0, datasets: [], sources: [] } } }]), false);
});

test('structured analytics answers preserve database values and exact provenance deterministically', () => {
  const answer = deterministicAnalyticsAnswer([{ payload: { result: {
    operation: 'GROUP_BY', columnName: 'FORM TÜRÜ',
    groups: [{ value: 'Onay', count: 4 }, { value: 'Red', count: 2 }],
    sources: [{ documentId: '12345678-aaaa-bbbb-cccc-dddddddddddd', filename: 'records.xlsx', sourceRef: 'records.xlsx [12345678] (Sheet1, rows 2-7)', chunkIndex: 0 }],
  } } }]);
  assert.equal(answer, 'Groups for FORM TÜRÜ:\nOnay: 4\nRed: 2\nSources: [[records.xlsx [12345678] (Sheet1, rows 2-7)]]');
  assert.equal(deterministicAnalyticsAnswer([{ payload: { result: { operation: 'COUNT', total: 0, datasets: [], sources: [] } } }]), 'Record count: 0 (the authorized query completed with no matching records)');
  assert.equal(deterministicDatasetSchemaAnswer([{ payload: { toolName: 'dataset-discovery', result: { datasets: [{ filename: 'records.xlsx', sheets: [{ sheetName: 'Sheet1', columns: ['FORM TÜRÜ'] }] }] } } }]), 'records.xlsx:\n- Sheet1: FORM TÜRÜ\n\nSchema discovery completed. No row-level analytics or exact-record lookup was executed.');
});

test('fallback search keeps authenticated tenant/user scope and supplies retrieved chunk text to the grounded prompt', async () => {
  const hit: DocumentSearchHit = {
    content: 'Project leader: Deniz Kaya.', score: 1, sourceRef: 'project-brief.md (section Leadership)',
    citation: { documentId: 'doc-a', filename: 'project-brief.md', bucketId: 'documents', chunkIndex: 0, chunkCount: 1 }, metadata: {},
  };
  let call: unknown[] = [];
  const service = {
    searchDocuments: async (...args: unknown[]) => { call = args; return { query: args[0], hits: [hit], timing: { embeddingMs: 1, retrievalMs: 2, searchMs: 3 } }; },
  } as unknown as TypegraphService;
  const result = await authorizedDocumentSearchFallback(service, 'Who is the project leader?', principal);
  assert.deepEqual(call, ['Who is the project leader?', 8, 'tenant-a', 'user-a', undefined]);
  assert.equal(result.hits[0]!.content, hit.content);
  const prompt = withRetrievedEvidence([{ role: 'user', content: 'Who is the project leader?' }], 'Who is the project leader?', result.hits);
  assert.match(prompt[0]!.content, /Project leader: Deniz Kaya\./);
  assert.match(prompt[0]!.content, /\[\[project-brief\.md \(section Leadership\)\]\]/);

  await authorizedDocumentSearchFallback(service, 'Summarize the documents in my workspace', principal);
  assert.equal(call[0], 'Summarize the documents in my workspace');
});
