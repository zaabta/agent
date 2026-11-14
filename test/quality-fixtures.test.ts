import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualityDocuments } from './fixtures/quality-documents.js';
import { parseDocument } from '../src/documents/parser.js';

test('six-format quality corpus parses the known project facts and structured cells', async () => {
  const facts = ['safety review', '120000', 'supplier delay', '2027-03-15', 'Pump', 'KKD'];
  const docs = await qualityDocuments();
  for (const [i, document] of docs.entries()) {
    const parsed = await parseDocument(document.filename, document.buffer);
    assert.ok(parsed.text.includes(facts[i]!), document.filename);
    if (/xlsx|csv/.test(document.filename)) assert.ok(parsed.structuredCells?.length);
  }
});
