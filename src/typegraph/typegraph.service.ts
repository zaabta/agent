import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { AgentId, typegraphInit, type QueryChunkResult, type typegraphInstance } from '@typegraph-ai/sdk';
import type { IndexProgressEvent } from '@typegraph-ai/sdk';
import { Pool } from 'pg';
import { config } from '../config.js';
import { EmbeddingsService } from './embeddings.service.js';
import { typegraphConfig } from './typegraph.config.js';

export interface DocumentSearchHit {
  content: string;
  score: number;
  sourceRef: string;
  citation: {
    documentId: string;
    filename: string;
    bucketId: string;
    chunkIndex: number;
    chunkCount: number;
    location?: string;
  };
  metadata: Record<string, unknown>;
}
export type TypegraphIngestProgress = Pick<IndexProgressEvent, 'phase' | 'done' | 'total'>;

@Injectable()
export class TypegraphService implements OnModuleInit, OnModuleDestroy {
  private static readonly maxTenantClients = 128;
  private readonly logger = new Logger(TypegraphService.name);
  private readonly pool = new Pool({ connectionString: config.databaseUrl });
  private readonly clients = new Map<string, Promise<typegraphInstance>>();

  constructor(@Inject(EmbeddingsService) private readonly embeddings: EmbeddingsService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.clientFor(config.tenantId);
    } catch (cause) {
      this.logger.error('TypeGraph runtime initialization failed');
      await this.pool.end();
      throw new Error('TYPEGRAPH_INITIALIZATION_FAILED: check PostgreSQL, pgvector deployment, and local Ollama embeddings', { cause });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async ingestDocument(document: { id: string; name: string; content: string; metadata: Record<string, unknown> }, abortSignal?: AbortSignal, tenantId = config.tenantId, userId?: string, graphExtraction = config.typegraphGraphExtraction, onProgress?: (event: TypegraphIngestProgress) => void) {
    const startedAt = performance.now();
    const client = await this.clientFor(tenantId);
    const measured = await this.embeddings.measure(() => client.document.ingest(document, {
        bucketId: 'documents',
        context: this.actor(userId),
        // SDK 0.6 resolves chunk identity from deduplicateBy. Its default is
        // ['url']; uploads have no URL, so all documents otherwise share a key.
        deduplicateBy: ['id'],
        abortSignal,
        graphExtraction,
        ...(onProgress ? { onProgress: event => {
          // Embedding progress comes from EmbeddingsService after each Ollama
          // batch succeeds. Use SDK callbacks for its other actual phases to
          // avoid double-counting the SDK's aggregate embed notification.
          if (event.phase !== 'embed') onProgress({ phase: event.phase, done: event.done, total: event.total });
        } } : {}),
      }), abortSignal,
      progress => onProgress?.({ phase: 'embed', done: progress.done, total: progress.total }),
    );
    const result = measured.result;
    const indexingDurationMs = performance.now() - startedAt;
    return {
      result,
      timing: {
        embeddingMs: measured.embeddingMs,
        indexingMs: Math.round(indexingDurationMs),
      },
    };
  }

  async listDocuments(tenantId = config.tenantId, userId?: string) {
    const startedAt = performance.now();
    const client = await this.clientFor(tenantId);
    const documents = await client.document.list(
      { bucketId: 'documents' },
      { context: this.actor(userId) },
    );
    return { documents, durationMs: Math.round(performance.now() - startedAt) };
  }

  async deleteDocument(id: string, tenantId = config.tenantId, userId?: string) {
    const client = await this.clientFor(tenantId);
    return client.document.delete(
      { bucketId: 'documents', documentIds: [id] },
      { context: this.actor(userId) },
    );
  }

  async searchDocuments(query: string, limit = 5, tenantId = config.tenantId, userId?: string, abortSignal?: AbortSignal, minScore = config.typegraphMinScore): Promise<{
    query: string;
    hits: DocumentSearchHit[];
    timing: { embeddingMs: number; retrievalMs: number; searchMs: number };
  }> {
    const startedAt = performance.now();
    const client = await this.clientFor(tenantId);
    const measured = await this.embeddings.measure(() => client.search(query, {
        buckets: ['documents'],
        resources: config.typegraphGraphExtraction ? ['documents', 'entities', 'facts'] : ['documents'],
        weights: { semantic: 1, bm25: 1, graph: config.typegraphGraphExtraction ? 0.5 : false, recency: false },
        fusion: { method: 'rrf', k: 60 },
        ...(config.typegraphRerank ? { rerank: { topK: Math.max(8, limit) } } : {}),
        limit: Math.min(Math.max(limit, 1), 8),
        context: this.actor(userId),
        abortSignal,
      }),
      abortSignal,
    );
    const response = measured.result;

    const searchDurationMs = performance.now() - startedAt;
    const embeddingDurationMs = measured.embeddingMs;
    return {
      query,
      // Keep retrieval inside TypeGraph, then discard weak native-ranked hits so
      // unrelated high-level matches cannot be offered as factual evidence.
      hits: response.results.chunks
        .map(hit => this.toSearchHit(hit))
        .filter(hit => hit.score >= minScore),
      timing: {
        embeddingMs: Math.round(embeddingDurationMs),
        retrievalMs: Math.max(0, Math.round(searchDurationMs - embeddingDurationMs)),
        searchMs: Math.round(searchDurationMs),
      },
    };
  }

  private toSearchHit(hit: QueryChunkResult): DocumentSearchHit {
    const filename = hit.document.name;
    const chunkIndex = hit.chunk.index;
    const location = this.sourceLocation(hit.content);
    const sourceRef = `${filename} (${location || `chunk ${chunkIndex + 1}`})`;
    return {
      content: hit.content,
      score: hit.score,
      sourceRef,
      citation: {
        documentId: hit.document.id,
        filename,
        bucketId: hit.document.bucketId,
        chunkIndex,
        chunkCount: hit.chunk.total,
        ...(location ? { location } : {}),
      },
      metadata: hit.metadata,
    };
  }

  private sourceLocation(content: string): string | undefined {
    const page = content.match(/\bPage\s+(\d+)\s*:/i)?.[1];
    if (page) return `page ${page}`;
    const sheet = content.match(/^Sheet:\s*(.+)$/im)?.[1]?.trim();
    const rowLines = [...content.matchAll(/^Row\s+(\d+)\s*:\s*(.+)$/gim)];
    if (rowLines.length) {
      const rowNumbers = [...new Set(rowLines.map(match => Number(match[1])))].sort((a, b) => a - b);
      const rowLocation = rowNumbers.length === 1 ? `row ${rowNumbers[0]}` : `rows ${rowNumbers[0]}-${rowNumbers.at(-1)}`;
      const cellRefs = [...new Set(rowLines.flatMap(line => [...line[2]!.matchAll(/\b([A-Z]{1,3}\d+)\s*=/g)].map(match => match[1]!)))];
      if (sheet) return `sheet ${sheet}, ${rowLocation}${cellRefs.length ? `, cells ${cellRefs.slice(0, 12).join(', ')}${cellRefs.length > 12 ? ', …' : ''}` : ''}`;
      if (/^CSV headers:/im.test(content)) return `CSV ${rowLocation}`;
    }
    if (sheet) return `sheet ${sheet}`;
    const docxHeading = content.match(/\bHeading:\s*([^\r\n]+)/i)?.[1]?.trim();
    if (docxHeading) return `section ${docxHeading.slice(0, 120)}`;
    const markdownHeading = content.match(/^Line\s+\d+:\s*#{1,6}\s+([^\r\n]+)/m)?.[1]?.trim();
    if (markdownHeading) return `section ${markdownHeading.slice(0, 120)}`;
    const textLine = content.match(/^Line\s+(\d+):/m)?.[1];
    if (textLine) return `line ${textLine}`;
    return undefined;
  }

  private actor(userId?: string) {
    return { agentId: AgentId('sitepilot-agent'), ...(userId ? { userId } : {}) };
  }

  private async clientFor(tenantId: string): Promise<typegraphInstance> {
    if (!tenantId || tenantId.length > 200) throw new ServiceUnavailableException('TYPEGRAPH_TENANT_REQUIRED');
    let client = this.clients.get(tenantId);
    if (client) {
      this.clients.delete(tenantId);
      this.clients.set(tenantId, client);
    }
    if (!client) {
      client = typegraphInit(typegraphConfig(this.pool, this.embeddings, tenantId));
      this.clients.set(tenantId, client);
      client.catch(() => this.clients.delete(tenantId));
      if (this.clients.size > TypegraphService.maxTenantClients) {
        const oldest = [...this.clients.keys()].find(id => id !== config.tenantId);
        if (oldest) this.clients.delete(oldest);
      }
    }
    return client;
  }
}
