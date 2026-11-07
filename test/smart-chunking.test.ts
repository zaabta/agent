import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens, smartChunk } from '../src/documents/smart-chunker.js';

const identity = { documentId: 'doc-a', documentVersionId: 'ver-a' };

test('markdown chunks keep heading hierarchy and fenced code intact when it fits', () => {
  const text = '# Guide\n\nIntro paragraph.\n\n## Install\n\nRun this:\n```ts\nconst site = "SitePilot";\n```';
  const chunks = smartChunk(text, 'md', identity);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[1]?.headingPath, ['Guide', 'Install']);
  assert.match(chunks[1]!.content, /```ts[\s\S]*```/);
});

test('DOCX headings retain nesting and table rows stay in their section', () => {
  const chunks = smartChunk('Heading 1: Policy\n\nIntro.\n\nHeading 2: Fees\n\nTable row: Plan | Price\nTable row: Enterprise | 42 credits', 'docx', identity);
  assert.ok(chunks.some(chunk => chunk.headingPath?.join('/') === 'Policy/Fees' && chunk.content.includes('Enterprise | 42 credits')));
  assert.ok(chunks.some(chunk => chunk.headingPath?.join('/') === 'Policy/Fees' && chunk.paragraphStart !== undefined && chunk.paragraphEnd !== undefined));
});

test('PDF chunks retain the originating page', () => {
  const chunks = smartChunk('Page 2:\nFirst page paragraph.\n\nPage 8:\nSecond page paragraph.', 'pdf', identity);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map(chunk => chunk.pageNumber), [2, 8]);
});

test('CSV chunks retain headers, sheet, row span, cell references, and exact identifiers', () => {
  const chunks = smartChunk('CSV headers: Account | Form number\nRow 2: A1=00125 | B1=F-0042\nRow 3: A2=00126 | B2=F-0043', 'csv', identity);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.content, /00125/);
  assert.match(chunks[0]!.content, /F-0043/);
  assert.equal(chunks[0]!.sheetName, 'CSV');
  assert.equal(chunks[0]!.rowStart, 2);
  assert.equal(chunks[0]!.rowEnd, 3);
  assert.equal(chunks[0]!.cellRange, 'A1:B2');
  assert.deepEqual(chunks.map(chunk => chunk.id), smartChunk('CSV headers: Account | Form number\nRow 2: A1=00125 | B1=F-0042\nRow 3: A2=00126 | B2=F-0043', 'csv', identity).map(chunk => chunk.id));
});

test('very long multilingual rows are bounded and carry row provenance', () => {
  const row = `Row 42: A42=${'معرّف Türkçe ıİşğ '.repeat(500)}`;
  const chunks = smartChunk(row, 'xlsx', identity);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => estimateTokens(chunk.content) <= 480));
  assert.ok(chunks.every(chunk => chunk.rowStart === 42 && chunk.rowEnd === 42));
  assert.equal(chunks[0]!.id, smartChunk(row, 'xlsx', identity)[0]!.id);
});

test('structured table cells are grouped into bounded row chunks with headers and stable cell addresses', () => {
  const cells = Array.from({ length: 200 }, (_, index) => {
    const rowNumber = index + 2;
    return [
      { sheetName: 'CSV', rowNumber, address: `${rowNumber}:1`, columnName: 'Account ID', value: String(10000 + index) },
      { sheetName: 'CSV', rowNumber, address: `${rowNumber}:2`, columnName: 'Form Number', value: `F-${String(index).padStart(4, '0')}` },
    ];
  }).flat();
  const chunks = smartChunk('', 'csv', identity, cells);
  assert.ok(chunks.length > 1 && chunks.length < 200);
  assert.ok(chunks.every(chunk => estimateTokens(chunk.content) <= 480));
  assert.ok(chunks.every(chunk => chunk.sheetName === 'CSV' && chunk.rowStart !== undefined && chunk.rowEnd !== undefined && chunk.cellRange));
  assert.ok(chunks.some(chunk => chunk.content.includes('Account ID')));
  assert.ok(chunks.some(chunk => chunk.content.includes('F-0199')));
});

test('XLSX chunks keep workbook, sheet, header, and exact cell address metadata', () => {
  const cells = [
    { sheetName: 'Forecast', rowNumber: 1, address: 'A1', columnName: 'Account ID', value: 'Account ID' },
    { sheetName: 'Forecast', rowNumber: 1, address: 'B1', columnName: 'Total', value: 'Total' },
    { sheetName: 'Forecast', rowNumber: 2, address: 'A2', columnName: 'Account ID', value: '000042' },
    { sheetName: 'Forecast', rowNumber: 2, address: 'B2', columnName: 'Total', value: '125.00' },
    { sheetName: 'Forecast', rowNumber: 3, address: 'A3', columnName: 'Account ID', value: '000043' },
    { sheetName: 'Forecast', rowNumber: 3, address: 'B3', columnName: 'Total', value: '135.00' },
  ];
  const chunks = smartChunk('', 'xlsx', { ...identity, originalFilename: 'forecast.xlsx' }, cells);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.content, /Workbook: forecast.xlsx/);
  assert.match(chunks[0]!.content, /Sheet: Forecast/);
  assert.match(chunks[0]!.content, /Account ID/);
  assert.match(chunks[0]!.content, /000042/);
  assert.equal(chunks[0]!.rowStart, 2);
  assert.equal(chunks[0]!.rowEnd, 3);
  assert.equal(chunks[0]!.cellRange, 'A2:B3');
});
