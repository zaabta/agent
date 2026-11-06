import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TypegraphModule } from '../typegraph/typegraph.module.js';
import { DocumentStorageService } from './document-storage.service.js';
import { DocumentProcessorService } from './document-processor.service.js';
import { DocumentQueueModule } from './document-queue.module.js';
import { WorkerMonitoringService } from './worker-monitoring.service.js';

@Module({ imports: [PrismaModule, TypegraphModule, DocumentQueueModule], providers: [DocumentStorageService, DocumentProcessorService, WorkerMonitoringService] })
export class DocumentWorkerModule {}
