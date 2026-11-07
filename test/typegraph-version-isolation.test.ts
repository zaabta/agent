import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TypegraphService } from '../src/typegraph/typegraph.service.js';

const tenant = 'tenant-a';
const documentId = 'doc-current';
const versionTwo = 'version-two';
const legacyDocumentId = 'doc-legacy';
const legacyVersion = 'legacy-version';

function indexedDocument(id: string, logicalId: string, content: string, metadata: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.txt`,
    content,
    metadata: { documentId: logicalId, ...metadata },
  };
}

function result(id: string, logicalId: string, content: string, metadata: Record<string, unknown> = {}) {
  return {
    content,
    score: 0.9,
    scores: { raw: {}, normalized: {}, output: {} },
    matchedBy: ['semantic', 'keyword'],
    document: { id, bucketId: 'documents', graph: 'public', name: `${id}.txt`, updatedAt: new Date() },
    chunk: { index: 0, total: 1 },
    metadata: { documentId: logicalId, ...metadata },
  };
}

test('TypeGraph search filters active versions before ranking and fails closed on stale/unversioned hits', async () => {
  let receivedOptions: Record<string, any> | undefined;
  const listed = [
    indexedDocument(`${documentId}::version-one::g1::chunk`, documentId, 'F-4 2400 x 4400 mm', { documentVersionId: 'version-one', indexGeneration: 1 }),
    indexedDocument(`${documentId}::${versionTwo}::g1::chunk`, documentId, 'stale generation', { documentVersionId: versionTwo, indexGeneration: 1 }),
    indexedDocument(`${documentId}::${versionTwo}::g2::chunk`, documentId, 'F-4 2600 x 4400 mm', { documentVersionId: versionTwo, indexGeneration: 2 }),
    indexedDocument(documentId, documentId, 'unversioned but superseded'),
    indexedDocument(legacyDocumentId, legacyDocumentId, 'legacy active content'),
    indexedDocument('doc-other-tenant::other-version::g1::chunk', 'doc-other-tenant', 'another tenant secret', { documentVersionId: 'other-version', indexGeneration: 1 }),
  ];
  const prisma: any = {
    appDocument: {
      findMany: async ({ where }: any) => where.tenantId === tenant ? [
        { id: documentId, activeVersionId: versionTwo },
        { id: legacyDocumentId, activeVersionId: legacyVersion },
      ] : [],
    },
    appDocumentVersion: {
      findMany: async ({ where }: any) => [
        { id: versionTwo, chunkingStrategy: 'structure-aware', activeIndexGeneration: 2 },
        { id: legacyVersion, chunkingStrategy: 'legacy', activeIndexGeneration: null },
      ].filter(version => where.id.in.includes(version.id) && where.tenantId === tenant),
    },
  };
  const embeddings: any = { measure: async (operation: () => Promise<unknown>) => ({ result: await operation(), embeddingMs: 0 }) };
  const client: any = {
    document: { list: async (_filter: unknown, _options: unknown, pagination: { offset: number }) => pagination.offset ? [] : listed },
    search: async (_query: string, options: Record<string, any>) => {
      receivedOptions = options;
      // Simulate an adapter that returns stale candidates despite the requested filter.
      return { results: { chunks: [
        result(`${documentId}::version-one::g1::chunk`, documentId, 'F-4 2400 x 4400 mm', { documentVersionId: 'version-one', indexGeneration: 1 }),
        result(`${documentId}::${versionTwo}::g1::chunk`, documentId, 'stale generation', { documentVersionId: versionTwo, indexGeneration: 1 }),
        result(`${documentId}::${versionTwo}::g2::chunk`, documentId, 'F-4 2600 x 4400 mm', { documentVersionId: versionTwo, indexGeneration: 2 }),
        result(documentId, documentId, 'unversioned but superseded'),
        result(legacyDocumentId, legacyDocumentId, 'legacy active content'),
        result('doc-other-tenant::other-version::g1::chunk', 'doc-other-tenant', 'another tenant secret', { documentVersionId: 'other-version', indexGeneration: 1 }),
      ] } };
    },
  };
  const service = new TypegraphService(embeddings, prisma);
  (service as any).clientFor = async () => client;

  const response = await service.searchDocuments('F-4 dimensions', 5, tenant);

  assert.deepEqual(receivedOptions?.documentFilter?.documentIds, [
    `${documentId}::${versionTwo}::g2::chunk`, legacyDocumentId,
  ]);
  assert.equal(receivedOptions?.graphReinforcement, 'only');
  assert.deepEqual(response.hits.map(hit => hit.citation.documentVersionId), [versionTwo, legacyVersion]);
  assert.deepEqual(response.hits.map(hit => hit.content), ['F-4 2600 x 4400 mm', 'legacy active content']);
  assert.ok(response.hits.every(hit => hit.citation.documentId !== 'doc-other-tenant'));
});

test('an exact filename in a content question narrows retrieval to that active document', async () => {
  let receivedOptions: Record<string, any> | undefined;
  const filename = 'ملف-علي.pdf';
  const listed = [
    { id: `${documentId}::${versionTwo}::g1::chunk`, name: filename, metadata: { documentId, documentVersionId: versionTwo, indexGeneration: 1 } },
    { id: 'other::version::g1::chunk', name: 'other.pdf', metadata: { documentId: 'other', documentVersionId: 'version', indexGeneration: 1 } },
  ];
  const prisma: any = {
    appDocument: { findMany: async () => [{ id: documentId, activeVersionId: versionTwo }] },
    appDocumentVersion: { findMany: async () => [{ id: versionTwo, chunkingStrategy: 'structure-aware', activeIndexGeneration: 1 }] },
  };
  const client: any = {
    document: { list: async (_filter: unknown, _options: unknown, pagination: { offset: number }) => pagination.offset ? [] : listed },
    search: async (_query: string, options: Record<string, any>) => {
      receivedOptions = options;
      const hit = result(`${documentId}::${versionTwo}::g1::chunk`, documentId, 'Authorized file contents', { documentVersionId: versionTwo, indexGeneration: 1 });
      hit.document.name = filename;
      return { results: { chunks: [hit] } };
    },
  };
  const service = new TypegraphService({ measure: async (operation: () => Promise<unknown>) => ({ result: await operation(), embeddingMs: 0 }) } as any, prisma);
  (service as any).clientFor = async () => client;

  const response = await service.searchDocuments(`Explain ${filename}`, 5, tenant);

  assert.deepEqual(receivedOptions?.documentFilter?.documentIds, [`${documentId}::${versionTwo}::g1::chunk`]);
  assert.equal(response.hits[0]?.content, 'Authorized file contents');
  assert.equal(response.hits[0]?.citation.filename, filename);
});

test('document inventory excludes superseded and unversioned stale index rows', async () => {
  const listed = [
    { id: `${documentId}::version-one::g1::chunk`, name: 'old.pdf', metadata: { documentId, documentVersionId: 'version-one', indexGeneration: 1 } },
    { id: `${documentId}::${versionTwo}::g1::chunk`, name: 'stale.pdf', metadata: { documentId, documentVersionId: versionTwo, indexGeneration: 1 } },
    { id: `${documentId}::${versionTwo}::g2::chunk`, name: 'current.pdf', metadata: { documentId, documentVersionId: versionTwo, indexGeneration: 2 } },
    { id: documentId, name: 'legacy-stale.pdf', metadata: { documentId } },
  ];
  const prisma: any = {
    appDocument: { findMany: async () => [{ id: documentId, activeVersionId: versionTwo }] },
    appDocumentVersion: { findMany: async () => [{ id: versionTwo, chunkingStrategy: 'structure-aware', activeIndexGeneration: 2 }] },
  };
  const client: any = { document: { list: async () => listed } };
  const service = new TypegraphService({} as any, prisma);
  (service as any).clientFor = async () => client;

  const response = await service.listDocuments(tenant);

  assert.deepEqual(response.documents.map((document: any) => document.name), ['current.pdf']);
});
