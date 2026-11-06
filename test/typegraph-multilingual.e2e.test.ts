import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import { typegraphInit } from '@typegraph-ai/sdk';
import { TypegraphModule } from '../src/typegraph/typegraph.module.js';
import { TypegraphService } from '../src/typegraph/typegraph.service.js';
import { EmbeddingsService } from '../src/typegraph/embeddings.service.js';
import { typegraphConfig } from '../src/typegraph/typegraph.config.js';
import { localOllamaReranker } from '../src/typegraph/local-reranker.js';
import { config } from '../src/config.js';

const enabled = process.env.RUN_TYPEGRAPH_E2E === 'true';
const fixtures = [
  { id: 'en', name: 'synthetic-english-pricing.md', content: 'Aster Enterprise subscription costs 417 credits per month. The contract renews annually.', query: 'What is the Aster Enterprise monthly subscription price?', expected: '417 credits' },
  { id: 'en-decoy', name: 'synthetic-english-decoy.md', content: 'Aster Enterprise support responds within four business hours. The contract renews annually.', query: '', expected: '' },
  { id: 'ar', name: 'synthetic-arabic-pricing.md', content: 'سعر اشتراك أطلس المؤسسي هو ٥٢٧ ريالًا سعوديًا شهريًا. يتجدد العقد سنويًا.', query: 'ما سعر الاشتراك المؤسسي الشهري لأطلس؟', expected: '٥٢٧ ريالًا سعوديًا' },
  { id: 'ar-decoy', name: 'synthetic-arabic-decoy.md', content: 'يستجيب فريق دعم أطلس خلال أربع ساعات عمل. يتجدد العقد سنويًا.', query: '', expected: '' },
  { id: 'tr', name: 'synthetic-turkish-pricing.md', content: 'Mavi Atlas Kurumsal aboneliğinin aylık ücreti 638 Türk lirasıdır. Sözleşme her yıl yenilenir.', query: 'Mavi Atlas Kurumsal aboneliğinin aylık ücreti nedir?', expected: '638 Türk lirası' },
  { id: 'tr-decoy', name: 'synthetic-turkish-decoy.md', content: 'Mavi Atlas destek ekibi dört iş saati içinde yanıt verir. Sözleşme her yıl yenilenir.', query: '', expected: '' },
];

test('real TypeGraph multilingual retrieval benchmark and native local reranker comparison', {
  skip: !enabled ? 'Set RUN_TYPEGRAPH_E2E=true with PostgreSQL, Ollama nomic-embed-text, and the deployed TypeGraph index' : false,
  timeout: 600000,
}, async () => {
  const context = await NestFactory.createApplicationContext(TypegraphModule, { logger: false });
  const typegraph = context.get(TypegraphService);
  const embeddings = context.get(EmbeddingsService);
  const tenantId = `phase5-multilingual-${randomUUID()}`;
  const pool = new Pool({ connectionString: config.databaseUrl });
  let rerankClient: Awaited<ReturnType<typeof typegraphInit>> | undefined;
  const indexed: string[] = [];
  try {
    assert.match(embeddings.name, /^ollama\//);
    assert.equal(embeddings.dimensions, config.embedDimensions);
    for (const fixture of fixtures) {
      const id = `${tenantId}-${fixture.id}`;
      const result = await typegraph.ingestDocument({ id, name: fixture.name, content: fixture.content, metadata: { test: 'synthetic', tenantId } }, undefined, tenantId);
      assert.equal(result.result.status, 'complete');
      indexed.push(id);
    }

    const baseline: Record<string, { rank: number | null; durationMs: number; top: string[] }> = {};
    const queries = fixtures.filter(item => item.query);
    for (const item of queries) {
      const search = await typegraph.searchDocuments(item.query, 5, tenantId);
      const target = `${tenantId}-${item.id}`;
      const rank = search.hits.findIndex(hit => hit.citation.documentId === target);
      baseline[item.id] = { rank: rank < 0 ? null : rank + 1, durationMs: search.timing.searchMs, top: search.hits.map(hit => hit.citation.documentId) };
      assert.ok(rank >= 0, `${item.id} retrieval missed the synthetic correct document. Results: ${JSON.stringify(baseline[item.id])}`);
      assert.ok(search.hits[rank]!.content.includes(item.expected));
    }

    rerankClient = await typegraphInit({ ...typegraphConfig(pool, embeddings, tenantId), reranker: localOllamaReranker });
    const reranked: Record<string, { rank: number | null; durationMs: number; top: string[] }> = {};
    for (const item of queries) {
      const started = performance.now();
      const response = await rerankClient.search(item.query, {
        buckets: ['documents'], resources: ['documents'], limit: 5,
        weights: { semantic: 1, bm25: 1, graph: false, recency: false },
        fusion: { method: 'rrf', k: 60 }, rerank: { topK: 20 },
      });
      const hits = response.results.chunks;
      const target = `${tenantId}-${item.id}`;
      const rank = hits.findIndex(hit => hit.document.id === target);
      reranked[item.id] = { rank: rank < 0 ? null : rank + 1, durationMs: Math.round(performance.now() - started), top: hits.map(hit => hit.document.id) };
      assert.ok(rank >= 0, `${item.id} reranking lost the correct source`);
      assert.ok(hits[rank]!.content.includes(item.expected));
      assert.ok(hits.every(hit => indexed.includes(hit.document.id)), 'reranker returned a non-retrieved source');
    }
    console.log(JSON.stringify({ embeddingModel: embeddings.name, dimensions: embeddings.dimensions, baseline, reranked }, null, 2));
  } finally {
    if (rerankClient) for (const id of indexed) await rerankClient.document.delete({ bucketId: 'documents', documentIds: [id] }, { context: { agentId: 'phase5-benchmark' } }).catch(() => undefined);
    else for (const id of indexed) await typegraph.deleteDocument(id, tenantId).catch(() => undefined);
    await pool.end();
    await context.close();
  }
});
