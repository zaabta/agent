import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { loopbackAddress } from './custom-http-tool.js';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { InstallationOwnerOnly } from '../auth/installation-owner.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { BackendTools } from './backend-tools.js';
import { credentialEncryptionAvailable } from '../llm-admin/provider-credentials.js';

class ToolAuthDto {
  @ApiProperty({ type: String, enum: ['Authorization', 'X-API-Key'] }) headerName!:
    'Authorization' | 'X-API-Key';
  @ApiProperty({ type: String, required: false, description: 'For example, Bearer followed by a space.' })
  prefix?: string;
  @ApiProperty({ type: String, required: false, writeOnly: true, minLength: 8, maxLength: 2000 })
  secret?: string;
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
  @ApiProperty({ type: ToolAuthDto, required: false, nullable: true }) auth?: ToolAuthDto | null;
  @ApiProperty({ type: String, required: false, nullable: true, format: 'uuid' })
  connectionCredentialId?: string | null;
  @ApiProperty({
    type: String,
    isArray: true,
    required: false,
    description: 'User UUID allowlist required for shared privileged credentials.',
  })
  allowedUserIds?: string[];
  @ApiProperty({ type: String, enum: ['NONE', 'SHARED', 'PER_USER'], required: false })
  authScope?: 'NONE' | 'SHARED' | 'PER_USER';
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
class ConnectionLoginDto {
  @ApiProperty({ type: String, pattern: '^[a-z][a-z0-9_-]{0,63}$' }) name!: string;
  @ApiProperty({ type: String, format: 'email', maxLength: 254 }) email!: string;
  @ApiProperty({ type: String, writeOnly: true, minLength: 1, maxLength: 1024 }) password!: string;
}
class ConnectionProfileDto {
  @ApiProperty({ type: String, pattern: '^[a-z][a-z0-9_-]{0,63}$' }) id!: string;
  @ApiProperty({ type: String, maxLength: 120 }) displayName!: string;
  @ApiProperty({ type: String, format: 'uri' }) baseUrl!: string;
  @ApiProperty({ type: Boolean, required: false, default: false, description: 'Allow HTTP loopback only in non-production environments.' })
  allowLocalHttp?: boolean;
  @ApiProperty({ type: String, enum: ['NONE', 'SHARED', 'ATOMIC_COOKIE_REFRESH', 'OAUTH2_REFRESH'], required: false })
  authStrategy?: string;
  @ApiProperty({ type: String, required: false, format: 'uri' }) tokenUrl?: string;
  @ApiProperty({ type: String, required: false, maxLength: 200 }) clientId?: string;
  @ApiProperty({ type: Boolean, required: false }) enabled?: boolean;
}
class UserConnectionDto {
  @ApiProperty({ type: String, writeOnly: true, minLength: 8, maxLength: 8192 }) accessToken!: string;
  @ApiProperty({ type: String, writeOnly: true, minLength: 8, maxLength: 8192 }) refreshToken!: string;
  @ApiProperty({ type: Number, minimum: 1, maximum: 86400 }) expiresIn!: number;
}
class AtomicUserConnectionDto {
  @ApiProperty({ type: String, format: 'email', maxLength: 120 }) email!: string;
  @ApiProperty({ type: String, writeOnly: true, minLength: 8, maxLength: 1024 }) password!: string;
}

@ApiTags('custom agent tools')
@Controller('api/agent/custom-tools')
@UseGuards(ApiAuthGuard)
@ApiBearerAuth('bearer')
export class CustomToolsController {
  constructor(
    @Inject(BackendTools) private readonly service: BackendTools,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get('connections/encryption-status')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Check whether encrypted connection credentials can be stored' })
  connectionEncryptionStatus() {
    return { available: credentialEncryptionAvailable() };
  }

  @Get('connections')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'List approved custom-tool connection profiles (no credentials)' })
  connections(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.listConnectionProfiles(principal.tenantId);
  }

  @Get('connections/available')
  @ApiOperation({ summary: 'List safe metadata for enabled per-user integrations' })
  availableConnections(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.listAvailableUserConnections(principal.tenantId);
  }

  @Post('connections')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Create a database-backed custom-tool connection profile' })
  createConnection(@Body() body: ConnectionProfileDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.createConnectionProfile(body, principal.tenantId);
  }

  @Get('connections/:profile')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Get connection profile metadata without credentials' })
  getConnection(@Param('profile') profile: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.getConnectionProfile(profile, principal.tenantId);
  }

  @Put('connections/:profile')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Update connection profile metadata' })
  updateConnection(
    @Param('profile') profile: string,
    @Body() body: Partial<ConnectionProfileDto>,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    return this.service.updateConnectionProfile(profile, body, principal.tenantId);
  }

  @Delete('connections/:profile')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Delete an unused connection profile' })
  deleteConnection(@Param('profile') profile: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.deleteConnectionProfile(profile, principal.tenantId);
  }

  @Post('connections/:profile/connect')
  @ApiOperation({ summary: 'Store the current user’s encrypted connection tokens' })
  connectUser(@Param('profile') profile: string, @Body() body: UserConnectionDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.connectUserCredential(profile, body, principal);
  }

  @Delete('connections/:profile/disconnect')
  @ApiOperation({ summary: 'Disconnect the current user from a connection profile' })
  disconnectUser(@Param('profile') profile: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.disconnectUserCredential(profile, principal);
  }

  @Get('connections/:profile/status')
  @ApiOperation({ summary: 'Get the current user’s connection status' })
  userConnectionStatus(@Param('profile') profile: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.userCredentialStatus(profile, principal);
  }

  @Post('connections/:profile/connect/atomic')
  @ApiOperation({ summary: 'Connect the current user to an approved Atomic origin; password is never stored or returned' })
  @ApiBody({ type: AtomicUserConnectionDto })
  async connectAtomic(
    @Param('profile') profile: string,
    @Body() body: AtomicUserConnectionDto,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Ip() ip: string,
    @Req() request: Request,
  ) {
    if (!request.secure && !(process.env.NODE_ENV !== 'production' && loopbackAddress(request.socket.remoteAddress ?? ''))) {
      throw new ForbiddenException('HTTPS_REQUIRED');
    }
    await this.auth.enforceConnectionLoginLimit(ip, body?.email ?? '');
    return this.service.connectAtomicUserCredential(profile, body?.email, body?.password, principal);
  }

  @Get('connections/:profile/credentials')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'List connection credential metadata without secrets' })
  credentials(@Param('profile') profile: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.listConnectionCredentials(profile, principal.tenantId);
  }

  @Post('connections/:profile/credentials/login')
  @InstallationOwnerOnly()
  @ApiOperation({
    summary:
      'Create or replace an encrypted Atomic connection session; credentials and tokens are never returned',
  })
  @ApiBody({ type: ConnectionLoginDto })
  loginConnection(
    @Param('profile') profile: string,
    @Body() body: ConnectionLoginDto,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    return this.service.loginConnectionCredential(
      profile,
      body?.name,
      body?.email,
      body?.password,
      principal.userId,
      principal.tenantId,
    );
  }

  @Get()
  @InstallationOwnerOnly()
  @ApiOperation({
    summary: 'List administrator-created custom tools only; built-in Agent tools are excluded',
  })
  list(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.listCustomTools(principal.tenantId);
  }

  @Get(':id')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Get a custom tool configuration without secret values' })
  get(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.getCustomTool(id, principal.tenantId);
  }

  @Post()
  @InstallationOwnerOnly()
  @ApiOperation({
    summary: 'Create a disabled HTTPS GET API integration; input parameters generate its schema',
  })
  @ApiBody({ type: CustomToolDto })
  create(@Body() body: CustomToolDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.createCustomTool(body, principal.userId, principal.tenantId);
  }

  @Put(':id')
  @InstallationOwnerOnly()
  @ApiOperation({
    summary: 'Replace an API integration; use endpoint for full URLs or legacy profile/path fields',
  })
  @ApiBody({ type: CustomToolDto })
  update(@Param('id') id: string, @Body() body: CustomToolDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.updateCustomTool(id, body, principal.userId, principal.tenantId);
  }

  @Patch(':id/enabled')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Enable or disable a custom tool immediately' })
  @ApiBody({ type: EnabledDto })
  enabled(@Param('id') id: string, @Body() body: EnabledDto, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.service.setCustomToolEnabled(id, body?.enabled, principal.userId, principal.tenantId);
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
    return this.service.testCustomTool(id, body?.sampleInput, principal.userId, principal.tenantId);
  }

  @Get(':id/executions')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Read metadata-only execution history' })
  executions(@Param('id') id: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.service.customToolExecutions(id, Number(limit) || 50, Number(offset) || 0);
  }
}
