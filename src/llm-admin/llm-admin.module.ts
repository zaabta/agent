import { Module } from '@nestjs/common';
import { LlmAdminController } from './llm-admin.controller.js';
import { LlmAdminService } from './llm-admin.service.js';
import { LlmController } from './llm.controller.js';
@Module({controllers:[LlmAdminController,LlmController],providers:[LlmAdminService]}) export class LlmAdminModule{}
