import { BadRequestException, Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { LlmAdminService } from './llm-admin.service.js';

@ApiTags('LLM administration and usage') @Controller('api/admin/llm') @UseGuards(ApiAuthGuard) @ApiBearerAuth('bearer') @ApiSecurity('dev-api-key')
export class LlmAdminController {
 constructor(@Inject(LlmAdminService) private readonly service:LlmAdminService){}
 @Get('settings') @Roles('TENANT_ADMIN','SUPER_ADMIN') @ApiOperation({summary:'Read runtime model settings and secret configured flags'}) settings(){return this.service.settings();}
 @Post('settings') @Roles('TENANT_ADMIN','SUPER_ADMIN') @ApiOperation({summary:'Update allowlisted runtime settings'}) update(@Body() body:Record<string,unknown>,@CurrentPrincipal() p:AuthPrincipal){return this.service.updateSettings(body,p.userId);}
 @Get('models') @Roles('TENANT_ADMIN','SUPER_ADMIN') @ApiOperation({summary:'Discover installed Ollama, free OpenRouter, and configured Gemini models'}) models(){return this.service.discover();}
 @Post('models') @Roles('TENANT_ADMIN','SUPER_ADMIN') @ApiOperation({summary:'Register a compatible model identifier'}) add(@Body() b:{provider:string;modelId:string}){return this.service.addModel(b.provider,b.modelId);}
 @Get('usage') @ApiOperation({summary:'Tenant scoped token usage analytics; dates are ISO timestamps and buckets use Europe/Istanbul'}) usage(@Query('period') period='daily',@Query('from') from?:string,@Query('to') to?:string,@Query('groupBy') groupBy='date',@Query('provider') provider?:string,@Query('modelId') modelId?:string,@CurrentPrincipal() p?:AuthPrincipal){
   let start:Date,end:Date;const now=new Date(); if(from||to){if(!from||!to)throw new BadRequestException('FROM_AND_TO_REQUIRED');start=new Date(from);end=new Date(to);}else if(period==='today'||period==='yesterday'){const localToday=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())-3*60*60*1000);start=period==='today'?localToday:new Date(localToday.getTime()-86400000);end=period==='today'?now:localToday;}else{end=now;start=new Date(now);if(period==='daily')start.setUTCDate(start.getUTCDate()-1);else if(['weekly','last7days'].includes(period))start.setUTCDate(start.getUTCDate()-7);else if(['monthly','last30days'].includes(period))start.setUTCDate(start.getUTCDate()-30);else throw new BadRequestException('INVALID_PERIOD');}
   if(!['date','provider','model'].includes(groupBy))throw new BadRequestException('INVALID_GROUP_BY');return this.service.analytics(p!.tenantId,start,end,groupBy,provider,modelId);
 }
}
