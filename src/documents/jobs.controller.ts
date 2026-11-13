import { Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { JobsService } from './jobs.service.js';

@ApiTags('document jobs')
@ApiBearerAuth('bearer')
@Controller('api/jobs')
@UseGuards(ApiAuthGuard)
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}
  @Get(':jobId') @ApiOperation({ summary: 'Get the latest tenant-scoped document job status' })
  @ApiParam({ name: 'jobId', description: 'BullMQ document processing job identifier.' })
  @ApiResponse({ status: 200, description: 'Current status, stage, measurable progress, ETA, and progress details.' })
  @ApiNotFoundResponse({ description: 'Job does not exist or belongs to another tenant.' })
  get(@Param('jobId') jobId: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.jobs.get(jobId, principal.tenantId); }
  @Post(':jobId/cancel') @ApiOperation({ summary: 'Request cancellation of a queued or active document job' })
  @ApiParam({ name: 'jobId', description: 'BullMQ document processing job identifier.' })
  @ApiResponse({ status: 201, description: 'Updated job view; cancellation can be terminal or still cancelling.' })
  @ApiNotFoundResponse({ description: 'Job does not exist or belongs to another tenant.' })
  cancel(@Param('jobId') jobId: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.jobs.cancel(jobId, principal.tenantId); }
  @Get(':jobId/events')
  @ApiOperation({ summary: 'Stream tenant-scoped job snapshots and persisted stage transitions; no document content is sent.' })
  @ApiParam({ name: 'jobId', description: 'BullMQ document processing job identifier.' })
  @ApiResponse({ status: 200, description: 'SSE event names: status, stage, completed, failed, cancelled. Stage events have durable IDs and support Last-Event-ID replay.' })
  @ApiNotFoundResponse({ description: 'Job does not exist or belongs to another tenant.' })
  async events(@Param('jobId') jobId: string, @Res() res: Response, @Headers('last-event-id') lastEventId: string | undefined, @CurrentPrincipal() principal: AuthPrincipal) {
    await this.jobs.get(jobId, principal.tenantId);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    return this.jobs.stream(jobId, res, abort.signal, principal.tenantId, lastEventId);
  }
}
