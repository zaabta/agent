import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StructuredDataService } from '../src/documents/structured-data.service.js';

test('exact-value recovery searches tenant-authorized rows across actual columns', async () => {
  const queries: any[] = [];
  const prisma = {
    appDocumentCell: {
      findMany: async (args: any) => {
        queries.push(args);
        if (args.include?.document) return [{
          documentId: 'dd302dc5-f964-4ef7-844a-5a7c17ff1969', sheetName: 'CSV', rowNumber: 2,
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
});

test('filtered CSV lookup includes its first stored row because CSV headers are metadata', async () => {
  let query: any;
  const prisma = {
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
      return [{ documentId: 'dd302dc5-f964-4ef7-844a-5a7c17ff1969', filename: 'lookup.csv', sheetName: 'CSV', rowNumber: 2 }];
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
});
