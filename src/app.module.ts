import { Controller, Get, Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { TypegraphModule } from './typegraph/typegraph.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { AgentModule } from './agent/agent.module.js';
import { AuthModule } from './auth/auth.module.js';

@Controller()
class HealthController {
  @Get('health') health() { return { ok: true, service: 'sitepilot-mastra', prototype: true, database: 'prisma', retrieval: 'typegraph' }; }
}

@Module({imports: [PrismaModule, TypegraphModule, AuthModule, DocumentsModule, AgentModule],controllers: [HealthController]})
export class AppModule {}
