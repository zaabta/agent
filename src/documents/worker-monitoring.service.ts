import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker as Thread } from 'node:worker_threads';
import { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { config } from '../config.js';
import { DOCUMENT_QUEUE } from './document-queue.constants.js';
import { redisConnection } from './redis-connection.js';

type WorkerActivity = 'busy' | 'idle';
type Heartbeat = {
  workerId: string; pid: number; host: string; queue: string; activity: WorkerActivity;
  heartbeatAt: string;
  process: { cpuPercent: number; rssBytes: number; heapUsedBytes: number };
  hostMemory: { totalBytes: number; freeBytes: number };
};

const require = createRequire(import.meta.url);
const HEARTBEAT_THREAD = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { hostname, totalmem, freemem } = require('node:os');
const Redis = require(workerData.redisModulePath);
const redis = new Redis(workerData.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
let activity = 'idle';
let cpuAt = process.hrtime.bigint();
let cpuUsage = process.cpuUsage();
async function beat() {
  const now = Date.now();
  const cpu = process.cpuUsage(cpuUsage);
  const elapsedUs = Number(process.hrtime.bigint() - cpuAt) / 1000;
  cpuAt = process.hrtime.bigint();
  cpuUsage = process.cpuUsage();
  const memory = process.memoryUsage();
  const payload = {
    workerId: workerData.workerId, pid: process.pid, host: hostname(), queue: workerData.queue,
    activity, heartbeatAt: new Date(now).toISOString(),
    process: { cpuPercent: elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : 0, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
    hostMemory: { totalBytes: totalmem(), freeBytes: freemem() },
  };
  await redis.multi().set(workerData.key, JSON.stringify(payload), 'EX', 15).zadd(workerData.registryKey, now, workerData.workerId).exec();
  const registrySize = await redis.zcard(workerData.registryKey);
  if (registrySize > 100) await redis.zremrangebyrank(workerData.registryKey, 0, registrySize - 101);
}
const timer = setInterval(() => { void beat().catch(error => parentPort.postMessage({ type: 'error', message: String(error) })); }, 2000);
timer.unref();
parentPort.on('message', message => {
  if (message.type === 'activity') { activity = message.activity; void beat().catch(error => parentPort.postMessage({ type: 'error', message: String(error) })); }
  if (message.type === 'stop') { clearInterval(timer); void redis.del(workerData.key).then(() => redis.zrem(workerData.registryKey, workerData.workerId)).finally(() => redis.quit()).finally(() => process.exit(0)); }
});
void beat().catch(error => parentPort.postMessage({ type: 'error', message: String(error) }));
`;

@Injectable()
export class WorkerMonitoringService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerMonitoringService.name);
  private readonly redis: Redis;
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private heartbeatThread?: Thread;
  private readonly heartbeatPrefix = `sitepilot:worker:${config.documentQueue}:`;
  private readonly registryKey = `sitepilot:worker-registry:${config.documentQueue}`;

  constructor(
    @Inject(DOCUMENT_QUEUE) private readonly queue: Queue,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) { this.redis = redisConnection(config.redisUrl); }

  startHeartbeat() {
    if (this.heartbeatThread) return;
    this.heartbeatThread = new Thread(HEARTBEAT_THREAD, {
      eval: true,
      workerData: {
        redisUrl: config.redisUrl, redisModulePath: require.resolve('ioredis'),
        workerId: this.workerId, queue: config.documentQueue,
        key: this.heartbeatPrefix + this.workerId, registryKey: this.registryKey,
      },
    });
    this.heartbeatThread.on('message', message => { if (message?.type === 'error') this.logger.warn(`Worker heartbeat thread error: ${message.message}`); });
    this.heartbeatThread.on('error', error => this.logger.error(`Worker heartbeat thread failed: ${error.message}`));
  }

  setActivity(activity: WorkerActivity) {
    this.heartbeatThread?.postMessage({ type: 'activity', activity });
  }

  async stopHeartbeat() {
    const thread = this.heartbeatThread;
    if (!thread) return;
    this.heartbeatThread = undefined;
    thread.postMessage({ type: 'stop' });
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { void thread.terminate().finally(resolve); }, 3000);
      thread.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }

  async overview(tenantId: string) {
    const [counts, workers, documents] = await Promise.all([
      this.queue.getJobCounts(), this.health(),
      this.prisma.appDocument.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
    ]);
    return {
      queue: { waiting: counts.waiting ?? counts.wait ?? 0, active: counts.active ?? 0, completedRetained: counts.completed ?? 0, failedRetained: counts.failed ?? 0, delayed: counts.delayed ?? 0, paused: counts.paused ?? 0, totalsBasis: 'retained BullMQ jobs; lifetime totals are not available from the configured queue retention' },
      workers, tenantDocumentStates: Object.fromEntries(documents.map(item => [item.status, item._count._all])),
    };
  }

  async health() {
    const ids = await this.redis.zrevrange(this.registryKey, 0, 49, 'WITHSCORES').catch(() => null);
    if (!ids) return [{ status: 'unknown', health: 'unknown', reason: 'HEARTBEAT_STORE_UNAVAILABLE' }];
    const entries: Array<{ id: string; score: number }> = [];
    for (let index = 0; index < ids.length; index += 2) entries.push({ id: ids[index]!, score: Number(ids[index + 1]) });
    const now = Date.now();
    return Promise.all(entries.map(async entry => {
      const raw = await this.redis.get(this.heartbeatPrefix + entry.id).catch(() => null);
      if (!raw) {
        const missingForMs = Math.max(0, now - entry.score);
        return { workerId: entry.id, status: missingForMs <= 15_000 ? 'disconnected' : 'stale', health: 'unresponsive', lastHeartbeatAt: new Date(entry.score).toISOString(), heartbeatAgeMs: missingForMs };
      }
      try {
        const data = JSON.parse(raw) as Heartbeat;
        const ageMs = Math.max(0, now - Date.parse(data.heartbeatAt));
        if (!Number.isFinite(ageMs)) return { workerId: entry.id, status: 'unknown', health: 'unknown' };
        if (ageMs > 10_000) return { workerId: entry.id, status: 'stale', health: 'unresponsive', heartbeatAgeMs: ageMs, lastHeartbeatAt: data.heartbeatAt, activity: data.activity };
        return { ...data, status: data.activity, health: 'healthy', heartbeatAgeMs: ageMs, metricScope: { cpu: 'worker process', rss: 'worker process', heap: 'worker process', memory: 'host' } };
      } catch { return { workerId: entry.id, status: 'unknown', health: 'unknown' }; }
    }));
  }

  async metrics(windowMinutes = 60) {
    const boundedWindowMinutes = Math.min(1440, Math.max(15, Math.floor(windowMinutes)));
    const windowMs = boundedWindowMinutes * 60_000;
    const [counts, jobs] = await Promise.all([
      this.queue.getJobCounts(),
      this.queue.getJobs(['completed', 'failed'], 0, 999, false),
    ]);
    const cutoff = Date.now() - windowMs;
    const recent = jobs.filter(job => (job.finishedOn || 0) >= cutoff);
    const completed = recent.filter(job => job.finishedOn && job.returnvalue?.status === 'completed');
    const failed = recent.filter(job => job.finishedOn && job.failedReason);
    const waitTimes = recent.flatMap(job => job.processedOn ? [Math.max(0, job.processedOn - job.timestamp)] : []);
    const processTimes = recent.flatMap(job => job.processedOn && job.finishedOn ? [Math.max(0, job.finishedOn - job.processedOn)] : []);
    const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    return {
      window: { minutes: boundedWindowMinutes, since: new Date(cutoff).toISOString() },
      retainedCounts: { waiting: counts.waiting ?? counts.wait ?? 0, active: counts.active ?? 0, completed: counts.completed ?? 0, failed: counts.failed ?? 0, delayed: counts.delayed ?? 0, paused: counts.paused ?? 0 },
      windowMetrics: { sampleSize: recent.length, sampleLimit: 1000, throughputPerMinute: Math.round(completed.length / boundedWindowMinutes * 100) / 100, retries: recent.filter(job => job.attemptsMade > 1).length, averageQueueWaitMs: average(waitTimes), averageProcessingMs: average(processTimes), failureRate: recent.length ? Math.round(failed.length / recent.length * 10000) / 100 : null },
      resourceScope: 'Worker process CPU/RSS/heap and host memory are reported separately by /health.',
    };
  }

  async listJobs(tenantId: string, page = 1, limit = 25, status?: string) {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const versionStatuses = status === 'processing' ? ['processing', 'reindexing'] : status ? [status] : [];
    const where = { tenantId, ...(status ? { OR: [{ status }, ...(versionStatuses.length ? [{ versions: { some: { status: { in: versionStatuses } } } }] : [])] } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.appDocument.count({ where }),
      this.prisma.appDocument.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit, select: { id: true, jobId: true, filename: true, status: true, stage: true, retryCount: true, failureCode: true, createdAt: true, updatedAt: true, completedAt: true } }),
    ]);
    const versions = await this.prisma.appDocumentVersion.findMany({ where: { jobId: { in: rows.flatMap(row => row.jobId ? [row.jobId] : []) }, tenantId }, select: { id: true, jobId: true, versionNumber: true, status: true, indexedChunkCount: true, indexGeneration: true } });
    const byJob = new Map(versions.map(version => [version.jobId, version]));
    return { page: safePage, limit: safeLimit, total, jobs: rows.map(row => {
      const version = byJob.get(row.jobId);
      return { ...row, ...(version ? { versionId: version.id, versionNumber: version.versionNumber, indexedChunkCount: version.indexedChunkCount, indexGeneration: version.indexGeneration, status: version.status === 'reindexing' ? 'processing' : version.status } : {}) };
    }) };
  }

  async jobDetail(tenantId: string, jobId: string) {
    const version = await this.prisma.appDocumentVersion.findFirst({ where: { tenantId, jobId }, select: { id: true, versionNumber: true, status: true, indexedChunkCount: true, indexGeneration: true, activeIndexGeneration: true, documentId: true } });
    const document = await this.prisma.appDocument.findFirst({ where: { tenantId, ...(version ? { id: version.documentId } : { jobId }) }, select: { id: true, jobId: true, filename: true, status: true, stage: true, retryCount: true, failureCode: true, errorCode: true, createdAt: true, updatedAt: true, completedAt: true } });
    if (!document) return null;
    const [progressEvents, queueJob] = await Promise.all([
      this.prisma.documentProgressEvent.findMany({ where: { tenantId, jobId }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], take: 100 }),
      this.queue.getJob(jobId).catch(() => null),
    ]);
    return {
      ...document, ...(version ? { versionId: version.id, versionNumber: version.versionNumber, indexedChunkCount: version.indexedChunkCount, indexGeneration: version.indexGeneration, activeIndexGeneration: version.activeIndexGeneration, status: version.status } : {}), failureCode: document.failureCode || document.errorCode, progressEvents,
      queue: { state: await queueJob?.getState().catch(() => 'unknown') || 'unknown', attemptsMade: queueJob?.attemptsMade ?? null, attemptsMax: queueJob?.opts.attempts ?? null },
    };
  }

  async recentEvents(tenantId: string, hours = 24) {
    const boundedHours = Math.min(168, Math.max(1, Math.floor(hours)));
    return { hours: boundedHours, events: await this.prisma.documentProgressEvent.findMany({
      where: { tenantId, startedAt: { gte: new Date(Date.now() - boundedHours * 3_600_000) } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 100,
      select: { id: true, documentId: true, jobId: true, attempt: true, stage: true, status: true, startedAt: true, finishedAt: true, completedUnits: true, totalUnits: true, embeddingDurationMs: true, unit: true, failureCode: true },
    }) };
  }

  async onModuleDestroy() { await this.redis.quit().catch(() => undefined); }
}
