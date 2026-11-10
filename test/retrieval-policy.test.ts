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

test('explicit multilingual evidence follow-ups require prior cited context', async () => {
  const { isEvidenceFollowUp } = await import('../src/agent/retrieval-policy.js');
  const history = [{ role: 'assistant' as const, content: 'Supported finding [[report.md (line 1)]]' }];
  for (const message of ['What about its risks?', 'Compare them', 'وماذا عن المخاطر؟', 'قارن بينهما', 'İkisini karşılaştır', 'Peki onun riskleri?']) assert.equal(isEvidenceFollowUp(message, history), true, message);
  for (const message of ['Hi', 'شكراً', 'Merhaba', 'Explain quantum physics']) assert.equal(isEvidenceFollowUp(message, history), false, message);
  assert.equal(isEvidenceFollowUp('Compare them', []), false);
});

test('real Arabic and Turkish follow-ups retain the cited conversation context', async () => {
  const { isEvidenceFollowUp } = await import('../src/agent/retrieval-policy.js');
  const history = [
    { role: 'user' as const, content: 'Summarize the Orion project risks.' },
    { role: 'assistant' as const, content: 'The project has two risks. [[orion.pdf (page 2)]]' },
  ];
  const arabicFollowUp = '\u0645\u0627\u0630\u0627 \u0639\u0646 \u0627\u0644\u062a\u0643\u0644\u0641\u0629\u061f';
  assert.equal(isEvidenceFollowUp(arabicFollowUp, history), true);
  const afterArabic = [...history, { role: 'user' as const, content: arabicFollowUp }, { role: 'assistant' as const, content: '\u0627\u0644\u062a\u0643\u0644\u0641\u0629 \u0645\u0648\u0636\u062d\u0629 \u0641\u064a \u0627\u0644\u0645\u0633\u062a\u0646\u062f. [[orion.pdf (page 3)]]' }];
  assert.equal(isEvidenceFollowUp('Peki maliyet nedir?', afterArabic), true);
  assert.equal(isEvidenceFollowUp('Bununla ilgili daha fazla ayr\u0131nt\u0131?', afterArabic), true);
});
