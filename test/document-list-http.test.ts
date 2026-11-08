import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentsController } from '../src/documents/documents.controller.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { DocumentStorageService } from '../src/documents/document-storage.service.js';
import { AuthService } from '../src/auth/auth.service.js';

// Real HTTP/controller/guard/service; deterministic in-memory Prisma substitute.
// This does not establish PostgreSQL LIKE collation or transaction behavior.
test('document catalog exposes scoped search, filters and numbered pagination through HTTP', async t => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    tenantId: 'company-a', filename: index === 24 ? 'file_100%.pdf' : index < 12 ? `متطلبات-${index}.pdf` : `İş-Planı-${index}.txt`,
    fileType: index % 2 ? 'txt' : 'pdf', status: index % 3 ? 'failed' : 'ready', fileSize: 42n,
    createdAt: new Date('2026-11-08T00:00:00Z'), updatedAt: new Date('2026-11-08T00:00:00Z'),
  }));
  const allRows = [...rows, { ...rows[0]!, id: 'private-other', tenantId: 'company-b' }];
  const queries: any[] = [];
  const filtered = (where: any) => allRows.filter(row => row.tenantId === where.tenantId
    && (!where.status || row.status === where.status) && (!where.fileType || row.fileType === where.fileType)
    && (!where.filename || row.filename.toLocaleLowerCase().includes(where.filename.contains.replace(/\\([\\%_])/g, '$1').toLocaleLowerCase())));
  const prisma: any = {
    appDocument: {
      findMany: async ({ where, skip, take, select, orderBy }: any) => {
        queries.push(where);
        return filtered(where).sort((a: any, b: any) => {
          for (const order of orderBy) {
            const [key, direction] = Object.entries(order)[0]!;
            const delta = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
            if (delta) return direction === 'asc' ? delta : -delta;
          }
          return 0;
        }).slice(skip, skip + take).map(row => Object.fromEntries(Object.keys(select).map(key => [key, (row as any)[key]])));
      },
      count: async ({ where }: any) => { queries.push(where); return filtered(where).length; },
    },
    $transaction: async (operations: any[], options: any) => { assert.equal(options.isolationLevel, 'RepeatableRead'); return Promise.all(operations); },
  };
  const root = await mkdtemp(join(tmpdir(), 'sitepilot-list-'));
  const storage = { root, ensureRoot: async () => undefined };
  const service = new DocumentsService(prisma, {} as any, {} as any, storage as any);
  @Module({ controllers: [DocumentsController], providers: [
    { provide: DocumentsService, useValue: service }, { provide: DocumentStorageService, useValue: storage },
    { provide: AuthService, useValue: { validateAccessToken: async (token: string) => {
      if (!['company-a', 'company-b'].includes(token)) throw new UnauthorizedException();
      return { userId: 'user', tenantId: token, role: 'MEMBER', authMethod: 'jwt' };
    } } },
  ] }) class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (query = '', token = 'company-a') => fetch(`${base}/api/documents${query}`, { headers: { authorization: `Bearer ${token}` } });
  try {
    await t.test('default and subsequent pages are stable across tied timestamps', async () => {
      const first = await (await request()).json() as any;
      assert.equal(first.documents.length, 20); assert.equal(first.meta.total, 25); assert.equal(first.meta.totalPages, 2);
      assert.equal(first.meta.hasNextPage, true); assert.equal(first.meta.hasPreviousPage, false);
      assert.equal(first.documents[0].id, rows[24]!.id); assert.equal(first.documents[0].fileSize, 42);
      assert.equal(first.documents[0].tenantId, undefined);
      const second = await (await request('?page=2')).json() as any;
      assert.equal(second.meta.count, 5); assert.equal(second.meta.hasNextPage, false); assert.equal(second.meta.hasPreviousPage, true);
      assert.equal(new Set([...first.documents, ...second.documents].map(d => d.id)).size, 25);
    });
    await t.test('filters compose with multilingual filename search and filtered totals', async () => {
      const query = `?search=${encodeURIComponent('متطلبات')}&status=ready&fileType=.PDF&limit=1`;
      const first = await (await request(query)).json() as any;
      const second = await (await request(`${query}&page=2`)).json() as any;
      assert.equal(first.meta.total, 2); assert.equal(first.meta.totalPages, 2); assert.equal(first.documents.length, 1);
      assert.equal(first.meta.filters.fileType, 'pdf'); assert.equal(first.meta.filters.search, 'متطلبات');
      assert.notEqual(first.documents[0].id, second.documents[0].id); assert.equal(second.meta.hasNextPage, false);
      const turkish = await (await request(`?search=${encodeURIComponent('İş-Planı')}`)).json() as any;
      assert.equal(turkish.meta.total, 12);
      const literal = await (await request(`?search=${encodeURIComponent('FILE_100%')}`)).json() as any;
      assert.equal(literal.meta.total, 1); assert.equal(literal.documents[0].filename, 'file_100%.pdf');
      assert.ok(queries.some(where => where.filename?.contains === 'FILE\\_100\\%'));
      const empty = await (await request('?search=missing')).json() as any;
      assert.deepEqual(empty.documents, []); assert.equal(empty.meta.total, 0); assert.equal(empty.meta.totalPages, 0); assert.equal(empty.meta.hasNextPage, false);
      const beyond = await (await request('?page=999')).json() as any;
      assert.deepEqual(beyond.documents, []); assert.equal(beyond.meta.total, 25); assert.equal(beyond.meta.hasNextPage, false);
    });
    await t.test('tenant scope and authentication remain enforced for rows and counts', async () => {
      const other = await (await request('', 'company-b')).json() as any;
      assert.equal(other.meta.total, 1); assert.equal(other.documents[0].id, 'private-other');
      assert.equal((await request('', 'invalid')).status, 401);
      assert.equal((await fetch(`${base}/api/documents`)).status, 401);
      assert.equal((await request('?tenantId=company-b')).status, 400);
    });
    await t.test('invalid or repeated query values are rejected before querying storage', async () => {
      const countBefore = queries.length;
      for (const query of ['?page=0', '?page=-1', '?page=1.5', '?page=1e3', '?page=1000001', '?limit=101', '?limit=NaN', '?limit=0', '?page=1&page=2', '?status=unknown', '?fileType=exe', '?fileType=pdf&fileType=txt', '?search=a&search=b', `?search=${'x'.repeat(201)}`, '?unknown=value']) assert.equal((await request(query)).status, 400, query);
      assert.equal(queries.length, countBefore);
    });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
