import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function main() {
  if (!config.companyWorkspaceId) {
    throw new Error('COMPANY_WORKSPACE_ID must identify the existing shared company workspace');
  }
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_DEV_API_KEY_AUTH === 'true') {
    throw new Error('ENABLE_DEV_API_KEY_AUTH must be disabled in production');
  }
  if (process.env.NODE_ENV === 'production' && (!process.env.AUTH_JWT_SECRET || Buffer.byteLength(process.env.AUTH_JWT_SECRET) < 32)) {
    throw new Error('AUTH_JWT_SECRET must be configured with at least 32 bytes in production');
  }
  const app = await NestFactory.create(AppModule);
  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('SitePilot AI API')
      .setDescription('SitePilot AI API for authentication and company workspace membership, Agent conversations and streaming, document upload/versioning/search, asynchronous ingestion jobs, and admin worker monitoring. Protected routes require a valid JWT; send it as Authorization: Bearer <token>. Refresh tokens are HttpOnly cookies and rotate on use. The development x-api-key scheme is accepted only when ENABLE_DEV_API_KEY_AUTH=true outside production. Document ingestion is asynchronous through BullMQ and TypeGraph; upload responses provide job IDs, job status includes measurable progress and ETA, and job SSE events are status, stage, completed, failed, cancelled. Agent POST /api/agent/stream returns SSE events status (with runId), stage, tool-start, tool-finish, text-delta, text-reset, sources, step-start, step-finish, cancelled, error, done. POST /api/agent/runs/{runId}/cancel is authenticated and owner scoped. Admin worker monitoring routes require TENANT_ADMIN or SUPER_ADMIN. Swagger is enabled only outside production.')
      .setVersion('1.0')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'dev-api-key')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }
  app.enableShutdownHooks();
  await app.listen(config.port, config.apiHost);
  console.log(`SitePilot starter: http://127.0.0.1:${config.port}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
