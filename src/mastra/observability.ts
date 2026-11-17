import { Mastra } from '@mastra/core/mastra';
import type { AnySpan, LogEvent } from '@mastra/core/observability';
import { Observability, MastraStorageExporter, SamplingStrategyType } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { config } from '../config.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** PostgresStore's legacy observability domain stores spans, not signal logs. */
export class SitePilotMastraStorageExporter extends MastraStorageExporter {
  override async onLogEvent(_event: LogEvent): Promise<void> {
    // Application diagnostics remain in recordWorkflowDiagnostic and spans
    // continue through MastraStorageExporter; only unsupported log persistence
    // is disabled. In particular, no-op-trace logger signals are not exported.
  }
}

export function createSitePilotStorageExporter() {
  return new SitePilotMastraStorageExporter({ maxBatchSize: 100, maxBatchWaitMs: 1000 });
}

type LocalWorkflowDiagnostic = { traceId: string; tenantHash: string; recordedAt: string; details: Record<string, unknown> };
const localDiagnostics = new Map<string, LocalWorkflowDiagnostic>();
const diagnosticTtlMs = 30 * 24 * 60 * 60 * 1000;
const diagnosticLimit = 5000;

/** Retain redacted failure summaries locally even when a successful-trace sample is skipped. */
export function recordWorkflowDiagnostic(traceId: string, tenantId: string, details: Record<string, unknown>) {
  const now = Date.now();
  for (const [key, value] of localDiagnostics) if (now - Date.parse(value.recordedAt) > diagnosticTtlMs) localDiagnostics.delete(key);
  const previous = localDiagnostics.get(traceId);
  localDiagnostics.set(traceId, { traceId, tenantHash: tenantTraceKey(tenantId), recordedAt: new Date(now).toISOString(), details: { ...previous?.details, ...details } });
  while (localDiagnostics.size > diagnosticLimit) localDiagnostics.delete(localDiagnostics.keys().next().value!);
}

export function readLocalWorkflowDiagnostic(traceId: string, tenantId: string) {
  const diagnostic = localDiagnostics.get(traceId);
  return diagnostic && diagnostic.tenantHash === tenantTraceKey(tenantId)
    ? { traceId: diagnostic.traceId, recordedAt: diagnostic.recordedAt, ...diagnostic.details }
    : undefined;
}

export async function persistPlannerDiagnostic(prisma: Pick<PrismaService, 'plannerDiagnostic'>, diagnostic: {
  requestId: string; tenantId: string; availableToolIds: string[]; selectedOperation: string; selectedToolId?: string;
  schemaValidationOutcome: string; argumentSchemaValidationOutcome?: string; fallbackReason?: string;
  validationIssues?: Array<{ attempt: number; branch: string; path: string; code: string }>;
}) {
  const data = {
    requestId: diagnostic.requestId,
    tenantId: diagnostic.tenantId,
    availableToolIds: diagnostic.availableToolIds.slice(0, 48).map(id => id.slice(0, 120)),
    selectedOperation: diagnostic.selectedOperation.slice(0, 40),
    selectedToolId: diagnostic.selectedToolId?.slice(0, 120),
    schemaValidationOutcome: diagnostic.schemaValidationOutcome.slice(0, 24),
    argumentSchemaValidationOutcome: diagnostic.argumentSchemaValidationOutcome?.slice(0, 24),
    fallbackReason: diagnostic.fallbackReason?.slice(0, 80),
    validationIssues: diagnostic.validationIssues?.slice(0, 8).map(issue => ({
      attempt: issue.attempt === 2 ? 2 : 1,
      branch: issue.branch.slice(0, 32),
      path: issue.path.slice(0, 96),
      code: issue.code.slice(0, 40),
    })),
  };
  try {
    await prisma.plannerDiagnostic.upsert({ where: { requestId: data.requestId }, create: data, update: data });
    await prisma.plannerDiagnostic.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - diagnosticTtlMs) } } });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'planner_diagnostic_persistence_failed', errorType: error instanceof Error ? error.name : 'unknown' }));
  }
}

// Content-bearing fields are removed wholesale. The remaining attributes retain
// only operational measurements needed for diagnostics; key-based PII filters
// alone cannot reliably identify arbitrary document text.
const redactSpan = {
  name: 'sitepilot-content-redaction',
  process(span?: AnySpan) {
    if (!span) return undefined;
    const value = span as any;
    if ('input' in value) value.input = '[REDACTED]';
    if ('output' in value) value.output = '[REDACTED]';
    if ('requestContext' in value) value.requestContext = undefined;
    if (value.attributes && typeof value.attributes === 'object') {
      const keep = /^(model|provider|tool|operation|success|status|duration|promptTokens|completionTokens|inputTokens|outputTokens|usage|finishReason|callCount|retryCount)$/i;
      value.attributes = Object.fromEntries(Object.entries(value.attributes).filter(([key, item]) => keep.test(key) && (typeof item !== 'object' || item === null)));
    }
    if (value.metadata) {
      const safe: Record<string, unknown> = {};
      for (const key of ['requestId', 'tenantHash', 'orchestration']) if (typeof value.metadata[key] === 'string') safe[key] = value.metadata[key];
      value.metadata = safe;
    }
    return span;
  },
  async shutdown() {},
};

let sitePilotMastra: Mastra | undefined;
let observability: Observability | undefined;
function ensureObservability() {
  if (sitePilotMastra && observability) return { mastra: sitePilotMastra, observability };
  const storage = new PostgresStore({
    id: 'sitepilot-mastra-observability',
    connectionString: config.databaseUrl,
    retention: { observability: { spans: { maxAge: '30d', batchSize: 1000 } } },
  });
  observability = new Observability({
    sensitiveDataFilter: true,
    configs: {
      default: {
        serviceName: 'sitepilot-agent',
        sampling: { type: SamplingStrategyType.RATIO, probability: 0.1 },
        exporters: [createSitePilotStorageExporter()],
        spanOutputProcessors: [redactSpan],
        serializationOptions: { maxStringLength: 256, maxDepth: 4, maxArrayLength: 20, maxObjectKeys: 30 },
      },
    },
  });
  // Provider SDK errors may carry raw response bodies; operational failures are
  // already captured in redacted workflow diagnostics, so do not let the
  // framework logger print request/provider payloads.
  sitePilotMastra = new Mastra({ storage, observability, logger: false });
  const prune = () => { void sitePilotMastra?.getStorage()?.prune().catch(() => undefined); };
  prune();
  const retentionTimer = setInterval(prune, 24 * 60 * 60 * 1000);
  retentionTimer.unref();
  return { mastra: sitePilotMastra, observability };
}

export async function readTenantTrace(traceId: string, tenantId: string, prisma: Pick<PrismaService, 'plannerDiagnostic'>) {
  const localDiagnostic = readLocalWorkflowDiagnostic(traceId, tenantId);
  const compactId = traceId.replace(/-/g, '').toLowerCase();
  const requestId = compactId.length === 32
    ? `${compactId.slice(0, 8)}-${compactId.slice(8, 12)}-${compactId.slice(12, 16)}-${compactId.slice(16, 20)}-${compactId.slice(20)}`
    : traceId;
  const stored = await prisma.plannerDiagnostic.findUnique({ where: { requestId } }).catch(() => undefined);
  const persistedDiagnostic = stored?.tenantId === tenantId ? {
    traceId: compactId,
    step: 'planner-routing',
    availableToolIds: stored.availableToolIds,
    selectedOperation: stored.selectedOperation,
    selectedToolId: stored.selectedToolId ?? undefined,
    schemaValidationOutcome: stored.schemaValidationOutcome,
    argumentSchemaValidationOutcome: stored.argumentSchemaValidationOutcome ?? undefined,
    fallbackReason: stored.fallbackReason ?? undefined,
    validationIssues: stored.validationIssues ?? undefined,
    recordedAt: stored.createdAt.toISOString(),
  } : undefined;
  const diagnostic = localDiagnostic && persistedDiagnostic
    ? { ...localDiagnostic, ...persistedDiagnostic }
    : localDiagnostic ?? persistedDiagnostic;
  if (!observability) return diagnostic;
  const trace = await observability.getRecordedTrace({ traceId }).catch(() => undefined);
  if (!trace || (trace.rootSpan.metadata as Record<string, unknown> | undefined)?.tenantHash !== tenantTraceKey(tenantId)) return diagnostic;
  return {
    traceId: trace.traceId,
    spans: trace.spans.map((span: any) => ({
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      type: span.type,
      status: span.status,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      duration: span.duration,
      metadata: span.metadata,
      attributes: safeAttributes(span.attributes),
    })),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function safeAttributes(attributes: unknown) {
  if (!attributes || typeof attributes !== 'object') return {};
  const keep = /^(model|provider|tool|operation|success|status|duration|promptTokens|completionTokens|inputTokens|outputTokens|usage|finishReason|callCount|retryCount)$/i;
  return Object.fromEntries(Object.entries(attributes).filter(([key, value]) => keep.test(key) && (typeof value !== 'object' || value === null)));
}

export function registerWorkflowTracing(agent: any, planner: any, workflow: any) {
  if (process.env.MASTRA_OBSERVABILITY === 'false') return;
  const { mastra } = ensureObservability();
  mastra.addAgent(agent, 'sitepilot-request-agent');
  mastra.addAgent(planner, 'sitepilot-request-planner');
  mastra.addWorkflow(workflow, 'sitepilot-request-workflow');
}

export function tenantTraceKey(tenantId: string) {
  // Stable hash allows tenant isolation in trace metadata without retaining IDs.
  return createTenantHash(tenantId);
}
import { createHash } from 'node:crypto';
function createTenantHash(tenantId: string) { return createHash('sha256').update(tenantId).digest('hex').slice(0, 16); }
