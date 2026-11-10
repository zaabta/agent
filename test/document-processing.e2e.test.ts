import { isolatedAccount } from './helpers/isolated-account.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { TypegraphModule } from '../src/typegraph/typegraph.module.js';
import { TypegraphService } from '../src/typegraph/typegraph.service.js';
import { StructuredDataService } from '../src/documents/structured-data.service.js';
import { config } from '../src/config.js';

const baseUrl = process.env.DOCUMENT_E2E_URL || `http://127.0.0.1:${config.port}`;
const enabled = process.env.RUN_DOCUMENT_E2E === 'true' && process.env.CONFIRM_ISOLATED_E2E === 'true';
let accessToken = '';
const authHeaders = () => ({ authorization: `Bearer ${accessToken}` });

type Fixture = { name: string; mime: string; bytes: Buffer; query: string; expected: string };

function pdfFixture(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return Buffer.from(`${pdf}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

async function docxFixture(marker: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Phase Five Fixture</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Answer</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${marker}</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function workbookFixture(bookType: 'xlsx' | 'biff8', code: string) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Reference', 'Answer'], [code, 'SHEET-ANSWER-731']]);
  (sheet.A2 as XLSX.CellObject).z = '000000';
  XLSX.utils.book_append_sheet(workbook, sheet, 'Phase Five');
  return XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer;
}

const fixtures: Promise<Fixture[]> = Promise.all([
  docxFixture('DOCX-ANSWER-731').then(bytes => ({ name: 'phase5-docx.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes, query: 'DOCX-ANSWER-731', expected: 'DOCX-ANSWER-731' })),
]).then(async docx => {
  const xlsxCode = `XLSX-${createHash('sha1').update('phase5-xlsx').digest('hex').slice(0, 8)}`;
  const xlsCode = `XLS-${createHash('sha1').update('phase5-xls').digest('hex').slice(0, 8)}`;
  const csvCode = `CSV-${createHash('sha1').update('phase5-csv').digest('hex').slice(0, 8)}`;
  const largeCsvRows = ['Reference,Description,Answer', ...Array.from({ length: 3000 }, (_, index) => `LARGE-${index + 1},Synthetic indexed CSV row ${index + 1} with enough descriptive text to exercise chunked embedding batches,${index === 0 ? 'LARGE-CSV-ANSWER-731' : `ROW-${index + 1}`}`)];
  return [
    { name: 'phase5.pdf', mime: 'application/pdf', bytes: pdfFixture('PDF-ANSWER-731'), query: 'PDF-ANSWER-731', expected: 'PDF-ANSWER-731' },
    docx[0],
    { name: 'phase5.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: workbookFixture('xlsx', xlsxCode), query: xlsxCode, expected: 'SHEET-ANSWER-731' },
    { name: 'phase5.xls', mime: 'application/vnd.ms-excel', bytes: workbookFixture('biff8', xlsCode), query: xlsCode, expected: 'SHEET-ANSWER-731' },
    { name: 'phase5.csv', mime: 'text/csv', bytes: Buffer.from(`Reference,Answer\n${csvCode},CSV-ANSWER-731`), query: csvCode, expected: 'CSV-ANSWER-731' },
    { name: 'large-progress.csv', mime: 'text/csv', bytes: Buffer.from(largeCsvRows.join('\n')), query: 'LARGE-CSV-ANSWER-731', expected: 'LARGE-CSV-ANSWER-731' },
    { name: 'phase5.md', mime: 'text/markdown', bytes: Buffer.from('# Phase Five\nMarkdown marker MD-ANSWER-731'), query: 'MD-ANSWER-731', expected: 'MD-ANSWER-731' },
    { name: 'phase5.txt', mime: 'text/plain', bytes: Buffer.from('Plain text marker TXT-ANSWER-731'), query: 'TXT-ANSWER-731', expected: 'TXT-ANSWER-731' },
  ];
});

async function upload(fixture: Fixture) {
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(fixture.bytes)], { type: fixture.mime }), fixture.name);
  return fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', headers: authHeaders(), body: form });
}

async function waitForJob(jobId: string, maxWaitMs = 300000) {
  const deadline = Date.now() + maxWaitMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    last = await response.json() as Record<string, unknown>;
    if (['ready', 'failed', 'cancelled'].includes(String(last.status))) return last;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  assert.fail(`Job ${jobId} did not finish: ${JSON.stringify(last)}`);
}

test('real authenticated upload -> BullMQ -> worker -> TypeGraph -> Prisma E2E for all supported formats', {
  skip: !enabled ? 'Set RUN_DOCUMENT_E2E=true, CONFIRM_ISOLATED_E2E=true and start the API, worker, PostgreSQL, Redis, TypeGraph, and Ollama' : false,
  timeout: 600000,
}, async () => {
  const context = await NestFactory.createApplicationContext(TypegraphModule, { logger: false, abortOnError: false });
  const typegraph = context.get(TypegraphService);
  const prisma = new PrismaClient();
  const structuredData = new StructuredDataService(prisma);
  let tenantId: string | undefined;
  let userId: string | undefined;
  const testDocumentIds: string[] = [];
  try {
    const identity = await isolatedAccount(prisma, baseUrl, 'documents-e2e');
    accessToken = identity.accessToken;
    tenantId = identity.tenant.id;
    userId = identity.user.id;
    const allFixtures = await fixtures;
    const initialStorage = new Set(await readdir(config.uploadDir).catch(() => []));
    const accepted: Array<{ fixture: Fixture; documentId: string; jobId: string }> = [];
    for (const fixture of allFixtures) {
      console.info(JSON.stringify({ event: 'document-e2e-upload', filename: fixture.name }));
      const response = await upload(fixture);
      assert.equal(response.status, 202, `${fixture.name} upload should be accepted`);
      const payload = await response.json() as { document: { id: string; jobId: string; status: string; stage: string } };
      assert.match(payload.document.id, /^[0-9a-f-]{36}$/i);
      assert.match(payload.document.jobId, /^[0-9a-f-]{36}$/i);
      testDocumentIds.push(payload.document.id);
      const job = await waitForJob(payload.document.jobId);
      assert.equal(job.status, 'ready', `${fixture.name}: ${JSON.stringify(job)}`);
      assert.equal(job.stage, 'completed');
      const progress = job.progressDetails as { overallPercent: number | null; etaMs: number | null; stages: Array<{ stage: string; status: string; stagePercent: number | null; completedUnits: number | null; totalUnits: number | null; unit: string | null; embeddingChunksPerSecond?: number | null }> };
      assert.equal(progress.overallPercent, 100);
      assert.equal(progress.etaMs, null, 'ETA must remain unknown without measured throughput');
      assert.ok(progress.stages.some(stage => stage.stage === 'upload' && stage.completedUnits === stage.totalUnits && stage.stagePercent === 100), 'received upload byte count should be recorded');
      for (const stage of ['validation', 'queued', 'verification', 'parsing', 'smart_chunking', 'indexing', 'embedding', 'publication', 'completed']) assert.ok(progress.stages.some(item => item.stage === stage), `Missing persisted stage ${stage}`);
      const embedding = progress.stages.find(stage => stage.stage === 'embedding')!;
      assert.equal(embedding.unit, 'chunks');
      assert.ok(embedding.completedUnits !== null && embedding.totalUnits !== null && embedding.completedUnits === embedding.totalUnits, 'Embedding batches must report completed SDK chunks against the actual total');
      assert.ok(progress.stages.some(stage => stage.stage === 'publication' && stage.status === 'completed'), 'Only a committed publication may complete a versioned job');
      assert.ok((embedding.embeddingChunksPerSecond ?? 0) > 0, 'Measured embedding duration should yield actual chunk throughput');
      console.info(JSON.stringify({ event: 'document-e2e-ready', filename: fixture.name, chunks: embedding.totalUnits }));
      accepted.push({ fixture, documentId: payload.document.id, jobId: payload.document.jobId });
    }

    for (const { fixture, documentId } of accepted) {
      const result = await typegraph.searchDocuments(fixture.query, 8, tenantId);
      const hit = result.hits.find(item => item.citation.documentId === documentId);
      assert.ok(hit, `${fixture.name} content was not retrieved by TypeGraph: ${JSON.stringify(result.hits.map(h => h.sourceRef))}`);
      assert.ok(hit.content.includes(fixture.expected), `${fixture.name} retrieved chunk did not contain expected answer`);
      const expectedLocation: Record<string, string> = {
        'phase5.pdf': 'page 1', 'phase5-docx.docx': 'section Phase Five Fixture',
        'phase5.xlsx': 'sheet Phase Five, row 2', 'phase5.xls': 'sheet Phase Five, row 2',
        'phase5.csv': 'sheet CSV, row 2', 'large-progress.csv': 'sheet CSV, rows 2-', 'phase5.md': 'section Phase Five', 'phase5.txt': 'line 1',
      };
      assert.ok(hit.sourceRef.includes(expectedLocation[fixture.name]!), `${fixture.name} citation location was not source-derived: ${hit.sourceRef}`);
    }

    const directSearch = await fetch(`${baseUrl}/api/documents/search`, {
      method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ query: accepted[0]!.fixture.query, limit: 5 }),
    });
    assert.equal(directSearch.status, 200);
    const directResults = await directSearch.json() as { hits: Array<{ content: string; sourceRef: string; citation: { documentId: string } }> };
    const directHit = directResults.hits.find(hit => hit.citation.documentId === accepted[0]!.documentId);
    assert.ok(directHit, 'direct authenticated document search should return an indexed TypeGraph source');
    assert.ok(directHit.content.includes(accepted[0]!.fixture.expected));
    assert.ok(directHit.sourceRef);

    const sameName: Fixture[] = [
      { name: 'same-name.csv', mime: 'text/csv', bytes: Buffer.from('Reference,Answer\nSAME-A,Concurrent upload A'), query: 'SAME-A', expected: 'Concurrent upload A' },
      { name: 'same-name.csv', mime: 'text/csv', bytes: Buffer.from('Reference,Answer\nSAME-B,Concurrent upload B'), query: 'SAME-B', expected: 'Concurrent upload B' },
    ];
    const sameNameUploads = await Promise.all(sameName.map(upload));
    const sameNameAccepted = await Promise.all(sameNameUploads.map(async response => {
      assert.equal(response.status, 202);
      const result = await response.json() as { document: { id: string; jobId: string }; duplicate: boolean };
      assert.equal(result.duplicate, false);
      testDocumentIds.push(result.document.id);
      return result.document;
    }));
    assert.notEqual(sameNameAccepted[0]!.id, sameNameAccepted[1]!.id, 'identical filenames with different contents must get independent document IDs');
    assert.notEqual(sameNameAccepted[0]!.jobId, sameNameAccepted[1]!.jobId, 'identical filenames with different contents must get independent job IDs');
    for (let index = 0; index < sameNameAccepted.length; index++) {
      const completed = await waitForJob(sameNameAccepted[index]!.jobId);
      assert.equal(completed.status, 'ready');
      const result = await typegraph.searchDocuments(sameName[index]!.query, 8, tenantId);
      assert.ok(result.hits.some(hit => hit.citation.documentId === sameNameAccepted[index]!.id && hit.content.includes(sameName[index]!.expected)));
    }

    for (const { fixture, documentId } of accepted.filter(item => ['phase5.xlsx', 'phase5.xls', 'phase5.csv'].includes(item.fixture.name))) {
      const codeCell = fixture.query;
      const cells = await prisma.appDocumentCell.findMany({ where: { tenantId, documentId, value: codeCell }, select: { sheetName: true, rowNumber: true, address: true, columnName: true } });
      assert.ok(cells.length > 0, `${fixture.name} exact structured cell was not persisted`);
      const exact: { documentId: string } | null = await prisma.appDocumentCell.findFirst({ where: { tenantId, documentId, value: codeCell }, select: { documentId: true } });
      assert.equal(exact?.documentId, documentId);
      const lookup = await structuredData.lookup(codeCell, tenantId);
      assert.ok(lookup.hits.some(hit => hit.citation.documentId === documentId), `${fixture.name} exact lookup did not return its source row`);
    }

    const first = accepted[0]!;
    const sse = await fetch(`${baseUrl}/api/jobs/${first.jobId}/events`, { headers: authHeaders() });
    assert.equal(sse.status, 200);
    const sseText = await sse.text();
    assert.match(sseText, /event: completed/);
    assert.doesNotMatch(sseText, /PDF-ANSWER|DOCX-ANSWER|SHEET-ANSWER|CSV-ANSWER/);
    const firstProgress = (await (await fetch(`${baseUrl}/api/jobs/${first.jobId}`, { headers: authHeaders() })).json()) as { progressDetails: { stages: Array<{ id: string; stage: string }> } };
    const uploadEventId = firstProgress.progressDetails.stages.find(event => event.stage === 'upload')!.id;
    const replay = await fetch(`${baseUrl}/api/jobs/${first.jobId}/events`, { headers: { ...authHeaders(), 'last-event-id': uploadEventId } });
    const replayText = await replay.text();
    assert.match(replayText, /event: stage/);
    assert.match(replayText, /event: completed/);

    const duplicateResponse = await upload(first.fixture);
    assert.equal(duplicateResponse.status, 202);
    const duplicate = await duplicateResponse.json() as { document: { id: string; jobId: string }; duplicate: boolean };
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.document.id, first.documentId);
    assert.equal(duplicate.document.jobId, first.jobId);

    const invalid: Fixture = { name: 'broken.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-invalid fixture'), query: '', expected: '' };
    const corruptResponse = await upload(invalid);
    assert.equal(corruptResponse.status, 202);
    const corrupt = await corruptResponse.json() as { document: { id: string; jobId: string } };
    testDocumentIds.push(corrupt.document.id);
    const failed = await waitForJob(corrupt.document.jobId);
    assert.equal(failed.status, 'failed');
    const failedProgress = failed.progressDetails as { stages: Array<{ stage: string; status: string; attempt: number; failureCode: string | null }> };
    assert.ok(failedProgress.stages.some(event => event.stage === 'parsing' && event.status === 'failed' && event.attempt >= 1));
    assert.ok(failedProgress.stages.every(event => !event.failureCode || /^[A-Z][A-Z0-9_]{0,63}$/.test(event.failureCode)), 'failure details must remain sanitized codes');
    const failedDoc = await prisma.appDocument.findFirst({ where: { id: corrupt.document.id }, select: { storageKey: true, failureCode: true } });
    assert.equal(failedDoc?.storageKey, null);
    assert.ok(failedDoc?.failureCode);

    const finalStorage = await readdir(config.uploadDir).catch(() => []);
    assert.deepEqual(finalStorage.filter(name => !initialStorage.has(name)), []);
  } finally {
    if (tenantId) {
      for (const id of testDocumentIds) {
        await fetch(`${baseUrl}/api/documents/${id}`, { method: 'DELETE', headers: authHeaders() }).catch(() => undefined);
        await typegraph.deleteDocument(id, tenantId).catch(() => undefined);
      }
      await prisma.appDocument.deleteMany({ where: { tenantId, id: { in: testDocumentIds } } }).catch(() => undefined);
      // The workspace is shared: never delete it during per-test cleanup.
    }
    if (userId) await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
    await context.close();
  }
});
