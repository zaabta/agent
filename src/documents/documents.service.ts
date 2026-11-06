import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { extname, basename } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { config } from '../config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TypegraphService } from '../typegraph/typegraph.service.js';
import { DocumentQueueService } from './document-queue.service.js';
import { DocumentStorageService } from './document-storage.service.js';
import { SUPPORTED_EXTENSIONS } from './parser.js';

const MIME_BY_EXTENSION: Record<string, string[]> = {
  '.md': ['text/markdown', 'text/plain', 'application/octet-stream'],
  '.txt': ['text/plain', 'application/octet-stream'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream'],
  '.pdf': ['application/pdf', 'application/octet-stream'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream'],
  '.xls': ['application/vnd.ms-excel', 'application/octet-stream'],
  '.csv': ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'],
};

export function safeDisplayName(input: string) {
  const leaf = basename(input.replace(/\\/g, '/')).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return leaf.slice(0, 180) || 'upload';
}

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
    const referenced = await this.prisma.appDocument.findMany({ where: { storageKey: { in: stale.map(file => file.key) } }, select: { storageKey: true } });
    const live = new Set(referenced.flatMap(item => item.storageKey ? [item.storageKey] : []));
    await Promise.all(stale.filter(file => !live.has(file.key)).map(file => this.storage.cleanup(file.key)));
  }
  private safeDocument<T extends { fileSize: bigint | null }>(document: T) {
    return { ...document, fileSize: document.fileSize == null ? null : Number(document.fileSize) };
  }

  async list(tenantId = config.tenantId) {
    const documents = await this.prisma.appDocument.findMany({
      where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, filename: true, fileType: true, status: true, stage: true, progress: true, jobId: true, retryCount: true, failureCode: true, fileSize: true, createdAt: true, updatedAt: true, completedAt: true },
    });
    return documents.map(document => this.safeDocument(document));
  }

  async get(id: string, tenantId = config.tenantId) {
    const document = await this.prisma.appDocument.findFirst({ where: { id, tenantId }, select: { id: true, filename: true, fileType: true, status: true, stage: true, progress: true, jobId: true, retryCount: true, failureCode: true, fileSize: true, createdAt: true, updatedAt: true, completedAt: true } });
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

  async upload(file: { filename: string; originalName: string; mimetype: string; size: number; path: string }, tenantId = config.tenantId, userId?: string) {
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
    const existing = await this.prisma.appDocument.findFirst({ where: { tenantId, checksum } });
    if (existing) {
      await this.storage.cleanup(file.filename);
      return { document: await this.get(existing.id, tenantId), duplicate: true };
    }
    const tenantDocumentCount = await this.prisma.appDocument.count({ where: { tenantId } });
    if (tenantDocumentCount >= config.maxTenantDocuments) {
      await this.storage.cleanup(file.filename);
      throw new BadRequestException('TENANT_DOCUMENT_QUOTA_EXCEEDED');
    }
    const validationFinishedAt = new Date();

    const id = randomUUID();
    const jobId = randomUUID();
    try {
      await this.prisma.$transaction([
        this.prisma.appDocument.create({ data: {
          id, tenantId, filename, fileType: extension.slice(1), status: 'queued', stage: 'queued',
          jobId, fileSize: BigInt(file.size), checksum, storageKey: file.filename,
        } }),
        // Multer invokes this service after the request body has been received.
        // This records verified received bytes, not network-time progress.
        this.prisma.documentProgressEvent.create({ data: {
          documentId: id, tenantId, jobId, attempt: 0, stage: 'upload', status: 'completed',
          startedAt: uploadReceivedAt, finishedAt: uploadReceivedAt, completedUnits: file.size, totalUnits: file.size, unit: 'bytes',
        } }),
        this.prisma.documentProgressEvent.create({ data: {
          documentId: id, tenantId, jobId, attempt: 0, stage: 'validation', status: 'completed',
          startedAt: validationStartedAt, finishedAt: validationFinishedAt,
        } }),
        this.prisma.documentProgressEvent.create({ data: {
          documentId: id, tenantId, jobId, attempt: 0, stage: 'queued', status: 'queued', startedAt: validationFinishedAt,
        } }),
      ]);
      await this.queue.enqueue({ documentId: id, tenantId, userId, storageKey: file.filename, filename, checksum, fileSize: file.size }, jobId);
    } catch (error) {
      await this.prisma.appDocument.deleteMany({ where: { id, tenantId } }).catch(() => undefined);
      await this.storage.cleanup(file.filename).catch(() => undefined);
      if ((error as { code?: string }).code === 'P2002') {
        const racedDuplicate = await this.prisma.appDocument.findFirst({ where: { tenantId, checksum } });
        if (racedDuplicate) return { document: await this.get(racedDuplicate.id, tenantId), duplicate: true };
      }
      throw error;
    }
    return { document: await this.get(id, tenantId), duplicate: false };
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
    await this.prisma.appDocument.delete({ where: { id } });
    return { id, status: 'deleted' };
  }
}
