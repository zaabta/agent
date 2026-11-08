import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedConversationContext, mergeRetrievalEvidence, retrievalQueries } from '../src/agent/retrieval-policy.js';
import type { DocumentSearchHit } from '../src/typegraph/typegraph.service.js';
const hit = (documentId: string, index: number, version = 'v1'): DocumentSearchHit => ({ content: 'known evidence', score: 0.4, sourceRef: `${documentId}:${version}:${index}`, metadata: {}, citation: { documentId, documentVersionId: version, filename: `${documentId}.md`, chunkIndex: index, chunkCount: 10, bucketId: 'documents' } });

test('evidence fusion preserves versions and exact citations, deduplicates chunks and covers documents', () => {
  const dominant = Array.from({ length: 5 }, (_, i) => hit('requirements', i));
  const costs = hit('costs', 0), risks = hit('risks', 0);
  const merged = mergeRetrievalEvidence([dominant, [dominant[0]!, costs], [risks]], 4);
  assert.deepEqual(new Set(merged.map(h => h.citation.documentId)), new Set(['requirements', 'costs', 'risks']));
  assert.equal(merged.filter(h => h.sourceRef === dominant[0]!.sourceRef).length, 1);
  assert.equal(merged.find(h => h.citation.documentId === 'costs'), costs);
  assert.equal(mergeRetrievalEvidence([[hit('same', 0), hit('same', 0, 'v2')]]).length, 2);
  assert.deepEqual(mergeRetrievalEvidence([[costs]], 8, 1), []);
});

test('simple queries use one retrieval and complex queries are deduplicated and bounded', () => {
  assert.deepEqual(retrievalQueries('simple', ['single']), ['simple']);
  assert.deepEqual(retrievalQueries('complex', [' A ', 'a', 'B', 'C', 'D', 'E']), ['A', 'B', 'C', 'D']);
});

test('multilingual conversation context stays within total and per-message budgets', () => {
  const history = [ { role: 'user' as const, content: 'متطلبات المشروع' }, { role: 'assistant' as const, content: 'Önceki cevap' }, { role: 'user' as const, content: 'Compare them' } ];
  assert.deepEqual(boundedConversationContext(history), history);
  assert.equal(boundedConversationContext(history, 2).length, 2);
  assert.ok(boundedConversationContext(history, 10, 15).reduce((n, h) => n + h.content.length, 0) <= 15);
});
