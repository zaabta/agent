import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvidencePackage } from '../src/agent/evidence.js';
import { answerClaimSpans, extractEvidenceClaims, removeRejectedEvidenceClaims, renderCitationMarkersAtClaimEnd, unreferencedFactualSpans, verifyEvidenceClaims } from '../src/agent/evidence-verification.js';

const scope = { tenantId: 'tenant-a', userId: 'user-a' };
const evidence = createEvidencePackage({ requestId: 'request-a', scope, history: [], toolResults: [
  { name: 'documentSearch', result: { hits: [{ sourceRef: 'report page 2', content: 'The beam is 350 mm wide.', citation: { documentId: 'doc-a', filename: 'report.pdf', chunkIndex: 1 } }] } },
  { name: 'custom-tool', result: { customToolId: 'custom-price', configurationVersion: 3, data: { price: 25.5, currency: 'EUR' } } },
  { name: 'structuredDataAnalytics', input: { operation: 'SUM', columnName: 'Cost' }, result: { operation: 'SUM', total: 60, sources: [{ sourceRef: 'costs rows 1-3', documentId: 'sheet-a', filename: 'costs.xlsx', chunkIndex: 0 }] } },
] });

test('evidence verification separates source types and checks numeric values and scope', () => {
  assert.deepEqual(verifyEvidenceClaims({ answer: 'The beam is 350 mm wide [E1]. Price is 25.5 EUR [T1]. Total is 60 [[costs rows 1-3]].', evidence, ...scope }).reasonCodes, []);
  assert.deepEqual(verifyEvidenceClaims({ answer: 'The beam is 3500 mm wide [E1].', evidence, ...scope }).reasonCodes, ['numeric_value_not_in_source']);
  assert.deepEqual(verifyEvidenceClaims({ answer: 'The beam is 3500 mm wide [E1].', evidence, ...scope }).claimFailures, [{ claimId: 0, reasonCodes: ['numeric_value_not_in_source'] }]);
  assert.deepEqual(verifyEvidenceClaims({ answer: 'Price is 25.5 USD [T1].', evidence, ...scope }).reasonCodes, ['unit_not_in_source']);
  assert.deepEqual(verifyEvidenceClaims({ answer: 'The beam is 350 mm wide [E4].', evidence, ...scope }).reasonCodes, ['unknown_evidence_reference']);
  const unrelatedSources = createEvidencePackage({ requestId: 'request-b', scope, history: [], toolResults: [{ name: 'documentSearch', result: { hits: [
    { sourceRef: 'first page 1', content: 'The measured value is 12.', citation: { documentId: 'first', filename: 'first.pdf', chunkIndex: 0 } },
    { sourceRef: 'second page 1', content: 'The measured value is 99.', citation: { documentId: 'second', filename: 'second.pdf', chunkIndex: 0 } },
  ] } }] });
  assert.deepEqual(verifyEvidenceClaims({ answer: 'The measured value is 12 [E2].', evidence: unrelatedSources, ...scope }).reasonCodes, ['numeric_value_not_in_source']);
  const crossTenant = { ...evidence, items: evidence.items.map(item => item.type === 'document' ? { ...item, scope: { tenantId: 'tenant-b' } } : item) };
  assert.deepEqual(verifyEvidenceClaims({ answer: 'The beam is 350 mm wide [E1].', evidence: crossTenant, ...scope }).reasonCodes, ['authorization_scope_mismatch']);
});

test('seeded varied values retain source attribution and reject altered amounts', () => {
  let seed = 0x51a7;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let index = 0; index < 24; index++) {
    const amount = random() % 9000 + 100;
    const unit = ['mm', 'kg', '%', 'USD'][random() % 4]!;
    const source = createEvidencePackage({ requestId: `seeded-${index}`, scope, history: [], toolResults: [{
      name: 'documentSearch', result: { hits: [{ sourceRef: `generated-${index}`, content: `Recorded measurement: ${amount} ${unit}.`, citation: { documentId: `doc-${index}`, filename: 'generated.pdf', chunkIndex: 0 } }] },
    }] });
    assert.deepEqual(verifyEvidenceClaims({ answer: `Recorded measurement: ${amount} ${unit} [E1].`, evidence: source, ...scope }).reasonCodes, []);
    assert.ok(verifyEvidenceClaims({ answer: `Recorded measurement: ${amount + 1} ${unit} [E1].`, evidence: source, ...scope }).reasonCodes.includes('numeric_value_not_in_source'));
  }
  assert.equal(seed, 0x5984cbd7);
});

test('claim spans distinguish structural headings and list introductions across English, Turkish, and Arabic', () => {
  const cases = [
    { language: 'English', answer: '# Foundation types\nThe listed types are:\n\n- Type Alpha [E1]\n- Type Beta [E1]\n\nThese are shown in the drawing.' },
    { language: 'Turkish', answer: '## Temel türleri\nÇizimde geçen türler şunlardır:\n\n- Tür Alfa [E1]\n- Tür Beta [E1]\n\nBu türler çizimde gösterilmiştir.' },
    { language: 'Arabic', answer: '## أنواع الأساسات\nالأنواع الواردة في الرسم هي:\n\n• النوع ألف [E1]\n• النوع باء [E1]\n\nهذه الأنواع موضحة في الرسم.' },
  ];
  for (const { language, answer } of cases) {
    const claims = extractEvidenceClaims(answer);
    const missing = unreferencedFactualSpans(answer);
    assert.equal(claims.length, 2, `${language}: each cited list item is its own claim`);
    assert.equal(missing.length, 1, `${language}: only the uncited conclusion is factual and missing a citation`);
    assert.match(missing[0]!.text, /drawing|çizimde|الرسم/u);
    assert.equal(answerClaimSpans(answer).some(span => span.kind === 'paragraph' && span.text.endsWith(':')), false, `${language}: structural list introduction is excluded`);
  }
});

test('claim spans check each table row and citation-bearing conclusions independently', () => {
  const table = '| Item | Value | Citation |\n| --- | --- | --- |\n| Width | 350 mm | [E1] |\n| Height | 200 mm | |\n\n## Conclusion\nThe width is documented [E1].';
  const missing = unreferencedFactualSpans(table);
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.kind, 'table-row');
  assert.match(missing[0]!.text, /Height/);
  const claims = extractEvidenceClaims(table);
  assert.equal(claims.length, 2, 'the cited row and conclusion remain separate claims');
});

test('engineering measurements are checked against the cited document row, not a neighboring footing row', () => {
  const tableEvidence = createEvidencePackage({ requestId: 'footing-rows', scope, history: [], toolResults: [{ name: 'documentSearch', result: { hits: [
    { sourceRef: 'foundation.pdf (page 4, table 2, row F1)', content: 'Table 2 | Footing | Size | Depth\nF1 | 2800 x 2800 mm | 550 mm', citation: { documentId: 'foundation', filename: 'foundation.pdf', chunkIndex: 4, pageNumber: 4 } },
    { sourceRef: 'foundation.pdf (page 4, table 2, row F2)', content: 'Table 2 | Footing | Size | Depth\nF2 | 2500 x 3200 mm | 750 mm', citation: { documentId: 'foundation', filename: 'foundation.pdf', chunkIndex: 5, pageNumber: 4 } },
  ] } }] });
  assert.deepEqual(verifyEvidenceClaims({ answer: '| F1 | 2800 x 2800 mm | 550 mm | [E1] |\n| F2 | 2500 x 3200 mm | 750 mm | [E2] |', evidence: tableEvidence, ...scope }).reasonCodes, []);
  const mismatch = verifyEvidenceClaims({ answer: '| F1 | 2800 x 2800 mm | 750 mm | [E1] |', evidence: tableEvidence, ...scope });
  assert.ok(mismatch.reasonCodes.includes('numeric_value_not_in_source'));
  assert.deepEqual(mismatch.claimFailures.map(failure => failure.claimId), [0]);
});

test('alphanumeric footing IDs and concrete grades are not mistaken for measurement values', () => {
  const source = createEvidencePackage({ requestId: 'footing-identifiers', scope, history: [], toolResults: [{ name: 'documentSearch', result: { hits: [
    { sourceRef: 'foundation.pdf (page 4, table 2)', content: 'Table 2 | Footing | Size | Depth | Grade\nF1 | 2800 x 2800 mm | 550 mm | M25', citation: { documentId: 'foundation', filename: 'foundation.pdf', chunkIndex: 4, pageNumber: 4 } },
  ] } }] });
  const check = verifyEvidenceClaims({ answer: '| F1 | 2800 x 2800 mm | 550 mm | M25 | [E1] |', evidence: source, ...scope });
  assert.deepEqual(check.reasonCodes, []);
});

test('sentence spans preserve exact offsets so mixed paragraphs can repair supported and unsupported claims separately', () => {
  const answer = 'The plan records 17 items. [E1] The unrelated note cannot be verified.';
  const spans = answerClaimSpans(answer);
  assert.equal(spans.length, 2);
  assert.equal(spans[0]!.evidenceIds[0], 'E1', 'a citation after sentence punctuation remains attached to that sentence');
  assert.equal(spans[1]!.evidenceIds.length, 0);
  for (const span of spans) assert.equal(answer.slice(span.startOffset, span.endOffset), span.text);
});

test('revision citations stay outside identifiers, dates, decimals, and complete claims', () => {
  const revisionEvidence = createEvidencePackage({ requestId: 'revision-claim-boundaries', scope, history: [], toolResults: [{ name: 'documentSearch', result: { hits: [
    { sourceRef: 'revisions.pdf (row 1)', content: 'Rev. 1 — 17-09-09 — For Execution.', citation: { documentId: 'revisions', filename: 'revisions.pdf', chunkIndex: 0, pageNumber: 1 } },
    { sourceRef: 'revisions.pdf (row 2)', content: 'Rev. 2 — 20-09-09 — C10 and C11 dimensions revised.', citation: { documentId: 'revisions', filename: 'revisions.pdf', chunkIndex: 1, pageNumber: 1 } },
    { sourceRef: 'revisions.pdf (row 2, dimensions)', content: 'C10: 1.25 x 0.75 m. C11: 0.80 x 0.60 m.', citation: { documentId: 'revisions', filename: 'revisions.pdf', chunkIndex: 2, pageNumber: 1 } },
  ] } }] });
  const corrupted = 'Rev. [E1] 1 — 17-09-09 — For Execution. Rev. [E2] [E3] 2 — 20-09-09 — C10 [E3]/C11 dimensions revised to 1.25 x 0.75 m and 0.80 x 0.60 m.';
  const claims = extractEvidenceClaims(corrupted);
  assert.equal(claims.length, 2, 'Rev. is an abbreviation, not a sentence boundary even with a citation after it');
  assert.equal(claims[0]!.text, 'Rev. 1 — 17-09-09 — For Execution.');
  assert.deepEqual(claims[0]!.evidenceIds, ['E1']);
  assert.equal(claims[1]!.text, 'Rev. 2 — 20-09-09 — C10/C11 dimensions revised to 1.25 x 0.75 m and 0.80 x 0.60 m.');
  assert.deepEqual(claims[1]!.evidenceIds, ['E2', 'E3']);
  assert.deepEqual(verifyEvidenceClaims({ answer: corrupted, evidence: revisionEvidence, ...scope }).reasonCodes, []);

  const rendered = renderCitationMarkersAtClaimEnd(corrupted);
  assert.equal(rendered, 'Rev. 1 — 17-09-09 — For Execution. [E1] Rev. 2 — 20-09-09 — C10/C11 dimensions revised to 1.25 x 0.75 m and 0.80 x 0.60 m. [E2] [E3]');
  assert.deepEqual(verifyEvidenceClaims({ answer: rendered, evidence: revisionEvidence, ...scope }).reasonCodes, []);
});

test('citation rendering moves identifiers and multiple references to the end of multilingual claims and table rows', () => {
  const examples = [
    { answer: 'Rev. [E1] 1 — 17-09-09 — For Execution.', expected: 'Rev. 1 — 17-09-09 — For Execution. [E1]' },
    { answer: 'Rev. [E1] 2 — 20-09-09 — dimensions changed.', expected: 'Rev. 2 — 20-09-09 — dimensions changed. [E1]' },
    { answer: 'C10 [E1]/C11 ölçüleri 1.25 x 0.75 m [E2].', expected: 'C10/C11 ölçüleri 1.25 x 0.75 m. [E1] [E2]' },
    { answer: 'تُظهر المراجعة [E1] 2 أبعاد C10/C11 وهي 1.25 م [E2].', expected: 'تُظهر المراجعة 2 أبعاد C10/C11 وهي 1.25 م. [E1] [E2]' },
    { answer: '| F1 [E1] | 2800 x 2800 mm | [E2] |', expected: '| F1 | 2800 x 2800 mm | [E1] [E2] |' },
    { answer: '| Footing | Size |\n| --- | --- |\n| F1 [E1] | 2800 x 2800 mm |\n| F2 [E2] | 2500 x 3200 mm |', expected: '| Footing | Size |\n| --- | --- |\n| F1 | 2800 x 2800 mm [E1] |\n| F2 | 2500 x 3200 mm [E2] |' },
  ];
  for (const { answer, expected } of examples) {
    const rendered = renderCitationMarkersAtClaimEnd(answer);
    assert.equal(rendered, expected);
    assert.doesNotMatch(rendered, /(?:Rev\.|F1|F2|C10) \[(?:E|T|S)\d+\]/);
  }
});

test('claim-level repair removes only a rejected table row or sentence and retains supported content', () => {
  const prose = 'The listed value is 17 [E1]. The unrelated amount is 99 [E2].';
  assert.equal(removeRejectedEvidenceClaims(prose, [1]), 'The listed value is 17 [E1].');
  const table = '| Item | Value | Citation |\n| --- | --- | --- |\n| F1 | 2800 | [E1] |\n| F2 | 99 | [E2] |';
  assert.equal(removeRejectedEvidenceClaims(table, [1]), '| Item | Value | Citation |\n| --- | --- | --- |\n| F1 | 2800 | [E1] |');
});
