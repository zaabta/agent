import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StructuredDataService } from '../src/documents/structured-data.service.js';

test('exact-value recovery searches tenant-authorized rows across actual columns', async () => {
  const queries: any[] = [];
  const prisma = {
    appDocument: { findMany: async () => [{ activeVersionId: '88000000-0000-4000-8000-000000000001' }] },
    appDocumentCell: {
      findMany: async (args: any) => {
        queries.push(args);
        if (args.include?.document) return [{
          documentId: 'dd302dc5-f964-4ef7-844a-5a7c17ff1969', versionId: '88000000-0000-4000-8000-000000000001', sheetName: 'CSV', rowNumber: 2,
          address: '2:2', columnName: 'Reference Code', value: 'SP-CELL-931',
          document: { id: 'dd302dc5-f964-4ef7-844a-5a7c17ff1969', filename: 'lookup.csv' },
        }];
        return [
          { address: '2:1', columnName: 'Plan', value: 'Enterprise', formula: null },
          { address: '2:2', columnName: 'Reference Code', value: 'SP-CELL-931', formula: null },
          { address: '2:3', columnName: 'Price', value: '93 credits', formula: null },
        ];
      },
    },
  } as any;
  const result = await new StructuredDataService(prisma).lookupAnyExact(['SP-CELL-931'], 'tenant-a');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.metadata.matchedColumn, 'Reference Code');
  assert.equal(result.hits[0]?.sourceRef, 'lookup.csv (CSV row 2)');
  assert.equal(queries[0]?.where.tenantId, 'tenant-a');
  assert.equal(queries[0]?.where.document.status, 'ready');
  assert.equal(queries[0]?.where.OR[0]?.value.equals, 'SP-CELL-931');
  assert.deepEqual(queries[0]?.where.versionId.in, ['88000000-0000-4000-8000-000000000001']);
  assert.equal(queries[1]?.where.versionId, '88000000-0000-4000-8000-000000000001');
});

test('filtered CSV lookup includes its first stored row because CSV headers are metadata', async () => {
  let query: any;
  const prisma = {
    appDocument: { findMany: async () => [{ activeVersionId: '88000000-0000-4000-8000-000000000001' }] },
    appDocumentCell: {
      findMany: async (args: any) => {
        if (args.distinct) return [{ columnName: 'Plan' }];
        return [
          { address: '2:1', columnName: 'Plan', value: 'Enterprise' },
          { address: '2:2', columnName: 'Reference Code', value: 'SP-CELL-931' },
          { address: '2:3', columnName: 'Price', value: '93 credits' },
        ];
      },
    },
    $queryRaw: async (sql: any) => {
      query = sql;
      return [{ documentId: 'dd302dc5-f964-4ef7-844a-5a7c17ff1969', versionId: '88000000-0000-4000-8000-000000000001', filename: 'lookup.csv', sheetName: 'CSV', rowNumber: 2 }];
    },
  } as any;
  const result = await new StructuredDataService(prisma).lookupRows(
    [{ columnName: 'Plan', operator: 'EQ', value: 'Enterprise' }],
    'tenant-a',
    { documentId: 'dd302dc5-f964-4ef7-844a-5a7c17ff1969', sheetName: 'CSV' },
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.rowNumber, 2);
  assert.match(query.sql, /d\.file_type = 'csv' OR c\.row_number >/);
  assert.match(query.sql, /c\.version_id = d\.active_version_id/);
  assert.match(query.sql, /h\.version_id = c\.version_id/);
  assert.equal((result.records[0] as any)?.source.documentVersionId, '88000000-0000-4000-8000-000000000001');
});

test('structured COUNT and SUM analytics scope data and provenance to active document versions', async () => {
  const queries: any[] = [];
  const prisma: any = {
    appDocument: { findMany: async () => [{ activeVersionId: '88000000-0000-4000-8000-000000000001' }] },
    appDocumentCell: { findMany: async () => [{ columnName: 'Amount' }] },
    $queryRaw: async (query: any) => {
      queries.push(query);
      if (/COUNT\(\*\).*AS count/s.test(query.sql)) return [{ documentId: 'dd302dc5-f964-4ef7-844a-5a7c17ff1969', versionId: '88000000-0000-4000-8000-000000000001', filename: 'active.csv', sheetName: 'Sheet1', count: 1, firstRow: 2, lastRow: 2 }];
      if (/AS "numericCount"/s.test(query.sql)) return [{ value: '2400', numericCount: 1, nonnumericCount: 0 }];
      if (/AS "rowNumbers"/s.test(query.sql)) return [{ documentId: 'dd302dc5-f964-4ef7-844a-5a7c17ff1969', versionId: '88000000-0000-4000-8000-000000000001', filename: 'active.csv', sheetName: 'Sheet1', rowNumbers: [2] }];
      return [];
    },
  };
  const service = new StructuredDataService(prisma);
  const counted = await service.countRecords('tenant-a');
  const summed = await service.aggregate('SUM', 'Amount', 'tenant-a');
  assert.equal(counted.sources[0]?.documentVersionId, '88000000-0000-4000-8000-000000000001');
  assert.equal(summed.sources[0]?.documentVersionId, '88000000-0000-4000-8000-000000000001');
  assert.ok(queries.every(query => /c\.version_id = d\.active_version_id/.test(query.sql)));
  assert.match(queries[0].sql, /h\.version_id = c\.version_id/);
});
