import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';

type LocalDiagnostic = {
  traceId: string;
  tenantHash: string;
  recordedAt: string;
  details: Record<string, unknown>;
};
const localDiagnostics = new Map<string, LocalDiagnostic>();
const diagnosticTtlMs = 30 * 24 * 60 * 60 * 1000;
const diagnosticLimit = 5000;

export function tenantTraceKey(tenantId: string) {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
}

export function recordAgentDiagnostic(traceId: string, tenantId: string, details: Record<string, unknown>) {
  const now = Date.now();
  for (const [key, value] of localDiagnostics)
    if (now - Date.parse(value.recordedAt) > diagnosticTtlMs) localDiagnostics.delete(key);
  const previous = localDiagnostics.get(traceId);
  localDiagnostics.set(traceId, {
    traceId,
    tenantHash: tenantTraceKey(tenantId),
    recordedAt: new Date(now).toISOString(),
    details: { ...previous?.details, ...details },
  });
  while (localDiagnostics.size > diagnosticLimit)
    localDiagnostics.delete(localDiagnostics.keys().next().value!);
}

export function readLocalAgentDiagnostic(traceId: string, tenantId: string) {
  const diagnostic = localDiagnostics.get(traceId);
  return diagnostic && diagnostic.tenantHash === tenantTraceKey(tenantId)
    ? { traceId: diagnostic.traceId, recordedAt: diagnostic.recordedAt, ...diagnostic.details }
    : undefined;
}

export async function persistPlannerDiagnostic(
  prisma: Pick<PrismaService, 'plannerDiagnostic'>,
  diagnostic: {
    requestId: string;
    tenantId: string;
    availableToolIds: string[];
    selectedOperation: string;
    selectedToolId?: string;
    schemaValidationOutcome: string;
    argumentSchemaValidationOutcome?: string;
    fallbackReason?: string;
    validationIssues?: Array<{ attempt: number; branch: string; path: string; code: string }>;
  },
) {
  const data = {
    requestId: diagnostic.requestId,
    tenantId: diagnostic.tenantId,
    availableToolIds: diagnostic.availableToolIds.slice(0, 48).map((id) => id.slice(0, 120)),
    selectedOperation: diagnostic.selectedOperation.slice(0, 40),
    selectedToolId: diagnostic.selectedToolId?.slice(0, 120),
    schemaValidationOutcome: diagnostic.schemaValidationOutcome.slice(0, 24),
    argumentSchemaValidationOutcome: diagnostic.argumentSchemaValidationOutcome?.slice(0, 24),
    fallbackReason: diagnostic.fallbackReason?.slice(0, 80),
    validationIssues: diagnostic.validationIssues?.slice(0, 8).map((issue) => ({
      attempt: issue.attempt === 2 ? 2 : 1,
      branch: issue.branch.slice(0, 32),
      path: issue.path.slice(0, 96),
      code: issue.code.slice(0, 40),
    })),
  };
  try {
    await prisma.plannerDiagnostic.upsert({
      where: { requestId: data.requestId },
      create: data,
      update: data,
    });
    await prisma.plannerDiagnostic.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - diagnosticTtlMs) } },
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'planner_diagnostic_persistence_failed',
        errorType: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }
}

export async function readTenantTrace(
  traceId: string,
  tenantId: string,
  prisma: Pick<PrismaService, 'plannerDiagnostic'>,
) {
  const local = readLocalAgentDiagnostic(traceId, tenantId);
  const compactId = traceId.replace(/-/g, '').toLowerCase();
  const requestId =
    compactId.length === 32
      ? `${compactId.slice(0, 8)}-${compactId.slice(8, 12)}-${compactId.slice(12, 16)}-${compactId.slice(16, 20)}-${compactId.slice(20)}`
      : traceId;
  const stored = await prisma.plannerDiagnostic.findUnique({ where: { requestId } }).catch(() => undefined);
  const persisted =
    stored?.tenantId === tenantId
      ? {
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
        }
      : undefined;
  return local && persisted ? { ...local, ...persisted } : (local ?? persisted);
}
