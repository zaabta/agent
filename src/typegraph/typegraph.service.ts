import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { AgentId, typegraphInit, type QueryChunkResult, type typegraphInstance } from '@typegraph-ai/sdk';
import type { IndexProgressEvent } from '@typegraph-ai/sdk';
import { Pool } from 'pg';
import { config } from '../config.js';
import { EmbeddingsService } from './embeddings.service.js';
import { typegraphConfig } from './typegraph.config.js';
import type { SmartChunk } from '../documents/smart-chunker.js';
import { repairFilenameEncoding } from '../documents/display-name.js';
import { PrismaService } from '../prisma/prisma.service.js';

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
    documentVersionId?: string;
    chunkId?: string;
    contentHash?: string;
    paragraphStart?: number;
    paragraphEnd?: number;
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

  constructor(@Inject(EmbeddingsService) private readonly embeddings: EmbeddingsService, @Inject(PrismaService) private readonly prisma: PrismaService) {}

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

  async ingestDocument(document: { id: string; name: string; content: string; metadata: Record<string, unknown> }, abortSignal?: AbortSignal, tenantId = config.tenantId, userId?: string, graphExtraction = config.typegraphGraphExtraction, onProgress?: (event: TypegraphIngestProgress) => void, chunks?: SmartChunk[]) {
    const startedAt = performance.now();
    const client = await this.clientFor(tenantId);
    const inputs = chunks?.length ? chunks.map(chunk => ({
      id: `${document.id}::${String(document.metadata.documentVersionId || 'legacy')}::g${String(document.metadata.indexGeneration || 1)}::${chunk.id}`,
      name: document.name,
      content: chunk.content,
      metadata: { ...document.metadata, ...chunk, chunkId: chunk.id, chunkIndex: chunk.index, chunkCount: chunks.length },
    })) : document;
    const measured = await this.embeddings.measure(() => client.document.ingest(inputs, {
        bucketId: 'documents',
        context: this.actor(userId),
        // SDK 0.6 resolves chunk identity from deduplicateBy. Its default is
        // ['url']; uploads have no URL, so all documents otherwise share a key.
        deduplicateBy: ['id'],
        ...(chunks?.length ? { chunkSize: 2400, chunkOverlap: 0 } : {}),
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
    const active = await this.activeVersionScopes(tenantId);
    const activeIds = new Set(await this.activeTypegraphDocumentIds(client, userId, active));
    const documents: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    let offset = 0;
    while (true) {
      const page = await client.document.list({ bucketId: 'documents' }, { context: this.actor(userId) }, { limit: 500, offset });
      const items = Array.isArray(page) ? page : page.items;
      documents.push(...items.filter(document => activeIds.has(document.id)));
      if (items.length < 500) break;
      offset += items.length;
    }
    return { documents, durationMs: Math.round(performance.now() - startedAt) };
  }

  async deleteDocument(id: string, tenantId = config.tenantId, userId?: string) {
    const client = await this.clientFor(tenantId);
    return this.deleteDocumentScope(id, undefined, tenantId, userId);
  }

  async deleteDocumentScope(documentId: string, documentVersionId?: string, tenantId = config.tenantId, userId?: string, indexGeneration?: number) {
    const client = await this.clientFor(tenantId);
    const documents: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    let offset = 0;
    while (true) {
      const page = await client.document.list({ bucketId: 'documents' }, { context: this.actor(userId) }, { limit: 500, offset });
      const items = Array.isArray(page) ? page : page.items;
      documents.push(...items);
      if (items.length < 500) break;
      offset += items.length;
    }
    const ids = documents.filter(document => document.metadata.documentId === documentId &&
      (documentVersionId === undefined || document.metadata.documentVersionId === documentVersionId) &&
      (indexGeneration === undefined || Number(document.metadata.indexGeneration ?? 1) === indexGeneration)).map(document => document.id);
    if (!ids.includes(documentId) && documentVersionId === undefined) ids.push(documentId); // legacy TypeGraph identity
    if (!ids.length) return 0;
    return client.document.delete({ bucketId: 'documents', documentIds: ids }, { context: this.actor(userId) });
  }

  async deleteLegacyDocumentScope(documentId: string, tenantId = config.tenantId, userId?: string) {
    const client = await this.clientFor(tenantId);
    const documents: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    let offset = 0;
    while (true) {
      const page = await client.document.list({ bucketId: 'documents' }, { context: this.actor(userId) }, { limit: 500, offset });
      const items = Array.isArray(page) ? page : page.items;
      documents.push(...items);
      if (items.length < 500) break;
      offset += items.length;
    }
    const ids = documents.filter(document => (document.metadata.documentId === documentId && typeof document.metadata.documentVersionId !== 'string') || document.id === documentId).map(document => document.id);
    if (!ids.length) return 0;
    return client.document.delete({ bucketId: 'documents', documentIds: ids }, { context: this.actor(userId) });
  }

  async searchDocuments(query: string, limit = 5, tenantId = config.tenantId, userId?: string, abortSignal?: AbortSignal, minScore = config.typegraphMinScore): Promise<{
    query: string;
    hits: DocumentSearchHit[];
    timing: { embeddingMs: number; retrievalMs: number; searchMs: number };
  }> {
    const startedAt = performance.now();
    const client = await this.clientFor(tenantId);
    const candidateLimit = Math.min(Math.max(limit * 8, 16), 64);
    const activeScopes = await this.activeVersionScopes(tenantId);
    const indexedMetadata = new Map<string, Record<string, unknown>>();
    const candidateDocumentIds = await this.activeTypegraphDocumentIds(client, userId, activeScopes, query, indexedMetadata);
    if (!candidateDocumentIds.length) {
      return { query, hits: [], timing: { embeddingMs: 0, retrievalMs: 0, searchMs: Math.round(performance.now() - startedAt) } };
    }
    const measured = await this.embeddings.measure(() => client.search(query, {
        buckets: ['documents'],
        resources: config.typegraphGraphExtraction ? ['documents', 'entities', 'facts'] : ['documents'],
        weights: { semantic: 1, bm25: 1, graph: config.typegraphGraphExtraction ? 0.5 : false, recency: false },
        fusion: { method: 'rrf', k: 60 },
        // Graph-only additions are not constrained by documentIds in SDK 0.6.
        // Permit graph evidence only when it reinforces an already-authorized
        // indexed chunk, whose candidates were filtered before ranking.
        graphReinforcement: 'only',
        ...(config.typegraphRerank ? { rerank: { topK: candidateLimit } } : {}),
        limit: candidateLimit,
        // TypeGraph SDK 0.6 supports documentIds filtering before semantic,
        // BM25/hybrid fusion, and reranking. The IDs are enumerated from the
        // tenant's active published versions below; post-filtering remains a
        // second fail-closed check for publication races and stale index rows.
        documentFilter: { bucketId: 'documents', documentIds: candidateDocumentIds },
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
      hits: (await this.activeVersionHits(response.results.chunks, tenantId, new Set(candidateDocumentIds), indexedMetadata))
        .map(hit => this.toSearchHit(hit))
        .filter(hit => hit.score >= minScore)
        .slice(0, Math.min(Math.max(limit, 1), 8)),
      timing: {
        embeddingMs: Math.round(embeddingDurationMs),
        retrievalMs: Math.max(0, Math.round(searchDurationMs - embeddingDurationMs)),
        searchMs: Math.round(searchDurationMs),
      },
    };
  }

  private async activeVersionScopes(tenantId: string) {
    const docs = await this.prisma.appDocument.findMany({
      where: { tenantId, status: 'ready' },
      select: { id: true, tenantId: true, filename: true, checksum: true, status: true, stage: true, progress: true, completedAt: true, jobId: true, activeVersionId: true, cancelRequested: true, deleteRequested: true },
    });
    const activeVersionIds = docs.flatMap(doc => doc.activeVersionId ? [doc.activeVersionId] : []);
    const activeVersions = activeVersionIds.length ? await this.prisma.appDocumentVersion.findMany({
      where: { id: { in: activeVersionIds }, tenantId },
      select: { id: true, documentId: true, tenantId: true, filename: true, checksum: true, versionNumber: true, status: true, jobId: true, chunkingStrategy: true, indexGeneration: true, activeIndexGeneration: true },
    }) : [];
    // Some deployments upgraded the schema but retained a completed, ready
    // legacy document whose activeVersionId was never populated. Consider
    // only its matching v1 row; TypeGraph must also prove tenant, filename,
    // and checksum identity before the row becomes searchable.
    const recoverableDocs = docs.filter(doc => !doc.activeVersionId
      && Boolean(doc.checksum)
      && doc.stage === 'completed'
      && doc.progress === 100
      && Boolean(doc.completedAt)
      && !doc.cancelRequested
      && !doc.deleteRequested
      && Boolean(doc.jobId));
    const recoverableVersions = recoverableDocs.length ? await this.prisma.appDocumentVersion.findMany({
      where: {
        tenantId,
        documentId: { in: recoverableDocs.map(doc => doc.id) },
        versionNumber: 1,
        checksum: { in: [...new Set(recoverableDocs.map(doc => doc.checksum).filter((checksum): checksum is string => Boolean(checksum)))] },
      },
      select: { id: true, documentId: true, tenantId: true, filename: true, checksum: true, versionNumber: true, status: true, jobId: true, chunkingStrategy: true, indexGeneration: true, activeIndexGeneration: true },
    }) : [];
    const versions = [...activeVersions, ...recoverableVersions];
    return new Map(docs.map(doc => {
      const version = doc.activeVersionId
        ? versions.find(item => item.id === doc.activeVersionId)
        : recoverableVersions.find(item => item.documentId === doc.id
          && item.tenantId === doc.tenantId
          && item.versionNumber === 1
          && item.filename === doc.filename
          && item.checksum === doc.checksum
          && item.jobId === doc.jobId
          && ['queued', 'ready'].includes(item.status)
          && (item.chunkingStrategy === null || item.chunkingStrategy === 'legacy'));
      const recoveredLegacy = !doc.activeVersionId && Boolean(version);
      return [doc.id, {
        versionId: doc.activeVersionId ?? (recoveredLegacy ? version?.id ?? null : null),
        activeGeneration: version?.activeIndexGeneration ?? (recoveredLegacy ? version?.indexGeneration ?? 1 : null),
        legacy: Boolean(version && (version.chunkingStrategy === 'legacy' || recoveredLegacy)),
        tenantId: doc.tenantId,
        filename: doc.filename,
        checksum: doc.checksum,
      }] as const;
    }));
  }

  private async activeTypegraphDocumentIds(client: typegraphInstance, userId: string | undefined, active: Awaited<ReturnType<TypegraphService['activeVersionScopes']>>, query?: string, indexedMetadata?: Map<string, Record<string, unknown>>) {
    const ids: string[] = [];
    const filenameMatches: string[] = [];
    const normalizedQuery = query?.normalize('NFC').toLocaleLowerCase();
    const pageSize = 2000;
    const collect = (items: Array<{ id: string; name?: string; metadata: Record<string, unknown> }>) => {
      for (const document of items) {
        const logicalId = typeof document.metadata.documentId === 'string' ? document.metadata.documentId : document.id.split('::')[0]!;
        const scope = active.get(logicalId);
        if (!scope || !scope.versionId) continue;
        if (typeof document.metadata.tenantId === 'string' && document.metadata.tenantId !== scope.tenantId) continue;
        const indexedVersionId = document.metadata.documentVersionId;
        let isActive = false;
        if (typeof indexedVersionId === 'string') {
          isActive = indexedVersionId === scope.versionId && Number(document.metadata.indexGeneration ?? 1) === scope.activeGeneration;
        } else {
          const originalFilename = typeof document.metadata.originalFilename === 'string' ? document.metadata.originalFilename : document.name;
          isActive = scope.legacy
            && document.id === logicalId
            && document.metadata.tenantId === scope.tenantId
            && document.metadata.checksum === scope.checksum
            && originalFilename === scope.filename;
        }
        if (isActive) {
          indexedMetadata?.set(document.id, document.metadata);
          ids.push(document.id);
          const names = [document.name, document.metadata.originalFilename].filter((name): name is string => typeof name === 'string');
          if (normalizedQuery && names.some(name => {
            const normalizedName = name.normalize('NFC').toLocaleLowerCase();
            const index = normalizedQuery.indexOf(normalizedName);
            const isWord = (character: string | undefined) => Boolean(character && /[\p{L}\p{N}_]/u.test(character));
            return index >= 0 && !isWord(normalizedQuery[index - 1]) && !isWord(normalizedQuery[index + normalizedName.length]);
          })) filenameMatches.push(document.id);
        }
      }
    };
    const firstPage = await client.document.list({ bucketId: 'documents' }, { context: this.actor(userId) }, { limit: pageSize, offset: 0 });
    const firstItems = Array.isArray(firstPage) ? firstPage : firstPage.items;
    collect(firstItems);
    if (!Array.isArray(firstPage)) {
      const pageCount = Math.ceil(firstPage.total / pageSize);
      const remaining = await Promise.all(Array.from({ length: Math.max(0, pageCount - 1) }, (_, pageIndex) =>
        client.document.list({ bucketId: 'documents' }, { context: this.actor(userId) }, { limit: pageSize, offset: (pageIndex + 1) * pageSize }),
      ));
      for (const page of remaining) collect(Array.isArray(page) ? page : page.items);
    }
    // When the request contains an exact indexed filename, constrain retrieval
    // to that file before semantic/BM25 fusion and reranking. If no exact name
    // was found, retain normal tenant-scoped semantic search behavior.
    return filenameMatches.length ? [...new Set(filenameMatches)] : ids;
  }

  private async activeVersionHits(chunks: QueryChunkResult[], tenantId: string, authorizedIndexIds: Set<string>, indexedMetadata = new Map<string, Record<string, unknown>>()) {
    const active = await this.activeVersionScopes(tenantId);
    return chunks.flatMap(hit => {
      // Keep a second check against the IDs authorized before TypeGraph
      // ranking. SDK 0.6 returns custom metadata on list(), but search hits
      // project only basic metadata; version identity lives in the ID.
      if (!authorizedIndexIds.has(hit.document.id)) return [];
      const identity = this.indexIdentity(hit.document.id, hit.metadata);
      if (!identity) return [];
      const { id, versionId, generation } = identity;
      const state = active.get(id);
      if (!state || !state.versionId) return [];
      if (versionId) {
        return state.versionId === versionId && generation === state.activeGeneration
          ? [{ ...hit, metadata: { ...hit.metadata, ...indexedMetadata.get(hit.document.id), documentId: id, documentVersionId: versionId, indexGeneration: generation } }]
          : [];
      }
      return state.legacy && hit.document.id === id
        ? [{ ...hit, metadata: { ...hit.metadata, ...indexedMetadata.get(hit.document.id), documentId: id, documentVersionId: state.versionId, indexGeneration: state.activeGeneration } }]
        : [];
    });
  }

  private indexIdentity(indexId: string, metadata: Record<string, unknown>) {
    const parts = indexId.split('::');
    const idFromIndex = parts[0];
    const idFromMetadata = typeof metadata.documentId === 'string' ? metadata.documentId : undefined;
    if (!idFromIndex || (idFromMetadata && idFromMetadata !== idFromIndex)) return undefined;
    const versionFromIndex = parts.length >= 4 && /^g\d+$/.test(parts[2]!) ? parts[1] : undefined;
    const generationFromIndex = versionFromIndex ? Number(parts[2]!.slice(1)) : undefined;
    const versionFromMetadata = typeof metadata.documentVersionId === 'string' ? metadata.documentVersionId : undefined;
    const generationFromMetadata = Number.isInteger(metadata.indexGeneration) ? Number(metadata.indexGeneration) : undefined;
    if (versionFromIndex && versionFromMetadata && versionFromIndex !== versionFromMetadata) return undefined;
    if (generationFromIndex !== undefined && generationFromMetadata !== undefined && generationFromIndex !== generationFromMetadata) return undefined;
    return {
      id: idFromMetadata ?? idFromIndex,
      versionId: versionFromMetadata ?? versionFromIndex,
      generation: generationFromMetadata ?? generationFromIndex,
    };
  }

  private toSearchHit(hit: QueryChunkResult): DocumentSearchHit {
    const filename = repairFilenameEncoding(hit.document.name);
    const chunkIndex = Number.isInteger(hit.metadata.chunkIndex) && Number(hit.metadata.chunkIndex) >= 0 ? Number(hit.metadata.chunkIndex) : hit.chunk.index;
    const location = this.sourceLocation(hit.content, hit.metadata);
    const sourceRef = `${filename} (${location || `chunk ${chunkIndex + 1}`})`;
    return {
      content: hit.content,
      score: hit.score,
      sourceRef,
      citation: {
        documentId: typeof hit.metadata.documentId === 'string' ? hit.metadata.documentId : hit.document.id.split('::')[0]!,
        filename,
        bucketId: hit.document.bucketId,
        chunkIndex: Number.isInteger(hit.metadata.chunkIndex) ? Number(hit.metadata.chunkIndex) : chunkIndex,
        chunkCount: Number.isInteger(hit.metadata.chunkCount) ? Number(hit.metadata.chunkCount) : hit.chunk.total,
        ...(location ? { location } : {}),
        ...(typeof hit.metadata.documentVersionId === 'string' ? { documentVersionId: hit.metadata.documentVersionId } : {}),
        ...(typeof hit.metadata.chunkId === 'string' ? { chunkId: hit.metadata.chunkId } : {}),
        ...(typeof hit.metadata.contentHash === 'string' ? { contentHash: hit.metadata.contentHash } : {}),
        ...(Number.isInteger(hit.metadata.paragraphStart) ? { paragraphStart: Number(hit.metadata.paragraphStart) } : {}),
        ...(Number.isInteger(hit.metadata.paragraphEnd) ? { paragraphEnd: Number(hit.metadata.paragraphEnd) } : {}),
      },
      metadata: hit.metadata,
    };
  }

  private sourceLocation(content: string, metadata: Record<string, unknown> = {}): string | undefined {
    if (Number.isInteger(metadata.pageNumber)) return `page ${metadata.pageNumber}`;
    if (Array.isArray(metadata.headingPath) && metadata.headingPath.length) return `section ${metadata.headingPath.join(' › ')}${Number.isInteger(metadata.paragraphStart) ? `, paragraph${metadata.paragraphStart === metadata.paragraphEnd ? '' : 's'} ${metadata.paragraphStart}${metadata.paragraphStart === metadata.paragraphEnd ? '' : `-${metadata.paragraphEnd}`}` : ''}`;
    if (typeof metadata.sheetName === 'string' && Number.isInteger(metadata.rowStart)) {
      const rows = metadata.rowStart === metadata.rowEnd ? `row ${metadata.rowStart}` : `rows ${metadata.rowStart}-${metadata.rowEnd}`;
      return `sheet ${metadata.sheetName}, ${rows}${typeof metadata.cellRange === 'string' ? `, cells ${metadata.cellRange}` : ''}`;
    }
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
