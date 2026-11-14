import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedConversationContext, mergeRetrievalEvidence, retrievalQueries, isEvidenceFollowUp } from '../src/agent/retrieval-policy.js';
import type { DocumentSearchHit } from '../src/typegraph/typegraph.service.js';
import { evidenceReferencesForRequest, extractDecisionSentences } from '../src/agent/conversation-context.js';

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
  const history = [ { role: 'user' as const, content: '\u0645\u062a\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u0645\u0634\u0631\u0648\u0639' }, { role: 'assistant' as const, content: '\u00d6nceki cevap' }, { role: 'user' as const, content: 'Compare them' } ];
  assert.deepEqual(boundedConversationContext(history), history);
  assert.equal(boundedConversationContext(history, 2).length, 2);
  assert.ok(boundedConversationContext(history, 10, 15).reduce((n, h) => n + h.content.length, 0) <= 15);
});

test('English, Arabic, and Turkish follow-ups work with cited or citation-free history', () => {
  const cited = [
    { role: 'user' as const, content: 'Summarize Orion project risks and costs.' },
    { role: 'assistant' as const, content: 'The Orion report lists risks. [[orion.pdf (page 2)]]' },
  ];
  const uncited = [...cited.slice(0, 1), { role: 'assistant' as const, content: 'The report lists risks but no cost figure.' }];
  const messages = [
    'What about its risks?',
    '\u0648\u0645\u0627\u0630\u0627 \u0639\u0646 \u0627\u0644\u0645\u062e\u0627\u0637\u0631\u061f',
    '\u0642\u0627\u0631\u0646 \u0628\u064a\u0646\u0647\u0645\u0627',
    '\u0130kisini kar\u015f\u0131la\u015ft\u0131r',
    'Peki onun riskleri?',
  ];
  for (const history of [cited, uncited]) for (const message of messages) assert.equal(isEvidenceFollowUp(message, history), true, message);
  for (const message of ['Why?', 'Neden?', '\u0644\u0645\u0627\u0630\u0627\u061f']) assert.equal(isEvidenceFollowUp(message, uncited), true, message);
  for (const message of ['Hi', '\u0634\u0643\u0631\u0627\u064b', 'Merhaba', 'Explain quantum physics', 'What about climate policy?', 'Peki iklim politikasini acikla', '\u0627\u0634\u0631\u062d \u0627\u0644\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0645\u0646\u0627\u062e\u064a\u0629']) assert.equal(isEvidenceFollowUp(message, cited), false, message);
  assert.equal(isEvidenceFollowUp('Compare them', []), false);
});

test('persisted entities and selections help resolve reopened followups but unrelated topics do not inherit refs', () => {
  const history = [{ role: 'user' as const, content: 'Show Orion delivery options.' }, { role: 'assistant' as const, content: 'Two options are listed.' }];
  const context = { entities: ['Orion', 'delivery options'], summary: 'Context: orion.pdf', evidenceRefs: [{ filename: 'orion.pdf' }] };
  assert.equal(isEvidenceFollowUp('How do they compare?', history, context), true);
  assert.equal(isEvidenceFollowUp('What about climate policy?', history, context), false);
  assert.deepEqual(evidenceReferencesForRequest('How do they compare?', history, [{ documentId: 'doc-a', filename: 'orion.pdf', sourceRef: 'orion.pdf p2' }], context).map(ref => ref.documentId), ['doc-a']);
  assert.deepEqual(evidenceReferencesForRequest('Explain quantum physics', history, [{ documentId: 'doc-a', filename: 'orion.pdf', sourceRef: 'orion.pdf p2' }], context), []);
});

test('previous references remain bounded hints after a citation-free related answer', () => {
  const history = [
    { role: 'user' as const, content: 'Summarize Orion risks.' },
    { role: 'assistant' as const, content: 'The project has two risks. [[orion.pdf (page 2)]]' },
    { role: 'user' as const, content: 'What about its costs?' },
    { role: 'assistant' as const, content: 'The retrieved passages do not state a cost.' },
  ];
  const refs = [{ documentId: '11111111-1111-4111-8111-111111111111', filename: 'orion.pdf', sourceRef: 'orion.pdf (page 2)' }];
  assert.deepEqual(evidenceReferencesForRequest('Could you compare them?', history, refs), refs);
  assert.deepEqual(evidenceReferencesForRequest('Explain quantum physics', history, refs), []);
});

test('decision extraction recognizes English, Turkish, and Arabic without ASCII word boundaries', () => {
  assert.deepEqual(extractDecisionSentences('We decided to use the Orion format.\nKarar\u0131m\u0131z Orion format\u0131n\u0131 kullanmak.\n\u0642\u0631\u0631\u0646\u0627 \u0627\u0639\u062a\u0645\u0627\u062f \u062a\u0646\u0633\u064a\u0642 \u0623\u0648\u0631\u064a\u0648\u0646.'), [
    'We decided to use the Orion format.',
    'Karar\u0131m\u0131z Orion format\u0131n\u0131 kullanmak.',
    '\u0642\u0631\u0631\u0646\u0627 \u0627\u0639\u062a\u0645\u0627\u062f \u062a\u0646\u0633\u064a\u0642 \u0623\u0648\u0631\u064a\u0648\u0646.',
  ]);
});
