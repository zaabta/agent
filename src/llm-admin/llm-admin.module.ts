import { Module } from '@nestjs/common';
import { LlmAdminController } from './llm-admin.controller.js';
import { LlmAdminService } from './llm-admin.service.js';
@Module({controllers:[LlmAdminController],providers:[LlmAdminService]}) export class LlmAdminModule{}
