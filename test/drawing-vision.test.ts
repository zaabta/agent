import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuthService } from '../src/auth/auth.service.js';
import { config } from '../src/config.js';
import { DocumentsController } from '../src/documents/documents.controller.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { DocumentStorageService } from '../src/documents/document-storage.service.js';
import { test } from 'node:test';
import { parseDocument } from '../src/documents/parser.js';
import { smartChunk } from '../src/documents/smart-chunker.js';
import { qualityDocuments } from './fixtures/quality-documents.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAsYAAAAASUVORK5CYII=', 'base64');

test('image and PDF drawing parsing keeps schedules, uncertainty and physical page references', async t => {
  const saved = process.env.OLLAMA_VISION_MODEL;
  process.env.OLLAMA_VISION_MODEL = 'fixture-vision';
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const rendered = Buffer.from(body.messages[0].images[0], 'base64');
    assert.equal(rendered.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(body.model, 'fixture-vision');
    requests++;
    return Response.json({ message: { content: JSON.stringify({
      observations: [{ kind: 'room', text: 'A101', area: 'North' }, { kind: 'dimension', text: '4000 mm', area: 'North' }],
      schedule: [['Room', 'Area'], ['A101', null]],
      uncertainties: ['Area value unreadable'],
    }) } });
  });
  try {
    const pdf = (await qualityDocuments()).find(doc => doc.filename.endsWith('.pdf'))!.buffer;
    for (const [filename, bytes] of [['A101.png', png], ['A101.drawing.pdf', pdf]] as const) {
      const parsed = await parseDocument(filename, bytes);
      const chunks = smartChunk(parsed.text, parsed.extension, { documentId: 'drawing', originalFilename: filename });
      assert.equal(chunks[0]?.pageNumber, 1);
      assert.match(chunks[0]!.content, /unverified/);
      assert.match(chunks[0]!.content, /Visual dimension \(North\): 4000 mm/);
      assert.match(chunks[0]!.content, /A101 \| \[unreadable\]/);
    }
    assert.equal(requests, 2);
    assert.match((await parseDocument('ordinary.pdf', pdf)).text, /supplier delay/);
    await assert.rejects(parseDocument('invalid.png', Buffer.from('bad')), /INVALID_DRAWING_IMAGE/);
    assert.equal(requests, 2);
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_VISION_MODEL;
    else process.env.OLLAMA_VISION_MODEL = saved;
  }
});

test('authenticated multipart upload validates drawing files and queues the original drawing names', async () => {
  const previous = config.uploadDir;
  const root = await mkdtemp(join(tmpdir(), 'sitepilot-drawing-'));
  config.uploadDir = root;
  const storage = new DocumentStorageService();
  const rows = new Map<string, any>();
  const queued: Array<{ filename: string; tenantId: string }> = [];
  const prisma = {
    appDocument: {
      create: async ({ data }: any) => rows.set(data.id, { ...data, createdAt: new Date(), updatedAt: new Date() }),
      findFirst: async ({ where }: any) => rows.get(where.id) ?? null,
      count: async () => rows.size,
    },
    appDocumentVersion: { findFirst: async () => null, create: async () => undefined },
    documentProgressEvent: { create: async () => undefined },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  };
  const service = new DocumentsService(prisma as never, {} as never, { enqueue: async (job: typeof queued[number]) => { queued.push(job); } } as never, storage);
  @Module({ controllers: [DocumentsController], providers: [
    { provide: DocumentsService, useValue: service },
    { provide: DocumentStorageService, useValue: storage },
    { provide: AuthService, useValue: { validateAccessToken: async () => ({ userId: 'owner', tenantId: 'test-tenant', role: 'MEMBER', authMethod: 'jwt' }) } },
  ] }) class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const upload = (name: string, bytes: Buffer, type: string) => {
      const body = new FormData();
      body.set('file', new Blob([new Uint8Array(bytes)], { type }), name);
      return fetch(`${base}/api/documents/upload`, { method: 'POST', headers: { authorization: 'Bearer fixture' }, body });
    };
    const pdf = (await qualityDocuments()).find(doc => doc.filename.endsWith('.pdf'))!.buffer;
    for (const [name, bytes, type] of [['A.png', png, 'image/png'], ['B.drawing.pdf', pdf, 'application/pdf']] as const) {
      const response = await upload(name, bytes, type);
      assert.equal(response.status, 202, await response.clone().text());
      assert.ok((await response.json() as any).version.jobId);
    }
    assert.equal((await upload('invalid.png', Buffer.from('bad'), 'image/png')).status, 400);
    assert.deepEqual(queued.map(({ filename, tenantId }) => [filename, tenantId]), [['A.png', 'test-tenant'], ['B.drawing.pdf', 'test-tenant']]);
  } finally {
    await app.close();
    config.uploadDir = previous;
    await rm(root, { recursive: true, force: true });
  }
});
