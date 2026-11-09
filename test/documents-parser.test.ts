import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { extractableTextCoverage, parseDocument } from '../src/documents/parser.js';

async function docxFixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Service Terms</w:t></w:r></w:p><w:p><w:r><w:t>Enterprise costs 42 credits.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Enterprise</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>73 credits</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function pdfPagesFixture(texts: string[]) {
  const pageIds = texts.map((_text, index) => 4 + index * 2);
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${texts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  texts.forEach((text, index) => {
    const pageId = pageIds[index]!;
    const contentId = pageId + 1;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    bodies.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function pdfFixture(text: string) { return pdfPagesFixture([text]); }

test('parses Markdown and UTF-8 BOM TXT while retaining line references', async () => {
  const md = await parseDocument('terms.md', Buffer.from('# Price\nEnterprise costs 42 credits.'));
  assert.match(md.text, /Line 2: Enterprise costs 42 credits/);
  const txt = await parseDocument('hello.txt', Buffer.from('\uFEFFArabic مرحبا\nsecond line'));
  assert.match(txt.text, /Line 1: Arabic مرحبا/);
});

test('parses DOCX paragraphs and headings from an OOXML package', async () => {
  const result = await parseDocument('terms.docx', await docxFixture());
  assert.match(result.text, /Service Terms/);
  assert.match(result.text, /Enterprise costs 42 credits/);
  assert.match(result.text, /Table row: Enterprise \| 73 credits/);
});

test('extracts text PDFs normally and sends scanned pages to local vision instead of OCR_REQUIRED', async t => {
  const result = await parseDocument('terms.pdf', pdfFixture('Enterprise price is 42 credits. '.repeat(40)));
  assert.match(result.text, /Page 1:/);
  assert.match(result.text, /Enterprise price is 42 credits/);
  const scanned = pdfFixture('');
  const previousModel = process.env.OLLAMA_VISION_MODEL;
  process.env.OLLAMA_VISION_MODEL = 'fixture-vision';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: URL, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'fixture-vision');
    assert.ok(body.messages[0].images[0]);
    return Response.json({ message: { content: JSON.stringify({ text: 'Scanned resume text' }) } });
  });
  try {
    const parsed = await parseDocument('scan.pdf', scanned);
    assert.match(parsed.text, /Page 1:\nScanned resume text/);
    assert.equal(calls, 1);
  } finally {
    if (previousModel === undefined) delete process.env.OLLAMA_VISION_MODEL;
    else process.env.OLLAMA_VISION_MODEL = previousModel;
  }
});

test('mixed PDFs preserve searchable pages and OCR only sparse pages with original page numbers', async t => {
  const previousModel = process.env.OLLAMA_VISION_MODEL;
  process.env.OLLAMA_VISION_MODEL = 'fixture-vision';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ message: { content: JSON.stringify({ text: 'OCR content from page two' }) } });
  });
  try {
    const nativeText = 'Searchable page one says native text. '.repeat(40);
    const parsed = await parseDocument('mixed.pdf', pdfPagesFixture([nativeText, '']));
    assert.match(parsed.text, /Page 1:\nSearchable page one says native text\./);
    assert.match(parsed.text, /Page 2:\nOCR content from page two/);
    assert.equal(calls, 1);
  } finally {
    if (previousModel === undefined) delete process.env.OLLAMA_VISION_MODEL;
    else process.env.OLLAMA_VISION_MODEL = previousModel;
  }
});

test('PDF text coverage identifies image-only pages and gives searchable pages a full score', () => {
  assert.equal(extractableTextCoverage('', 595, 842), 0);
  assert.ok(extractableTextCoverage('x'.repeat(1000), 595, 842) > 0.9);
  assert.ok(extractableTextCoverage('x'.repeat(20), 595, 842) < 0.16);
});

test('scanned PDF without a local vision model fails once with an actionable configuration code', async () => {
  const previousModel = process.env.OLLAMA_VISION_MODEL;
  delete process.env.OLLAMA_VISION_MODEL;
  try {
    await assert.rejects(() => parseDocument('scan.pdf', pdfFixture('')), /OCR_VISION_NOT_CONFIGURED/);
  } finally {
    if (previousModel !== undefined) process.env.OLLAMA_VISION_MODEL = previousModel;
  }
});

test('preserves workbook and sheet names, row/cell addresses, formulas, and displayed identifiers', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Account ID', 'Total'], [123, 42], [null, null]]);
  (sheet.A2 as XLSX.CellObject).z = '00000';
  (sheet.B2 as XLSX.CellObject).f = '20+22';
  (sheet.B2 as XLSX.CellObject).v = 42;
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  XLSX.utils.book_append_sheet(workbook, sheet, 'Enterprise Plans');
  for (const extension of ['xlsx', 'xls'] as const) {
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: extension === 'xlsx' ? 'xlsx' : 'biff8' }) as Buffer;
    const result = await parseDocument(`plans.${extension}`, buffer);
    assert.match(result.text, /Sheet: Enterprise Plans/);
    assert.match(result.text, /A2=00123/);
    if (extension === 'xlsx') assert.match(result.text, /B2=formula=20\+22; cached=42/);
    else assert.match(result.text, /B2=42/);
    assert.match(result.text, /Merged cells: A1:B1/);
    assert.ok(result.structuredCells?.some(cell => cell.value === '00123' && cell.columnName === 'Account ID'));
  }
});

test('parses quoted multiline CSV, BOM, delimiters, headers, and source row numbers', async () => {
  const result = await parseDocument('plans.csv', Buffer.from('\uFEFFPlan;Price;Reference code\r\nEnterprise;"42 credits\nper month";SP-PHASE4-731'));
  assert.match(result.text, /Plan \(column 1\)=Enterprise/);
  assert.match(result.text, /Row 2:/);
  assert.match(result.text, /42 credits\nper month/);
  assert.ok(result.structuredCells?.some(cell => cell.value === 'SP-PHASE4-731' && cell.columnName === 'Reference code'));
});

test('rejects malformed and unsupported uploads clearly', async () => {
  await assert.rejects(() => parseDocument('bad.pdf', Buffer.from('%PDF-not-a-real-pdf')), /INVALID_PDF/);
  await assert.rejects(() => parseDocument('bad.csv', Buffer.from('a,"unfinished')), /MALFORMED_CSV/);
  await assert.rejects(() => parseDocument('file.doc', Buffer.from('anything')), /UNSUPPORTED_FILE_TYPE/);
});
