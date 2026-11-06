import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { config } from '../config.js';
import { DocumentQueueService } from './document-queue.service.js';
import { redisConnection } from './redis-connection.js';
import { DOCUMENT_QUEUE } from './document-queue.constants.js';

@Module({
  providers: [
    { provide: DOCUMENT_QUEUE, useFactory: () => new Queue(config.documentQueue, { connection: redisConnection(config.redisUrl) }) },
    DocumentQueueService,
  ],
  exports: [DOCUMENT_QUEUE, DocumentQueueService],
})
export class DocumentQueueModule {}
