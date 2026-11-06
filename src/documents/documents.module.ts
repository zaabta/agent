import { Module } from '@nestjs/common';
import { TypegraphModule } from '../typegraph/typegraph.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { DocumentQueueModule } from './document-queue.module.js';
import { DocumentStorageService } from './document-storage.service.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { StructuredDataService } from './structured-data.service.js';
import { AdminWorkersController } from './admin-workers.controller.js';
import { WorkerMonitoringService } from './worker-monitoring.service.js';
@Module({imports:[TypegraphModule, DocumentQueueModule],controllers: [DocumentsController, JobsController, AdminWorkersController], providers: [DocumentsService, DocumentStorageService, JobsService, StructuredDataService, WorkerMonitoringService], exports:[DocumentsService, StructuredDataService]})
export class DocumentsModule {}
