import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function main() {
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
      .setDescription('SitePilot API. Use the authentication endpoints to obtain a JWT. Refresh tokens are HttpOnly cookies and rotate on use. Development x-api-key is accepted only when ENABLE_DEV_API_KEY_AUTH=true outside production. Documents are indexed asynchronously by BullMQ/TypeGraph. Job status includes nullable measurable progress and ETA; job SSE events: status, stage, completed, failed, cancelled. Admin worker monitoring routes require TENANT_ADMIN or SUPER_ADMIN. Agent POST /stream SSE events: status, tool-start, tool-finish, text-delta, sources, step-start, step-finish, error, done.')
      .setVersion('1.0')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'dev-api-key')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }
  app.enableShutdownHooks();
  await app.listen(config.port, '127.0.0.1');
  console.log(`SitePilot starter: http://127.0.0.1:${config.port}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
