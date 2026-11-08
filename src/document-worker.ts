import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentWorkerModule } from './documents/document-worker.module.js';
import { config } from './config.js';

if (!config.companyWorkspaceId) {
  throw new Error('COMPANY_WORKSPACE_ID must identify the existing shared company workspace');
}

NestFactory.createApplicationContext(DocumentWorkerModule, { logger: ['error', 'warn', 'log'] })
  .then(context => {
    context.enableShutdownHooks();
    console.log('SitePilot document worker is running');
  })
  .catch(error => { console.error('Document worker failed to start', error); process.exitCode = 1; });
