import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { config } from '../config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TypegraphService } from '../typegraph/typegraph.service.js';
import { DocumentQueueService } from './document-queue.service.js';
import { DocumentStorageService } from './document-storage.service.js';
import { SUPPORTED_EXTENSIONS } from './parser.js';
import { safeDisplayName } from './display-name.js';

const MIME_BY_EXTENSION: Record<string, string[]> = {
  '.md': ['text/markdown', 'text/plain', 'application/octet-stream'],
  '.txt': ['text/plain', 'application/octet-stream'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream'],
  '.pdf': ['application/pdf', 'application/octet-stream'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream'],
  '.xls': ['application/vnd.ms-excel', 'application/octet-stream'],
  '.csv': ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'],
};

function validateSignature(extension: string, data: Buffer) {
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  const checks: Record<string, boolean> = {
    '.md': data.length > 0, '.txt': data.length > 0,
    '.docx': isZip, '.xlsx': isZip,
    '.pdf': data.subarray(0, 5).toString('ascii') === '%PDF-',
    '.xls': data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0,
    '.csv': data.length > 0,
  };
  if (!checks[extension]) throw new BadRequestException('FILE_SIGNATURE_MISMATCH');
}

@Injectable()
export class DocumentsService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TypegraphService) private readonly typegraph: TypegraphService,
    @Inject(DocumentQueueService) private readonly queue: DocumentQueueService,
    @Inject(DocumentStorageService) private readonly storage: DocumentStorageService,
  ) {}

  async onModuleInit() {
    await this.storage.ensureRoot();
    const entries = await readdir(this.storage.root, { withFileTypes: true });
    const stale: Array<{ key: string; modifiedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(entry.name)) continue;
      const details = await stat(this.storage.pathFor(entry.name)).catch(() => null);
      if (details && Date.now() - details.mtimeMs > 24 * 60 * 60 * 1000) stale.push({ key: entry.name, modifiedAt: details.mtimeMs });
    }
    if (!stale.length) return;
    const [referenced, versionFiles] = await Promise.all([
      this.prisma.appDocument.findMany({ where: { storageKey: { in: stale.map(file => file.key) } }, select: { storageKey: true } }),
      this.prisma.appDocumentVersion.findMany({ where: { storageKey: { in: stale.map(file => file.key) } }, select: { storageKey: true } }),
    ]);
    const live = new Set([...referenced, ...versionFiles].flatMap(item => item.storageKey ? [item.storageKey] : []));
    await Promise.all(stale.filter(file => !live.has(file.key)).map(file => this.storage.cleanup(file.key)));
  }
  private safeDocument<T extends { fileSize: bigint | null; filename: string }>(document: T) {
    return { ...document, filename: safeDisplayName(document.filename), fileSize: document.fileSize == null ? null : Number(document.fileSize) };
  }

  async list(tenantId = config.tenantId) {
    const documents = await this.prisma.appDocument.findMany({
      where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, filename: true, fileType: true, status: true, stage: true, progress: true, jobId: true, retryCount: true, failureCode: true, fileSize: true, activeVersionId: true, createdAt: true, updatedAt: true, completedAt: true },
    });
    return documents.map(document => this.safeDocument(document));
  }

  async get(id: string, tenantId = config.tenantId) {
    const document = await this.prisma.appDocument.findFirst({ where: { id, tenantId }, select: { id: true, filename: true, fileType: true, status: true, stage: true, progress: true, jobId: true, retryCount: true, failureCode: true, fileSize: true, activeVersionId: true, createdAt: true, updatedAt: true, completedAt: true } });
    if (!document) throw new NotFoundException('DOCUMENT_NOT_FOUND');
    return this.safeDocument(document);
  }

  async search(query: string, tenantId = config.tenantId, userId?: string, limit = 5) {
    // A direct search UI should show TypeGraph's ranked candidates for the
    // user to inspect. Keep the stricter minimum-score cutoff for Agent/RAG
    // grounding, where weak passages must not be offered as evidence.
    const result = await this.typegraph.searchDocuments(query, limit, tenantId, userId, undefined, 0);
    // TypeGraph owns retrieval. Prisma is consulted only to avoid returning
    // results from a document whose application record is not yet published.
    const visible = await this.prisma.appDocument.findMany({
      where: { tenantId, status: 'ready' }, select: { id: true },
    });
    const visibleIds = new Set(visible.map(document => document.id));
    return {
      query: result.query,
      hits: result.hits.filter(hit => visibleIds.has(hit.citation.documentId)).map(hit => ({
        content: hit.content,
        score: hit.score,
        sourceRef: hit.sourceRef,
        citation: hit.citation,
      })),
      timing: result.timing,
    };
  }

  private async recoverQueuedUpload(documentId: string, tenantId: string, userId?: string, versionId?: string) {
    // SQL commit and Redis enqueue are separate. Re-uploading the same file can
    // safely restore an absent queued job using BullMQ's existing stable job ID.
    // Never restart processing, completed, failed or cancelled versions here.
    const version = await this.prisma.appDocumentVersion.findFirst({
      where: { documentId, tenantId, ...(versionId ? { id: versionId } : {}), status: 'queued', cancelRequested: false, document: { cancelRequested: false, deleteRequested: false } },
      orderBy: { versionNumber: 'desc' },
    });
    if (!version?.jobId || !version.storageKey || !version.checksum || await this.queue.queue.getJob(version.jobId)) return;
    await this.queue.enqueue({ documentId, versionId: version.id, tenantId, userId, storageKey: version.storageKey, filename: version.filename, checksum: version.checksum, fileSize: Number(version.fileSize) }, version.jobId);
  }

  async upload(file: { filename: string; originalName: string; mimetype: string; size: number; path: string }, tenantId = config.tenantId, userId?: string, existingDocumentId?: string, replacementReason?: string): Promise<{ document: Awaited<ReturnType<DocumentsService['get']>>; duplicate: boolean; version?: unknown }> {
    const uploadReceivedAt = new Date();
    const validationStartedAt = new Date();
    const filename = safeDisplayName(file.originalName);
    const extension = extname(filename).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension as typeof SUPPORTED_EXTENSIONS[number])) {
      await this.storage.cleanup(file.filename);
      throw new BadRequestException('UNSUPPORTED_FILE_TYPE');
    }
    if (!(MIME_BY_EXTENSION[extension] || []).includes(file.mimetype.toLowerCase())) {
      await this.storage.cleanup(file.filename);
      throw new BadRequestException('MIME_TYPE_MISMATCH');
    }
    if (file.size <= 0 || file.size > config.maxBytes) {
      await this.storage.cleanup(file.filename);
      throw new BadRequestException(file.size > config.maxBytes ? 'FILE_TOO_LARGE' : 'EMPTY_FILE');
    }
    let stored: Buffer;
    try {
      stored = await readFile(file.path);
      validateSignature(extension, stored);
    } catch (error) {
      await this.storage.cleanup(file.filename).catch(() => undefined);
      throw error;
    }
    const checksum = createHash('sha256').update(stored).digest('hex');
    const parent = existingDocumentId ? await this.prisma.appDocument.findFirst({ where: { id: existingDocumentId, tenantId } }) : null;
    if (existingDocumentId && !parent) { await this.storage.cleanup(file.filename); throw new NotFoundException('DOCUMENT_NOT_FOUND'); }
    const duplicateVersion = existingDocumentId ? await this.prisma.appDocumentVersion.findFirst({ where: { documentId: existingDocumentId, checksum } }) : null;
    if (duplicateVersion) {
      await this.storage.cleanup(file.filename);
      await this.recoverQueuedUpload(existingDocumentId!, tenantId, userId, duplicateVersion.id);
      return { document: await this.get(existingDocumentId!, tenantId), duplicate: true, version: this.safeVersion(duplicateVersion) };
    }
    const existing = existingDocumentId ? null : await this.prisma.appDocument.findFirst({ where: { tenantId, checksum } });
    if (existing) {
      await this.storage.cleanup(file.filename);
      await this.recoverQueuedUpload(existing.id, tenantId, userId);
      return { document: await this.get(existing.id, tenantId), duplicate: true };
    }
    if (!existingDocumentId) {
      const existingVersion = await this.prisma.appDocumentVersion.findFirst({ where: { tenantId, checksum } });
      if (existingVersion) {
        await this.storage.cleanup(file.filename);
        await this.recoverQueuedUpload(existingVersion.documentId, tenantId, userId, existingVersion.id);
        return { document: await this.get(existingVersion.documentId, tenantId), duplicate: true, version: this.safeVersion(existingVersion) };
      }
    }
    const tenantDocumentCount = await this.prisma.appDocument.count({ where: { tenantId } });
    if (tenantDocumentCount >= config.maxTenantDocuments) {
      await this.storage.cleanup(file.filename);
      throw new BadRequestException('TENANT_DOCUMENT_QUOTA_EXCEEDED');
    }
    const validationFinishedAt = new Date();

    const id = randomUUID();
    const documentId = existingDocumentId || id;
    const versionId = randomUUID();
    const jobId = randomUUID();
    const versionNumber = existingDocumentId
      ? (await this.prisma.appDocumentVersion.aggregate({ where: { documentId, tenantId }, _max: { versionNumber: true } }))._max.versionNumber! + 1
      : 1;
    try {
      const writes = [
        ...(!existingDocumentId ? [this.prisma.appDocument.create({ data: {
          id: documentId, tenantId, filename, fileType: extension.slice(1), status: 'queued', stage: 'queued',
          jobId, fileSize: BigInt(file.size), checksum, storageKey: file.filename,
        } })] : [this.prisma.appDocument.update({ where: { id: documentId }, data: { jobId, ...(parent?.activeVersionId ? {} : { status: 'queued', stage: 'queued', filename, fileType: extension.slice(1), fileSize: BigInt(file.size), checksum, storageKey: file.filename }) } })]),
        this.prisma.appDocumentVersion.create({ data: {
          id: versionId, documentId, tenantId, versionNumber, filename, checksum,
          fileSize: BigInt(file.size), mimeType: file.mimetype, uploadedBy: userId,
          status: 'queued', storageKey: file.filename, jobId, replacementReason,
        } }),
        // Multer invokes this service after the request body has been received.
        // This records verified received bytes, not network-time progress.
        this.prisma.documentProgressEvent.create({ data: {
          documentId, tenantId, jobId, attempt: 0, stage: 'upload', status: 'completed',
          startedAt: uploadReceivedAt, finishedAt: uploadReceivedAt, completedUnits: file.size, totalUnits: file.size, unit: 'bytes',
        } }),
        this.prisma.documentProgressEvent.create({ data: {
          documentId, tenantId, jobId, attempt: 0, stage: 'validation', status: 'completed',
          startedAt: validationStartedAt, finishedAt: validationFinishedAt,
        } }),
        this.prisma.documentProgressEvent.create({ data: {
          documentId, tenantId, jobId, attempt: 0, stage: 'queued', status: 'queued', startedAt: validationFinishedAt,
        } }),
      ];
      await this.prisma.$transaction(writes);
      await this.queue.enqueue({ documentId, versionId, tenantId, userId, storageKey: file.filename, filename, checksum, fileSize: file.size }, jobId);
    } catch (error) {
      if (existingDocumentId) await this.prisma.appDocumentVersion.updateMany({ where: { id: versionId, tenantId }, data: { status: 'failed' } }).catch(() => undefined);
      else await this.prisma.appDocument.deleteMany({ where: { id: documentId, tenantId } }).catch(() => undefined);
      if ((error as { code?: string }).code === 'P2002') {
        const racedDuplicate = existingDocumentId ? null : await this.prisma.appDocument.findFirst({ where: { tenantId, checksum } });
        if (racedDuplicate) { await this.storage.cleanup(file.filename).catch(() => undefined); return { document: await this.get(racedDuplicate.id, tenantId), duplicate: true }; }
        if (existingDocumentId) {
          const racedVersion = await this.prisma.appDocumentVersion.findFirst({ where: { documentId: existingDocumentId, checksum } });
          if (racedVersion) { await this.storage.cleanup(file.filename).catch(() => undefined); return { document: await this.get(existingDocumentId, tenantId), duplicate: true, version: this.safeVersion(racedVersion) }; }
          return this.upload(file, tenantId, userId, existingDocumentId, replacementReason);
        }
      }
      await this.storage.cleanup(file.filename).catch(() => undefined);
      throw error;
    }
    return { document: await this.get(documentId, tenantId), duplicate: false, version: { id: versionId, versionNumber, jobId, status: 'queued' } };
  }

  private safeVersion<T extends { fileSize: bigint; filename: string; storageKey?: string | null }>(version: T) {
    const { storageKey: _storageKey, ...publicVersion } = version;
    return { ...publicVersion, filename: safeDisplayName(version.filename), fileSize: Number(version.fileSize) };
  }

  async listVersions(documentId: string, tenantId: string, page = 1, limit = 20) {
    const document = await this.prisma.appDocument.findFirst({ where: { id: documentId, tenantId }, select: { id: true, activeVersionId: true } });
    if (!document) throw new NotFoundException('DOCUMENT_NOT_FOUND');
    const [versions, total] = await this.prisma.$transaction([
      this.prisma.appDocumentVersion.findMany({ where: { documentId, tenantId }, orderBy: { versionNumber: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.appDocumentVersion.count({ where: { documentId, tenantId } }),
    ]);
    return { documentId, activeVersionId: document.activeVersionId, page, limit, total, versions: versions.map(version => this.safeVersion(version)) };
  }

  async getVersion(documentId: string, versionId: string, tenantId: string) {
    const version = await this.prisma.appDocumentVersion.findFirst({ where: { id: versionId, documentId, tenantId }, include: { document: { select: { activeVersionId: true } } } });
    if (!version) throw new NotFoundException('DOCUMENT_VERSION_NOT_FOUND');
    return { ...this.safeVersion(version), active: version.document.activeVersionId === version.id };
  }

  async restoreVersion(documentId: string, versionId: string, tenantId: string, userId?: string) {
    const version = await this.prisma.appDocumentVersion.findFirst({ where: { id: versionId, documentId, tenantId } });
    if (!version) throw new NotFoundException('DOCUMENT_VERSION_NOT_FOUND');
    if (!['ready', 'failed', 'cancelled'].includes(version.status)) throw new BadRequestException('VERSION_NOT_RETRIEVAL_READY');
    const document = await this.prisma.appDocument.findFirst({ where: { id: documentId, tenantId }, select: { activeVersionId: true } });
    if (document?.activeVersionId === version.id) return { documentId, activeVersionId: version.id, versionNumber: version.versionNumber, status: 'already_active' };
    if (version.chunkingStrategy === 'legacy' && !version.storageKey) {
      await this.prisma.$transaction([
        this.prisma.appDocument.updateMany({ where: { id: documentId, tenantId }, data: { activeVersionId: version.id, filename: version.filename, fileType: version.filename.split('.').at(-1) || 'unknown', fileSize: version.fileSize, status: 'ready', stage: 'completed', progress: 100, errorCode: null, failureCode: null } }),
        this.prisma.appDocumentVersion.updateMany({ where: { id: version.id, documentId, tenantId }, data: { status: 'ready' } }),
      ]);
      return { documentId, activeVersionId: version.id, versionNumber: version.versionNumber, status: 'restored_legacy_index' };
    }
    if (version.activeIndexGeneration === null || version.indexedChunkCount < 1) throw new BadRequestException('VERSION_NOT_RETRIEVAL_READY');
    return this.reindexVersion(documentId, versionId, tenantId, userId, true);
  }

  async reindexVersion(documentId: string, versionId: string, tenantId: string, userId?: string, publishAfter = false) {
    const version = await this.prisma.appDocumentVersion.findFirst({ where: { id: versionId, documentId, tenantId } });
    if (!version) throw new NotFoundException('DOCUMENT_VERSION_NOT_FOUND');
    if (!version.storageKey) throw new BadRequestException('VERSION_CONTENT_UNAVAILABLE');
    if (['queued', 'processing', 'reindexing'].includes(version.status)) throw new BadRequestException('VERSION_JOB_ALREADY_ACTIVE');
    const jobId = randomUUID();
    const nextGeneration = version.indexGeneration + 1;
    await this.prisma.$transaction([
      this.prisma.appDocumentVersion.update({ where: { id: version.id }, data: { status: 'reindexing', jobId, cancelRequested: false, publishRequested: publishAfter, indexGeneration: nextGeneration } }),
      this.prisma.appDocument.updateMany({ where: { id: documentId, tenantId }, data: { jobId, ...(version.activeIndexGeneration === null ? { status: 'queued', stage: 'queued', progress: null } : {}) } }),
      this.prisma.documentProgressEvent.create({ data: { documentId, tenantId, jobId, attempt: 0, stage: 'queued', status: 'queued', startedAt: new Date() } }),
    ]);
    try {
      await this.queue.enqueue({ documentId, versionId, tenantId, userId, storageKey: version.storageKey, filename: version.filename, checksum: version.checksum || '', fileSize: Number(version.fileSize) }, jobId);
    } catch (error) {
      await this.prisma.appDocumentVersion.updateMany({ where: { id: version.id, jobId }, data: { status: version.activeIndexGeneration ? 'ready' : 'failed' } });
      throw error;
    }
    return { documentId, versionId, jobId, indexGeneration: nextGeneration, status: 'queued' };
  }

  async cancelVersionJob(documentId: string, versionId: string, tenantId: string) {
    const version = await this.prisma.appDocumentVersion.findFirst({ where: { id: versionId, documentId, tenantId } });
    if (!version) throw new NotFoundException('DOCUMENT_VERSION_NOT_FOUND');
    if (!version.jobId || !['queued', 'processing', 'reindexing'].includes(version.status)) throw new BadRequestException('VERSION_JOB_NOT_ACTIVE');
    const job = await this.queue.queue.getJob(version.jobId);
    const state = await job?.getState();
    if (job && ['waiting', 'delayed', 'waiting-children'].includes(state || '')) {
      await job.remove();
      await this.prisma.appDocumentVersion.updateMany({ where: { id: version.id, jobId: version.jobId }, data: { status: version.activeIndexGeneration ? 'ready' : 'cancelled', cancelRequested: true } });
      return { documentId, versionId, status: 'cancelled' };
    }
    await this.prisma.appDocumentVersion.updateMany({ where: { id: version.id, jobId: version.jobId }, data: { cancelRequested: true } });
    return { documentId, versionId, status: 'cancelling' };
  }

  async uploadBatch(files: Array<{ filename: string; originalName: string; mimetype: string; size: number; path: string }>, tenantId = config.tenantId, userId?: string) {
    if (!files.length) throw new BadRequestException('FILES_REQUIRED');
    if (files.length > config.maxBatchFiles || files.reduce((total, file) => total + file.size, 0) > config.maxBatchBytes) {
      await Promise.all(files.map(file => this.storage.cleanup(file.filename).catch(() => undefined)));
      throw new BadRequestException('BATCH_LIMIT_EXCEEDED');
    }
    const accepted = [];
    const rejected: Array<{ filename: string; code: string }> = [];
    for (const file of files) {
      try { accepted.push(await this.upload(file, tenantId, userId)); }
      catch (error) {
        await this.storage.cleanup(file.filename).catch(() => undefined);
        rejected.push({ filename: safeDisplayName(file.originalName), code: (error as { response?: string; message?: string }).response?.toString() || 'UPLOAD_REJECTED' });
      }
    }
    return { accepted, rejected };
  }

  async remove(id: string, tenantId = config.tenantId) {
    const doc = await this.prisma.appDocument.findFirst({ where: { id, tenantId } });
    if (!doc) throw new NotFoundException('DOCUMENT_NOT_FOUND');
    const versions = await this.prisma.appDocumentVersion.findMany({ where: { documentId: id, tenantId }, select: { id: true, jobId: true, status: true, storageKey: true, activeIndexGeneration: true } });
    const activeVersionJobs = versions.filter(version => version.jobId && ['queued', 'processing', 'reindexing'].includes(version.status));
    let activeWorker = false;
    for (const version of activeVersionJobs) {
      const queueJob = await this.queue.queue.getJob(version.jobId!);
      const state = await queueJob?.getState();
      if (state === 'active') { activeWorker = true; continue; }
      if (queueJob && ['waiting', 'delayed', 'waiting-children'].includes(state || '')) await queueJob.remove();
      await this.prisma.appDocumentVersion.updateMany({ where: { id: version.id, tenantId }, data: { status: version.activeIndexGeneration ? 'ready' : 'cancelled', cancelRequested: true, publishRequested: false } });
    }
    if (activeWorker) {
      await this.prisma.$transaction([
        this.prisma.appDocument.updateMany({ where: { id, tenantId }, data: { cancelRequested: true, deleteRequested: true, stage: 'cancelling' } }),
        this.prisma.appDocumentVersion.updateMany({ where: { documentId: id, tenantId, status: { in: ['queued', 'processing', 'reindexing'] } }, data: { cancelRequested: true } }),
      ]);
      return { id, status: 'cancelling' };
    }
    if (doc.status === 'processing' && doc.stage === 'indexing') {
      await this.prisma.appDocument.updateMany({ where: { id, tenantId }, data: { cancelRequested: true, deleteRequested: true, stage: 'cancelling' } });
      return { id, status: 'cancelling' };
    }
    if (doc.jobId && ['queued', 'processing'].includes(doc.status)) {
      const queuedJob = await this.queue.queue.getJob(doc.jobId);
      const state = await queuedJob?.getState();
      if (queuedJob && (state === 'waiting' || state === 'delayed' || state === 'waiting-children')) await queuedJob.remove();
      if (state === 'active') {
        await this.prisma.appDocument.updateMany({ where: { id, tenantId }, data: { cancelRequested: true, deleteRequested: true, stage: 'cancelling' } });
        return { id, status: 'cancelling' };
      }
      await this.storage.cleanup(doc.storageKey);
      await this.prisma.appDocument.delete({ where: { id } });
      return { id, status: 'deleted' };
    }
    if (doc.status === 'ready') await this.typegraph.deleteDocument(doc.id, tenantId);
    await this.storage.cleanup(doc.storageKey);
    await Promise.all(versions.map(version => this.storage.cleanup(version.storageKey).catch(() => undefined)));
    await this.prisma.appDocument.delete({ where: { id } });
    return { id, status: 'deleted' };
  }
}
