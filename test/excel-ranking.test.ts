import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import * as XLSX from 'xlsx';
import { parseDocument } from '../src/documents/parser.js';
import { StructuredDataService } from '../src/documents/structured-data.service.js';

test('ranks five employees from parsed Excel cells using PostgreSQL SQL and active tenant scope', async () => {
  const book = XLSX.utils.book_new();
  const employees = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'];
  const rows = employees.flatMap((id, i) => Array.from({ length: 6 - i }, () => [id, 2025]));
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Employee', 'Year'], ...rows, ...Array.from({ length: 10 }, () => ['E6', 2024])]), 'Violations');
  const parsed = await parseDocument('violations.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.ok(parsed.structuredCells?.length);
  const db = new PGlite();
  const doc = '11111111-1111-4111-8111-111111111111';
  const version = '22222222-2222-4222-8222-222222222222';
  const stale = '33333333-3333-4333-8333-333333333333';
  try {
    await db.exec(`
      CREATE TABLE app_documents (id uuid, tenant_id text, filename text, active_version_id uuid, status text, file_type text);
      CREATE TABLE app_document_cells (document_id uuid, tenant_id text, version_id uuid, sheet_name text, row_number int, column_name text, value text);
    `);
    for (const tenant of ['own', 'other']) {
      await db.query("INSERT INTO app_documents VALUES ($1,$2,'violations.xlsx',$3,'ready','xlsx')", [doc, tenant, version]);
      for (const cell of parsed.structuredCells) {
        const values = [doc, tenant, version, cell.sheetName, cell.rowNumber, cell.columnName, cell.value];
        await db.query('INSERT INTO app_document_cells VALUES ($1,$2,$3,$4,$5,$6,$7)', values);
      }
    }
    await db.query("INSERT INTO app_document_cells SELECT document_id,tenant_id,$1,sheet_name,row_number,column_name,value FROM app_document_cells WHERE tenant_id='own'", [stale]);
    const service = new StructuredDataService({
      appDocument: { findMany: async () => [{ activeVersionId: version }] },
      appDocumentCell: { findMany: async () => [{ columnName: 'Employee' }, { columnName: 'Year' }] },
      $queryRaw: async (query: { text: string; values: unknown[] }) => (await db.query(query.text, query.values)).rows,
    } as never);
    const result = await service.aggregate('GROUP_BY', 'Employee', 'own', {
      documentId: doc, sheetName: 'Violations', groupLimit: 5,
      filters: [{ columnName: 'Year', operator: 'EQ', value: '2025' }],
    });
    assert.ok("groups" in result && result.groups);
    assert.deepEqual(result.groups.map(group => [group.value, group.count]), employees.slice(0, 5).map((id, i) => [id, 6 - i]));
    assert.equal(result.sources.length, 5);
    assert.ok(result.sources.every(source => source.documentVersionId === version && source.sourceRef.includes('Violations')));
  } finally {
    await db.close();
  }
});
