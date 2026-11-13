import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { InstallationOwnerOnly } from '../auth/installation-owner.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { LlmAdminService } from './llm-admin.service.js';

class SaveProviderCredentialDto {
  @ApiProperty({ type: String, minLength: 8, maxLength: 500, writeOnly: true, description: 'Provider API key. Stored encrypted and never returned.' })
  apiKey!: string;
}

class ProviderCredentialStatusDto {
  @ApiProperty({ type: String }) provider!: string;
  @ApiProperty({ type: Boolean }) configured!: boolean;
  @ApiProperty({ type: String, enum: ['database', 'environment', 'none'] }) source!: string;
}

@ApiTags('LLM models and token usage')
@Controller('api/llm')
@UseGuards(ApiAuthGuard)
@ApiBearerAuth('bearer')
export class LlmController {
  constructor(@Inject(LlmAdminService) private readonly service: LlmAdminService) {}

  @Get('providers') @InstallationOwnerOnly() @ApiOperation({ summary: 'Providers and secret configuration flags (never returns keys)' }) providers() { return this.service.providers(); }
  @Put('providers/:provider/credential') @InstallationOwnerOnly() @ApiOperation({summary:'Encrypt and save a cloud provider credential; plaintext is never returned'}) @ApiBody({type:SaveProviderCredentialDto}) @ApiResponse({status:200,type:ProviderCredentialStatusDto}) saveCredential(@Param('provider') provider:string,@Body() body:SaveProviderCredentialDto,@CurrentPrincipal() p:AuthPrincipal){return this.service.saveCredential(provider,body?.apiKey,p.userId);}
  @Delete('providers/:provider/credential') @InstallationOwnerOnly() @ApiOperation({summary:'Revoke a stored cloud provider credential; environment fallback remains active'}) @ApiResponse({status:200,type:ProviderCredentialStatusDto}) revokeCredential(@Param('provider') provider:string,@CurrentPrincipal() p:AuthPrincipal){return this.service.revokeCredential(provider,p.userId);}
  @Post('providers/:provider/test') @InstallationOwnerOnly() @ApiOperation({summary:'Test fixed official provider connectivity and API-key authorization'}) @ApiResponse({status:200,description:'Connectivity and authentication result; never includes key or provider response body.'}) testCredential(@Param('provider') provider:string){return this.service.testCredential(provider);}
  @Get('models') @InstallationOwnerOnly() @ApiOperation({ summary: 'List registered provider models' }) models() { return this.service.models(); }
  @Post('models/sync') @InstallationOwnerOnly() @ApiOperation({ summary: 'Synchronize Ollama, free OpenRouter, and credentialed OpenAI model catalogs' }) sync() { return this.service.discover(); }
  @Post('models') @InstallationOwnerOnly() @ApiOperation({ summary: 'Manually register a Gemini or OpenAI model ID' }) add(@Body() body: { provider: string; modelId: string }) { return this.service.addModel(body.provider, body.modelId); }
  @Patch('models/:id') @InstallationOwnerOnly() @ApiOperation({ summary: 'Enable or disable a registered model' }) patch(@Param('id') id: string, @Body() body: { enabled?: boolean }) { return this.service.patchModel(id, body); }
  @Post('models/:id/test') @InstallationOwnerOnly() @ApiOperation({ summary: 'Check provider listing or local installation without generating text' }) testModel(@Param('id') id: string) { return this.service.testModel(id); }
  @Get('active-model') @InstallationOwnerOnly() @ApiOperation({ summary: 'Get the active database-backed model selection' }) active() { return this.service.activeModel(); }
  @Put('active-model') @InstallationOwnerOnly() @ApiOperation({ summary: 'Select a registered model for new invocations immediately' }) setActive(@Body() body: { provider?: string; modelId?: string }, @CurrentPrincipal() p: AuthPrincipal) {
    if (!body.provider || !body.modelId) throw new BadRequestException('PROVIDER_AND_MODEL_ID_REQUIRED');
    return this.service.setActive(body.provider, body.modelId, p.userId);
  }
  @Get('usage/summary') @ApiOperation({ summary: 'User-scoped token totals for an ISO date range' }) summary(@Query() q: any, @CurrentPrincipal() p: AuthPrincipal) { return this.analytics(q, p, 'provider'); }
  @Get('usage/daily') @ApiOperation({ summary: 'User-scoped daily, weekly, monthly, or custom token buckets in Europe/Istanbul' }) daily(@Query() q: any, @CurrentPrincipal() p: AuthPrincipal) { return this.analytics(q, p, 'date', true); }
  @Get('usage/by-model') @ApiOperation({ summary: 'User-scoped exact provider/model totals' }) byModel(@Query() q: any, @CurrentPrincipal() p: AuthPrincipal) { return this.analytics(q, p, 'model'); }
  @Get('usage/logs') @ApiOperation({ summary: 'Paginated user-scoped invocation records; prompt contents are never stored' }) logs(@Query() q: any, @CurrentPrincipal() p: AuthPrincipal) {
    const from = q.from ? new Date(q.from) : undefined, to = q.to ? new Date(q.to) : undefined;
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from >= to)) throw new BadRequestException('INVALID_DATE_RANGE');
    return this.service.logs(p.userId, { from, to, provider: q.provider, modelId: q.modelId, conversationId: q.conversationId, limit: Math.min(100, Math.max(1, Number(q.limit) || 50)), offset: Math.max(0, Number(q.offset) || 0) });
  }
  private analytics(q: any, p: AuthPrincipal, grouping: string, periodBuckets = false) {
    const now = new Date(); let from: Date; let to = now;
    if (q.from || q.to) { if (!q.from || !q.to) throw new BadRequestException('FROM_AND_TO_REQUIRED'); from = new Date(q.from); to = new Date(q.to); }
    else { const days = q.period === 'weekly' ? 7 : q.period === 'monthly' ? 30 : 1; if (q.period && !['daily', 'weekly', 'monthly'].includes(q.period)) throw new BadRequestException('INVALID_PERIOD'); from = new Date(now.getTime() - days * 86400000); }
    const selectedGroup = q.groupBy && ['date','week','month','provider','model'].includes(q.groupBy) ? q.groupBy : periodBuckets && q.period === 'weekly' ? 'week' : periodBuckets && q.period === 'monthly' ? 'month' : grouping;
    return this.service.analytics(p.userId, from!, to, selectedGroup, q.provider, q.modelId, q.conversationId);
  }
}
