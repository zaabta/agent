import { BackendTools } from './backend-tools.js';
import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { TypegraphModule } from '../typegraph/typegraph.module.js';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
@Module({imports:[DocumentsModule, TypegraphModule],controllers:[AgentController],providers:[AgentService, BackendTools],exports:[BackendTools]})
export class AgentModule {}
