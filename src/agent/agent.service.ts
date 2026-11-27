import { BackendTools } from './backend-tools.js';
import { structuredSelectionSchema, type StructuredSelection } from './structured-selection.js';
import { Inject, Injectable, NotFoundException, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TypegraphService } from '../typegraph/typegraph.service.js';
import { config } from '../config.js';
import { StructuredDataService } from '../documents/structured-data.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { readTenantTrace } from './trace-diagnostics.js';
import { persistPlannerDiagnostic } from './trace-diagnostics.js';
import { AgentRequestFailure, safeAgentFailure } from './provider-errors.js';
import { ActiveAgentRunRegistry, AgentRunCancelledError } from './active-run-registry.js';
import { ConversationContextService } from './conversation-context.service.js';
import { conversationEntitiesSchema, conversationEvidenceReferencesSchema } from './conversation-context.js';
import { UserMemoryService } from './user-memory.service.js';
import { modelForRole, resolveRuntimeModels, type RuntimeModelInput } from '../llm-admin/runtime-model.js';
import { persistUsage } from '../llm-admin/usage-recorder.js';
import { createLangGraphOrchestrator } from './langgraph-orchestrator.js';
import type { Prisma } from '@prisma/client';

export interface VerifiedSource {
  citationId: string;
  documentId: string;
  documentVersionId?: string;
  chunkId?: string;
  pageNumber?: number;
  location?: string;
  headingPath?: string[];
  sheetName?: string;
  rowStart?: number;
  rowEnd?: number;
  rowNumbers?: number[];
  cellRange?: string;
  cellRefs?: string[];
  matchedCell?: string;
  contentHash?: string;
  paragraphStart?: number;
  paragraphEnd?: number;
  filename: string;
  sourceRef: string;
  chunkIndex: number;
}

export interface AgentStreamResult {
  answer: string;
  sources: VerifiedSource[];
  evidenceReferences: Array<{
    claimIndex: number;
    evidenceIds: string[];
    citationIds: string[];
    sources: VerifiedSource[];
  }>;
  toolsCalled: string[];
  conversationId: string;
  timing: Record<string, number | null>;
  citationValidation: 'valid' | 'no-evidence' | 'fallback';
  verificationStatus?: 'unverified' | 'not_required';
  outcome?: 'success' | 'empty' | 'clarification' | 'failure';
  executionStatus?: 'completed' | 'failed';
}

type EventWriter = (event: string, data: Record<string, unknown>) => Promise<void>;
type AgentMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string };

@Injectable()
export class AgentService implements OnModuleDestroy {
  private readonly typegraph: TypegraphService;
  private readonly structuredData: StructuredDataService;
  private readonly conversationContext: ConversationContextService;
  private readonly userMemory: UserMemoryService;
  private readonly activeRuns = new ActiveAgentRunRegistry();
  constructor(
    @Inject(TypegraphService) typegraph: TypegraphService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StructuredDataService) structuredData: StructuredDataService,
    @Optional() @Inject(BackendTools) private readonly backendTools?: BackendTools,
    @Optional() @Inject(ConversationContextService) conversationContext?: ConversationContextService,
    @Optional() @Inject(UserMemoryService) userMemory?: UserMemoryService,
  ) {
    this.typegraph = typegraph;
    this.structuredData = structuredData;
    this.conversationContext = conversationContext ?? new ConversationContextService(prisma);
    this.userMemory = userMemory ?? new UserMemoryService(prisma);
  }

  async onModuleDestroy() {
    await this.activeRuns.shutdown();
  }

  readTrace(traceId: string, tenantId: string) {
    return readTenantTrace(traceId, tenantId, this.prisma);
  }
  async createConversation(principal: AuthPrincipal) {
    const conversation = await this.prisma.conversation.create({
      data: { tenantId: principal.tenantId, ownerId: principal.userId },
      select: { id: true, createdAt: true },
    });
    return conversation;
  }

  async listConversations(principal: AuthPrincipal, limit = 50, cursor?: string) {
    const pageSize = Math.max(1, Math.min(100, Math.trunc(limit)));
    if (
      cursor &&
      !(await this.prisma.conversation.findFirst({
        where: { id: cursor, tenantId: principal.tenantId, ownerId: principal.userId, deletedAt: null },
        select: { id: true },
      }))
    )
      throw new NotFoundException('CONVERSATION_CURSOR_NOT_FOUND');
    const rows = await this.prisma.conversation.findMany({
      where: { tenantId: principal.tenantId, ownerId: principal.userId, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    const hasMore = rows.length > pageSize;
    const conversations = rows.slice(0, pageSize);
    const nextCursor = hasMore ? conversations.at(-1)?.id : null;
    const ids = conversations.map((item) => item.id);
    await this.reconcileStaleTurns(ids);
    const messages = ids.length
      ? await this.prisma.message.findMany({
          where: { conversationId: { in: ids } },
          orderBy: [{ createdAt: 'desc' }, { role: 'asc' }],
          distinct: ['conversationId'],
          select: {
            id: true,
            conversationId: true,
            role: true,
            content: true,
            status: true,
            stage: true,
            createdAt: true,
          },
        })
      : [];
    const latest = new Map(messages.map((item) => [item.conversationId, item]));
    return {
      hasMore,
      nextCursor,
      meta: {
        limit: pageSize,
        count: conversations.length,
        hasMore,
        nextCursor,
        direction: 'older' as const,
      },
      conversations: conversations.map((conversation) => ({
        ...conversation,
        lastMessage: latest.get(conversation.id) ?? null,
      })),
    };
  }

  async getConversation(
    conversationId: string,
    principal: AuthPrincipal,
    page: { limit?: number; cursor?: string } = {},
  ) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        tenantId: principal.tenantId,
        ownerId: principal.userId,
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!conversation) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    await this.reconcileStaleTurns([conversationId]);
    const limit = Math.min(200, Math.max(1, Math.trunc(page.limit ?? 100)));
    // UI pagination is independent of the model context budget. Validate cursor
    // ownership before using Prisma's unique cursor.
    if (
      page.cursor &&
      !(await this.prisma.message.findFirst({
        where: { id: page.cursor, conversationId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('MESSAGE_CURSOR_NOT_FOUND');
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { role: 'asc' }, { id: 'desc' }],
      take: limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit);
    const nextCursor = hasMore ? messages.at(-1)?.id : null;
    return {
      ...conversation,
      hasMore,
      nextCursor,
      meta: { limit, count: messages.length, hasMore, nextCursor, direction: 'older' as const },
      messages: messages
        .map(({ structuredSelection: _selection, ...item }) => item)
        .reverse()
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.role === 'user' ? -1 : b.role === 'user' ? 1 : 0),
        ),
    };
  }

  async renameConversation(conversationId: string, title: string, principal: AuthPrincipal) {
    const result = await this.prisma.conversation.updateMany({
      where: { id: conversationId, tenantId: principal.tenantId, ownerId: principal.userId, deletedAt: null },
      data: { title, updatedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    return { id: conversationId, title };
  }

  async deleteConversation(conversationId: string, principal: AuthPrincipal) {
    const deletedAt = new Date();
    const result = await this.prisma.conversation.updateMany({
      where: { id: conversationId, tenantId: principal.tenantId, ownerId: principal.userId, deletedAt: null },
      data: { deletedAt, updatedAt: deletedAt },
    });
    if (!result.count) throw new NotFoundException('CONVERSATION_NOT_FOUND');
    return { id: conversationId, deletedAt };
  }

  async listMemories(principal: AuthPrincipal) {
    return this.userMemory.list(principal);
  }

  async createMemory(input: { category?: unknown; content?: unknown }, principal: AuthPrincipal) {
    return this.userMemory.create(input, principal);
  }

  async updateMemory(id: string, input: { category?: unknown; content?: unknown }, principal: AuthPrincipal) {
    return this.userMemory.update(id, input, principal);
  }

  async deleteMemory(id: string, principal: AuthPrincipal) {
    return this.userMemory.delete(id, principal);
  }

  async ask(message: string, conversationId: string | undefined, principal: AuthPrincipal) {
    const runtime = await resolveRuntimeModels(this.prisma);
    return this.askLangGraph(message, conversationId, principal, runtime);
  }

  protected createGraph(
    principal: AuthPrincipal,
    runtime: RuntimeModelInput,
    progress?: (event: string, data: Record<string, unknown>) => Promise<void> | void,
    requestContext?: { conversationId: string; logicalRequestId: string },
  ) {
    return createLangGraphOrchestrator({
      typegraph: this.typegraph,
      structuredData: this.structuredData,
      principal,
      backendTools: this.backendTools,
      runtime: {
        router: modelForRole(runtime, 'ROUTER'),
        planner: modelForRole(runtime, 'PLANNER'),
        answer: modelForRole(runtime, 'ANSWER'),
      },
      progress,
      onPlannerDiagnostic: (diagnostic) => persistPlannerDiagnostic(this.prisma, diagnostic),
      onUsage: (record) =>
        persistUsage(
          this.prisma,
          {
            tenantId: principal.tenantId,
            userId: principal.userId,
            conversationId: requestContext?.conversationId,
            logicalRequestId: requestContext?.logicalRequestId ?? record.requestId,
            runtime: modelForRole(runtime, record.role),
          },
          {
            usage: record.usage,
            status: record.status,
            latencyMs: record.latencyMs,
            source: 'langchain-openai',
            error: record.error,
            errorCategory: record.error ? safeAgentFailure(record.error)?.code : undefined,
            finishReason: record.finishReason,
          },
        ),
    });
  }
  async stream(
    message: string,
    conversationId: string | undefined,
    abortSignal: AbortSignal,
    write: EventWriter,
    principal: AuthPrincipal,
  ): Promise<AgentStreamResult> {
    const startedAt = performance.now();
    const runtime = await resolveRuntimeModels(this.prisma);
    const run = this.activeRuns.create(principal);
    const overallDeadlineMs = Math.min(
      600_000,
      (runtime.router.requestTimeoutMs ?? config.agentTimeoutMs) +
        (runtime.planner.requestTimeoutMs ?? config.agentTimeoutMs) +
        (runtime.answer.maxStreamDurationMs ?? config.answerStreamMaxDurationMs),
    );
    const runSignal = AbortSignal.any([
      abortSignal,
      run.controller.signal,
      AbortSignal.timeout(overallDeadlineMs),
    ]);
    const runWriter: EventWriter = (event, data) =>
      write(event, event === 'status' ? { ...data, runId: run.runId } : data);
    try {
      const result = await this.streamLangGraph(
        message,
        conversationId,
        runSignal,
        runWriter,
        principal,
        run.runId,
        runtime,
      );
      this.activeRuns.finish(run.runId, 'completed');
      return result;
    } catch (error) {
      if (run.cancelRequested) {
        this.activeRuns.finish(run.runId, 'cancelled');
        throw new AgentRunCancelledError(
          run.runId,
          Math.max(0, Date.now() - (run.cancelRequestedAtMs ?? Date.now())),
        );
      }
      if (runSignal.aborted && !safeAgentFailure(runSignal.reason)) {
        this.activeRuns.finish(run.runId, 'cancelled');
        throw runSignal.reason ?? new Error('CLIENT_DISCONNECTED');
      }
      this.activeRuns.finish(run.runId, 'failed');
      const failure = safeAgentFailure(error);
      if (failure && !failure.requestId)
        throw new AgentRequestFailure(failure.code, {
          requestId: run.runId,
          retryable: failure.retryable,
          retryAfterMs: failure.retryAfterMs,
          telemetry: ['INVALID_MODEL_OUTPUT', 'OUTPUT_TRUNCATED', 'TOOL_EXECUTION_FAILED'].includes(
            failure.code,
          )
            ? undefined
            : { providerErrors: 1, totalMs: Math.round(performance.now() - startedAt) },
        });
      throw error;
    }
  }

  private async askLangGraph(
    message: string,
    conversationId: string | undefined,
    principal: AuthPrincipal,
    runtime: RuntimeModelInput,
  ) {
    const startedAt = performance.now();
    const turn = await this.beginTurn(message, conversationId, principal);
    const graph = this.createGraph(principal, runtime, undefined, {
      conversationId: turn.conversationId,
      logicalRequestId: turn.assistantMessageId,
    });
    try {
      const final = await graph.invoke({
        message,
        history: turn.prompt.slice(0, -1),
        memories: turn.userMemories,
        previousSelection: turn.previousSelection,
        previousContext: {
          summary: turn.conversationSummary ?? '',
          entities: turn.contextEntities ?? [],
          sources: (turn.evidenceRefs ?? []).map(({ filename, sourceRef }) => ({ filename, sourceRef })),
        },
        signal: AbortSignal.timeout(config.agentTimeoutMs),
      });
      await this.saveAssistant(
        turn.conversationId,
        turn.assistantMessageId,
        final.answer,
        undefined,
        principal,
        final.persistenceSources,
        final.contextRelevant,
        final.outcome === 'failure' ? 'failed' : 'completed',
        final.evidenceReferences,
      );
      return {
        answer: final.answer,
        sources: final.sources,
        evidenceReferences: final.evidenceReferences,
        toolsCalled: final.toolsCalled,
        citationValidation: final.citationValidation,
        verificationStatus: final.verificationStatus,
        executionStatus: final.executionStatus,
        outcome: final.outcome,
        conversationId: turn.conversationId,
        requestId: final.requestId,
        timing: {
          llmCalls: final.llmCalls,
          totalMs: Math.round(performance.now() - startedAt),
          orchestration: 1,
        },
      };
    } catch (error) {
      await this.finishAssistantTurn(turn.conversationId, turn.assistantMessageId, 'failed').catch(
        () => undefined,
      );
      const failure = safeAgentFailure(error);
      if (failure)
        throw new AgentRequestFailure(failure.code, {
          requestId: turn.assistantMessageId,
          retryable: failure.retryable,
          retryAfterMs: failure.retryAfterMs,
          telemetry: failure.telemetry,
        });
      throw error;
    }
  }

  private async streamLangGraph(
    message: string,
    conversationId: string | undefined,
    abortSignal: AbortSignal,
    write: EventWriter,
    principal: AuthPrincipal,
    runId: string,
    runtime: RuntimeModelInput,
  ): Promise<AgentStreamResult> {
    const startedAt = performance.now();
    const turn = await this.beginTurn(message, conversationId, principal);
    this.activeRuns.bindConversation(runId, turn.conversationId);
    await write('status', {
      status: 'started',
      orchestration: 'langgraph',
      conversationId: turn.conversationId,
      turnId: turn.assistantMessageId,
    });
    let timeToFirstTextMs: number | null = null;
    const graph = this.createGraph(
      principal,
      runtime,
      async (event, data) => {
        if (event === 'stage' && typeof data.stage === 'string')
          await this.updateAssistantStage(turn.conversationId, turn.assistantMessageId, data.stage);
        await write(event, data);
      },
      { conversationId: turn.conversationId, logicalRequestId: turn.assistantMessageId },
    );
    try {
      const final = await graph.invoke({
        message,
        history: turn.prompt.slice(0, -1),
        memories: turn.userMemories,
        previousSelection: turn.previousSelection,
        previousContext: {
          summary: turn.conversationSummary ?? '',
          entities: turn.contextEntities ?? [],
          sources: (turn.evidenceRefs ?? []).map(({ filename, sourceRef }) => ({ filename, sourceRef })),
        },
        signal: abortSignal,
      });
      this.activeRuns.beginFinalization(runId, abortSignal);
      await this.saveAssistant(
        turn.conversationId,
        turn.assistantMessageId,
        final.answer,
        undefined,
        principal,
        final.persistenceSources,
        final.contextRelevant,
        final.outcome === 'failure' ? 'failed' : 'completed',
        final.evidenceReferences,
      );
      await write('sources', { sources: final.sources });
      timeToFirstTextMs = Math.round(performance.now() - startedAt);
      await write('text-delta', { text: final.answer, verification: final.verificationStatus });
      const timing = {
        timeToFirstStatusMs: Math.round(performance.now() - startedAt),
        timeToFirstTextMs,
        totalMs: Math.round(performance.now() - startedAt),
        llmCalls: final.llmCalls,
        orchestration: 1,
      };
      const result = {
        answer: final.answer,
        sources: final.sources,
        evidenceReferences: final.evidenceReferences,
        toolsCalled: final.toolsCalled,
        citationValidation: final.citationValidation,
        verificationStatus: final.verificationStatus,
        executionStatus: final.executionStatus,
        outcome: final.outcome,
        conversationId: turn.conversationId,
        timing,
      };
      await write('stage', {
        stage: final.outcome === 'failure' ? 'failed' : 'completed',
        status: final.outcome === 'failure' ? 'failed' : 'completed',
        message: final.outcome === 'failure' ? 'Answer generation failed' : 'Answer is ready',
      });
      await write('done', { ...result, requestId: final.requestId, finishObserved: true, telemetry: timing });
      return result;
    } catch (error) {
      await this.finishAssistantTurn(
        turn.conversationId,
        turn.assistantMessageId,
        abortSignal.aborted ? 'interrupted' : 'failed',
      ).catch(() => undefined);
      const failure = safeAgentFailure(error);
      if (failure)
        throw new AgentRequestFailure(failure.code, {
          requestId: turn.assistantMessageId,
          retryable: failure.retryable,
          retryAfterMs: failure.retryAfterMs,
          telemetry: failure.telemetry,
        });
      throw error;
    }
  }

  async cancelRun(runId: string, principal: AuthPrincipal) {
    const requestStartedAt = Date.now();
    const run = this.activeRuns.getOwned(runId, principal);
    if (!run || !run.conversationId) throw new NotFoundException('AGENT_RUN_NOT_FOUND');
    // Recheck private conversation ownership in persistent state. The API guard
    // has already revalidated the JWT, workspace membership, and user status.
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: run.conversationId, tenantId: principal.tenantId, ownerId: principal.userId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException('AGENT_RUN_NOT_FOUND');
    const result = await this.activeRuns.cancel(run);
    return { ...result, ackLatencyMs: Math.max(result.ackLatencyMs, Date.now() - requestStartedAt) };
  }

  private async beginTurn(
    message: string,
    conversationId: string | undefined,
    principal: AuthPrincipal,
  ): Promise<{
    conversationId: string;
    assistantMessageId: string;
    prompt: AgentMessage[];
    previousSelection?: StructuredSelection;
    userMemories: Array<{ category: 'preference' | 'fact' | 'project' | 'decision'; content: string }>;
    evidenceRefs: Array<{
      documentId: string;
      filename: string;
      sourceRef: string;
      documentVersionId?: string;
    }>;
    contextEntities: string[];
    conversationSummary: string;
  }> {
    const conversation = conversationId
      ? await this.prisma.conversation.findFirst({
          where: {
            id: conversationId,
            tenantId: principal.tenantId,
            ownerId: principal.userId,
            deletedAt: null,
          },
          select: { id: true },
        })
      : await this.prisma.conversation.create({
          data: { tenantId: principal.tenantId, ownerId: principal.userId },
          select: { id: true },
        });
    if (!conversation) throw new NotFoundException('CONVERSATION_NOT_FOUND');

    const [context, userMemories] = await Promise.all([
      this.conversationContext.load(conversation.id, principal),
      this.userMemory.forPrompt(principal),
    ]);

    const history = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        OR: [{ role: 'user' }, { role: 'assistant', status: 'completed' }],
      },
      // PostgreSQL now() is shared by the two inserts in a turn's transaction.
      // Reverse chronological order must put assistant before user on that tie,
      // so reversing the bounded page restores the actual dialogue order.
      orderBy: [{ createdAt: 'desc' }, { role: 'asc' }, { id: 'desc' }],
      take: config.conversationHistoryMessages,
      select: { role: true, content: true, structuredSelection: true },
    });
    const [, assistantMessage] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: { conversationId: conversation.id, role: 'user', content: message },
      }),
      this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: 'assistant',
          content: '',
          status: 'processing',
          stage: 'thinking',
        },
      }),
      this.prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
    ]);
    const prompt = history
      .filter((item) => item.role !== 'assistant' || item.content.trim())
      .reverse()
      .map((item) => ({
        role: item.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: item.content.slice(0, config.conversationHistoryChars),
      }));
    prompt.push({ role: 'user', content: message });
    const storedSelection = context
      ? context.activeSelection
      : history.find((item) => item.role === 'assistant' && item.structuredSelection)?.structuredSelection;
    const previous = structuredSelectionSchema.safeParse(storedSelection);
    const contextEntities = conversationEntitiesSchema.safeParse(context?.entities);
    const evidenceRefs = conversationEvidenceReferencesSchema.safeParse(context?.evidenceRefs);
    const savedEvidenceRefs = evidenceRefs.success ? evidenceRefs.data : [];
    return {
      conversationId: conversation.id,
      assistantMessageId: assistantMessage.id,
      prompt,
      previousSelection: previous.success ? previous.data : undefined,
      userMemories,
      evidenceRefs: savedEvidenceRefs,
      contextEntities: contextEntities.success ? contextEntities.data : [],
      conversationSummary: typeof context?.summary === 'string' ? context.summary.slice(0, 2000) : '',
    };
  }

  private async saveAssistant(
    conversationId: string,
    assistantMessageId: string,
    content: string,
    selection?: StructuredSelection,
    principal?: AuthPrincipal,
    sources: VerifiedSource[] = [],
    preserveConversationContext = false,
    status: 'completed' | 'failed' = 'completed',
    evidenceReferences: AgentStreamResult['evidenceReferences'] = [],
  ) {
    const contextModel = (this.prisma as unknown as { conversationContext?: { upsert?: unknown } })
      .conversationContext;
    if (principal && contextModel?.upsert) {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.message.updateMany({
          where: { id: assistantMessageId, conversationId, role: 'assistant' },
          data: {
            content,
            status,
            stage: status === 'failed' ? 'failed' : null,
            evidenceReferences: (status === 'completed' ? evidenceReferences : []) as unknown as Prisma.InputJsonValue,
            ...(selection ? { structuredSelection: selection } : {}),
          },
        });
        await transaction.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
        if (status === 'completed')
          await this.conversationContext.saveTurn(
            transaction,
            conversationId,
            principal,
            content,
            sources,
            selection,
            preserveConversationContext,
          );
      });
      return;
    }
    await this.prisma.$transaction([
      this.prisma.message.updateMany({
        where: { id: assistantMessageId, conversationId, role: 'assistant' },
        data: {
          content,
          status,
          stage: status === 'failed' ? 'failed' : null,
          evidenceReferences: (status === 'completed' ? evidenceReferences : []) as unknown as Prisma.InputJsonValue,
          ...(selection ? { structuredSelection: selection } : {}),
        },
      }),
      this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
    ]);
  }

  private async updateAssistantStage(conversationId: string, assistantMessageId: string, stage: string) {
    await this.prisma.$transaction([
      this.prisma.message.updateMany({
        where: { id: assistantMessageId, conversationId, role: 'assistant', status: 'processing' },
        data: { stage },
      }),
      this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
    ]);
  }

  private async finishAssistantTurn(
    conversationId: string,
    assistantMessageId: string,
    status: 'interrupted' | 'failed',
  ) {
    await this.prisma.$transaction([
      this.prisma.message.updateMany({
        where: { id: assistantMessageId, conversationId, role: 'assistant', status: 'processing' },
        data: { status, stage: status },
      }),
      this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
    ]);
  }

  private async reconcileStaleTurns(conversationIds: string[]) {
    if (!conversationIds.length) return;
    const staleBefore = new Date(Date.now() - config.agentTimeoutMs - 10_000);
    await this.prisma.message.updateMany({
      where: {
        conversationId: { in: conversationIds },
        role: 'assistant',
        status: 'processing',
        createdAt: { lt: staleBefore },
      },
      data: { status: 'interrupted', stage: 'interrupted' },
    });
  }
}
