import { BadRequestException, Body, Controller, Delete, Get, HttpException, Inject, NotFoundException, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { config } from '../config.js';
import { AgentService } from './agent.service.js';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator.js';
import { readTenantTrace } from '../mastra/observability.js';
import { safeProviderClientResponse, safeProviderFailure } from './provider-errors.js';
import { AgentRunCancelledError, AgentRunCapacityError } from './active-run-registry.js';

interface AgentBody {
  message?: string;
  conversationId?: string;
}

@Controller('api/agent')
@ApiTags('agent and conversations')
@ApiBearerAuth('bearer')
@ApiSecurity('dev-api-key')
@ApiResponse({ status: 401, description: 'Valid access JWT required; local dev key is optional when explicitly enabled.' })
@UseGuards(ApiAuthGuard)
export class AgentController {
  constructor(@Inject(AgentService) private readonly agent: AgentService) {}

  @Post('ask')
  @ApiOperation({ summary: 'Ask Mastra and return a synchronous JSON answer' })
  @ApiBody({ schema: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 6000 }, conversationId: { type: 'string', format: 'uuid' } } } })
  async ask(@Body() body: AgentBody, @CurrentPrincipal() principal: AuthPrincipal) {
    const { message, conversationId } = this.validateBody(body, false);
    try {
      return await this.agent.ask(message, conversationId, principal);
    } catch (error) {
      const provider = safeProviderClientResponse(error);
      if (!provider) throw error;
      throw new HttpException(provider.body, provider.statusCode);
    }
  }

  @Post('stream')
  @ApiOperation({ summary: 'Stream native Mastra Agent events as SSE from a POST request' })
  @ApiResponse({ status: 200, description: 'SSE events: status (includes runId), stage, tool-start, tool-finish, text-delta, text-reset, sources, step-start, step-finish, cancelled, error, done.' })
  async stream(@Body() body: AgentBody, @Res() response: Response, @CurrentPrincipal() principal: AuthPrincipal): Promise<void> {
    const { message, conversationId } = this.validateBody(body, false);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('REQUEST_TIMEOUT'));
    }, config.agentTimeoutMs);
    timeout.unref();

    // A disconnected browser stops receiving SSE but does not cancel generation;
    // the persisted assistant turn can be restored from conversation history.
    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    const write = async (event: string, data: Record<string, unknown>, allowAborted = false) => {
      if (response.destroyed || (controller.signal.aborted && !allowAborted)) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (!response.write(frame)) {
        await new Promise<void>(resolve => {
          const done = () => {
            response.off('drain', done);
            response.off('close', done);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          response.once('drain', done);
          response.once('close', done);
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    };

    try {
      await this.agent.stream(message, conversationId, controller.signal, write, principal);
      if (!response.destroyed && !response.writableEnded) response.end();
    } catch (error) {
      if (error instanceof AgentRunCancelledError) {
        if (!response.destroyed && !response.writableEnded) {
          await write('cancelled', { runId: error.runId, status: 'cancelled', executionSettled: true, providerStopConfirmed: false, ackLatencyMs: error.ackLatencyMs }, true);
          response.end();
        }
        return;
      }
      if (!response.destroyed && !response.writableEnded && !controller.signal.reason?.message?.includes('CLIENT_DISCONNECTED')) {
        const provider = safeProviderFailure(error);
        const modelFailure = error instanceof Error && error.message === 'MODEL_STREAM_FAILED';
        const capacity = error instanceof AgentRunCapacityError ? error : undefined;
        await write('error', {
          code: timedOut ? 'REQUEST_TIMEOUT' : capacity?.code ?? provider?.code ?? (modelFailure ? 'MODEL_ERROR' : 'AGENT_REQUEST_FAILED'),
          message: timedOut ? 'The request timed out.' : capacity?.message ?? 'The agent request could not be completed.',
          recoverable: provider?.retryable ?? Boolean(capacity),
          ...(provider ? { retryable: provider.retryable } : {}),
          ...(capacity ? { retryable: true, retryAfterMs: 1000 } : {}),
          ...(provider?.retryAfterMs !== undefined ? { retryAfterMs: provider.retryAfterMs } : {}),
          discardProvisional: true,
        }, true);
        response.end();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  @Post('runs/:runId/cancel')
  @ApiOperation({ summary: 'Request cancellation of an active agent execution owned by the authenticated user' })
  @ApiResponse({ status: 200, description: 'Cancellation request result; executionSettled describes local execution only and providerStopConfirmed remains false because remote model shutdown is not observable.' })
  cancelRun(@Param('runId') runId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(runId)) throw new NotFoundException('AGENT_RUN_NOT_FOUND');
    return this.agent.cancelRun(runId, principal);
  }

  @Post('conversations')
  createConversation(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.agent.createConversation(principal);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Cursor-based infinite scroll of owned conversations with latest-message status', description: 'Returns conversations and meta {limit,count,hasMore,nextCursor,direction:"older"}. Pass meta.nextCursor unchanged for the next batch. Existing top-level hasMore/nextCursor remain available.' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', format: 'uuid' } })
  listConversations(@CurrentPrincipal() principal: AuthPrincipal, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) throw new BadRequestException('INVALID_PAGE_LIMIT');
    if (cursor !== undefined && !isUuid(cursor)) throw new BadRequestException('INVALID_CONVERSATION_CURSOR');
    return this.agent.listConversations(principal, limit ? Number(limit) : 50, cursor);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Load recent messages or prepend older messages on upward scroll', description: 'Messages in each batch are chronological. The first request selects the newest batch. Pass meta.nextCursor to get older messages and prepend them. Returns conversation fields, messages and meta; model context limits are independent.' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', format: 'uuid' } })
  getConversation(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_CONVERSATION_ID');
    if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)) throw new BadRequestException('INVALID_PAGE_LIMIT');
    if (cursor !== undefined && !isUuid(cursor)) throw new BadRequestException('INVALID_MESSAGE_CURSOR');
    return this.agent.getConversation(id, principal, { ...(limit ? { limit: Number(limit) } : {}), ...(cursor ? { cursor } : {}) });
  }

  @Patch('conversations/:id')
  @ApiOperation({ summary: 'Rename an owned conversation' })
  @ApiBody({ schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 120 } } } })
  renameConversation(@Param('id') id: string, @Body() body: { title?: unknown }, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_CONVERSATION_ID');
    if (typeof body?.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) {
      throw new BadRequestException('INVALID_CONVERSATION_TITLE');
    }
    return this.agent.renameConversation(id, body.title.trim(), principal);
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'Soft-delete an owned conversation and its grouped messages' })
  deleteConversation(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_CONVERSATION_ID');
    return this.agent.deleteConversation(id, principal);
  }

  @Get('traces/:traceId')
  @Roles('SUPER_ADMIN', 'TENANT_ADMIN')
  @ApiOperation({ summary: 'Read redacted Mastra diagnostics for the authenticated tenant' })
  async trace(@Param('traceId') traceId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!/^[a-f0-9]{32}$/i.test(traceId)) throw new NotFoundException('TRACE_NOT_FOUND');
    const result = await readTenantTrace(traceId, principal.tenantId);
    if (!result) throw new NotFoundException('TRACE_NOT_FOUND');
    return result;
  }

  private validateBody(body: AgentBody, requireConversation: boolean) {
    if (typeof body?.message !== 'string' || !body.message.trim() || body.message.length > 6000) {
      throw new BadRequestException('INVALID_MESSAGE');
    }
    if (body.conversationId !== undefined && !isUuid(body.conversationId)) {
      throw new BadRequestException('INVALID_CONVERSATION_ID');
    }
    if (requireConversation && !body.conversationId) throw new BadRequestException('CONVERSATION_ID_REQUIRED');
    return { message: body.message.trim(), conversationId: body.conversationId };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
