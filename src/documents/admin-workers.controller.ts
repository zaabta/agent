import { Controller, Get, Inject, NotFoundException, Query, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { InstallationOwnerOnly } from '../auth/installation-owner.decorator.js';
import { WorkerMonitoringService } from './worker-monitoring.service.js';

@ApiTags('admin worker monitoring')
@ApiBearerAuth('bearer')
@Controller('api/admin/workers')
@UseGuards(ApiAuthGuard)
@InstallationOwnerOnly()
export class AdminWorkersController {
  constructor(@Inject(WorkerMonitoringService) private readonly monitoring: WorkerMonitoringService) {}

  @Get('overview') @ApiOperation({ summary: 'Queue counts, worker health, and authenticated tenant document states' })
  @ApiResponse({ status: 200, description: 'Tenant-scoped document state totals and global queue/worker summary.' })
  overview(@CurrentPrincipal() principal: AuthPrincipal) { return this.monitoring.overview(principal.tenantId); }

  @Get('health') @ApiOperation({ summary: 'Worker process heartbeats and process/host resource metrics' })
  @ApiResponse({ status: 200, description: 'Worker liveness, heartbeat age, and process/host resource metrics.' })
  health() { return this.monitoring.health(); }

  @Get('jobs') @ApiOperation({ summary: 'Paginated jobs for the authenticated tenant only' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, default: 25 } })
  @ApiQuery({ name: 'status', required: false, description: 'Optional job status filter.' })
  @ApiResponse({ status: 200, description: 'Tenant-scoped page of jobs and pagination metadata.' })
  jobs(@CurrentPrincipal() principal: AuthPrincipal, @Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string) {
    return this.monitoring.listJobs(principal.tenantId, Number(page || 1), Number(limit || 25), status);
  }

  @Get('jobs/:jobId') @ApiOperation({ summary: 'Tenant-scoped job details with sanitized stage history' })
  @ApiParam({ name: 'jobId', description: 'BullMQ document processing job identifier.' })
  @ApiResponse({ status: 200, description: 'Job details and sanitized persisted stage history.' })
  @ApiNotFoundResponse({ description: 'JOB_NOT_FOUND.' })
  async job(@CurrentPrincipal() principal: AuthPrincipal, @Param('jobId') jobId: string) {
    const result = await this.monitoring.jobDetail(principal.tenantId, jobId);
    if (!result) throw new NotFoundException('JOB_NOT_FOUND');
    return result;
  }

  @Get('metrics') @ApiOperation({ summary: 'Retained queue totals and bounded-window throughput/latency metrics' })
  @ApiQuery({ name: 'windowMinutes', required: false, schema: { type: 'integer', minimum: 1, default: 60 } })
  @ApiResponse({ status: 200, description: 'Queue totals, throughput, and latency for the requested bounded time window.' })
  metrics(@Query('windowMinutes') windowMinutes?: string) { return this.monitoring.metrics(Number(windowMinutes || 60)); }

  @Get('events') @ApiOperation({ summary: 'Recent tenant-scoped persisted ingestion stage events' })
  @ApiQuery({ name: 'hours', required: false, schema: { type: 'integer', minimum: 1, default: 24 } })
  @ApiResponse({ status: 200, description: 'Recent persisted ingestion stage events for the authenticated tenant.' })
  events(@CurrentPrincipal() principal: AuthPrincipal, @Query('hours') hours?: string) { return this.monitoring.recentEvents(principal.tenantId, Number(hours || 24)); }
}
