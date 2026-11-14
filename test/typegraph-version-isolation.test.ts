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
    indexedDocument(legacyDocumentId, legacyDocumentId, 'legacy active content', { tenantId: tenant, checksum: 'legacy-checksum', originalFilename: 'legacy.txt' }),
    indexedDocument('doc-other-tenant::other-version::g1::chunk', 'doc-other-tenant', 'another tenant secret', { documentVersionId: 'other-version', indexGeneration: 1 }),
  ];
  const prisma: any = {
    appDocument: {
      findMany: async ({ where }: any) => where.tenantId === tenant ? [
        { id: documentId, activeVersionId: versionTwo, tenantId: tenant, filename: 'current.txt', checksum: 'current-checksum' },
        { id: legacyDocumentId, activeVersionId: legacyVersion, tenantId: tenant, filename: 'legacy.txt', checksum: 'legacy-checksum' },
      ] : [],
    },
    appDocumentVersion: {
      findMany: async ({ where }: any) => [
        { id: versionTwo, documentId, tenantId: tenant, filename: 'current.txt', checksum: 'current-checksum', chunkingStrategy: 'structure-aware', activeIndexGeneration: 2 },
        { id: legacyVersion, documentId: legacyDocumentId, tenantId: tenant, filename: 'legacy.txt', checksum: 'legacy-checksum', chunkingStrategy: 'legacy', activeIndexGeneration: null },
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

test('completed legacy data recovers only when the unversioned index proves tenant, filename, and checksum identity', async () => {
  const legacyId = 'doc-vcfo-legacy';
  const recoveredVersionId = 'version-vcfo-legacy';
  const filename = 'VCFO-AI.xlsx';
  const checksum = 'same-content-checksum';
  const doc = { id: legacyId, tenantId: tenant, filename, checksum, status: 'ready', stage: 'completed', progress: 100, completedAt: new Date(), jobId: 'completed-job', activeVersionId: null, cancelRequested: false, deleteRequested: false };
  const version = { id: recoveredVersionId, documentId: legacyId, tenantId: tenant, versionNumber: 1, filename, checksum, status: 'queued', jobId: doc.jobId, chunkingStrategy: null, indexGeneration: 1, activeIndexGeneration: null };
  let searchCalled = false;
  const client: any = {
    document: { list: async () => [{ id: legacyId, name: filename, metadata: { documentId: legacyId, tenantId: tenant, checksum, originalFilename: filename } }] },
    search: async (_query: string, options: Record<string, any>) => {
      searchCalled = true;
      assert.deepEqual(options.documentFilter.documentIds, [legacyId]);
      // TypeGraph SDK search hits do not include custom document metadata.
      return { results: { chunks: [{ ...result(legacyId, legacyId, 'VCFO AI finance overview'), metadata: { name: filename, updatedAt: new Date() } }] } };
    },
  };
  const prisma: any = {
    appDocument: { findMany: async () => [doc] },
    appDocumentVersion: { findMany: async ({ where }: any) => where.versionNumber === 1 ? [version] : [] },
  };
  const service = new TypegraphService({ measure: async (operation: () => Promise<unknown>) => ({ result: await operation(), embeddingMs: 0 }) } as any, prisma);
  (service as any).clientFor = async () => client;

  const response = await service.searchDocuments('VCFO AI', 8, tenant);

  assert.equal(searchCalled, true);
  assert.equal(response.hits.length, 1);
  assert.equal(response.hits[0]?.content, 'VCFO AI finance overview');
  assert.equal(response.hits[0]?.citation.documentVersionId, recoveredVersionId);
});

test('legacy index entries with a wrong tenant or checksum are excluded before search', async () => {
  const legacyId = 'doc-legacy-guard';
  const versionId = 'version-legacy-guard';
  const doc = { id: legacyId, tenantId: tenant, filename: 'guarded.txt', checksum: 'current-checksum', status: 'ready', activeVersionId: versionId };
  const version = { id: versionId, documentId: legacyId, tenantId: tenant, filename: doc.filename, checksum: doc.checksum, versionNumber: 1, chunkingStrategy: 'legacy', activeIndexGeneration: null };
  const prisma: any = {
    appDocument: { findMany: async () => [doc] },
    appDocumentVersion: { findMany: async () => [version] },
  };
  const client: any = {
    document: { list: async () => [
      { id: legacyId, name: doc.filename, metadata: { documentId: legacyId, tenantId: 'tenant-other', checksum: 'old-checksum', originalFilename: doc.filename } },
    ] },
    search: async () => { assert.fail('Search must not run without an authorized legacy index candidate'); },
  };
  const service = new TypegraphService({ measure: async (operation: () => Promise<unknown>) => ({ result: await operation(), embeddingMs: 0 }) } as any, prisma);
  (service as any).clientFor = async () => client;

  const response = await service.searchDocuments('guarded file', 8, tenant);

  assert.deepEqual(response.hits, []);
  assert.equal(response.timing.embeddingMs, 0);
});

test('version identity survives SDK metadata projection and publication restore switches the authorized ID set', async () => {
  const versionOneId = 'version-one';
  const versionTwoId = 'version-two';
  let activeVersionId = versionTwoId;
  const activeGeneration = 1;
  const doc = { id: documentId, tenantId: tenant, filename: 'conflicting-values.pdf', checksum: 'current-checksum', status: 'ready', activeVersionId };
  const versions = [
    { id: versionOneId, documentId, tenantId: tenant, filename: 'conflicting-values.pdf', checksum: 'v1-checksum', versionNumber: 1, chunkingStrategy: 'structure-aware', indexGeneration: 1, activeIndexGeneration: 1 },
    { id: versionTwoId, documentId, tenantId: tenant, filename: 'conflicting-values.pdf', checksum: 'v2-checksum', versionNumber: 2, chunkingStrategy: 'structure-aware', indexGeneration: 1, activeIndexGeneration: 2 },
  ];
  const indexRows = versions.map(version => ({
    id: `${documentId}::${version.id}::g${version.activeIndexGeneration}::chunk`,
    name: 'conflicting-values.pdf',
    metadata: { documentId, documentVersionId: version.id, indexGeneration: version.activeIndexGeneration, tenantId: tenant },
  }));
  const prisma: any = {
    appDocument: { findMany: async () => [{ ...doc, activeVersionId }] },
    appDocumentVersion: { findMany: async ({ where }: any) => versions.filter(version => where.id.in.includes(version.id)) },
  };
  const client: any = {
    document: { list: async () => indexRows },
    search: async () => ({ results: { chunks: indexRows.map((row, index) => {
      const hit: any = result(row.id, documentId, index === 0 ? 'Version 1 content' : 'Version 2 content');
      hit.metadata = { name: row.name, updatedAt: new Date() };
      return hit;
    }) } }),
  };
  const service = new TypegraphService({ measure: async (operation: () => Promise<unknown>) => ({ result: await operation(), embeddingMs: 0 }) } as any, prisma);
  (service as any).clientFor = async () => client;

  const publishedV2 = await service.searchDocuments('F-4 value', 8, tenant);
  assert.deepEqual(publishedV2.hits.map(hit => hit.content), ['Version 2 content']);
  assert.deepEqual(publishedV2.hits.map(hit => hit.citation.documentVersionId), [versionTwoId]);

  activeVersionId = versionOneId;
  doc.activeVersionId = versionOneId;
  versions[0]!.activeIndexGeneration = activeGeneration;
  const restoredV1 = await service.searchDocuments('F-4 value', 8, tenant);
  assert.deepEqual(restoredV1.hits.map(hit => hit.content), ['Version 1 content']);
  assert.deepEqual(restoredV1.hits.map(hit => hit.citation.documentVersionId), [versionOneId]);
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

test('authorized indexed provenance restores PDF pages and logical chunk identity after SDK projection', async () => {
  const id = 'provenance-document', version = 'provenance-version';
  const indexId = `${id}::${version}::g1::logical-chunk-7`;
  const metadata = { documentId: id, documentVersionId: version, indexGeneration: 1, pageNumber: 7, chunkIndex: 4, chunkCount: 9, chunkId: 'logical-chunk-7', contentHash: 'source-hash' };
  const listed = { id: indexId, name: 'source.pdf', metadata };
  const prisma: any = {
    appDocument: { findMany: async () => [{ id, tenantId: tenant, activeVersionId: version, filename: 'source.pdf', checksum: 'checksum' }] },
    appDocumentVersion: { findMany: async () => [{ id: version, documentId: id, tenantId: tenant, chunkingStrategy: 'structure-aware', activeIndexGeneration: 1 }] },
  };
  const service = new TypegraphService({ measure: async (operation: any) => ({ result: await operation(), embeddingMs: 0 }) } as any, prisma);
  (service as any).clientFor = async () => ({ document: { list: async () => [listed] }, search: async () => ({ results: { chunks: [{ ...result(indexId, id, 'Known PDF fact'), document: { id: indexId, name: 'source.pdf', bucketId: 'documents' } }] } }) });
  try {
    const response = await service.searchDocuments('Known PDF fact', 5, tenant);
    assert.equal(response.hits[0]?.sourceRef, 'source.pdf (page 7)');
    assert.equal(response.hits[0]?.citation.chunkIndex, 4);
    assert.equal(response.hits[0]?.citation.chunkCount, 9);
    assert.equal(response.hits[0]?.citation.chunkId, 'logical-chunk-7');
    assert.equal(response.hits[0]?.citation.contentHash, 'source-hash');
  } finally { await service.onModuleDestroy(); }
});
