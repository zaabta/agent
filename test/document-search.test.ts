import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentsService } from '../src/documents/documents.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { TypegraphService } from '../src/typegraph/typegraph.service.js';
import type { DocumentQueueService } from '../src/documents/document-queue.service.js';
import type { DocumentStorageService } from '../src/documents/document-storage.service.js';

test('direct document search returns TypeGraph ranked passages and filters to ready tenant documents', async () => {
  let searchArgs: unknown[] = [];
  const typegraph = {
    searchDocuments: async (...args: unknown[]) => {
      searchArgs = args;
      return {
        query: 'project location',
        hits: [
          { content: 'Ready source content', score: 0.12, sourceRef: 'ready.md (line 1)', citation: { documentId: 'ready', filename: 'ready.md', bucketId: 'documents', chunkIndex: 0, chunkCount: 1 }, metadata: { internal: true } },
          { content: 'Not published yet', score: 0.8, sourceRef: 'processing.md', citation: { documentId: 'processing', filename: 'processing.md', bucketId: 'documents', chunkIndex: 0, chunkCount: 1 }, metadata: {} },
        ],
        timing: { embeddingMs: 20, retrievalMs: 5, searchMs: 25 },
      };
    },
  };
  const prisma = {
    appDocument: {
      findMany: async ({ where }: { where: { tenantId: string; status: string } }) => {
        assert.deepEqual(where, { tenantId: 'tenant-a', status: 'ready' });
        return [{ id: 'ready' }];
      },
    },
  };
  const service = new DocumentsService(
    prisma as unknown as PrismaService,
    typegraph as unknown as TypegraphService,
    {} as DocumentQueueService,
    {} as DocumentStorageService,
  );

  const result = await service.search('project location', 'tenant-a', 'user-a', 8);

  assert.deepEqual(searchArgs, ['project location', 8, 'tenant-a', 'user-a', undefined, 0]);
  assert.equal(result.hits.length, 1, 'non-ready TypeGraph content must not be returned');
  assert.equal(result.hits[0]?.content, 'Ready source content');
  assert.equal('metadata' in (result.hits[0] || {}), false);
});
