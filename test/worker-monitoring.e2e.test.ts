import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { config } from '../src/config.js';
import { redisConnection } from '../src/documents/redis-connection.js';
import { WorkerMonitoringService } from '../src/documents/worker-monitoring.service.js';

const enabled = process.env.RUN_WORKER_MONITORING_E2E === 'true';

test('worker heartbeat stays independent of the worker event loop and queue window metrics are bounded', {
  skip: !enabled ? 'Set RUN_WORKER_MONITORING_E2E=true and start Redis' : false,
  timeout: 30000,
}, async () => {
  const now = Date.now();
  const jobs = [
    { timestamp: now - 1000, processedOn: now - 700, finishedOn: now - 100, failedReason: null, attemptsMade: 2, returnvalue: { status: 'completed' } },
    { timestamp: now - 2000, processedOn: now - 1500, finishedOn: now - 500, failedReason: 'SANITIZED_FAILURE', attemptsMade: 1, returnvalue: null },
    { timestamp: now - 4 * 3_600_000, processedOn: now - 4 * 3_600_000 + 500, finishedOn: now - 4 * 3_600_000 + 900, failedReason: null, attemptsMade: 1, returnvalue: { status: 'completed' } },
  ];
  const queue = {
    getJobCounts: async () => ({ waiting: 2, active: 1, completed: 4, failed: 1, delayed: 3, paused: 0 }),
    getJobs: async () => jobs,
  } as unknown as Queue;
  const prisma = {} as PrismaService;
  const service = new WorkerMonitoringService(queue, prisma);
  const workerId = (service as unknown as { workerId: string }).workerId;
  const registry = `sitepilot:worker-registry:${config.documentQueue}`;
  const heartbeat = `sitepilot:worker:${config.documentQueue}:${workerId}`;
  const redis = redisConnection(config.redisUrl);
  try {
    const metrics = await service.metrics(60);
    assert.deepEqual(metrics.retainedCounts, { waiting: 2, active: 1, completed: 4, failed: 1, delayed: 3, paused: 0 });
    assert.equal(metrics.windowMetrics.sampleSize, 2, 'older retained jobs are excluded from the time window');
    assert.equal(metrics.windowMetrics.retries, 1);
    assert.equal(metrics.windowMetrics.failureRate, 50);
    assert.equal(metrics.windowMetrics.averageQueueWaitMs, 400);

    service.startHeartbeat();
    let own: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      own = await service.health() as Array<Record<string, unknown>>;
      if (own.some(worker => worker.workerId === workerId)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(own.find(worker => worker.workerId === workerId)?.status, 'idle');
    service.setActivity('busy');
    await new Promise(resolve => setTimeout(resolve, 100));
    own = await service.health() as Array<Record<string, unknown>>;
    const current = own.find(worker => worker.workerId === workerId)!;
    assert.equal(current.status, 'busy');
    assert.equal(current.health, 'healthy');
    assert.equal((current.metricScope as Record<string, string>).cpu, 'worker process');
    // Simulate a synchronous CPU-bound parser blocking the parent event loop.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
    own = await service.health() as Array<Record<string, unknown>>;
    assert.equal(own.find(worker => worker.workerId === workerId)?.health, 'healthy');
  } finally {
    await service.stopHeartbeat();
    await redis.zadd(registry, Date.now() - 60_000, 'synthetic-stale-worker');
    try {
      const workers = await service.health() as Array<Record<string, unknown>>;
      assert.equal(workers.find(worker => worker.workerId === 'synthetic-stale-worker')?.status, 'stale');
    } finally {
      await redis.zrem(registry, 'synthetic-stale-worker');
      await redis.del(heartbeat);
      await redis.quit();
      await service.onModuleDestroy();
    }
  }
});
