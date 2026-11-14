import { BadRequestException, Body, Controller, Delete, Get, HttpException, Inject, NotFoundException, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { config } from '../config.js';
import { AgentService } from './agent.service.js';
import { ApiBearerAuth, ApiBody, ApiNotFoundResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InstallationOwnerOnly } from '../auth/installation-owner.decorator.js';
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
@ApiResponse({ status: 401, description: 'Valid access JWT required.' })
@UseGuards(ApiAuthGuard)
export class AgentController {
  constructor(@Inject(AgentService) private readonly agent: AgentService) {}

  @Post('ask')
  @ApiOperation({ summary: 'Ask Mastra and return a synchronous JSON answer' })
  @ApiBody({ schema: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 6000 }, conversationId: { type: 'string', format: 'uuid' } } } })
  @ApiResponse({ status: 200, description: 'Assistant answer and retrieved source citations.' })
  @ApiResponse({ status: 400, description: 'INVALID_MESSAGE or INVALID_CONVERSATION_ID.' })
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
  @ApiBody({ schema: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 6000 }, conversationId: { type: 'string', format: 'uuid' } } } })
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
          message: timedOut ? 'The request timed out.' : provider?.code === 'PROVIDER_DAILY_QUOTA_EXHAUSTED'
            ? 'The AI service has reached its daily request limit. Please try again after the quota resets.'
            : capacity?.message ?? 'The agent request could not be completed.',
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
  @ApiParam({ name: 'runId', description: 'UUID returned in the stream status event.' })
  @ApiResponse({ status: 200, description: 'Cancellation request result; executionSettled describes local execution only and providerStopConfirmed remains false because remote model shutdown is not observable.' })
  @ApiNotFoundResponse({ description: 'AGENT_RUN_NOT_FOUND or run is not owned by this user.' })
  cancelRun(@Param('runId') runId: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(runId)) throw new NotFoundException('AGENT_RUN_NOT_FOUND');
    return this.agent.cancelRun(runId, principal);
  }

  @Post('conversations')
  @ApiOperation({ summary: 'Create an empty conversation for the authenticated user' })
  @ApiResponse({ status: 201, description: 'Created conversation identifier and timestamp.' })
  createConversation(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.agent.createConversation(principal);
  }

  @Get('memories')
  @ApiOperation({ summary: 'List private, user-managed memories in the authenticated tenant' })
  @ApiResponse({ status: 200, description: 'At most 100 active preference, fact, project, and decision memories.' })
  listMemories(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.agent.listMemories(principal);
  }

  @Post('memories')
  @ApiOperation({ summary: 'Create a short user-authored memory for context across conversations' })
  @ApiBody({ schema: { type: 'object', required: ['category', 'content'], properties: { category: { type: 'string', enum: ['preference', 'fact', 'project', 'decision'] }, content: { type: 'string', minLength: 3, maxLength: 500 } } } })
  @ApiResponse({ status: 201, description: 'Created memory. Credentials, source citations, and prompt-like text are rejected.' })
  @ApiResponse({ status: 400, description: 'Invalid or disallowed memory.' })
  createMemory(@Body() body: { category?: unknown; content?: unknown }, @CurrentPrincipal() principal: AuthPrincipal) {
    return this.agent.createMemory(body ?? {}, principal);
  }

  @Patch('memories/:id')
  @ApiOperation({ summary: 'Correct an owned memory' })
  @ApiParam({ name: 'id', description: 'Memory UUID.' })
  @ApiBody({ schema: { type: 'object', required: ['category', 'content'], properties: { category: { type: 'string', enum: ['preference', 'fact', 'project', 'decision'] }, content: { type: 'string', minLength: 3, maxLength: 500 } } } })
  @ApiResponse({ status: 404, description: 'Memory does not exist or is not owned by this user in this tenant.' })
  updateMemory(@Param('id') id: string, @Body() body: { category?: unknown; content?: unknown }, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_MEMORY_ID');
    return this.agent.updateMemory(id, body ?? {}, principal);
  }

  @Delete('memories/:id')
  @ApiOperation({ summary: 'Delete an owned memory' })
  @ApiParam({ name: 'id', description: 'Memory UUID.' })
  @ApiResponse({ status: 200, description: 'Memory deletion result.' })
  @ApiResponse({ status: 404, description: 'Memory does not exist or is not owned by this user in this tenant.' })
  deleteMemory(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_MEMORY_ID');
    return this.agent.deleteMemory(id, principal);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'Cursor-based infinite scroll of owned conversations with latest-message status', description: 'Returns conversations and meta {limit,count,hasMore,nextCursor,direction:"older"}. Pass meta.nextCursor unchanged for the next batch. Existing top-level hasMore/nextCursor remain available.' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Owned conversations and pagination cursor metadata.' })
  @ApiResponse({ status: 400, description: 'INVALID_PAGE_LIMIT or INVALID_CONVERSATION_CURSOR.' })
  listConversations(@CurrentPrincipal() principal: AuthPrincipal, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) throw new BadRequestException('INVALID_PAGE_LIMIT');
    if (cursor !== undefined && !isUuid(cursor)) throw new BadRequestException('INVALID_CONVERSATION_CURSOR');
    return this.agent.listConversations(principal, limit ? Number(limit) : 50, cursor);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Load recent messages or prepend older messages on upward scroll', description: 'Messages in each batch are chronological. The first request selects the newest batch. Pass meta.nextCursor to get older messages and prepend them. Returns conversation fields, messages and meta; model context limits are independent.' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'id', description: 'Conversation UUID.' })
  @ApiResponse({ status: 200, description: 'Conversation details, chronological messages, and pagination metadata.' })
  @ApiResponse({ status: 400, description: 'Invalid conversation ID, page limit, or message cursor.' })
  @ApiNotFoundResponse({ description: 'Conversation does not exist or is not owned by this user.' })
  getConversation(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_CONVERSATION_ID');
    if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)) throw new BadRequestException('INVALID_PAGE_LIMIT');
    if (cursor !== undefined && !isUuid(cursor)) throw new BadRequestException('INVALID_MESSAGE_CURSOR');
    return this.agent.getConversation(id, principal, { ...(limit ? { limit: Number(limit) } : {}), ...(cursor ? { cursor } : {}) });
  }

  @Patch('conversations/:id')
  @ApiOperation({ summary: 'Rename an owned conversation' })
  @ApiParam({ name: 'id', description: 'Conversation UUID.' })
  @ApiBody({ schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 120 } } } })
  @ApiResponse({ status: 200, description: 'Updated conversation metadata.' })
  @ApiResponse({ status: 400, description: 'Invalid conversation ID or title.' })
  @ApiNotFoundResponse({ description: 'Conversation does not exist or is not owned by this user.' })
  renameConversation(@Param('id') id: string, @Body() body: { title?: unknown }, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_CONVERSATION_ID');
    if (typeof body?.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) {
      throw new BadRequestException('INVALID_CONVERSATION_TITLE');
    }
    return this.agent.renameConversation(id, body.title.trim(), principal);
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'Soft-delete an owned conversation and its grouped messages' })
  @ApiParam({ name: 'id', description: 'Conversation UUID.' })
  @ApiResponse({ status: 200, description: 'Deletion result.' })
  @ApiNotFoundResponse({ description: 'Conversation does not exist or is not owned by this user.' })
  deleteConversation(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_CONVERSATION_ID');
    return this.agent.deleteConversation(id, principal);
  }

  @Get('traces/:traceId')
  @InstallationOwnerOnly()
  @ApiOperation({ summary: 'Read redacted Mastra diagnostics for the installation' })
  @ApiParam({ name: 'traceId', description: '32-character hexadecimal trace identifier.' })
  @ApiResponse({ status: 200, description: 'Redacted trace metadata and spans.' })
  @ApiResponse({ status: 403, description: 'Installation owner required.' })
  @ApiNotFoundResponse({ description: 'TRACE_NOT_FOUND.' })
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
