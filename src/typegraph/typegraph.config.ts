import { PgVectorAdapter, type SqlExecutor } from '@typegraph-ai/adapter-pgvector';
import { TenantId, type typegraphConfig } from '@typegraph-ai/sdk';
import type { Pool } from 'pg';
import { config } from '../config.js';
import { EmbeddingsService } from './embeddings.service.js';
import { localOllamaReranker } from './local-reranker.js';
import { ollamaTypegraphLlm } from './ollama-llm.provider.js';

export function typegraphConfig(pool: Pool, embeddings: EmbeddingsService, tenantId = config.tenantId): typegraphConfig {
  const sql: SqlExecutor = async (query, params) => {
    const result = await pool.query(query, params);
    return result.rows as Record<string, unknown>[];
  };

  return {
    tenantId: TenantId(tenantId),
    vectorStore: new PgVectorAdapter({ sql }),
    embedding: embeddings,
    searchEmbedding: embeddings,
    llm: ollamaTypegraphLlm,
    ...(config.typegraphRerank ? { reranker: localOllamaReranker } : {}),
    buckets: {
      documents: {
        name: 'SitePilot Documents',
        graph: 'public',
        graphExtraction: config.typegraphGraphExtraction,
        indexDefaults: { chunkSize: 1000, chunkOverlap: 150 },
      },
    },
  };
}
