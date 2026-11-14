import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function main() {
  if (!config.companyWorkspaceId) {
    throw new Error('COMPANY_WORKSPACE_ID must identify the existing shared company workspace');
  }
  if (process.env.NODE_ENV === 'production' && (!process.env.AUTH_JWT_SECRET || Buffer.byteLength(process.env.AUTH_JWT_SECRET) < 32)) {
    throw new Error('AUTH_JWT_SECRET must be configured with at least 32 bytes in production');
  }
  const app = await NestFactory.create(AppModule);
  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('SitePilot AI API')
      .setDescription('SitePilot AI is a single-installation, multi-user API. Accounts use unique usernames and passwords. Protected routes require Authorization: Bearer <token>; rotating refresh tokens are HttpOnly cookies. Conversations and token analytics are user scoped; documents retain the shared installation workspace behavior. Global provider/model configuration and worker administration require the configured installation owner (INSTALLATION_OWNER_USER_ID). Document ingestion is asynchronous through BullMQ and TypeGraph; Agent POST /api/agent/stream returns SSE events and POST /api/agent/runs/{runId}/cancel is authenticated and owner scoped. Swagger is enabled only outside production.')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }
  app.enableShutdownHooks();
  await app.listen(config.port, config.apiHost);
  console.log(`SitePilot starter: http://127.0.0.1:${config.port}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
