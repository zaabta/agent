import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TypegraphService, type TypegraphIngestProgress } from '../typegraph/typegraph.service.js';
import { parseDocument } from './parser.js';
import { DocumentStorageService } from './document-storage.service.js';
import type { ProcessDocumentJob } from './document-queue.service.js';
import { redisConnection } from './redis-connection.js';
import { WorkerMonitoringService } from './worker-monitoring.service.js';
import { CHUNKER_VERSION, smartChunk } from './smart-chunker.js';

@Injectable()
export class DocumentProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentProcessorService.name);
  private worker?: Worker<ProcessDocumentJob>;
  private readonly activeJobIds = new Set<string>();
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TypegraphService) private readonly typegraph: TypegraphService,
    @Inject(DocumentStorageService) private readonly storage: DocumentStorageService,
    @Inject(WorkerMonitoringService) private readonly monitoring: WorkerMonitoringService,
  ) {}

  onModuleInit() {
    this.worker = new Worker<ProcessDocumentJob>(config.documentQueue, job => this.process(job), {
      connection: redisConnection(config.redisUrl), concurrency: config.documentWorkerConcurrency,
    });
    this.monitoring.startHeartbeat();
    this.worker.on('active', job => { if (job.id) this.activeJobIds.add(job.id); this.updateWorkerActivity(); });
    this.worker.on('completed', job => { if (job.id) this.activeJobIds.delete(job.id); this.updateWorkerActivity(); });
    this.worker.on('failed', (job, error) => { if (job) void this.failed(job, error); });
    this.worker.on('failed', job => { if (job?.id) this.activeJobIds.delete(job.id); this.updateWorkerActivity(); });
    this.worker.on('error', error => this.logger.error(`Document worker transport error: ${error.message}`));
    this.worker.on('completed', job => { if (!job.data.versionId) void this.storage.cleanup(job.data.storageKey).catch(() => undefined); });
  }

  async onModuleDestroy() { await this.monitoring.stopHeartbeat(); await this.worker?.close(); }

  private updateWorkerActivity() {
    this.monitoring.setActivity(this.activeJobIds.size ? 'busy' : 'idle');
  }

  private async process(job: Job<ProcessDocumentJob>) {
    const data = job.data;
    const attempt = job.attemptsMade + 1;
    const owned = await this.prisma.appDocument.findFirst({ where: { id: data.documentId, tenantId: data.tenantId } });
    const version = data.versionId ? await this.prisma.appDocumentVersion.findFirst({ where: { id: data.versionId, documentId: data.documentId, tenantId: data.tenantId, jobId: job.id } }) : null;
    if (!owned || (data.versionId && !version)) throw new Error('DOCUMENT_JOB_NOT_FOUND');
    const cancelled = async () => {
      const doc = await this.prisma.appDocument.findFirst({ where: { id: data.documentId, tenantId: data.tenantId }, select: { cancelRequested: true } });
      if (!doc || doc.cancelRequested) return true;
      if (data.versionId) {
        const versionState = await this.prisma.appDocumentVersion.findFirst({ where: { id: data.versionId, tenantId: data.tenantId }, select: { cancelRequested: true } });
        return !versionState || versionState.cancelRequested;
      }
      return false;
    };
    const markCancelled = async () => {
      const state = await this.prisma.appDocument.findFirst({ where: { id: data.documentId, tenantId: data.tenantId }, select: { deleteRequested: true } });
      await this.prisma.documentProgressEvent.updateMany({ where: { documentId: data.documentId, tenantId: data.tenantId, jobId: job.id!, status: 'running' }, data: { status: 'cancelled', finishedAt: new Date() } });
      if (data.versionId) {
        const versionState = await this.prisma.appDocumentVersion.findFirst({ where: { id: data.versionId, tenantId: data.tenantId }, select: { indexGeneration: true } });
        await this.prisma.appDocumentVersion.updateMany({ where: { id: data.versionId, tenantId: data.tenantId, jobId: job.id }, data: { status: 'cancelled', publishRequested: false } });
        if (versionState) await this.typegraph.deleteDocumentScope(data.documentId, data.versionId, data.tenantId, data.userId, versionState.indexGeneration).catch(() => undefined);
        await this.prisma.appDocument.updateMany({ where: { id: data.documentId, tenantId: data.tenantId, activeVersionId: null, jobId: job.id }, data: { status: 'cancelled', stage: 'cancelled', progress: null, completedAt: new Date(), storageKey: null } });
      }
      else {
        await this.prisma.appDocument.updateMany({ where: { id: data.documentId, tenantId: data.tenantId }, data: { status: 'cancelled', stage: 'cancelled', progress: null, completedAt: new Date(), storageKey: null } });
        await this.prisma.appDocumentCell.deleteMany({ where: { documentId: data.documentId, tenantId: data.tenantId } });
      }
      if (!data.versionId) await this.storage.cleanup(data.storageKey);
      if (state?.deleteRequested) {
        await this.typegraph.deleteDocumentScope(data.documentId, undefined, data.tenantId, data.userId).catch(() => undefined);
        const versionFiles = await this.prisma.appDocumentVersion.findMany({ where: { documentId: data.documentId, tenantId: data.tenantId }, select: { storageKey: true } });
        await Promise.all(versionFiles.map(file => this.storage.cleanup(file.storageKey).catch(() => undefined)));
        await this.prisma.appDocument.deleteMany({ where: { id: data.documentId, tenantId: data.tenantId } });
      }
    };
    if (await cancelled()) { await markCancelled(); return { status: 'cancelled' }; }

    await this.stage(job, 'verification', attempt);
    const path = this.storage.pathFor(data.storageKey);
    const buffer = await readFile(path);
    if (buffer.length !== data.fileSize || createHash('sha256').update(buffer).digest('hex') !== data.checksum) throw new Error('UPLOAD_INTEGRITY_CHECK_FAILED');
    await this.finishStage(job, 'verification', attempt);
    if (await cancelled()) { await markCancelled(); return { status: 'cancelled' }; }

    await this.stage(job, 'parsing', attempt);
    const parsed = await parseDocument(data.filename, buffer);
    const parsedRows = parsed.structuredCells?.length
      ? new Set(parsed.structuredCells.map(cell => `${cell.sheetName}:${cell.rowNumber}`)).size
      : undefined;
    await this.finishStage(job, 'parsing', attempt, parsedRows, parsedRows, parsedRows === undefined ? undefined : 'rows');
    if (await cancelled()) { await markCancelled(); return { status: 'cancelled' }; }

    await this.stage(job, 'smart_chunking', attempt);
    const chunks = smartChunk(parsed.text, parsed.extension, { documentId: data.documentId, originalFilename: data.filename, ...(data.versionId ? { documentVersionId: data.versionId } : {}) }, parsed.structuredCells);
    await this.finishStage(job, 'smart_chunking', attempt, chunks.length, chunks.length, 'chunks');
    if (data.versionId) await this.prisma.appDocumentVersion.updateMany({ where: { id: data.versionId, tenantId: data.tenantId, jobId: job.id }, data: { indexedChunkCount: chunks.length, chunkingStrategy: 'structure-aware', chunkerVersion: CHUNKER_VERSION, embeddingModel: `ollama/${config.embedModel}`, embeddingDimensions: config.embedDimensions } });
    if (await cancelled()) { await markCancelled(); return { status: 'cancelled' }; }

    await this.stage(job, 'indexing', attempt);
    let progressStage: string | undefined;
    let progressDone = 0;
    let progressTotal: number | undefined;
    let lastProgressWriteAt = 0;
    let progressWrite = Promise.resolve();
    const phaseStage = (phase: string) => ({
      fetch: 'preparing', hash_check: 'checking', embed: 'embedding', store: 'persisting', prune: 'pruning',
    }[phase] || 'indexing');
    const reportIndexProgress = (event: TypegraphIngestProgress) => {
      const nextStage = phaseStage(event.phase);
      const now = Date.now();
      const total = Number.isFinite(event.total) && event.total >= 0 ? event.total : undefined;
      const done = Number.isFinite(event.done) && event.done >= 0 ? event.done : 0;
      const threshold = total && total > 0 ? Math.max(1, Math.ceil(total * 0.05)) : 1;
      const phaseChanged = progressStage !== nextStage;
      if (!phaseChanged && done < (progressDone + threshold) && done !== total && now - lastProgressWriteAt < 2000) return;
      progressStage = nextStage;
      progressDone = done;
      progressTotal = total;
      lastProgressWriteAt = now;
      const unit = event.phase === 'embed' || event.phase === 'store' ? 'chunks' : 'documents';
      // TypeGraph invokes this callback at real SDK phase boundaries. Coalesce
      // frequent callbacks to a 5% or 2s persistence cadence on CPU-only hosts.
      progressWrite = progressWrite.then(async () => {
        const timestamp = new Date();
        if (phaseChanged) {
          await this.prisma.$transaction([
            this.prisma.documentProgressEvent.updateMany({
              where: { documentId: data.documentId, tenantId: data.tenantId, jobId: job.id!, attempt, status: 'running' },
              data: { status: 'completed', finishedAt: timestamp },
            }),
            this.prisma.appDocument.updateMany({
              where: { id: data.documentId, tenantId: data.tenantId, ...(data.versionId ? { activeVersionId: null, jobId: job.id } : {}) },
              data: { status: 'processing', stage: nextStage, progress: null },
            }),
            this.prisma.documentProgressEvent.create({ data: {
              documentId: data.documentId, tenantId: data.tenantId, jobId: job.id!, attempt,
              stage: nextStage, status: 'running', startedAt: timestamp,
              completedUnits: done, totalUnits: total ?? null, unit,
            } }),
          ]);
        } else {
          await this.prisma.documentProgressEvent.updateMany({
            where: { documentId: data.documentId, tenantId: data.tenantId, jobId: job.id!, attempt, stage: nextStage, status: 'running' },
            data: { completedUnits: done, totalUnits: total ?? null, unit },
          });
        }
        await job.updateProgress({ stage: nextStage, phase: event.phase, attempt, completedUnits: done, totalUnits: total ?? null, unit, etaMs: null });
      }).catch(error => { this.logger.warn(`Could not persist TypeGraph progress for job ${job.id}: ${String(error)}`); });
    };
    const ingestAbort = new AbortController();
    let cancelling = false;
    const cancellationPoll = setInterval(() => {
      void cancelled().then(requested => {
        if (requested) {
          cancelling = true;
          ingestAbort.abort(new Error('DOCUMENT_JOB_CANCELLED'));
        }
      }).catch(error => this.logger.warn(`Cancellation poll failed for job ${job.id}: ${String(error)}`));
    }, 100);
    let indexed;
    try {
      indexed = await this.typegraph.ingestDocument({
        id: data.documentId, name: data.filename, content: parsed.text,
        metadata: { documentId: data.documentId, ...(data.versionId ? { documentVersionId: data.versionId, indexGeneration: version?.indexGeneration ?? 1 } : {}), tenantId: data.tenantId, fileType: parsed.extension, originalFilename: data.filename, checksum: data.checksum, chunkerVersion: CHUNKER_VERSION },
      }, ingestAbort.signal, data.tenantId, data.userId, config.typegraphGraphExtraction, reportIndexProgress, chunks);
    } catch (error) {
      if (!cancelling && !await cancelled()) throw error;
      if (!data.versionId) await this.typegraph.deleteDocumentScope(data.documentId, undefined, data.tenantId, data.userId).catch(() => undefined);
      await markCancelled();
      return { status: 'cancelled' };
    } finally {
      clearInterval(cancellationPoll);
    }
    await progressWrite;
    if (indexed.result.failedAt || indexed.result.status !== 'complete') {
      const failed = indexed.result.failedAt;
      throw new Error(failed ? `TYPEGRAPH_INDEX_FAILED_${failed.phase}` : 'TYPEGRAPH_INDEX_INCOMPLETE');
    }
    if (indexed.timing.embeddingMs > 0) {
      await this.prisma.documentProgressEvent.updateMany({
        where: { documentId: data.documentId, tenantId: data.tenantId, jobId: job.id!, attempt, stage: 'embedding' },
        data: { embeddingDurationMs: indexed.timing.embeddingMs },
      });
    }
    if (progressStage) {
      await this.finishStage(job, progressStage, attempt, progressDone, progressTotal, progressStage === 'embedding' || progressStage === 'persisting' ? 'chunks' : 'documents', progressStage === 'embedding' ? indexed.timing.embeddingMs : undefined);
    } else {
      await this.finishStage(job, 'indexing', attempt, indexed.result.total, indexed.result.total, 'chunks', indexed.timing.embeddingMs);
    }
    if (await cancelled()) {
      if (!data.versionId) await this.typegraph.deleteDocumentScope(data.documentId, undefined, data.tenantId, data.userId);
      await markCancelled();
      return { status: 'cancelled' };
    }
    await this.stage(job, 'publication', attempt);
    const committedAt = new Date();
    let previousActiveVersionId: string | null = null;
    let didPublishVersion = false;
    const completedCount = await this.prisma.$transaction(async tx => {
      let completedCount = 0;
      let publish = true;
      if (data.versionId) {
        const parent = await tx.appDocument.findFirst({ where: { id: data.documentId, tenantId: data.tenantId }, select: { activeVersionId: true } });
        previousActiveVersionId = parent?.activeVersionId ?? null;
        const publishRequested = Boolean(version?.publishRequested);
        const publishedVersion = await tx.appDocumentVersion.updateMany({ where: { id: data.versionId, documentId: data.documentId, tenantId: data.tenantId, jobId: job.id, cancelRequested: false }, data: { status: 'ready', activeIndexGeneration: version?.indexGeneration ?? 1, publishRequested: false } });
        completedCount = publishedVersion.count;
        const newest = await tx.appDocumentVersion.findFirst({ where: { documentId: data.documentId, tenantId: data.tenantId }, orderBy: { versionNumber: 'desc' }, select: { id: true } });
        publish = newest?.id === data.versionId || publishRequested;
        if (completedCount && publish) {
          didPublishVersion = true;
          const active = await tx.appDocument.updateMany({ where: { id: data.documentId, tenantId: data.tenantId, cancelRequested: false }, data: { activeVersionId: data.versionId, filename: version!.filename, fileType: version!.filename.split('.').at(-1) || 'unknown', fileSize: version!.fileSize, status: 'ready', stage: 'completed', progress: 100, completedAt: committedAt, errorCode: null, failureCode: null, storageKey: null } });
          if (!active.count) completedCount = 0;
          if (parsed.structuredCells?.length && active.count) {
            await tx.appDocumentCell.createMany({ data: parsed.structuredCells.map(cell => ({ ...cell, documentId: data.documentId, tenantId: data.tenantId, versionId: data.versionId })), skipDuplicates: true });
          }
        }
      } else {
        const completed = await tx.appDocument.updateMany({ where: { id: data.documentId, tenantId: data.tenantId, cancelRequested: false }, data: { status: 'ready', stage: 'completed', progress: 100, completedAt: committedAt, errorCode: null, failureCode: null, storageKey: null } });
        completedCount = completed.count;
        if (completed.count && parsed.structuredCells?.length) {
          await tx.appDocumentCell.deleteMany({ where: { documentId: data.documentId, tenantId: data.tenantId } });
          await tx.appDocumentCell.createMany({ data: parsed.structuredCells.map(cell => ({ ...cell, documentId: data.documentId, tenantId: data.tenantId })), skipDuplicates: true });
        }
      }
      if (completedCount) {
        await tx.documentProgressEvent.updateMany({
          where: { documentId: data.documentId, tenantId: data.tenantId, jobId: job.id!, attempt, stage: 'publication', status: 'running' },
          data: { status: 'completed', finishedAt: committedAt },
        });
        await tx.documentProgressEvent.create({ data: {
          documentId: data.documentId, tenantId: data.tenantId, jobId: job.id!, attempt,
          stage: 'completed', status: 'completed', startedAt: committedAt, finishedAt: committedAt,
        } });
      }
      return completedCount;
    }, { isolationLevel: 'Serializable' });
    if (completedCount && didPublishVersion && data.versionId && previousActiveVersionId && previousActiveVersionId !== data.versionId) {
      const previous = await this.prisma.appDocumentVersion.findFirst({ where: { id: previousActiveVersionId, tenantId: data.tenantId }, select: { chunkingStrategy: true, storageKey: true } });
      if (previous?.chunkingStrategy !== 'legacy' || previous.storageKey) {
        const prune = previous?.chunkingStrategy === 'legacy'
          ? this.typegraph.deleteLegacyDocumentScope(data.documentId, data.tenantId)
          : this.typegraph.deleteDocumentScope(data.documentId, previousActiveVersionId, data.tenantId);
        await prune.catch(error => this.logger.warn(`Could not prune superseded vectors for document ${data.documentId}: ${String(error)}`));
      }
    }
    if (completedCount === 0) {
      if (!data.versionId) await this.typegraph.deleteDocument(data.documentId, data.tenantId, data.userId);
      await markCancelled();
      return { status: 'cancelled' };
    }
    await job.updateProgress({ stage: 'completed', attempt, percent: 100, etaMs: null });
    return { status: 'completed', indexedChunks: indexed.result.total };
  }

  private async stage(job: Job<ProcessDocumentJob>, stage: string, attempt: number) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.documentProgressEvent.updateMany({
        where: { documentId: job.data.documentId, tenantId: job.data.tenantId, jobId: job.id!, finishedAt: null },
        data: { status: 'completed', finishedAt: now },
      }),
      this.prisma.appDocument.updateMany({
        where: { id: job.data.documentId, tenantId: job.data.tenantId, ...(job.data.versionId ? { activeVersionId: null, jobId: job.id } : {}) },
        data: { status: 'processing', stage, progress: null, retryCount: Math.max(0, attempt - 1) },
      }),
      ...(job.data.versionId ? [this.prisma.appDocumentVersion.updateMany({ where: { id: job.data.versionId, tenantId: job.data.tenantId, jobId: job.id }, data: { status: 'processing' } })] : []),
      this.prisma.documentProgressEvent.create({ data: {
        documentId: job.data.documentId, tenantId: job.data.tenantId, jobId: job.id!, attempt,
        stage, status: 'running', startedAt: now,
      } }),
    ]);
    // The queue copy is useful for operator inspection; Prisma remains the
    // API's durable source for progress and replayable transitions.
    await job.updateProgress({ stage, attempt, percent: null, completedUnits: null, totalUnits: null, etaMs: null });
  }

  private async finishStage(job: Job<ProcessDocumentJob>, stage: string, attempt: number, completedUnits?: number, totalUnits?: number, unit?: string, embeddingDurationMs?: number) {
    const now = new Date();
    await this.prisma.documentProgressEvent.updateMany({
      where: { documentId: job.data.documentId, tenantId: job.data.tenantId, jobId: job.id!, attempt, stage, status: 'running' },
      data: {
        status: 'completed', finishedAt: now,
        ...(completedUnits !== undefined ? { completedUnits } : {}),
        ...(totalUnits !== undefined ? { totalUnits } : {}),
        ...(unit ? { unit } : {}),
        ...(embeddingDurationMs !== undefined ? { embeddingDurationMs } : {}),
      },
    });
  }

  private async failed(job: Job<ProcessDocumentJob>, error: Error) {
    const attempts = job.opts.attempts || 1;
    const terminal = job.attemptsMade >= attempts;
    const code = error.message.match(/^[A-Z][A-Z0-9_]+/)?.[0] || 'PROCESSING_FAILED';
    const current = await this.prisma.appDocument.findFirst({ where: { id: job.data.documentId, tenantId: job.data.tenantId }, select: { cancelRequested: true, deleteRequested: true } }).catch(() => null);
    if (current?.cancelRequested) {
      await this.prisma.documentProgressEvent.updateMany({ where: { documentId: job.data.documentId, tenantId: job.data.tenantId, jobId: job.id!, status: 'running' }, data: { status: 'cancelled', finishedAt: new Date() } }).catch(() => undefined);
      if (job.data.versionId) {
        const version = await this.prisma.appDocumentVersion.findFirst({ where: { id: job.data.versionId, tenantId: job.data.tenantId }, select: { indexGeneration: true } }).catch(() => null);
        await this.prisma.appDocumentVersion.updateMany({ where: { id: job.data.versionId, tenantId: job.data.tenantId, jobId: job.id }, data: { status: 'cancelled', publishRequested: false } }).catch(() => undefined);
        if (version) await this.typegraph.deleteDocumentScope(job.data.documentId, job.data.versionId, job.data.tenantId, job.data.userId, version.indexGeneration).catch(() => undefined);
        await this.prisma.appDocument.updateMany({ where: { id: job.data.documentId, tenantId: job.data.tenantId, activeVersionId: null, jobId: job.id }, data: { status: 'cancelled', stage: 'cancelled', progress: null, completedAt: new Date(), storageKey: null } }).catch(() => undefined);
      } else {
        await this.typegraph.deleteDocumentScope(job.data.documentId, undefined, job.data.tenantId, job.data.userId).catch(() => undefined);
        await this.prisma.appDocumentCell.deleteMany({ where: { documentId: job.data.documentId, tenantId: job.data.tenantId } }).catch(() => undefined);
        await this.prisma.appDocument.updateMany({ where: { id: job.data.documentId, tenantId: job.data.tenantId }, data: { status: 'cancelled', stage: 'cancelled', progress: null, completedAt: new Date(), storageKey: null } }).catch(() => undefined);
        await this.storage.cleanup(job.data.storageKey).catch(() => undefined);
      }
      if (current.deleteRequested) {
        await this.typegraph.deleteDocumentScope(job.data.documentId, undefined, job.data.tenantId, job.data.userId).catch(() => undefined);
        const versionFiles = await this.prisma.appDocumentVersion.findMany({ where: { documentId: job.data.documentId, tenantId: job.data.tenantId }, select: { storageKey: true } }).catch(() => []);
        await Promise.all(versionFiles.map(file => this.storage.cleanup(file.storageKey).catch(() => undefined)));
        await this.prisma.appDocument.deleteMany({ where: { id: job.data.documentId, tenantId: job.data.tenantId } }).catch(() => undefined);
      }
      return;
    }
    await this.prisma.documentProgressEvent.updateMany({
      where: { documentId: job.data.documentId, tenantId: job.data.tenantId, jobId: job.id!, attempt: job.attemptsMade, status: 'running' },
      data: { status: terminal ? 'failed' : 'retrying', finishedAt: new Date(), failureCode: code },
    }).catch(() => undefined);
    await this.prisma.appDocument.updateMany({ where: { id: job.data.documentId, tenantId: job.data.tenantId, ...(job.data.versionId ? { activeVersionId: null } : {}) }, data: {
      retryCount: job.attemptsMade,
      ...(terminal ? { status: 'failed', stage: 'failed', progress: null, failureCode: code, errorCode: code, completedAt: new Date(), storageKey: null } : { status: 'queued', stage: 'queued', progress: null, failureCode: code }),
    } }).catch(dbError => this.logger.error(`Could not persist job failure state: ${String(dbError)}`));
    if (job.data.versionId) await this.prisma.appDocumentVersion.updateMany({ where: { id: job.data.versionId, tenantId: job.data.tenantId, jobId: job.id }, data: { status: terminal ? 'failed' : 'queued' } }).catch(() => undefined);
    if (terminal) {
      if (job.data.versionId) {
        const version = await this.prisma.appDocumentVersion.findFirst({ where: { id: job.data.versionId, tenantId: job.data.tenantId }, select: { indexGeneration: true } }).catch(() => null);
        if (version) await this.typegraph.deleteDocumentScope(job.data.documentId, job.data.versionId, job.data.tenantId, job.data.userId, version.indexGeneration).catch(() => undefined);
      } else {
        await this.typegraph.deleteDocumentScope(job.data.documentId, undefined, job.data.tenantId, job.data.userId).catch(() => undefined);
        await this.prisma.appDocumentCell.deleteMany({ where: { documentId: job.data.documentId, tenantId: job.data.tenantId } }).catch(() => undefined);
        await this.storage.cleanup(job.data.storageKey).catch(() => undefined);
      }
    }
    this.logger.warn(`Document job ${job.id} ${terminal ? 'failed permanently' : 'will retry'} (${code})`);
  }
}
