import { Mastra } from '@mastra/core/mastra';
import type { AnySpan, LogEvent } from '@mastra/core/observability';
import { Observability, MastraStorageExporter, SamplingStrategyType } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { config } from '../config.js';

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
  localDiagnostics.set(traceId, { traceId, tenantHash: tenantTraceKey(tenantId), recordedAt: new Date(now).toISOString(), details });
  while (localDiagnostics.size > diagnosticLimit) localDiagnostics.delete(localDiagnostics.keys().next().value!);
}

export function readLocalWorkflowDiagnostic(traceId: string, tenantId: string) {
  const diagnostic = localDiagnostics.get(traceId);
  return diagnostic && diagnostic.tenantHash === tenantTraceKey(tenantId)
    ? { traceId: diagnostic.traceId, recordedAt: diagnostic.recordedAt, ...diagnostic.details }
    : undefined;
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

export async function readTenantTrace(traceId: string, tenantId: string) {
  const diagnostic = readLocalWorkflowDiagnostic(traceId, tenantId);
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
