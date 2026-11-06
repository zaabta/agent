import { Controller, Get, Inject, NotFoundException, Query, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { Roles } from '../auth/roles.decorator.js';
import { WorkerMonitoringService } from './worker-monitoring.service.js';

@ApiTags('admin worker monitoring')
@ApiBearerAuth('bearer')
@ApiSecurity('dev-api-key')
@Controller('api/admin/workers')
@UseGuards(ApiAuthGuard)
@Roles('SUPER_ADMIN', 'TENANT_ADMIN')
export class AdminWorkersController {
  constructor(@Inject(WorkerMonitoringService) private readonly monitoring: WorkerMonitoringService) {}

  @Get('overview') @ApiOperation({ summary: 'Queue counts, worker health, and authenticated tenant document states' })
  overview(@CurrentPrincipal() principal: AuthPrincipal) { return this.monitoring.overview(principal.tenantId); }

  @Get('health') @ApiOperation({ summary: 'Worker process heartbeats and process/host resource metrics' })
  health() { return this.monitoring.health(); }

  @Get('jobs') @ApiOperation({ summary: 'Paginated jobs for the authenticated tenant only' })
  jobs(@CurrentPrincipal() principal: AuthPrincipal, @Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string) {
    return this.monitoring.listJobs(principal.tenantId, Number(page || 1), Number(limit || 25), status);
  }

  @Get('jobs/:jobId') @ApiOperation({ summary: 'Tenant-scoped job details with sanitized stage history' })
  async job(@CurrentPrincipal() principal: AuthPrincipal, @Param('jobId') jobId: string) {
    const result = await this.monitoring.jobDetail(principal.tenantId, jobId);
    if (!result) throw new NotFoundException('JOB_NOT_FOUND');
    return result;
  }

  @Get('metrics') @ApiOperation({ summary: 'Retained queue totals and bounded-window throughput/latency metrics' })
  metrics(@Query('windowMinutes') windowMinutes?: string) { return this.monitoring.metrics(Number(windowMinutes || 60)); }

  @Get('events') @ApiOperation({ summary: 'Recent tenant-scoped persisted ingestion stage events' })
  events(@CurrentPrincipal() principal: AuthPrincipal, @Query('hours') hours?: string) { return this.monitoring.recentEvents(principal.tenantId, Number(hours || 24)); }
}
