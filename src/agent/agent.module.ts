import { BackendTools } from './backend-tools.js';
import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { TypegraphModule } from '../typegraph/typegraph.module.js';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { ConversationContextService } from './conversation-context.service.js';
import { UserMemoryService } from './user-memory.service.js';
import { CustomToolsController } from './custom-tools.controller.js';
@Module({
  imports: [DocumentsModule, TypegraphModule],
  controllers: [AgentController, CustomToolsController],
  providers: [AgentService, BackendTools, ConversationContextService, UserMemoryService],
  exports: [BackendTools],
})
export class AgentModule {}
