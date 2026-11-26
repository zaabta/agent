import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { InstallationOwnerOnly } from '../auth/installation-owner.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { BackendTools } from './backend-tools.js';

class ToolAuthDto {
  @ApiProperty({ type: String, enum: ['Authorization', 'X-API-Key'] }) headerName!:
    'Authorization' | 'X-API-Key';
  @ApiProperty({ type: String, required: false, description: 'For example, Bearer followed by a space.' })
  prefix?: string;
  @ApiProperty({ type: String, writeOnly: true, minLength: 8, maxLength: 2000 }) secret!: string;
}
class CustomToolParameterDto {
  @ApiProperty({ type: String, pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }) name!: string;
  @ApiProperty({ type: String, enum: ['string', 'number', 'integer', 'boolean'] }) type!:
    'string' | 'number' | 'integer' | 'boolean';
  @ApiProperty({ type: Boolean, required: false, default: false }) required?: boolean;
  @ApiProperty({ type: String, required: false, maxLength: 300 }) description?: string;
  @ApiProperty({
    type: String,
    required: false,
    maxLength: 80,
    description: 'HTTP query parameter name; defaults to name.',
  })
  queryParameter?: string;
}
class CustomToolDto {
  @ApiProperty({ type: String, pattern: '^[a-z][a-z0-9_-]{0,63}$' }) name!: string;
  @ApiProperty({ type: String, required: false, description: 'Defaults to name.' }) displayName?: string;
  @ApiProperty({ type: String, maxLength: 500 }) description!: string;
  @ApiProperty({
    type: String,
    required: false,
    description: 'Full HTTPS endpoint. Use this for new integrations.',
  })
  endpoint?: string;
  @ApiProperty({ type: CustomToolParameterDto, isArray: true, required: false, maxItems: 20 })
  parameters?: CustomToolParameterDto[];
  @ApiProperty({ type: String, required: false, description: 'Legacy server-approved connection profile.' })
  connectionProfile?: string;
  @ApiProperty({
    type: String,
    required: false,
    description: 'Legacy fixed path under a connection profile.',
  })
  path?: string;
  @ApiProperty({
    type: Object,
    additionalProperties: { type: 'string' },
    required: false,
    example: { q: 'query' },
  })
  queryMappings?: Record<string, string>;
  @ApiProperty({
    type: Object,
    required: false,
    description: 'Advanced restricted JSON Schema. Generated from parameters when omitted.',
  })
  inputSchema?: Record<string, unknown>;
  @ApiProperty({
    type: Object,
    required: false,
    description: 'Advanced restricted JSON Schema. Bounded JSON object accepted when omitted.',
  })
  outputSchema?: Record<string, unknown>;
  @ApiProperty({ type: ToolAuthDto, required: false }) auth?: ToolAuthDto | null;
  @ApiProperty({ type: Number, required: false, minimum: 500, maximum: 30000, default: 10000 })
  timeoutMs?: number;
  @ApiProperty({ type: Number, required: false, minimum: 256, maximum: 1000000, default: 65536 })
  maxResponseBytes?: number;
}
class EnabledDto {
  @ApiProperty({ type: Boolean }) enabled!: boolean;
}
class ToolTestDto {
  @ApiProperty({ type: Object }) sampleInput!: Record<string, unknown>;
}

@ApiTags('custom agent tools')
@Controller('api/agent/custom-tools')
@UseGuards(ApiAuthGuard)
@ApiBearerAuth('bearer')
export class CustomToolsController {
  constructor(@Inject(BackendTools) private readonly service: BackendTools) {}

  @Get('connections')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'List approved custom-tool connection profiles (no credentials)' })
  connections() {
    return this.service.listConnectionProfiles();
  }

  @Get()
  @InstallationOwnerOnly()
  @ApiOperation({
    summary: 'List administrator-created custom tools only; built-in Agent tools are excluded',
  })
  list() {
    return this.service.listCustomTools();
  }

  @Get(':id')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Get a custom tool configuration without secret values' })
  get(@Param('id') id: string) {
    return this.service.getCustomTool(id);
  }

  @Post()
  @InstallationOwnerOnly()
  @ApiOperation({
    summary: 'Create a disabled HTTPS GET API integration; input parameters generate its schema',
  })
  @ApiBody({ type: CustomToolDto })
  create(@Body() body: CustomToolDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.createCustomTool(body, principal.userId);
  }

  @Put(':id')
  @InstallationOwnerOnly()
  @ApiOperation({
    summary: 'Replace an API integration; use endpoint for full URLs or legacy profile/path fields',
  })
  @ApiBody({ type: CustomToolDto })
  update(@Param('id') id: string, @Body() body: CustomToolDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.updateCustomTool(id, body, principal.userId);
  }

  @Patch(':id/enabled')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Enable or disable a custom tool immediately' })
  @ApiBody({ type: EnabledDto })
  enabled(@Param('id') id: string, @Body() body: EnabledDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.setCustomToolEnabled(id, body?.enabled, principal.userId);
  }

  @Delete(':id')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Archive a custom tool; execution history remains available' })
  archive(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.archiveCustomTool(id, principal.userId);
  }

  @Post(':id/test')
  @InstallationOwnerOnly()
  @ApiOperation({
    summary: 'Execute a safe sample GET using the same network policy; response fields are sanitized',
  })
  @ApiBody({ type: ToolTestDto })
  test(@Param('id') id: string, @Body() body: ToolTestDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.testCustomTool(id, body?.sampleInput, principal.userId);
  }

  @Get(':id/executions')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Read metadata-only execution history' })
  executions(@Param('id') id: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.service.customToolExecutions(id, Number(limit) || 50, Number(offset) || 0);
  }
}
