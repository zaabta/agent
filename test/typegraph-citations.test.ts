import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TypegraphService } from '../src/typegraph/typegraph.service.js';

test('TypeGraph citations preserve verified file locations and omit unavailable page numbers', () => {
  const service = Object.create(TypegraphService.prototype) as any;
  const excel = service.toSearchHit({
    content: 'Sheet: Costs\nRow 4: A4=Hardware | B4=42',
    score: 0.9,
    document: { id: 'doc-1::version-1::g1::chunk-1', name: 'costs.xlsx', bucketId: 'documents' },
    chunk: { index: 0, total: 1 },
    metadata: {
      documentId: 'doc-1',
      documentVersionId: 'version-1',
      chunkId: 'chunk-1',
      chunkIndex: 0,
      sheetName: 'Costs',
      rowStart: 4,
      rowEnd: 4,
      cellRange: 'A4:B4',
    },
  });
  assert.equal(excel.citation.sheetName, 'Costs');
  assert.equal(excel.citation.rowStart, 4);
  assert.equal(excel.citation.rowEnd, 4);
  assert.equal(excel.citation.cellRange, 'A4:B4');
  assert.equal(excel.sourceRef, 'costs.xlsx (sheet Costs, row 4, cells A4:B4)');

  const text = service.toSearchHit({
    content: 'A plain paragraph.',
    score: 0.8,
    document: { id: 'doc-2::version-2::g1::chunk-1', name: 'notes.txt', bucketId: 'documents' },
    chunk: { index: 0, total: 1 },
    metadata: { documentId: 'doc-2', documentVersionId: 'version-2', chunkIndex: 0 },
  });
  assert.equal(text.citation.pageNumber, undefined);
  assert.equal(text.citation.location, undefined);
  assert.equal(text.sourceRef, 'notes.txt (chunk 1)');
});
