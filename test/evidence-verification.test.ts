import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvidencePackage } from '../src/agent/evidence.js';
import { verifyEvidenceClaims } from '../src/agent/evidence-verification.js';

const scope = { tenantId: 'tenant-a', userId: 'user-a' };
const evidence = createEvidencePackage({ requestId: 'request-a', scope, history: [], toolResults: [
  { name: 'documentSearch', result: { hits: [{ sourceRef: 'report page 2', content: 'The beam is 350 mm wide.', citation: { documentId: 'doc-a', filename: 'report.pdf', chunkIndex: 1 } }] } },
  { name: 'custom-tool', result: { customToolId: 'custom-price', configurationVersion: 3, data: { price: 25.5, currency: 'EUR' } } },
  { name: 'structuredDataAnalytics', input: { operation: 'SUM', columnName: 'Cost' }, result: { operation: 'SUM', total: 60, sources: [{ sourceRef: 'costs rows 1-3', documentId: 'sheet-a', filename: 'costs.xlsx', chunkIndex: 0 }] } },
] });

test('evidence verification separates source types and checks numeric values and scope', () => {
  assert.deepEqual(verifyEvidenceClaims({ answer: 'The beam is 350 mm wide [E1]. Price is 25.5 EUR [T1]. Total is 60 [[costs rows 1-3]].', evidence, ...scope }).reasonCodes, []);
  assert.deepEqual(verifyEvidenceClaims({ answer: 'The beam is 3500 mm wide [E1].', evidence, ...scope }).reasonCodes, ['numeric_value_not_in_source']);
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
