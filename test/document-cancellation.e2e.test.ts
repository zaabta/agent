import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { config } from '../src/config.js';
import { redisConnection } from '../src/documents/redis-connection.js';

const baseUrl = process.env.DOCUMENT_E2E_URL || `http://127.0.0.1:${config.port}`;
const apiKey = process.env.DEV_API_KEY;
const enabled = process.env.RUN_DOCUMENT_E2E === 'true' && !!apiKey;

async function upload(name: string, content: string) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', headers: { 'x-api-key': apiKey! }, body: form });
  assert.equal(response.status, 202);
  return (await response.json() as { document: { id: string; jobId: string } }).document;
}

async function getJob(jobId: string) {
  const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers: { 'x-api-key': apiKey! } });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ documentId: string; status: string; stage: string; progressDetails: { etaMs: number | null; overallPercent: number | null; stages: Array<{ stage: string; status: string }> } }>;
}

async function until(jobId: string, predicate: (state: Awaited<ReturnType<typeof getJob>>) => boolean, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let state = await getJob(jobId);
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    state = await getJob(jobId);
  }
  assert.ok(predicate(state), `Job did not reach expected state: ${JSON.stringify(state)}`);
  return state;
}

test('real queued and active document cancellation cleans partial indexes and stays terminal', {
  skip: !enabled ? 'Requires RUN_DOCUMENT_E2E=true, API, worker, PostgreSQL, Redis, TypeGraph, and Ollama' : false,
  timeout: 300000,
}, async () => {
  const connection = redisConnection(config.redisUrl);
  const queue = new Queue(config.documentQueue, { connection });
  const prisma = new PrismaClient();
  try {
    // Pausing the existing queue is scoped to this integration test and is always
    // released in finally; no Redis state or volume is reset.
    await queue.pause();
    console.log('cancellation E2E: queue paused');
    const queued = await upload(`cancel-queued-${randomUUID()}.txt`, `Queued cancellation fixture ${randomUUID()}`);
    console.log('cancellation E2E: queued fixture uploaded');
    const cancelledQueuedResponse = await fetch(`${baseUrl}/api/jobs/${queued.jobId}/cancel`, { method: 'POST', headers: { 'x-api-key': apiKey! } });
    assert.equal(cancelledQueuedResponse.status, 201);
    assert.equal((await cancelledQueuedResponse.json() as { status: string }).status, 'cancelled');
    assert.equal((await getJob(queued.jobId)).status, 'cancelled');
    const queuedProgress = await getJob(queued.jobId);
    assert.equal(queuedProgress.progressDetails.etaMs, null);
    assert.ok(queuedProgress.progressDetails.stages.some(event => event.stage === 'cancelled' && event.status === 'cancelled'));
    console.log(`cancellation E2E: queued job ${queued.jobId} remains terminal`);
    const queuedRow = await prisma.appDocument.findFirst({ where: { id: queued.id, tenantId: config.tenantId } });
    assert.equal(queuedRow?.storageKey, null);
    assert.equal(await queue.getJob(queued.jobId), undefined);
    console.log('cancellation E2E: queued cancellation passed');
  } finally {
    await queue.resume().catch(() => undefined);
  }

  try {
    const marker = `ACTIVE-CANCEL-${randomUUID()}`;
    // Large synthetic text makes the indexing phase observable while local
    // embeddings are running, without using company data or changing indexes.
    const content = Array.from({ length: 1200 }, (_, i) => `Batch ${i}: ${marker} synthetic cancellation indexing fixture.`).join('\n');
    const active = await upload(`cancel-active-${randomUUID()}.txt`, content);
    console.log('cancellation E2E: active fixture uploaded');
    await until(active.jobId, state => state.stage === 'indexing' || ['ready', 'failed', 'cancelled'].includes(state.status));
    const before = await getJob(active.jobId);
    console.log(`cancellation E2E: job entered ${before.stage}/${before.status}`);
    assert.equal(before.status, 'processing', `Expected active indexing before cancellation, got ${JSON.stringify(before)}`);
    const disconnect = new AbortController();
    const progressResponse = await fetch(`${baseUrl}/api/jobs/${active.jobId}/events`, { headers: { 'x-api-key': apiKey! }, signal: disconnect.signal });
    assert.equal(progressResponse.status, 200);
    await progressResponse.body?.getReader().read();
    disconnect.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await getJob(active.jobId)).status, 'processing', 'closing the SSE stream must not cancel the job');
    const cancelResponse = await fetch(`${baseUrl}/api/jobs/${active.jobId}/cancel`, { method: 'POST', headers: { 'x-api-key': apiKey! } });
    assert.equal(cancelResponse.status, 201);
    const final = await until(active.jobId, state => ['cancelled', 'ready', 'failed'].includes(state.status));
    assert.equal(final.status, 'cancelled', `Cancellation lost race: ${JSON.stringify(final)}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal((await getJob(active.jobId)).status, 'cancelled', 'terminal cancellation must not become completed');
    const row = await prisma.appDocument.findFirst({ where: { id: active.id, tenantId: config.tenantId } });
    assert.equal(row?.status, 'cancelled');
    assert.equal(row?.storageKey, null);
    console.log(`cancellation E2E: active job ${active.jobId} remains terminal after TypeGraph rollback`);

    const { NestFactory } = await import('@nestjs/core');
    const { TypegraphModule } = await import('../src/typegraph/typegraph.module.js');
    const { TypegraphService } = await import('../src/typegraph/typegraph.service.js');
    const context = await NestFactory.createApplicationContext(TypegraphModule, { logger: false });
    try {
      const search = await context.get(TypegraphService).searchDocuments(marker, 8);
      assert.equal(search.hits.some(hit => hit.citation.documentId === active.id), false, 'cancelled document must not remain in TypeGraph');
    } finally { await context.close(); }
  } finally {
    await prisma.$disconnect();
    await queue.close();
    await connection.quit();
  }
});
