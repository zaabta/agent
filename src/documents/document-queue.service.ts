import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { DOCUMENT_QUEUE } from './document-queue.constants.js';

export interface ProcessDocumentJob {
  documentId: string; tenantId: string; userId?: string; storageKey: string; filename: string; checksum: string; fileSize: number;
}

@Injectable()
export class DocumentQueueService implements OnModuleDestroy {
  constructor(@Inject(DOCUMENT_QUEUE) readonly queue: Queue<ProcessDocumentJob>) {}
  async enqueue(data: ProcessDocumentJob, jobId = randomUUID()) {
    const job = await this.queue.add('process-document', data, {
      jobId, attempts: config.documentJobAttempts,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
    });
    return job.id!;
  }
  async onModuleDestroy() { await this.queue.close(); }
}
