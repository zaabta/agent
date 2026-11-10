import { Controller, Get, Module } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaModule } from './prisma/prisma.module.js';
import { TypegraphModule } from './typegraph/typegraph.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { AgentModule } from './agent/agent.module.js';
import { AuthModule } from './auth/auth.module.js';

@Controller()
@ApiTags('system')
class HealthController {
  @ApiOperation({ summary: 'Check API process availability and configured service adapters' })
  @ApiResponse({ status: 200, schema: { type: 'object', required: ['ok', 'service', 'database', 'retrieval'], properties: { ok: { type: 'boolean', example: true }, service: { type: 'string', example: 'sitepilot-mastra' }, prototype: { type: 'boolean' }, database: { type: 'string', example: 'prisma' }, retrieval: { type: 'string', example: 'typegraph' } } } })
  @Get('health') health() { return { ok: true, service: 'sitepilot-mastra', prototype: true, database: 'prisma', retrieval: 'typegraph' }; }
}

@Module({imports: [PrismaModule, TypegraphModule, AuthModule, DocumentsModule, AgentModule],controllers: [HealthController]})
export class AppModule {}
