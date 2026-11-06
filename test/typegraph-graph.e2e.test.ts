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
import { config } from '../src/config.js';

test('TypeGraph local graph extraction and connected-entity retrieval E2E', {
  skip: process.env.RUN_TYPEGRAPH_GRAPH_E2E !== 'true' ? 'Set RUN_TYPEGRAPH_GRAPH_E2E=true with local Ollama and the deployed TypeGraph index' : false,
  timeout: 300000,
}, async () => {
  const context = await NestFactory.createApplicationContext(TypegraphModule, { logger: false });
  const typegraph = context.get(TypegraphService);
  const embeddings = context.get(EmbeddingsService);
  const tenantId = `phase5-graph-${randomUUID()}`;
  const documentId = `${tenantId}-source`;
  const pool = new Pool({ connectionString: config.databaseUrl });
  let client: Awaited<ReturnType<typeof typegraphInit>> | undefined;
  try {
    const content = 'Northstar Incorporated acquired Helios Labs. Helios Labs created the Aurora Gateway product. The Aurora Gateway is used by Project Dawn.';
    const ingestion = await typegraph.ingestDocument({ id: documentId, name: 'synthetic-connected-organizations.txt', content, metadata: { test: 'synthetic-graph', tenantId } }, undefined, tenantId, undefined, true);
    console.log(`TypeGraph extraction stats: ${JSON.stringify(ingestion.result.extraction)}`);
    assert.equal(ingestion.result.status, 'complete');
    assert.ok((ingestion.result.extraction?.succeeded ?? 0) > 0, `Graph extraction failed: ${JSON.stringify(ingestion.result.extraction)}`);

    client = await typegraphInit(typegraphConfig(pool, embeddings, tenantId));
    const response = await client.search('Which company acquired the organization that created Aurora Gateway?', {
      buckets: ['documents'], resources: ['facts', 'entities', 'documents'], limit: 8,
      weights: { semantic: false, bm25: false, graph: 1, recency: false },
    });
    console.log(`TypeGraph graph search: facts=${response.results.facts.length}, entities=${response.results.entities.length}`);
    assert.ok(response.results.facts.length > 0, 'Graph-weighted search returned no graph facts');
    assert.ok(response.results.facts.some(fact => /Northstar|Helios|acquir/i.test(`${fact.evidenceText ?? ''} ${fact.sourceEntityName ?? ''} ${fact.targetEntityName ?? ''}`)), 'Graph search missed the acquired organization relation');
    const citedChunks = response.results.chunks.filter(chunk => chunk.document.id === documentId);
    assert.ok(citedChunks.every(chunk => chunk.content === content), 'Graph-expanded source chunks must remain attached to real indexed source content');
  } finally {
    if (client) await client.document.delete({ bucketId: 'documents', documentIds: [documentId] }, { context: { agentId: 'phase5-graph-test' } }).catch(() => undefined);
    else await typegraph.deleteDocument(documentId, tenantId).catch(() => undefined);
    await pool.end();
    await context.close();
  }
});
