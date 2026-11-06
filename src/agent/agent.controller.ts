import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiAuthGuard } from '../auth/api-auth.guard.js';
import { CurrentPrincipal } from '../auth/current-principal.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { config } from '../config.js';
import { AgentService } from './agent.service.js';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';

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
  ask(@Body() body: AgentBody, @CurrentPrincipal() principal: AuthPrincipal) {
    const { message, conversationId } = this.validateBody(body, false);
    return this.agent.ask(message, conversationId, principal);
  }

  @Post('stream')
  @ApiOperation({ summary: 'Stream native Mastra Agent events as SSE from a POST request' })
  @ApiResponse({ status: 200, description: 'SSE events: status, tool-start, tool-finish, text-delta, sources, step-start, step-finish, error, done.' })
  async stream(@Body() body: AgentBody, @Res() response: Response, @CurrentPrincipal() principal: AuthPrincipal): Promise<void> {
    const { message, conversationId } = this.validateBody(body, false);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('REQUEST_TIMEOUT'));
    }, config.agentTimeoutMs);
    timeout.unref();

    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    const onClose = () => {
      if (!response.writableEnded) controller.abort(new Error('CLIENT_DISCONNECTED'));
    };
    response.once('close', onClose);

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
      if (!response.destroyed && !response.writableEnded && !controller.signal.reason?.message?.includes('CLIENT_DISCONNECTED')) {
        const modelFailure = error instanceof Error && error.message === 'MODEL_STREAM_FAILED';
        await write('error', {
          code: timedOut ? 'REQUEST_TIMEOUT' : modelFailure ? 'MODEL_ERROR' : 'AGENT_REQUEST_FAILED',
          recoverable: false,
          discardProvisional: true,
        }, true);
        response.end();
      }
    } finally {
      clearTimeout(timeout);
      response.off('close', onClose);
    }
  }

  @Post('conversations')
  createConversation(@CurrentPrincipal() principal: AuthPrincipal) {
    return this.agent.createConversation(principal);
  }

  @Get('conversations/:id')
  getConversation(@Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) {
    if (!isUuid(id)) throw new BadRequestException('INVALID_CONVERSATION_ID');
    return this.agent.getConversation(id, principal);
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
