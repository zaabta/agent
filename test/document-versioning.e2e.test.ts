import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { config } from '../src/config.js';

const baseUrl = process.env.DOCUMENT_E2E_URL || `http://127.0.0.1:${config.port}`;
const apiKey = process.env.DEV_API_KEY;
const enabled = process.env.RUN_DOCUMENT_VERSION_E2E === 'true' && !!apiKey;
const headers = { 'x-api-key': apiKey! };

async function sendText(path: string, name: string, content: string, extra?: Record<string, string>) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), name);
  for (const [key, value] of Object.entries(extra || {})) form.append(key, value);
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: form });
  if (response.status !== 202) throw new Error(`Upload failed (${response.status}): ${await response.text()}`);
  return await response.json() as { document: { id: string }; version: { id: string; versionNumber: number; jobId: string } };
}

async function jobUntil(jobId: string, final = ['ready', 'failed', 'cancelled'], timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, { headers });
    assert.equal(response.status, 200);
    const state = await response.json() as { status: string; stage: string };
    if (final.includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Version job ${jobId} did not reach a terminal state`);
}

async function rawSearch(documentId: string, marker: string) {
  const response = await fetch(`${baseUrl}/api/documents/search`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ query: `F-4 dimensions ${marker}`, limit: 8 }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { hits: Array<{ content: string; citation: { documentId: string; documentVersionId?: string } }> };
  return result.hits.filter(hit => hit.citation.documentId === documentId);
}

test('versions publish atomically, preserve failed replacements, deduplicate, restore, and reindex', {
  skip: !enabled ? 'Requires RUN_DOCUMENT_VERSION_E2E=true, DEV_API_KEY, API, worker, PostgreSQL, Redis, TypeGraph, and Ollama' : false,
  timeout: 600000,
}, async () => {
  const marker = randomUUID();
  let documentId = '';
  try {
    const first = await sendText('/api/documents/upload', `version-v1-${marker}.txt`, `Fixture ${marker}. F-4 dimensions: 2400 x 4400 mm.`);
    documentId = first.document.id;
    assert.equal((await jobUntil(first.version.jobId)).status, 'ready');

    const second = await sendText(`/api/documents/${documentId}/versions`, `version-v2-${marker}.txt`, `Fixture ${marker}. F-4 dimensions: 2600 x 4400 mm.`, { reason: 'Updated fixture' });
    assert.equal(second.version.versionNumber, 2);
    assert.equal((await jobUntil(second.version.jobId)).status, 'ready');
    let versionsResponse = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, { headers });
    let versions = await versionsResponse.json() as { activeVersionId: string; versions: Array<{ id: string; versionNumber: number; status: string }> };
    assert.equal(versions.activeVersionId, second.version.id);
    assert.equal(versions.versions.length, 2);
    const versionTwoHits = await rawSearch(documentId, marker);
    assert.ok(versionTwoHits.some(hit => hit.citation.documentVersionId === second.version.id && hit.content.includes('2600 x 4400 mm')),
      `raw TypeGraph hits must contain Version 2's exact value: ${JSON.stringify(versionTwoHits)}`);
    assert.ok(versionTwoHits.every(hit => hit.citation.documentVersionId === second.version.id && hit.content.includes('2600 x 4400 mm') && !hit.content.includes('2400 x 4400 mm')),
      'raw default search must never expose Version 1 content or citations after Version 2 publishes');

    const concurrent = await Promise.all([
      sendText(`/api/documents/${documentId}/versions`, `concurrent-a-${marker}.txt`, `Concurrent version A ${marker}. F-4 dimensions: 2700 x 4400 mm.`),
      sendText(`/api/documents/${documentId}/versions`, `concurrent-b-${marker}.txt`, `Concurrent version B ${marker}. F-4 dimensions: 2800 x 4400 mm.`),
    ]);
    assert.deepEqual(concurrent.map(item => item.version.versionNumber).sort(), [3, 4]);
    for (const item of concurrent) assert.equal((await jobUntil(item.version.jobId)).status, 'ready');
    const latestConcurrent = concurrent.sort((a, b) => b.version.versionNumber - a.version.versionNumber)[0]!;
    const latestDimension = latestConcurrent.version.versionNumber === 3 ? '2700 x 4400 mm' : '2800 x 4400 mm';
    const concurrentHits = await rawSearch(documentId, marker);
    assert.ok(concurrentHits.some(hit => hit.citation.documentVersionId === latestConcurrent.version.id && hit.content.includes(latestDimension)));
    assert.ok(concurrentHits.every(hit => hit.citation.documentVersionId === latestConcurrent.version.id && hit.content.includes(latestDimension)),
      'concurrent publication must expose only the highest published version in raw hits');
    versionsResponse = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, { headers });
    versions = await versionsResponse.json() as typeof versions;
    assert.equal(versions.activeVersionId, latestConcurrent.version.id);

    const duplicate = await sendText(`/api/documents/${documentId}/versions`, `duplicate-${marker}.txt`, `Fixture ${marker}. F-4 dimensions: 2600 x 4400 mm.`);
    assert.equal((duplicate as unknown as { duplicate: boolean }).duplicate, true);

    const failedForm = new FormData();
    failedForm.append('file', new Blob(['%PDF-1.7\nnot a real PDF'], { type: 'application/pdf' }), `broken-${marker}.pdf`);
    const failedUpload = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, { method: 'POST', headers, body: failedForm });
    assert.equal(failedUpload.status, 202);
    const failedBody = await failedUpload.json() as { version: { id: string; jobId: string } };
    assert.equal((await jobUntil(failedBody.version.jobId)).status, 'failed');
    versionsResponse = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, { headers });
    versions = await versionsResponse.json() as typeof versions;
    assert.equal(versions.activeVersionId, latestConcurrent.version.id, 'failed replacement must not move the active pointer');
    const afterFailureHits = await rawSearch(documentId, marker);
    assert.ok(afterFailureHits.length > 0 && afterFailureHits.every(hit => hit.citation.documentVersionId === latestConcurrent.version.id && hit.content.includes(latestDimension)),
      'failed indexing must leave the prior published version as the only raw retrieval evidence');

    const cancellationForm = new FormData();
    cancellationForm.append('file', new Blob([`Cancellation fixture ${marker}. F-4 dimensions: 2900 x 4400 mm.\n`.repeat(50000)], { type: 'text/plain' }), `cancel-${marker}.txt`);
    const cancellationUpload = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, { method: 'POST', headers, body: cancellationForm });
    assert.equal(cancellationUpload.status, 202);
    const cancellationBody = await cancellationUpload.json() as { version: { id: string; jobId: string } };
    const cancellation = await fetch(`${baseUrl}/api/documents/${documentId}/versions/${cancellationBody.version.id}/cancel`, { method: 'POST', headers });
    assert.equal(cancellation.status, 202);
    assert.ok(['cancelling', 'cancelled'].includes((await cancellation.json() as { status: string }).status));
    assert.equal((await jobUntil(cancellationBody.version.jobId)).status, 'cancelled');
    const afterCancellationHits = await rawSearch(documentId, marker);
    assert.ok(afterCancellationHits.length > 0 && afterCancellationHits.every(hit => hit.citation.documentVersionId === latestConcurrent.version.id && hit.content.includes(latestDimension)),
      'cancelled replacement staging must not become retrieval evidence');

    const restoreResponse = await fetch(`${baseUrl}/api/documents/${documentId}/versions/${first.version.id}/restore`, { method: 'POST', headers });
    assert.equal(restoreResponse.status, 202);
    const restoreJob = await restoreResponse.json() as { jobId: string };
    assert.equal((await jobUntil(restoreJob.jobId)).status, 'ready');
    const restoredVersionOneHits = await rawSearch(documentId, marker);
    assert.ok(restoredVersionOneHits.some(hit => hit.citation.documentVersionId === first.version.id && hit.content.includes('2400 x 4400 mm')),
      `raw TypeGraph hits must contain restored Version 1's exact value: ${JSON.stringify(restoredVersionOneHits)}`);
    assert.ok(restoredVersionOneHits.every(hit => hit.citation.documentVersionId === first.version.id && hit.content.includes('2400 x 4400 mm') && !hit.content.includes('2600 x 4400 mm')),
      'raw default search must return only restored Version 1 content and citations');

    const reindexResponse = await fetch(`${baseUrl}/api/documents/${documentId}/versions/${first.version.id}/reindex`, { method: 'POST', headers });
    assert.equal(reindexResponse.status, 202);
    const reindex = await reindexResponse.json() as { jobId: string };
    assert.equal((await jobUntil(reindex.jobId)).status, 'ready');
    versionsResponse = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, { headers });
    versions = await versionsResponse.json() as typeof versions;
    assert.equal(versions.activeVersionId, first.version.id);
  } finally {
    if (documentId) await fetch(`${baseUrl}/api/documents/${documentId}`, { method: 'DELETE', headers }).catch(() => undefined);
  }
});
