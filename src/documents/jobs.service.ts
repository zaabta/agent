import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { config } from '../config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentQueueService } from './document-queue.service.js';
import { DocumentStorageService } from './document-storage.service.js';

@Injectable()
export class JobsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DocumentQueueService) private readonly queue: DocumentQueueService,
    @Inject(DocumentStorageService) private readonly storage: DocumentStorageService,
  ) {}
  private async document(jobId: string, tenantId = config.tenantId) {
    const doc = await this.prisma.appDocument.findFirst({ where: { jobId, tenantId } });
    if (!doc) throw new NotFoundException('JOB_NOT_FOUND');
    return doc;
  }
  private async view(doc: Awaited<ReturnType<JobsService['document']>>) {
    const [loadedEvents, queueJob] = await Promise.all([
      this.prisma.documentProgressEvent.findMany({ where: { documentId: doc.id, tenantId: doc.tenantId, jobId: doc.jobId || '' }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], take: 100 }),
      doc.jobId ? this.queue.queue.getJob(doc.jobId).catch(() => null) : null,
    ]);
    const stageOrder = ['upload', 'validation', 'queued', 'verification', 'parsing', 'indexing', 'preparing', 'checking', 'embedding', 'persisting', 'pruning', 'committing', 'completed', 'cancelled', 'failed'];
    const events = loadedEvents.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime()
      || left.attempt - right.attempt
      || stageOrder.indexOf(left.stage) - stageOrder.indexOf(right.stage));
    const latest = events.at(-1);
    const percent = (completedUnits: number | null, totalUnits: number | null) =>
      completedUnits !== null && totalUnits !== null && totalUnits > 0
        ? Math.min(100, Math.max(0, Math.round(completedUnits / totalUnits * 100)))
        : null;
    const queueState = await queueJob?.getState().catch(() => 'unknown') || 'unknown';
    const active = doc.status === 'processing' || queueState === 'active';
    const queueExpectation: Record<string, string[]> = {
      queued: ['waiting', 'wait', 'delayed', 'paused', 'waiting-children'],
      processing: ['active'], ready: ['completed'], failed: ['failed'],
      cancelled: ['completed', 'failed', 'unknown'],
    };
    const consistency = queueState === 'unknown' ? 'unknown'
      : queueExpectation[doc.status]?.includes(queueState) ? 'consistent'
      : doc.stage === 'cancelling' && queueState === 'active' ? 'consistent'
      : 'transitioning';
    const now = Date.now();
    const latestElapsedMs = latest?.startedAt
      ? Math.max(0, (latest.finishedAt?.getTime() ?? now) - latest.startedAt.getTime())
      : 0;
    const latestRate = latest?.completedUnits != null && latestElapsedMs >= 2000
      ? latest.completedUnits / (latestElapsedMs / 1000)
      : null;
    const etaMs = latest?.status === 'running' && latestRate && latest.totalUnits != null
      && latest.completedUnits != null && latest.totalUnits > latest.completedUnits
      ? Math.round((latest.totalUnits - latest.completedUnits) / latestRate * 1000)
      : null;
    return {
      jobId: doc.jobId, documentId: doc.id, status: doc.status, stage: doc.stage,
      progress: doc.progress,
      progressDetails: {
        stage: doc.stage, status: doc.status,
        stagePercent: percent(latest?.completedUnits ?? null, latest?.totalUnits ?? null) ?? doc.progress,
        overallPercent: doc.status === 'ready' ? 100 : null,
        completedUnits: latest?.completedUnits ?? null,
        totalUnits: latest?.totalUnits ?? null,
        unit: latest?.unit ?? null,
        attempt: latest?.attempt ?? doc.retryCount + (active ? 1 : 0),
        retryCount: doc.retryCount,
        startedAt: latest?.startedAt ?? doc.createdAt,
        finishedAt: latest?.finishedAt ?? doc.completedAt,
        elapsedMs: latest?.startedAt ? Math.max(0, (latest.finishedAt?.getTime() ?? now) - latest.startedAt.getTime()) : null,
        etaMs,
        stages: events.map(event => ({
          id: event.id, stage: event.stage, status: event.status, attempt: event.attempt,
          startedAt: event.startedAt, finishedAt: event.finishedAt,
          elapsedMs: event.finishedAt ? event.finishedAt.getTime() - event.startedAt.getTime() : Math.max(0, now - event.startedAt.getTime()),
          completedUnits: event.completedUnits, totalUnits: event.totalUnits, unit: event.unit,
          stagePercent: percent(event.completedUnits, event.totalUnits),
          unitsPerSecond: event.completedUnits != null && event.startedAt
            && Math.max(0, (event.finishedAt?.getTime() ?? now) - event.startedAt.getTime()) >= 2000
            ? Math.round(event.completedUnits / (Math.max(1, (event.finishedAt?.getTime() ?? now) - event.startedAt.getTime()) / 1000) * 100) / 100
            : null,
          embeddingDurationMs: event.embeddingDurationMs,
          embeddingChunksPerSecond: event.embeddingDurationMs && event.embeddingDurationMs > 0 && event.totalUnits != null
            ? Math.round(event.totalUnits / event.embeddingDurationMs * 1000 * 100) / 100
            : null,
          failureCode: event.failureCode,
        })),
      },
      queue: { state: queueState, consistency, attemptsMade: queueJob?.attemptsMade ?? null, attemptsMax: queueJob?.opts.attempts ?? null },
      retryCount: doc.retryCount, failureCode: doc.failureCode,
      fileSize: doc.fileSize == null ? null : Number(doc.fileSize),
      createdAt: doc.createdAt, updatedAt: doc.updatedAt, completedAt: doc.completedAt,
    };
  }
  async get(jobId: string, tenantId = config.tenantId) { return this.view(await this.document(jobId, tenantId)); }
  async cancel(jobId: string, tenantId = config.tenantId) {
    const doc = await this.document(jobId, tenantId);
    if (['ready', 'failed', 'cancelled'].includes(doc.status)) return this.view(doc);
    const job = await this.queue.queue.getJob(jobId);
    const state = await job?.getState();
    if (job && (state === 'waiting' || state === 'delayed' || state === 'waiting-children')) {
      await job.remove();
      await this.storage.cleanup(doc.storageKey);
      const cancelledAt = new Date();
      await this.prisma.$transaction([
        this.prisma.documentProgressEvent.updateMany({ where: { documentId: doc.id, tenantId, jobId, finishedAt: null }, data: { status: 'cancelled', finishedAt: cancelledAt } }),
        this.prisma.appDocument.updateMany({ where: { id: doc.id, tenantId }, data: { status: 'cancelled', stage: 'cancelled', progress: null, cancelRequested: true, completedAt: cancelledAt, storageKey: null } }),
        this.prisma.documentProgressEvent.create({ data: { documentId: doc.id, tenantId, jobId, attempt: job.attemptsMade + 1, stage: 'cancelled', status: 'cancelled', startedAt: cancelledAt, finishedAt: cancelledAt } }),
      ]);
      const cancelled = await this.document(jobId, tenantId);
      return this.view(cancelled);
    }
    if (state === 'active') {
      await this.prisma.appDocument.updateMany({ where: { id: doc.id, tenantId }, data: { cancelRequested: true, stage: 'cancelling' } });
      return this.view(await this.document(jobId, tenantId));
    }
    return this.view(doc);
  }
  async stream(jobId: string, res: import('express').Response, disconnected: AbortSignal, tenantId = config.tenantId, lastEventId?: string) {
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    res.write('retry: 1500\n\n');
    let previous = '';
    let cursor = lastEventId;
    let initialized = false;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const stop = () => { stopped = true; if (timer) clearInterval(timer); };
    disconnected.addEventListener('abort', stop, { once: true });
    res.on('close', stop);
    if (disconnected.aborted) { stop(); return; }
    const send = async () => {
      if (stopped || res.writableEnded) return;
      try {
        const firstSnapshot = !initialized;
        const snapshot = await this.get(jobId, tenantId);
        const payload = JSON.stringify(snapshot);
        const stableSnapshot = {
          ...snapshot,
          progressDetails: {
            ...snapshot.progressDetails,
            elapsedMs: undefined,
            etaMs: undefined,
            stages: snapshot.progressDetails.stages.map(event => ({ ...event, elapsedMs: undefined, unitsPerSecond: undefined })),
          },
        };
        const stablePayload = JSON.stringify(stableSnapshot);
        const events = snapshot.progressDetails.stages as Array<{ id: string; stage: string; status: string; attempt: number; startedAt: Date }>;
        if (!initialized && !cursor) {
          initialized = true;
          cursor = events.at(-1)?.id;
          previous = stablePayload;
          res.write(`${cursor ? `id: ${cursor}\n` : ''}event: status\ndata: ${payload}\n\n`);
        } else {
          initialized = true;
          const cursorIndex = cursor ? events.findIndex(event => event.id === cursor) : -1;
          const replayAfter = cursorIndex >= 0 ? cursorIndex + 1 : 0;
          for (const event of events.slice(replayAfter)) {
            res.write(`id: ${event.id}\nevent: stage\ndata: ${JSON.stringify({ jobId, documentId: snapshot.documentId, stage: event.stage, status: event.status, attempt: event.attempt, startedAt: event.startedAt })}\n\n`);
            cursor = event.id;
          }
          if (!cursor && events.length) cursor = events.at(-1)?.id;
        }
        if (stablePayload !== previous) {
          previous = stablePayload;
          const event = snapshot.status === 'ready' ? 'completed' : snapshot.status === 'failed' ? 'failed' : snapshot.status === 'cancelled' ? 'cancelled' : 'status';
          res.write(`${cursor ? `id: ${cursor}\n` : ''}event: ${event}\ndata: ${payload}\n\n`);
        } else if (firstSnapshot && ['ready', 'failed', 'cancelled'].includes(snapshot.status)) {
          const event = snapshot.status === 'ready' ? 'completed' : snapshot.status;
          res.write(`event: ${event}\ndata: ${payload}\n\n`);
        } else if (initialized) res.write(': keepalive\n\n');
        if (['ready', 'failed', 'cancelled'].includes(snapshot.status)) { stop(); res.end(); }
      } catch { stop(); if (!res.writableEnded) res.end(); }
    };
    timer = setInterval(() => void send(), 1000);
    await send();
  }
}
