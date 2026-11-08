import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentsService } from '../src/documents/documents.service.js';

test('duplicate upload restores only an absent authorized queued job with its stable identity', async () => {
  for (const scenario of ['missing', 'exists', 'processing', 'ready', 'cancelled', 'wrong-tenant', 'cancel-requested', 'deleted'] as const) {
    const version = { id: 'version', documentId: 'document', tenantId: scenario === 'wrong-tenant' ? 'another' : 'tenant', status: ['processing', 'ready', 'cancelled'].includes(scenario) ? scenario : 'queued', cancelRequested: scenario === 'cancel-requested', document: { cancelRequested: false, deleteRequested: scenario === 'deleted' }, storageKey: 'retained.txt', checksum: 'checksum', filename: 'requirements.txt', fileSize: 42n, jobId: 'original-job' };
    const matches = (row: any, where: any): boolean => Object.entries(where).every(([key,value]) => value && typeof value === 'object' ? matches(row[key],value) : row[key] === value);
    const enqueued: any[] = [];
    const service = new DocumentsService({ appDocumentVersion: { findFirst: async ({ where }: any) => matches(version,where) ? version : null } } as any, {} as any, { queue: { getJob: async () => scenario === 'exists' ? { id: 'original-job' } : null }, enqueue: async (data: any, id: string) => { enqueued.push({data,id}); } } as any, {} as any);
    await (service as any).recoverQueuedUpload('document','tenant','user','version');
    assert.equal(enqueued.length, scenario === 'missing' ? 1 : 0, scenario);
    if (scenario === 'missing') assert.deepEqual(enqueued[0], {id:'original-job',data:{documentId:'document',versionId:'version',tenantId:'tenant',userId:'user',storageKey:'retained.txt',filename:'requirements.txt',checksum:'checksum',fileSize:42}});
  }
});
