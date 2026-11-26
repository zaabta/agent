import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RuntimeModelSnapshot } from './runtime-model.js';

export interface UsageContext {
  tenantId: string;
  userId?: string;
  conversationId?: string;
  logicalRequestId: string;
  runtime: RuntimeModelSnapshot;
  prisma?: PrismaService;
}
const usageContext = new AsyncLocalStorage<UsageContext>();
export function runWithUsageContext<T>(context: UsageContext, operation: () => Promise<T>): Promise<T> {
  return usageContext.run(context, operation);
}
export function currentUsageContext() {
  return usageContext.getStore();
}
export async function persistUsageEvent(prisma: PrismaService, record: Record<string, unknown>) {
  try {
    await prisma.llmUsage.create({ data: record as any });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'llm_usage_persistence_failed',
        errorType: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }
}
export async function persistUsage(
  prisma: PrismaService,
  context: UsageContext,
  detail: {
    invocationId?: string;
    usage?: any;
    status: 'success' | 'failed';
    latencyMs: number | null;
    source: string;
    actualModel?: string;
    error?: unknown;
    errorCategory?: string | null;
    finishReason?: string | null;
    maxOutputTokens?: number | null;
  },
) {
  const usage = detail.usage;
  const hasCounts =
    !!usage &&
    [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cachedInputTokens',
      'cachedTokens',
      'reasoningTokens',
    ].some((key) => Number.isInteger(usage[key]));
  await persistUsageEvent(prisma, {
    tenantId: context.tenantId,
    userId: context.userId ?? null,
    conversationId: context.conversationId ?? null,
    logicalRequestId: context.logicalRequestId,
    role: context.runtime.role ?? null,
    invocationId: detail.invocationId ?? randomUUID(),
    provider: String(usage?.provider ?? context.runtime.provider),
    configuredModelId: context.runtime.model,
    modelId: String(detail.actualModel ?? usage?.modelId ?? context.runtime.model),
    inputTokens: Number.isInteger(usage?.inputTokens) ? usage.inputTokens : null,
    outputTokens: Number.isInteger(usage?.outputTokens) ? usage.outputTokens : null,
    totalTokens: Number.isInteger(usage?.totalTokens)
      ? usage.totalTokens
      : Number.isInteger(usage?.inputTokens) && Number.isInteger(usage?.outputTokens)
        ? usage.inputTokens + usage.outputTokens
        : null,
    cachedTokens: Number.isInteger(usage?.cachedInputTokens)
      ? usage.cachedInputTokens
      : Number.isInteger(usage?.cachedTokens)
        ? usage.cachedTokens
        : null,
    reasoningTokens: Number.isInteger(usage?.reasoningTokens) ? usage.reasoningTokens : null,
    usageSource: usage ? detail.source : null,
    accuracy: hasCounts ? 'provider-reported' : 'unavailable',
    status: detail.status,
    latencyMs: detail.latencyMs === null ? null : Math.max(0, Math.round(detail.latencyMs)),
    errorCategory:
      detail.status === 'failed'
        ? (detail.errorCategory ?? (detail.error instanceof Error ? detail.error.name : 'LLM_ERROR'))
        : null,
    finishReason: detail.finishReason ?? null,
    maxOutputTokens: detail.maxOutputTokens ?? context.runtime.maxOutputTokens ?? null,
  });
}
